// PokemonFleet — main application controller.

// [DEV] lockDownInspect disabled for debugging — re-enable before release.
// (function lockDownInspect() {
//   document.addEventListener("contextmenu", (e) => e.preventDefault());
//   document.addEventListener("keydown", (e) => {
//     const k = e.key?.toLowerCase();
//     // F12 — DevTools.
//     if (e.key === "F12") { e.preventDefault(); return; }
//     const meta = e.metaKey || e.ctrlKey;
//     // Cmd/Ctrl+Shift+I  — DevTools (Inspect)
//     // Cmd/Ctrl+Shift+J  — DevTools (Console)
//     // Cmd/Ctrl+Shift+C  — DevTools (Element picker)
//     if (meta && e.shiftKey && (k === "i" || k === "j" || k === "c")) {
//       e.preventDefault();
//       return;
//     }
//     // Cmd+Alt+I (macOS Inspect Element).
//     if (e.metaKey && e.altKey && k === "i") {
//       e.preventDefault();
//     }
//   });
// })();

//
// PokemonFleet is a free companion tool. Pokemon licensing is per-iPhone and
// is managed at https://pokemon.ioscontrol.com — we read the license info
// off each device via /api/device/info and surface it as a badge.

import * as api from "./api.js";
import { $, el, toast, showModal } from "./utils.js";
import { DeviceTable } from "./components/DeviceTable.js";
import { ScriptPicker } from "./components/ScriptPicker.js";
import { openConfigDialog } from "./components/ConfigDialog.js";
import { openDataViewer } from "./components/DataViewer.js";
import { openBootstrapWizard } from "./components/BootstrapWizard.js";
import { openLogModal } from "./components/LogModal.js";
import { openScreenView } from "./components/ScreenView.js";
import { openScreenGridView } from "./components/ScreenGridView.js";

const LOG_BUFFER_PER_DEVICE = 500; // hard cap so memory stays bounded.

const state = {
  devices: [],
  table: null,
  picker: null,
  fastRun: false,                    // true → bypass loader menu
  logBuffer: new Map(), // udid -> string[]
};

// ────────────────────────── Topbar info ──────────────────────────────────

function showHeaderInfo() {
  const badge = $("#license-badge");
  if (!badge) return;
  badge.textContent = "v0.1.0";
  badge.style.color = "var(--text-muted)";
  badge.style.fontSize = "12px";
  badge.style.fontWeight = "600";
}

// ─────────────────────────── Device handling ──────────────────────────────

async function refreshDeviceList({ refetchLicense = false } = {}) {
  state.devices = await api.listDevices().catch((e) => {
    console.error("listDevices failed:", e);
    return [];
  });
  state.table.render(state.devices);
  $("#device-count").textContent = state.devices.length;
  if (refetchLicense) {
    // User pressed refresh — wipe the throttle and re-pull license for every
    // device so a freshly-edited Pokemon_Config.txt shows the right plan
    // immediately.
    maybeFetchPokemonLicense._lastByUdid?.clear();
    for (const d of state.devices) {
      maybeFetchPokemonLicense(d, { force: true });
    }
  }
}

function onDeviceConnected(payload) {
  const d = payload;
  const idx = state.devices.findIndex((x) => x.udid === d.udid);
  if (idx >= 0) state.devices[idx] = d;
  else state.devices.push(d);
  state.table.render(state.devices);
  $("#device-count").textContent = state.devices.length;
  toast(`Connected: ${d.label || d.name}`, "success");
  maybeFetchPokemonLicense(d);
}

function onDeviceDisconnected(udid) {
  state.devices = state.devices.filter((d) => d.udid !== udid);
  state.table.render(state.devices);
  $("#device-count").textContent = state.devices.length;
}

function onDeviceUpdated(payload) {
  const d = payload;
  const idx = state.devices.findIndex((x) => x.udid === d.udid);
  if (idx >= 0) {
    state.devices[idx] = d;
    state.table.render(state.devices);
    maybeFetchPokemonLicense(d);
  }
}

/** Fire-and-forget Pokemon license refresh.
 *  Pass `{force: true}` to bypass the per-device throttle (used by the
 *  Refresh button so updated keys show up instantly).
 */
function maybeFetchPokemonLicense(device, { force = false } = {}) {
  if (!device.online || !device.has_loader) return;
  const last = maybeFetchPokemonLicense._lastByUdid ||= new Map();
  const now = Date.now();
  if (!force) {
    const prev = last.get(device.udid) || 0;
    if (now - prev < 30_000) return; // 30s cooldown per device
  }
  last.set(device.udid, now);
  api.getPokemonLicense(device.udid).catch((e) => {
    console.warn(`pokemon license fetch failed for ${device.udid}:`, e);
  });
}

