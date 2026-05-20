// Data Manager — dynamic folder-based file viewer/editor.
//
// Fetches folder list from iPhone's /api/scripts/files endpoint.
// Shows only directories as accordion items, files inside each as tabs.
// All files editable. Ctrl+S to save.

import { el, showModal, toast } from "../utils.js";
import * as api from "../api.js";

// Standard data files we expect inside each script folder
const EXPECTED_FILES = ["account.txt", "Success.txt", "Failed.txt"];

export async function openDataManager(device) {
  if (!device.online || !device.port) {
    toast("Thiết bị offline.", "error");
    return;
  }

  // Fetch file list from iPhone to discover folders
  let folders = [];
  try {
    const result = await api.listFiles(device.udid);
    // result is typically { files: [{name, is_dir, size}, ...] } or array
    const files = result.files || result || [];
    folders = files
      .filter(f => f.is_dir || f.type === "dir" || f.isDir)
      .map(f => f.name || f.filename)
      .filter(name => !name.startsWith("."));
  } catch (e) {
    toast("Không lấy được danh sách file: " + e, "error");
    return;
  }

  if (folders.length === 0) {
    toast("Chưa có thư mục data nào trên thiết bị.", "info");
    return;
  }

  let activePath = null;
  let openFolderIdx = folders.length === 1 ? 0 : -1; // auto-open if only 1 folder

  const container = el("div", { class: "dm-container" });
  const sidebar = el("div", { class: "dm-sidebar" });
  const editor = el("div", { class: "dm-editor" });
  const contentArea = el("textarea", {
    class: "dm-textarea",
    spellcheck: "false",
    placeholder: "👈 Chọn thư mục → chọn file để xem/sửa",
  });
  const statusBar = el("div", { class: "dm-status" }, ["Chọn file bên trái"]);

  function renderSidebar() {
    sidebar.innerHTML = "";
    folders.forEach((folder, fi) => {
      const isOpen = fi === openFolderIdx;
      const card = el("div", { class: `dm-folder-card${isOpen ? " open" : ""}` });

      const header = el("button", {
        class: "dm-folder-header",
        onclick: () => {
          openFolderIdx = isOpen ? -1 : fi;
          renderSidebar();
        },
      }, [
        el("span", { class: "dm-folder-icon" }, ["🎮"]),
        el("span", { class: "dm-folder-label" }, [folder]),
        el("span", { class: "dm-folder-arrow" }, ["▾"]),
      ]);

      const fileList = el("div", { class: "dm-file-list" });
      EXPECTED_FILES.forEach((fname) => {
        const path = `${folder}/${fname}`;
        const fileBtn = el("button", {
          class: `dm-file-btn${activePath === path ? " active" : ""}`,
          onclick: (e) => {
            e.stopPropagation();
            activePath = path;
            sidebar.querySelectorAll(".dm-file-btn").forEach(b => b.classList.remove("active"));
            fileBtn.classList.add("active");
            loadFile(folder, fname);
          },
        }, [`🗒️ ${fname}`]);
        fileList.appendChild(fileBtn);
      });

      card.appendChild(header);
      card.appendChild(fileList);
      sidebar.appendChild(card);
    });
  }

  async function loadFile(folder, fname) {
    const path = `${folder}/${fname}`;
    contentArea.value = "";
    contentArea.placeholder = `Đang tải ${path}...`;
    contentArea.readOnly = false;
    statusBar.textContent = `🗂️ ${folder} › 🗒️ ${fname}`;

    try {
      const content = await api.readFile(device.udid, path);
      if (typeof content === "string" && content.startsWith("{") && content.includes('"error"')) {
        contentArea.value = "";
        contentArea.placeholder = "File chưa tồn tại — nhập nội dung rồi bấm Save để tạo";
        statusBar.textContent = `${path} · chưa có dữ liệu`;
      } else {
        contentArea.value = content;
        contentArea.placeholder = "Nhập nội dung...";
        const lines = (content || "").split("\n").length;
        statusBar.textContent = `🗂️ ${folder} › 🗒️ ${fname} · ${lines} dòng`;
      }
    } catch (e) {
      contentArea.value = "";
      contentArea.placeholder = "File chưa tồn tại — nhập nội dung rồi bấm Save để tạo";
      statusBar.textContent = `${path}: chưa tồn tại`;
    }
  }

  async function saveFile() {
    if (!activePath) return;
    try {
      await api.writeFile(device.udid, activePath, contentArea.value);
      toast(`🌟 Đã lưu ${activePath}`, "success");
    } catch (e) {
      toast(`Lỗi lưu: ${e}`, "error");
    }
  }

  async function clearFile() {
    if (!activePath) return;
    if (!confirm(`Xóa toàn bộ nội dung ${activePath}?`)) return;
    contentArea.value = "";
    await saveFile();
  }

  // Assemble
  editor.appendChild(contentArea);
  editor.appendChild(statusBar);
  container.appendChild(sidebar);
  container.appendChild(editor);

  renderSidebar();

  const modal = showModal({
    title: `🗂️ Data · ${device.label || device.name}`,
    body: container,
    width: "min(820px, 96vw)",
    footer: [
      el("button", { class: "btn btn-primary", onclick: saveFile }, ["🌟 Save"]),
      el("button", { class: "btn btn-secondary", onclick: () => activePath && loadFile(...activePath.split("/")) }, ["🔄 Pull"]),
      el("button", { class: "btn btn-ghost", onclick: clearFile }, ["🧹 Clear"]),
      el("span", { style: "flex:1" }),
      el("button", { class: "btn btn-ghost", onclick: () => modal.close() }, ["Đóng"]),
    ],
  });

  // Ctrl+S / Cmd+S to save
  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (activePath) saveFile();
    }
  }
  document.addEventListener("keydown", onKeyDown);
  const origClose = modal.close;
  modal.close = () => {
    document.removeEventListener("keydown", onKeyDown);
    origClose();
  };
}
