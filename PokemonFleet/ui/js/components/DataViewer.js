// Data viewer — click a *.txt file to open a full-text editor popup.

import * as api from "../api.js";
import { el, showModal, toast } from "../utils.js";

export async function openDataViewer(device) {
  let listing;
  try {
    listing = await api.listFiles(device.udid);
  } catch (e) {
    toast("Failed to list files: " + e, "error");
    return;
  }

  // /api/scripts/files response shape can be {files} | {scripts} | array.
  const allFiles = listing?.files || listing?.scripts || listing || [];
  const txtFiles = allFiles
    .map((f) => typeof f === "string" ? { name: f } : f)
    .filter((f) => /\.txt$/i.test(f.name || ""));

  if (txtFiles.length === 0) {
    toast("No *.txt files on this device.", "info");
    return;
  }

  const list = el("div", { class: "dv-file-list" });
  for (const f of txtFiles) {
    const item = el("div", { class: "dv-file-item" }, [
      el("span", { class: "fname" }, [`📄 ${f.name}`]),
      el("span", { class: "fsize" }, [f.size != null ? formatBytes(f.size) : ""]),
    ]);
    item.addEventListener("click", () => {
      pickerModal.close();
      openFileEditor(device, f.name);
    });
    list.appendChild(item);
  }

  const pickerModal = showModal({
    title: `📂 Files — ${device.label || device.name}`,
    body: list,
    footer: [
      el("button", { class: "btn btn-ghost", onclick: () => pickerModal.close() }, ["Close"]),
    ],
    width: "560px",
  });
}

async function openFileEditor(device, filename) {
  let content;
  try {
    content = await api.readFile(device.udid, filename);
  } catch (e) {
    toast("Read failed: " + e, "error");
    return;
  }

  const initialText = content;

  // Stats helper.
  const computeStats = (text) => {
    const lines = text.split(/\r?\n/);
    const lastEmpty = lines.length > 0 && lines[lines.length - 1] === "";
    return {
      lineCount: lastEmpty ? lines.length - 1 : lines.length,
      bytes: new TextEncoder().encode(text).length,
    };
  };

  const summary = el("p", { class: "dv-summary" }, [""]);
  const updateSummary = (text) => {
    const s = computeStats(text);
    summary.textContent = `📏 ${s.lineCount} lines · ${formatBytes(s.bytes)}`;
  };
  updateSummary(initialText);

  const textarea = el("textarea", {
    class: "dv-editor",
    spellcheck: "false",
    style: "width:100%;height:60vh;border:2px solid var(--border);border-radius:var(--radius-md);padding:12px 14px;font-family:var(--font-mono);font-size:13px;line-height:1.55;background:#fff;color:var(--text-strong);resize:vertical;outline:none;",
  });
  textarea.value = initialText;
  textarea.addEventListener("input", () => updateSummary(textarea.value));
  // Indent with TAB (don't move focus).
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, start) + "  " + textarea.value.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
    }
  });

  const body = el("div", {}, [summary, textarea]);

  const modal = showModal({
    title: `📝 ${filename} — ${device.label || device.name}`,
    body,
    width: "1080px",
    footer: [
      el("button", {
        class: "btn btn-ghost",
        onclick: () => {
          if (textarea.value !== initialText &&
              !confirm("Bạn có thay đổi chưa lưu. Đóng luôn?")) return;
          modal.close();
        },
      }, ["Cancel"]),
      el("button", {
        class: "btn btn-warning",
        onclick: () => {
          textarea.value = initialText;
          updateSummary(initialText);
          toast("Reverted to last loaded content.", "info");
        },
      }, ["↺ Revert"]),
      el("button", {
        class: "btn btn-success",
        onclick: async () => {
          try {
            await api.writeFile(device.udid, filename, textarea.value);
            modal.close();
            toast(`💾 Saved ${filename}`, "success");
          } catch (e) {
            toast("Save failed: " + e, "error");
          }
        },
      }, ["💾 Save to device"]),
    ],
  });

  // Focus the editor right away so users can type immediately.
  setTimeout(() => textarea.focus(), 80);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