// ─────────────────────────── Logs ─────────────────────────────────────────

function onLog(payload) {
  const { udid, message } = payload;
  if (!udid || !message) return;
  let buf = state.logBuffer.get(udid);
  if (!buf) { buf = []; state.logBuffer.set(udid, buf); }
  buf.push(message);
  if (buf.length > LOG_BUFFER_PER_DEVICE) {
    buf.splice(0, buf.length - LOG_BUFFER_PER_DEVICE);
  }
  state.table.setLogTail(udid, message.slice(0, 120));
  // Re-broadcast for the LogModal listener.
  window.dispatchEvent(new CustomEvent("pokemonfleet:log", { detail: payload }));
}

// ─────────────────────── Running-status poller ──────────────────────────
//
// Mirrors IOSControl Web IDE's setInterval pattern: every 2s, fetch
// /api/scripts/running directly through each device's iproxy tunnel and
// flip the row's Run/Stop state based on the response. The device is the
// single source of truth — no backend echo loop to fight with.

const RUNNING_POLL_MS = 2000;

async function pollRunningStatus() {
  for (const d of state.devices) {
    if (!d.online || !d.port) continue;
    let running = null;
    try {
      const res = await fetch(`http://localhost:${d.port}/api/scripts/running`,
        { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.running) {
        running = data.scriptName || "(running)";
      }
    } catch {
      // Device unreachable on this tick — keep previous state.
      continue;
    }
    if (d.running_script !== running) {
      d.running_script = running;
      state.table.render(state.devices);
    }
  }
}

function startRunningPoller() {
  pollRunningStatus().catch(() => {});
  setInterval(() => pollRunningStatus().catch(() => {}), RUNNING_POLL_MS);
}

/** Optimistic flip when the user clicks Run/Stop. Poller confirms within 2s. */
function setLocalRunning(udid, running) {
  const d = state.devices.find((x) => x.udid === udid);
  if (!d) return;
  d.running_script = running;
  state.table.render(state.devices);
}

// ─────────────────────────── Actions ──────────────────────────────────────

async function handleAction(kind, device) {
  switch (kind) {
    case "run": {
      const scriptId = state.picker.selectedScriptId();
      if (!scriptId) {
        toast("Please choose a script first.", "error");
        return;
      }
      const label = state.picker.selectedLabel?.() || scriptId;
      // Optimistic flip — poller confirms or corrects within 2s.
      setLocalRunning(device.udid, label);
      try {
        if (state.fastRun) {
          const results = await api.fastRun([device.udid], scriptId, label);
          const r = results[0];
          if (!r || !r.success) {
            setLocalRunning(device.udid, null);
            toast((r && r.message) || "Fast run failed", "error", 6000);
          } else {
            toast(`\u26a1 ${label} started`, "success");
          }
        } else {
          await api.runSingle(device.udid, state.picker.filenameFor(scriptId));
          toast(`Started on ${device.label || device.name}`, "success");
        }
      } catch (e) {
        setLocalRunning(device.udid, null);
        toast("Run failed: " + e, "error");
      }
      break;
    }
    case "stop": {
      setLocalRunning(device.udid, null);
      try {
        await api.stopSingle(device.udid);
        toast(`Stopped ${device.label || device.name}`, "info");
      } catch (e) {
        toast("Stop failed: " + e, "error");
      }
      break;
    }
    case "config": {
      const selected = state.table.selectedDevices();
      openConfigDialog(device, selected.length > 1 ? selected : []);
      break;
    }
    case "data":  openDataViewer(device); break;
    case "log":   openLogModal(device, state.logBuffer); break;
    case "setup": openBootstrapWizard(device); break;
    case "info":  openInfoDialog(device); break;
    case "ide": {
      openScreenView(device);
      break;
    }
  }
}

async function runFleet() {
  const targets = state.table.selectedDevices();
  if (targets.length === 0) {
    toast("Select one or more devices first.", "error");
    return;
  }
  const scriptId = state.picker.selectedScriptId();
  if (!scriptId) {
    toast("Choose a script in the picker.", "error");
    return;
  }
  const label = state.picker.selectedLabel?.() || scriptId;
  // Optimistic flip for everyone targeted.
  for (const t of targets) setLocalRunning(t.udid, label);
  try {
    let results;
    if (state.fastRun) {
      results = await api.fastRun(targets.map((d) => d.udid), scriptId, label);
    } else {
      results = await api.runFleet(
        targets.map((d) => d.udid),
        state.picker.filenameFor(scriptId),
      );
    }
    // Roll back optimistic flip for any that failed and explain why.
    for (const r of results) {
      if (!r.success) {
        setLocalRunning(r.udid, null);
        const dev = state.devices.find((d) => d.udid === r.udid);
        const tag = dev ? (dev.label || dev.name) : r.udid;
        toast(`${tag}: ${r.message || "failed"}`, "error", 5000);
      }
    }
    const ok = results.filter((r) => r.success).length;
    const fail = results.length - ok;
    toast(`Started ${ok}/${results.length}${fail ? ` (${fail} failed)` : ""}`,
      fail ? "error" : "success");
  } catch (e) {
    for (const t of targets) setLocalRunning(t.udid, null);
    toast("Fleet run failed: " + e, "error");
  }
}

async function stopFleet() {
  const targets = state.table.selectedDevices();
  if (targets.length === 0) {
    toast("Select devices to stop.", "error");
    return;
  }
  for (const t of targets) setLocalRunning(t.udid, null);
  try {
    const results = await api.stopFleet(targets.map((d) => d.udid));
    const ok = results.filter((r) => r.success).length;
    toast(`Stopped ${ok}/${results.length}`,
      ok === results.length ? "info" : "error");
  } catch (e) {
    toast("Fleet stop failed: " + e, "error");
  }
}

// ────────────────────────── Quick guide modal ───────────────────────────

// ────────────────────── Device info modal ──────────────────────────────

function openInfoDialog(device) {
  const rows = [
    ["Tên",          device.label || device.name || "—"],
    ["Model",        device.product_type || "—"],
    ["iOS",          device.ios_version || "—"],
    ["UDID",         device.udid],
    ["Tunnel port",  String(device.port || "—")],
    ["Loader",       device.has_loader ? "✅ đã cài" : "❌ chưa cài"],
    ["Online",       device.online ? "🟢 Online" : "🔴 Offline"],
    ["Running",      device.running_script || "—"],
  ];

  const table = el("table", { class: "info-table" });
  for (const [k, v] of rows) {
    const valCell = el("td", {}, []);
    if (k === "UDID") {
      const code = el("code", {
        style: "font-family:var(--font-mono);font-size:12.5px;word-break:break-all;",
      }, [v]);
      const btn = el("button", {
        class: "btn btn-pikachu btn-sm",
        style: "margin-left:8px;",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(v);
            toast("📋 UDID copied", "success", 1500);
          } catch (e) {
            toast("Copy failed: " + e, "error");
          }
        },
      }, ["📋 Copy"]);
      valCell.appendChild(code);
      valCell.appendChild(btn);
    } else {
      valCell.textContent = v;
    }
    table.appendChild(el("tr", {}, [
      el("th", {}, [k]),
      valCell,
    ]));
  }

  const modal = showModal({
    title: "ℹ Thông tin thiết bị",
    body: el("div", {}, [table]),
    width: "600px",
    footer: [
      el("button", { class: "btn btn-primary", onclick: () => modal.close() }, ["Đóng"]),
    ],
  });
}

