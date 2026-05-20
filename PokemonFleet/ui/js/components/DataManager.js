// Data Manager — per-script file viewer/editor.
//
// Fetches the data registry from the worker, then for each file:
//   - Pull content from iPhone via /api/scripts/download?name=<file>
//   - Push content back via /api/scripts/save (editable files only)
//
// UI: modal with tab buttons (1 per file), textarea, action buttons.

import { el, showModal, toast } from "../utils.js";
import * as api from "../api.js";

const REGISTRY_URL = "https://pokemon.ioscontrol.com/api/scripts/data-registry";

let registryCache = null;

async function fetchRegistry() {
  if (registryCache) return registryCache;
  try {
    const res = await fetch(REGISTRY_URL, { cache: "no-store" });
    const data = await res.json();
    if (data.ok) registryCache = data.registry;
  } catch (e) {
    console.warn("Failed to fetch data registry:", e);
  }
  return registryCache || {};
}

export async function openDataManager(device) {
  if (!device.online || !device.port) {
    toast("Thiết bị offline.", "error");
    return;
  }

  const registry = await fetchRegistry();

  // Determine which script's files to show.
  // Use the first script in registry (most common case: 1 script).
  const scriptIds = Object.keys(registry);
  if (scriptIds.length === 0) {
    toast("Chưa có script nào trên server.", "error");
    return;
  }

  // Build tab UI
  const container = el("div", { class: "data-manager" });
  const tabBar = el("div", { class: "data-tabs" });
  const contentArea = el("textarea", {
    class: "data-textarea",
    spellcheck: "false",
    placeholder: "Đang tải...",
  });
  const statusBar = el("div", { class: "data-status" }, ["—"]);

  // Script selector (if multiple scripts)
  let currentScript = scriptIds[0];
  let currentFileIdx = 0;
  let currentFiles = registry[currentScript].files;

  function renderTabs() {
    tabBar.innerHTML = "";
    currentFiles = registry[currentScript].files;
    currentFiles.forEach((f, i) => {
      const tab = el("button", {
        class: `data-tab${i === currentFileIdx ? " active" : ""}`,
        onclick: () => { currentFileIdx = i; renderTabs(); loadFile(); },
      }, [`📄 ${f.name}`]);
      tabBar.appendChild(tab);
    });
  }

  async function loadFile() {
    const file = currentFiles[currentFileIdx];
    contentArea.value = "";
    contentArea.placeholder = `Đang tải ${file.name}...`;
    contentArea.readOnly = !file.editable;
    statusBar.textContent = `${file.desc} ${file.editable ? "(có thể sửa)" : "(chỉ đọc)"}`;

    try {
      const content = await api.readFile(device.udid, file.name);
      contentArea.value = content;
      contentArea.placeholder = file.editable
        ? "Nhập nội dung..."
        : "(File chỉ đọc)";
      const lines = content.split("\n").length;
      statusBar.textContent = `${file.desc} · ${lines} dòng · ${file.editable ? "✏️ Editable" : "🔒 Read-only"}`;
    } catch (e) {
      contentArea.value = "";
      contentArea.placeholder = `File chưa tồn tại hoặc lỗi: ${e}`;
      statusBar.textContent = `${file.name}: không tải được`;
    }
  }

  async function saveFile() {
    const file = currentFiles[currentFileIdx];
    if (!file.editable) {
      toast("File này chỉ đọc.", "error");
      return;
    }
    try {
      await api.writeFile(device.udid, file.name, contentArea.value);
      toast(`💾 Đã lưu ${file.name}`, "success");
    } catch (e) {
      toast(`Lỗi lưu: ${e}`, "error");
    }
  }

  async function clearFile() {
    const file = currentFiles[currentFileIdx];
    if (!confirm(`Xóa toàn bộ nội dung ${file.name}?`)) return;
    contentArea.value = "";
    await saveFile();
  }

  // Script selector dropdown (if multiple)
  let scriptSelect = null;
  if (scriptIds.length > 1) {
    scriptSelect = el("select", {
      class: "data-script-select",
      onchange: (e) => {
        currentScript = e.target.value;
        currentFileIdx = 0;
        renderTabs();
        loadFile();
      },
    });
    scriptIds.forEach(id => {
      scriptSelect.appendChild(el("option", { value: id }, [registry[id].label]));
    });
  }

  // Assemble
  if (scriptSelect) container.appendChild(scriptSelect);
  container.appendChild(tabBar);
  container.appendChild(contentArea);
  container.appendChild(statusBar);

  renderTabs();

  const modal = showModal({
    title: `📂 Data · ${device.label || device.name}`,
    body: container,
    width: "min(700px, 94vw)",
    footer: [
      el("button", { class: "btn btn-primary", onclick: saveFile }, ["💾 Save"]),
      el("button", { class: "btn btn-secondary", onclick: loadFile }, ["📥 Pull"]),
      el("button", { class: "btn btn-ghost", onclick: clearFile }, ["🗑 Clear"]),
      el("span", { style: "flex:1" }),
      el("button", { class: "btn btn-ghost", onclick: () => modal.close() }, ["Đóng"]),
    ],
  });

  // Load first file
  loadFile();
}
