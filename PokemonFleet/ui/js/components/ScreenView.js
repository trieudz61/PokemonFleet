// Pokemon-themed device screen viewer.
//
// Click "View Screen" on a row → fullscreen Pokeball-bordered modal embeds
// the device's noVNC canvas so you can watch + control the iPhone in real
// time. The footer has an "Open IDE" button that boots the system browser
// onto the on-device Web IDE.

import * as api from "../api.js";
import { el, showModal, toast } from "../utils.js";

export function openScreenView(device) {
  if (!device.online || !device.port) {
    toast("Thiết bị offline.", "error");
    return;
  }

  // Tunnel layout (mirrors src/device/tunnel.rs):
  //   IDE port      = 9990 + slot
  //   VNC HTML port = 5902 + slot * 10
  //   VNC WS port   = 15900 + slot * 10
  const slot = device.port - 9990;
  const vncHtmlPort = 5902 + slot * 10;
  const vncWsPort   = 15900 + slot * 10;
  const ideUrl = `http://localhost:${device.port}/ide`;
  const vncUrl =
    `http://localhost:${vncHtmlPort}/novnc/vnc.html` +
    `?autoconnect=true&host=localhost&port=${vncWsPort}` +
    `&encrypt=0&resize=scale&view_only=false&show_dot=false` +
    `&reconnect=true&reconnect_delay=2500&quality=6&compression=2`;

  const screen = el("iframe", {
    src: vncUrl,
    style: "width:100%;height:100%;border:0;display:block;background:#000;",
    allow: "clipboard-read; clipboard-write",
  });

  const screenWrap = el("div", { class: "pkm-screen-wrap" }, [
    el("div", { class: "pkm-screen-inner" }, [screen]),
  ]);

  const modal = showModal({
    title: `📺 ${device.label || device.name}`,
    body: screenWrap,
    width: "min(420px, 92vw)",
    className: "pkm-screen-modal",
    footer: [
      el("button", {
        class: "btn btn-pikachu",
        onclick: () => api.openExternalUrl(ideUrl),
      }, ["💻 Open IDE"]),
      el("button", {
        class: "btn btn-ghost",
        onclick: () => screen.contentWindow?.location.reload(),
      }, ["↻ Reconnect"]),
      el("span", { class: "spacer", style: "flex:1;" }),
      el("button", {
        class: "btn btn-primary",
        onclick: () => modal.close(),
      }, ["Đóng"]),
    ],
  });
}
