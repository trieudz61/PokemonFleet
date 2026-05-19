// Multi-device screen grid viewer — opens in a separate Tauri window.
//
// Stores selected devices in localStorage, then spawns a new WebviewWindow
// pointing at screen-grid.html which reads them back and renders the grid.

import { toast } from "../utils.js";

export async function openScreenGridView(devices) {
  const online = (devices || []).filter((d) => d.online && d.port);
  if (online.length === 0) {
    toast("Không có thiết bị online nào.", "error");
    return;
  }

  // Sort: stable order — by label/name then UDID.
  online.sort((a, b) => {
    const an = (a.label || a.name || "").toLowerCase();
    const bn = (b.label || b.name || "").toLowerCase();
    if (an !== bn) return an.localeCompare(bn);
    return (a.udid || "").localeCompare(b.udid || "");
  });

  // Pass devices via localStorage (simplest cross-window data passing).
  localStorage.setItem("__pkm_grid_devices", JSON.stringify(online));

  const T = window.__TAURI__;

  // Tauri 2 with withGlobalTauri exposes WebviewWindow at
  // window.__TAURI__.webviewWindow.WebviewWindow (from @tauri-apps/api)
  // Try all known paths.
  const WW =
    T?.webviewWindow?.WebviewWindow ||
    T?.window?.WebviewWindow ||
    T?.WebviewWindow;

  if (WW) {
    try {
      // Close existing if open.
      const existing = WW.getByLabel?.("screen-grid");
      if (existing) {
        await existing.close().catch(() => {});
        // Small delay to let it fully close.
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch {}

    try {
      const w = new WW("screen-grid", {
        url: "screen-grid.html",
        title: "POKEIOSControl — Screen Grid",
        width: 1200,
        height: 700,
        minWidth: 600,
        minHeight: 400,
        decorations: false,
        resizable: true,
        center: true,
      });
      console.log("[ScreenGrid] WebviewWindow created:", w);
      return;
    } catch (e) {
      console.error("[ScreenGrid] WebviewWindow constructor failed:", e);
    }
  }

  // Fallback: try invoke plugin:webview|create_webview_window
  if (T?.core?.invoke) {
    try {
      await T.core.invoke("plugin:webview|create_webview_window", {
        options: {
          label: "screen-grid",
          url: "screen-grid.html",
          title: "POKEIOSControl — Screen Grid",
          width: 1200.0,
          height: 700.0,
          minWidth: 600.0,
          minHeight: 400.0,
          decorations: false,
          resizable: true,
          center: true,
        },
      });
      console.log("[ScreenGrid] Created via invoke fallback");
      return;
    } catch (e) {
      console.error("[ScreenGrid] invoke fallback failed:", e);
    }
  }

  // Last resort: log what's available
  console.error("[ScreenGrid] Available __TAURI__ keys:", Object.keys(T || {}));
  console.error("[ScreenGrid] __TAURI__.window keys:", Object.keys(T?.window || {}));
  console.error("[ScreenGrid] __TAURI__.webviewWindow keys:", Object.keys(T?.webviewWindow || {}));
  toast("Không thể mở cửa sổ grid. Xem Console (F12) để debug.", "error");
}
