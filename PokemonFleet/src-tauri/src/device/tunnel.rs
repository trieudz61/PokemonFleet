//! USB tunnel pool — one `iproxy` process per device.
//!
//! Each iPhone the user plugs in needs a localhost TCP tunnel that bridges to
//! its on-device IOSControl HTTP server (port 9999). `iproxy` (from
//! libusbmuxd) handles the actual usbmuxd plumbing — we just spawn it,
//! allocate ports, and clean up children on Drop / app exit.
//!
//! On Windows we additionally place every child into a Job Object configured
//! with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so a hard crash of the parent
//! still tears down all `iproxy.exe` children — otherwise they would linger
//! and hold the USB tunnel open.

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

/// Slot → local-port mapping that mirrors the convention baked into the
/// IOSControl Web IDE (`static/app.js`):
///   slot 1…9   → IDE   port = 9990 + slot           (9991…9999)
///   slot N        → VNC HTML = 5902 + slot * 10
///   slot N        → VNC WS   = 15900 + slot * 10
///
/// We deliberately skip slot 0 — the IDE special-cases idePort==9999 to mean
/// slot 0, but binding 9999 on the host side is unreliable, so we always
/// start from slot 1.
const MAX_SLOTS: u8 = 16;
const DEVICE_IDE_PORT: u16 = 9999;
const DEVICE_VNC_HTML_PORT: u16 = 5902;
const DEVICE_VNC_WS_PORT: u16 = 5900;

pub struct TunnelPool {
    inner: Arc<Mutex<Inner>>,
    #[cfg(windows)]
    job: windows_job::JobHandle,
}

struct Inner {
    /// UDID -> tunnel record
    tunnels: HashMap<String, Tunnel>,
    /// Slot indices currently in use.
    used_slots: HashSet<u8>,
}

struct Tunnel {
    slot: u8,
    ide_port: u16,
    vnc_html_port: u16,
    vnc_ws_port: u16,
    /// All three iproxy children. We hold them so Drop can reap them.
    children: Vec<Child>,
}

impl TunnelPool {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                tunnels: HashMap::new(),
                used_slots: HashSet::new(),
            })),
            #[cfg(windows)]
            job: windows_job::create().unwrap_or_default(),
        }
    }

    /// Spawn three iproxy children for the given UDID and return the IDE port.
    /// Idempotent: if a tunnel already exists, returns the cached IDE port.
    pub fn ensure(&self, udid: &str) -> Result<u16> {
        let mut inner = self.inner.lock();
        if let Some(t) = inner.tunnels.get(udid) {
            return Ok(t.ide_port);
        }

        let slot = pick_slot(&inner.used_slots, udid)
            .ok_or_else(|| anyhow!("tunnel pool full ({} slots)", MAX_SLOTS))?;
        let iproxy = locate_iproxy()?;

        let ide_port      = 9990 + slot as u16;
        let vnc_html_port = 5902 + (slot as u16) * 10;
        let vnc_ws_port   = 15900 + (slot as u16) * 10;

        let mappings: [(u16, u16, &str); 3] = [
            (ide_port,      DEVICE_IDE_PORT,      "IDE"),
            (vnc_html_port, DEVICE_VNC_HTML_PORT, "VNC-HTML"),
            (vnc_ws_port,   DEVICE_VNC_WS_PORT,   "VNC-WS"),
        ];

        let mut children = Vec::with_capacity(3);
        for (local, device, kind) in mappings.iter() {
            let mut cmd = Command::new(&iproxy);
            cmd.arg(local.to_string())
                .arg(device.to_string())
                .arg("--udid")
                .arg(udid)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let child = cmd.spawn()
                .with_context(|| format!("spawn iproxy {} ({}->{}) at {:?}", kind, local, device, iproxy))?;
            #[cfg(windows)]
            {
                if let Err(e) = self.job.assign(&child) {
                    tracing::warn!(udid = %udid, kind = %kind, err = ?e,
                                   "failed to assign iproxy to job object");
                }
            }
            children.push(child);
            tracing::info!(udid = %udid, slot = slot, kind = %kind,
                           local = local, device = device, "iproxy tunnel spawned");
        }

        inner.used_slots.insert(slot);
        inner.tunnels.insert(udid.to_string(), Tunnel {
            slot, ide_port, vnc_html_port, vnc_ws_port, children,
        });
        Ok(ide_port)
    }

    /// Tear down the tunnels for a UDID (e.g. on disconnect). Returns true if
    /// a tunnel existed and was killed.
    pub fn drop_tunnel(&self, udid: &str) -> bool {
        let mut inner = self.inner.lock();
        if let Some(mut t) = inner.tunnels.remove(udid) {
            inner.used_slots.remove(&t.slot);
            for mut c in t.children.drain(..) {
                let _ = c.kill();
                let _ = c.wait();
            }
            tracing::info!(udid = %udid, slot = t.slot, "iproxy tunnels torn down");
            true
        } else {
            false
        }
    }

    pub fn port_for(&self, udid: &str) -> Option<u16> {
        self.inner.lock().tunnels.get(udid).map(|t| t.ide_port)
    }

    /// Snapshot of all ports allocated to a device — surfaced via Tauri so
    /// the UI can display VNC / IDE links explicitly when needed.
    pub fn ports_for(&self, udid: &str) -> Option<DevicePorts> {
        let inner = self.inner.lock();
        inner.tunnels.get(udid).map(|t| DevicePorts {
            slot: t.slot,
            ide: t.ide_port,
            vnc_html: t.vnc_html_port,
            vnc_ws: t.vnc_ws_port,
        })
    }

    /// Tear down every tunnel (on app exit).
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock();
        for (udid, mut t) in inner.tunnels.drain() {
            for mut c in t.children.drain(..) {
                let _ = c.kill();
                let _ = c.wait();
            }
            tracing::debug!(udid = %udid, slot = t.slot, "iproxy stopped on shutdown");
        }
        inner.used_slots.clear();
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DevicePorts {
    pub slot: u8,
    pub ide: u16,
    pub vnc_html: u16,
    pub vnc_ws: u16,
}

