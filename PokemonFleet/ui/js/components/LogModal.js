// Full-screen log viewer for a single device.

import { el, showModal } from "../utils.js";

export function openLogModal(device, logBuffer) {
  const lines = logBuffer.get(device.udid) || [];
  const pre = el("pre", { class: "log-pre" + (lines.length === 0 ? " empty" : "") });
  pre.textContent = lines.length === 0
    ? "Đang chờ log... Bấm ▶ Run để chạy script."
    : lines.join("\n");

  const clearBtn = el("button", {
    class: "btn btn-ghost",
    onclick: () => {
      lines.length = 0;
      pre.textContent = "(cleared)";
      pre.classList.add("empty");
    },
  }, ["🗑 Clear"]);

  const modal = showModal({
    title: `📜 Log — ${device.label || device.name}`,
    body: pre,
    width: "960px",
    footer: [
      clearBtn,
      el("button", { class: "btn btn-primary", onclick: () => modal.close() }, ["Close"]),
    ],
  });

  // Live append while modal is open.
  const handler = (e) => {
    if (e.detail.udid !== device.udid) return;
    if (pre.classList.contains("empty")) {
      pre.textContent = "";
      pre.classList.remove("empty");
    }
    pre.textContent += (pre.textContent.endsWith("\n") ? "" : "\n") + e.detail.message;
    pre.scrollTop = pre.scrollHeight;
  };
  window.addEventListener("pokemonfleet:log", handler);

  // Cleanup when modal closes.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(pre)) {
      window.removeEventListener("pokemonfleet:log", handler);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
