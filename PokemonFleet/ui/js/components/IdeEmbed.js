// Embedded IDE / VNC viewer — opens the on-device IDE in an iframe modal.
//
// IOSControl serves both the Web IDE (localhost:<port>/ide) and the noVNC
// canvas (localhost:<vnc_html>/novnc/vnc.html) — we let the user pick either,
// and just embed the URL in a near-fullscreen modal so they don't have to
// leave the app.

import * as api from "../api.js";
import { el, showModal, toast } from "../utils.js";

export async function openIdeEmbed(device, mode /* "ide" | "vnc" */ = "ide") {
  if (!device.online || !device.port) {
    toast("Thiết bị offline.", "error");
    return;
  }

  const port = device.port;
  const slot = port - 9990; // matches the slot allocator in tunnel.rs.
  const vncHtmlPort = 5902 + slot * 10;
  const vncWsPort   = 15900 + slot * 10;

  const ideUrl = `http://localhost:${port}/ide`;
  const vncUrl = `http://localhost:${vncHtmlPort}/novnc/vnc.html` +
    `?autoconnect=true&host=localhost&port=${vncWsPort}` +
    `&encrypt=0&resize=scale&view_only=false&show_dot=false` +
    `&reconnect=true&reconnect_delay=3000`;

  const iframe = el("iframe", {
    src: mode === "vnc" ? vncUrl : ideUrl,
    style: "width:100%;height:100%;border:0;display:block;background:#000;",
    allow: "clipboard-read; clipboard-write",
  });

  const wrap = el("div", {
    style: "width:100%;height:80vh;background:#000;border-radius:var(--radius-md);overflow:hidden;border:2px solid var(--border-strong);",
  }, [iframe]);

  const modeBtn = (label, kind) => el("button", {
    class: `btn ${mode === kind ? "btn-primary" : "btn-ghost"}`,
    onclick: () => {
      iframe.src = kind === "vnc" ? vncUrl : ideUrl;
      mode = kind;
      ideBtn.classList.toggle("btn-primary", kind === "ide");
      ideBtn.classList.toggle("btn-ghost",   kind !== "ide");
      vncBtn.classList.toggle("btn-primary", kind === "vnc");
      vncBtn.classList.toggle("btn-ghost",   kind !== "vnc");
    },
  }, [label]);
  const ideBtn = modeBtn("💻 IDE", "ide");
  const vncBtn = modeBtn("📺 Screen only", "vnc");

  const openExt = el("button", {
    class: "btn btn-ghost",
    onclick: () => api.openExternalUrl(mode === "vnc" ? vncUrl : ideUrl),
  }, ["🔗 Open in browser"]);

  const modal = showModal({
    title: `💻 ${device.label || device.name}`,
    body: wrap,
    width: "min(1280px, 96vw)",
    footer: [
      ideBtn,
      vncBtn,
      el("span", { class: "spacer", style: "flex:1;" }),
      openExt,
      el("button", { class: "btn btn-primary", onclick: () => modal.close() }, ["Đóng"]),
    ],
  });
}