impl Drop for TunnelPool {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Stable per-UDID slot picker. Hashes the UDID into a starting slot so a
/// device that comes back will (usually) get the same slot, then linear-probes
/// if that one is busy.
fn pick_slot(used: &HashSet<u8>, udid: &str) -> Option<u8> {
    if used.len() >= MAX_SLOTS as usize { return None; }
    let mut h: u32 = 5381;
    for b in udid.as_bytes() {
        h = h.wrapping_mul(33).wrapping_add(*b as u32);
    }
    let start: u8 = ((h % MAX_SLOTS as u32) + 1) as u8; // 1..=MAX_SLOTS
    let mut s = start;
    loop {
        if !used.contains(&s) { return Some(s); }
        s = if s >= MAX_SLOTS { 1 } else { s + 1 };
        if s == start { return None; }
    }
}

/// Resolve the `iproxy` binary. Search order:
///   1. `<exe-dir>/binaries/iproxy[.exe]`            — dev / portable layout
///   2. `<exe-dir>/resources/binaries/iproxy[.exe]`  — Windows MSI / NSIS
///   3. PATH (Homebrew on macOS, `setup.exe` install on Windows)
fn locate_iproxy() -> Result<std::path::PathBuf> {
    let exe_name = if cfg!(windows) { "iproxy.exe" } else { "iproxy" };

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(dir) = exe_path.parent() {
            let candidate = dir.join("binaries").join(exe_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
            let resources = dir.join("resources").join("binaries").join(exe_name);
            if resources.is_file() {
                return Ok(resources);
            }
        }
    }

    which::which(exe_name)
        .map_err(|_| anyhow!("iproxy not found — install libimobiledevice (brew install libimobiledevice on macOS)"))
}

// ─────────────────────────── Windows Job Object ───────────────────────────
//
// Wraps a single Job Object that every iproxy child gets assigned to. The job
// is configured with KILL_ON_JOB_CLOSE so when our process tree dies, Windows
// terminates iproxy automatically. On non-Windows targets this module is a
// no-op.

#[cfg(windows)]
mod windows_job {
    use anyhow::{Context, Result};
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::jobapi2::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    };
    use winapi::um::winnt::{
        JobObjectExtendedLimitInformation, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use winapi::shared::minwindef::FALSE;

    pub struct JobHandle {
        handle: winapi::um::winnt::HANDLE,
    }
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl Default for JobHandle {
        fn default() -> Self {
            Self { handle: std::ptr::null_mut() }
        }
    }

    pub fn create() -> Result<JobHandle> {
        unsafe {
            let h = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if h.is_null() {
                return Err(anyhow::anyhow!("CreateJobObjectW failed"));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == FALSE {
                CloseHandle(h);
                return Err(anyhow::anyhow!("SetInformationJobObject failed"));
            }
            Ok(JobHandle { handle: h })
        }
    }

    impl JobHandle {
        pub fn assign(&self, child: &Child) -> Result<()> {
            if self.handle.is_null() {
                return Ok(());
            }
            unsafe {
                let ok = AssignProcessToJobObject(self.handle, child.as_raw_handle() as _);
                if ok == FALSE {
                    return Err(anyhow::anyhow!("AssignProcessToJobObject failed"));
                }
            }
            Ok(())
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe { CloseHandle(self.handle) };
            }
        }
    }

    // Need this re-export so `JOBOBJECT_BASIC_LIMIT_INFORMATION` doesn't trip
    // unused-import warnings on the bigger struct above.
    #[allow(dead_code)]
    fn _refs(_: JOBOBJECT_BASIC_LIMIT_INFORMATION) {}
}