// ────────────────────── Quick guide modal ───────────────────────────────

function showQuickGuide() {
  const body = el("div", { style: "line-height:1.7;font-size:14px;" }, [
    el("h3", { style: "margin:0 0 12px;font-family:var(--font-display);color:var(--text-strong);" },
      ["\ud83d\udcd6 H\u01b0\u1edbng d\u1eabn k\u1ebft n\u1ed1i iPhone"]),
    el("ol", { style: "padding-left:20px;margin:0;" }, [
      el("li", {}, ["C\u1eafm iPhone v\u00e0o m\u00e1y qua c\u00e1p USB."]),
      el("li", {}, ["Tr\u00ean iPhone, ch\u1ecdn ", el("b", {}, ["Trust"]), " khi h\u1ed9p tho\u1ea1i hi\u1ec7n l\u00ean."]),
      el("li", {}, ["M\u00e1y s\u1ebd t\u1ef1 hi\u1ec7n trong b\u1ea3ng. N\u1ebfu ch\u01b0a c\u00f3 tool, b\u1ea5m ", el("b", {}, ["Setup"]),
        " \u0111\u1ec3 c\u00e0i Pokemon Tools."]),
      el("li", {}, ["Sau khi Setup xong, m\u1edf nh\u00f3m ", el("b", {}, ["Config"]),
        " \u0111\u1ec3 \u0111i\u1ec1n ", el("code", {}, ["LICENSE_KEY"]), " v\u00e0 ",
        el("code", {}, ["MAIL_SERVER"]), "."]),
      el("li", {}, ["Ch\u1ecdn script \u1edf thanh tr\u00ean c\u00f9ng \u2192 b\u1ea5m ", el("b", {}, ["Run"]), " tr\u00ean t\u1eebng m\u00e1y, ho\u1eb7c ",
        el("b", {}, ["Run selected"]), " \u0111\u1ec3 ch\u1ea1y h\u00e0ng lo\u1ea1t."]),
    ]),
    el("hr", { style: "margin:18px 0;border:0;border-top:2px dashed var(--border);" }),
    el("p", { class: "muted", style: "margin:0;" },
      ["M\u1ecdi license/script \u0111\u01b0\u1ee3c qu\u1ea3n l\u00fd t\u1eeb b\u00ean ngo\u00e0i, app n\u00e0y ch\u1ec9 l\u00e0 c\u00f4ng c\u1ee5 \u0111i\u1ec1u khi\u1ec3n."]),
  ]);

  const m = showModal({
    title: "\ud83d\udccb H\u01b0\u1edbng d\u1eabn nhanh",
    body,
    width: "560px",
    footer: [
      el("button", { class: "btn btn-primary", onclick: () => m.close() }, ["\u0110\u00e3 hi\u1ec3u"]),
    ],
  });
}

