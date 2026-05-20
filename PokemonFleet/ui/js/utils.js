// Minimal helpers: DOM, formatters, toasts.

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) node.setAttribute(k, "");
    else if (v === false || v == null) {/* skip */}
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function escape(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function fmtRelTime(unix) {
  if (!unix) return "—";
  const dt = Date.now() - unix * 1000;
  if (dt < 5_000) return "just now";
  if (dt < 60_000) return Math.floor(dt / 1000) + "s ago";
  if (dt < 3_600_000) return Math.floor(dt / 60_000) + "m ago";
  return Math.floor(dt / 3_600_000) + "h ago";
}

export function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } finally { ta.remove(); }
  return Promise.resolve();
}

// ─── Toast ─────────────────────────────────────────────────────────────────

let toastStack;
function ensureToastStack() {
  if (!toastStack) {
    toastStack = el("div", { class: "toast-stack" });
    document.body.appendChild(toastStack);
  }
  return toastStack;
}

export function toast(message, type = "info", durationMs = 3000) {
  const stack = ensureToastStack();
  const t = el("div", { class: `toast ${type}` }, [message]);
  stack.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transform = "translateX(20px)";
    setTimeout(() => t.remove(), 220);
  }, durationMs);
}

// ─── Modal ─────────────────────────────────────────────────────────────────

export function showModal({ title, body, footer, width, className, onClose }) {
  const root = $("#modal-root");
  const back = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: `modal${className ? ` ${className}` : ""}` });
  if (width) modal.style.width = `min(${width}, 92vw)`;
  const header = el("div", { class: "modal-header" }, [
    el("h2", {}, [title]),
    el("button", {
      class: "btn-icon", title: "Close",
      onclick: () => close(),
    }, ["✕"]),
  ]);
  const bodyEl = el("div", { class: "modal-body" });
  if (typeof body === "string") bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);
  const footerEl = el("div", { class: "modal-footer" });
  if (footer) footerEl.append(...[].concat(footer));
  modal.append(header, bodyEl, footerEl);
  back.append(modal);
  root.append(back);

  async function close() {
    if (onClose) await onClose();
    back.remove();
  }

  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });

  return { close, body: bodyEl };
}
