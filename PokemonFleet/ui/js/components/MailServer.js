// Mail Server UI — fullscreen modal for configuring + controlling the embedded mail server.

import { el, showModal, toast } from "../utils.js";

const invoke = window.__TAURI__?.core?.invoke;

export async function openMailServer() {
  // Load existing config
  let config = null;
  try {
    config = await invoke("mail_server_load_config");
  } catch (e) {
    console.warn("[MailServer] load config:", e);
  }

  if (!config) {
    config = {
      imap_host: "imap.mail.me.com",
      imap_port: 993,
      imap_user: "",
      imap_pass: "",
      max_emails: 500,
      server_port: 5000,
      ngrok_token: null,
      ngrok_domain: "",
    };
  }

  // Get initial status
  let status = null;
  try {
    status = await invoke("mail_server_status");
  } catch {}

  const isRunning = status?.running || false;

  // Build modal body
  const body = el("div", { class: "mail-server-form" }, [
    el("div", { class: "ms-status-bar", id: "ms-status" }, [
      el("span", { class: `ms-dot ${isRunning ? "ms-dot-on" : ""}`, id: "ms-dot" }),
      el("span", { id: "ms-status-text" }, [isRunning ? `✅ Running — ${status.total_emails_cached} emails cached` : "⏹ Stopped"]),
    ]),

    el("h4", {}, ["🔐 iCloud IMAP"]),
    el("div", { class: "form-row" }, [
      el("label", {}, ["Email"]),
      el("input", { type: "email", id: "ms-email", value: config.imap_user, placeholder: "your@icloud.com" }),
    ]),
    el("div", { class: "form-row" }, [
      el("label", {}, ["App Password"]),
      el("input", { type: "password", id: "ms-pass", value: config.imap_pass, placeholder: "xxxx-xxxx-xxxx-xxxx" }),
    ]),
    el("p", { class: "ms-hint" }, [
      "👉 Vào ",
      el("a", { href: "#", class: "ms-link", "data-url": "https://appleid.apple.com/account/manage/section/security" }, ["appleid.apple.com"]),
      " → Sign-In and Security → App-Specific Passwords → Tạo mới"
    ]),

    el("h4", {}, ["🌐 Ngrok (Public URL)"]),
    el("div", { class: "form-row" }, [
      el("label", {}, ["Domain"]),
      el("input", { type: "text", id: "ms-ngrok-domain", value: config.ngrok_domain || "", placeholder: "your-domain.ngrok-free.dev" }),
    ]),
    el("div", { class: "form-row" }, [
      el("label", {}, ["Auth Token"]),
      el("input", { type: "password", id: "ms-ngrok-token", value: config.ngrok_token || "", placeholder: "Ngrok authtoken" }),
    ]),
    el("p", { class: "ms-hint" }, [
      "👉 Đăng ký tại ",
      el("a", { href: "#", class: "ms-link", "data-url": "https://dashboard.ngrok.com/get-started/your-authtoken" }, ["ngrok.com"]),
      " → Copy Auth Token. Vào ",
      el("a", { href: "#", class: "ms-link", "data-url": "https://dashboard.ngrok.com/domains" }, ["Domains"]),
      " → New Domain → Copy domain"
    ]),

    el("h4", {}, ["⚙️ Server"]),
    el("div", { class: "form-row" }, [
      el("label", {}, ["Port"]),
      el("input", { type: "number", id: "ms-port", value: config.server_port, style: "width:100px" }),
    ]),
    el("div", { class: "form-row" }, [
      el("label", {}, ["Max Emails"]),
      el("input", { type: "number", id: "ms-max", value: config.max_emails, style: "width:100px" }),
    ]),
    el("p", { class: "ms-hint" }, [
      "💡 Port mặc định 5000. Max Emails = số email giữ trong bộ nhớ (mới nhất)."
    ]),
  ]);

  const saveBtn = el("button", { class: "btn btn-primary" }, ["💾 Save"]);
  const startBtn = el("button", { class: "btn btn-success" }, [isRunning ? "🔄 Restart" : "▶ Start"]);
  const stopBtn = el("button", { class: "btn btn-danger", style: isRunning ? "" : "display:none" }, ["■ Stop"]);

  const modal = showModal({
    title: "📧 Mail Server",
    body,
    footer: [saveBtn, startBtn, stopBtn],
    width: "520px",
  });

  // Open links in external browser
  body.querySelectorAll(".ms-link").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const url = link.dataset.url;
      if (url && invoke) invoke("open_external_url", { url });
    });
  });

  // Helpers
  function getFormConfig() {
    return {
      imap_host: "imap.mail.me.com",
      imap_port: 993,
      imap_user: document.getElementById("ms-email").value.trim(),
      imap_pass: document.getElementById("ms-pass").value.trim(),
      max_emails: parseInt(document.getElementById("ms-max").value) || 500,
      server_port: parseInt(document.getElementById("ms-port").value) || 5000,
      ngrok_token: document.getElementById("ms-ngrok-token").value.trim() || null,
      ngrok_domain: document.getElementById("ms-ngrok-domain").value.trim() || null,
    };
  }

  function updateStatus(running, text) {
    const dot = document.getElementById("ms-dot");
    const statusText = document.getElementById("ms-status-text");
    if (dot) dot.className = `ms-dot ${running ? "ms-dot-on" : ""}`;
    if (statusText) statusText.textContent = text;
    startBtn.textContent = running ? "🔄 Restart" : "▶ Start";
    stopBtn.style.display = running ? "" : "none";
  }

  // Save
  saveBtn.onclick = async () => {
    const cfg = getFormConfig();
    if (!cfg.imap_user || !cfg.imap_pass) {
      toast("Điền email và password", "error");
      return;
    }
    try {
      await invoke("mail_server_save_config", { config: cfg });
      toast("💾 Config saved!", "success");
    } catch (e) {
      toast("Lỗi save: " + e, "error");
    }
  };

  // Start
  startBtn.onclick = async () => {
    const cfg = getFormConfig();
    if (!cfg.imap_user || !cfg.imap_pass) {
      toast("Điền email và password trước", "error");
      return;
    }
    try {
      // Save first
      await invoke("mail_server_save_config", { config: cfg });
      // Stop if running
      try { await invoke("mail_server_stop"); } catch {}
      // Start
      let url = await invoke("mail_server_start");
      if (url.startsWith("started_with_ngrok_error:")) {
        const error = url.replace("started_with_ngrok_error:", "");
        updateStatus(true, `⚠️ Running (Local) — Ngrok error: ${error.substring(0, 30)}...`);
        toast("⚠️ Mail server started but tunnel failed. Using Local URL.", "warning");
        console.error("[MailServer] Ngrok error:", error);
      } else {
        updateStatus(true, `✅ Running — ${url}`);
        toast("▶ Mail server started: " + url, "success");
      }
    } catch (e) {
      updateStatus(false, "❌ Error: " + e);
      toast("Lỗi start: " + e, "error");
    }
  };

  // Stop
  stopBtn.onclick = async () => {
    try {
      await invoke("mail_server_stop");
      updateStatus(false, "⏹ Stopped");
      toast("■ Mail server stopped", "info");
    } catch (e) {
      toast("Lỗi stop: " + e, "error");
    }
  };

  // Poll status every 5s
  const pollInterval = setInterval(async () => {
    if (!document.getElementById("ms-dot")) {
      clearInterval(pollInterval);
      return;
    }
    try {
      const s = await invoke("mail_server_status");
      if (s.running) {
        updateStatus(true, `✅ Connected — ${s.total_emails_cached} emails cached`);
      }
    } catch {}
  }, 5000);
}