// ─────────────────────────── Boot ─────────────────────────────────────────

async function boot() {
  // Skip the license gate — reveal main app immediately.
  $("#license-gate")?.remove();
  $("#main")?.classList.remove("hidden");
  showHeaderInfo();

  state.table = new DeviceTable({
    tbody: $("#device-tbody"),
    onSelectionChange: (sel) => {
      $("#selection-summary").textContent =
        `${sel.length} selected${sel.length > 0 ? ` (${sel.filter((d) => d.online).length} online)` : ""}`;
    },
    onAction: handleAction,
  });

  state.picker = new ScriptPicker($("#script-picker"));
  await state.picker.loadFromWorker();

  // Buttons.
  $("#run-all-btn").addEventListener("click", runFleet);
  $("#stop-all-btn").addEventListener("click", stopFleet);
  $("#refresh-btn").addEventListener("click", async () => {
    refreshDeviceList({ refetchLicense: true });
    await state.picker.refresh().catch(() => {});
    toast("\ud83d\udd04 Refreshing devices, licenses and scripts...", "info", 1500);
  });
  const fastToggle = $("#fast-run-toggle");
  if (fastToggle) {
    fastToggle.addEventListener("change", async (e) => {
      state.fastRun = e.target.checked;
      await state.picker.setMode(state.fastRun ? "fast" : "loader");
    });
  }
  $("#select-all").addEventListener("change", (e) => {
    if (e.target.checked) state.table.selectAllOnline();
    else state.table.deselectAll();
  });
  $("#view-all-screens-btn").addEventListener("click", () => {
    const selected = state.table.selectedDevices();
    if (selected.length === 0) {
      toast("Chọn ít nhất 1 thiết bị trước.", "error");
      return;
    }
    openScreenGridView(selected);
  });
  $("#bootstrap-help-btn").addEventListener("click", () => {
    showQuickGuide();
  });

  // Custom window controls (frameless window).
  const tauriWin = window.__TAURI__?.window?.getCurrentWindow?.();
  if (tauriWin) {
    $("#win-min")?.addEventListener("click", () => tauriWin.minimize());
    $("#win-max")?.addEventListener("click", () => tauriWin.toggleMaximize());
    $("#win-close")?.addEventListener("click", () => tauriWin.close());
  }

  // Subscribe to backend events.
  await api.on("device-connected",     (e) => onDeviceConnected(e.payload));
  await api.on("device-disconnected",  (e) => onDeviceDisconnected(e.payload));
  await api.on("device-updated",       (e) => onDeviceUpdated(e.payload));
  await api.on("log",                  (e) => onLog(e.payload));

  await refreshDeviceList();
  // Kick off Pokemon license lookups for any device that's already there.
  for (const d of state.devices) maybeFetchPokemonLicense(d);
  // Start the IDE-style 2s poller for running script status.
  startRunningPoller();
  $("#status-text").textContent = "Watching USB ports for iPhones...";
}

boot().catch((e) => {
  console.error("boot failed:", e);
  toast("Failed to start: " + e, "error", 8000);
});
