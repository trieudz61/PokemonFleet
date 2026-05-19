// Tauri command + event wrappers.
//
// Tauri 2 exposes commands via `window.__TAURI__.core.invoke` and events via
// `window.__TAURI__.event.listen`. We wrap them so the rest of the UI never
// touches Tauri internals directly — easier to mock/test.

const T = window.__TAURI__;
if (!T) {
  // Allow running the UI in a normal browser for layout work.
  console.warn("Running outside Tauri — backend calls will fail.");
}

const invoke = T?.core?.invoke || (async () => {
  throw new Error("Tauri not available");
});

const listen = T?.event?.listen || (async () => () => {});

// ─── Device commands ─────────────────────────────────────────────────────

export const listDevices       = ()                           => invoke("list_devices");
export const refreshDevices    = ()                           => invoke("refresh_devices");
export const getDeviceDetail   = (udid)                       => invoke("get_device_detail", { udid });
export const setDeviceLabel    = (udid, label)                => invoke("set_device_label", { udid, label });

// ─── Fleet commands ───────────────────────────────────────────────────────

export const runFleet  = (udids, scriptName) => invoke("run_fleet",  { udids, scriptName });
export const stopFleet = (udids)             => invoke("stop_fleet", { udids });
export const runSingle  = (udid, scriptName) => invoke("run_single",  { udid, scriptName });
export const stopSingle = (udid)             => invoke("stop_single", { udid });
export const fastRun    = (udids, scriptId, scriptLabel) =>
  invoke("fast_run", { udids, scriptId, scriptLabel });

// ─── Files & config ───────────────────────────────────────────────────────

export const listFiles   = (udid)                 => invoke("list_files",   { udid });
export const readFile    = (udid, name)           => invoke("read_file",    { udid, name });
export const writeFile   = (udid, name, content)  => invoke("write_file",   { udid, name, content });
export const deleteFile  = (udid, name)           => invoke("delete_file",  { udid, name });
export const readConfig  = (udid)                 => invoke("read_config",  { udid });
export const writeConfig = (udid, config)         => invoke("write_config", { udid, config });

// ─── Bootstrap ────────────────────────────────────────────────────────────

export const installPokemonLoader = (udid, seedConfigTemplate = true) =>
  invoke("install_pokemon_loader", { udid, seedConfigTemplate });

// ─── License ──────────────────────────────────────────────────────────────

export const verifyFleetLicense = (key)   => invoke("verify_fleet_license", { key });
export const getMachineId       = ()      => invoke("get_machine_id");
export const getCachedLicense   = ()      => invoke("get_cached_license");

// ─── Misc ───────────────────────────────────────────────────────────────────────

export const getIdeUrl         = (udid) => invoke("get_ide_url",         { udid });
export const openExternalUrl   = (url)  => invoke("open_external_url",   { url });
export const getPokemonLicense = (udid) => invoke("get_pokemon_license", { udid });

// ─── Events ───────────────────────────────────────────────────────────────

export const on = listen;
