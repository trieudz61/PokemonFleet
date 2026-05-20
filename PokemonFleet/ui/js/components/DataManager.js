// Data Manager — full-screen modal overlay in main window.
//
// Opens as a full-screen modal (not a separate window) to avoid
// Tauri window management issues. Blocks interaction with main UI.

import { el, toast } from "../utils.js";
import * as api from "../api.js";

const EXPECTED_FILES = ["account.txt", "Success.txt", "Failed.txt"];

export async function openDataManager(device) {
  if (!device.online || !device.port) {
    toast("Thiết bị offline.", "error");
    return;
  }

  // Remove any existing overlay
  document.getElementById("dm-block-overlay")?.remove();
  document.getElementById("dm-fullscreen-modal")?.remove();

  let activePath = null;
  let lastLoadedContent = "";
  let tableMode = false;
  let folders = [];
  let openFolderIdx = -1;

  // Fetch folders
  try {
    const result = await api.listFiles(device.udid);
    const files = result.files || result || [];
    folders = files.filter(f => f.type === "folder").map(f => f.name).filter(n => !n.startsWith("."));
  } catch (e) {
    toast("Không lấy được danh sách file: " + e, "error");
    return;
  }
  if (folders.length === 0) {
    toast("Chưa có thư mục data nào trên thiết bị.", "info");
    return;
  }
  if (folders.length === 1) openFolderIdx = 0;

  // ─── Build DOM ───
  const modal = document.createElement("div");
  modal.id = "dm-fullscreen-modal";
  modal.innerHTML = `
    <div class="dm-fs-titlebar">
      <h1>🗂️ Data · ${device.label || device.name}</h1>
      <div class="dm-fs-btns">
        <button class="btn btn-ghost btn-sm" id="dm-fs-zoom" title="Zoom">⬜</button>
        <button class="btn btn-ghost btn-sm" id="dm-fs-close" title="Đóng">✕</button>
      </div>
    </div>
    <div class="dm-fs-body">
      <div class="dm-sidebar" id="dm-fs-sidebar"></div>
      <div class="dm-editor" id="dm-fs-editor">
        <div class="dm-editor-placeholder" id="dm-fs-placeholder">👈 Chọn thư mục → chọn file để xem/sửa</div>
        <div class="dm-editor-wrap" id="dm-fs-editor-wrap" style="display:none">
          <div class="dm-line-nums" id="dm-fs-line-nums"></div>
          <textarea class="dm-textarea" id="dm-fs-textarea" spellcheck="false" wrap="off" placeholder="Nhập nội dung..."></textarea>
        </div>
        <div class="dm-table-wrap" id="dm-fs-table-wrap" style="display:none"></div>
        <div class="dm-status" id="dm-fs-status">Chọn file bên trái</div>
      </div>
    </div>
    <div class="dm-fs-footer">
      <button class="btn btn-primary btn-sm" id="dm-fs-save">🌟 Save</button>
      <button class="btn btn-secondary btn-sm" id="dm-fs-pull">🔄 Pull</button>
      <button class="btn btn-ghost btn-sm" id="dm-fs-clear">🧹 Clear</button>
      <span style="flex:1"></span>
      <button class="btn btn-ghost btn-sm" id="dm-fs-toggle">📊 Dạng Bảng</button>
    </div>
    <div class="dm-confirm-backdrop" id="dm-fs-confirm" style="display:none">
      <div class="dm-confirm-box">
        <div class="dm-confirm-icon">💾</div>
        <p class="dm-confirm-msg">File đã thay đổi. Lưu trước khi thoát?</p>
        <div class="dm-confirm-btns">
          <button class="btn btn-primary btn-sm" id="dm-fs-confirm-yes">Lưu & Thoát</button>
          <button class="btn btn-ghost btn-sm" id="dm-fs-confirm-no">Không lưu</button>
          <button class="btn btn-ghost btn-sm" id="dm-fs-confirm-cancel">Hủy</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // References
  const sidebar = modal.querySelector("#dm-fs-sidebar");
  const placeholder = modal.querySelector("#dm-fs-placeholder");
  const editorWrap = modal.querySelector("#dm-fs-editor-wrap");
  const tableWrap = modal.querySelector("#dm-fs-table-wrap");
  const lineNums = modal.querySelector("#dm-fs-line-nums");
  const textarea = modal.querySelector("#dm-fs-textarea");
  const statusBar = modal.querySelector("#dm-fs-status");
  const toggleBtn = modal.querySelector("#dm-fs-toggle");
  const confirmEl = modal.querySelector("#dm-fs-confirm");

  // ─── Sidebar ───
  function renderSidebar() {
    sidebar.innerHTML = "";
    folders.forEach((folder, fi) => {
      const isOpen = fi === openFolderIdx;
      const card = document.createElement("div");
      card.className = `dm-folder-card${isOpen ? " open" : ""}`;
      const header = document.createElement("button");
      header.className = "dm-folder-header";
      header.innerHTML = `<span class="dm-folder-icon">🎮</span><span class="dm-folder-label">${folder}</span><span class="dm-folder-arrow">▾</span>`;
      header.onclick = () => { openFolderIdx = isOpen ? -1 : fi; renderSidebar(); };
      const fileList = document.createElement("div");
      fileList.className = "dm-file-list";
      EXPECTED_FILES.forEach(fname => {
        const path = `${folder}/${fname}`;
        const btn = document.createElement("button");
        btn.className = `dm-file-btn${activePath === path ? " active" : ""}`;
        btn.textContent = `🗒️ ${fname}`;
        btn.onclick = (e) => {
          e.stopPropagation();
          activePath = path;
          sidebar.querySelectorAll(".dm-file-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          loadFile(folder, fname);
        };
        fileList.appendChild(btn);
      });
      card.appendChild(header);
      card.appendChild(fileList);
      sidebar.appendChild(card);
    });
  }

  // ─── Load File ───
  async function loadFile(folder, fname) {
    const path = `${folder}/${fname}`;
    placeholder.style.display = "none";
    if (!tableMode) editorWrap.style.display = "flex";
    textarea.value = "";
    textarea.placeholder = `Đang tải ${path}...`;
    statusBar.textContent = `🗂️ ${folder} › 🗒️ ${fname}`;
    try {
      const content = await api.readFile(device.udid, path);
      if (typeof content === "string" && content.startsWith("{") && content.includes('"error"')) {
        textarea.value = "";
        textarea.placeholder = "File chưa tồn tại — nhập nội dung rồi bấm Save để tạo";
        statusBar.textContent = `${path} · chưa có dữ liệu`;
      } else {
        textarea.value = content;
        textarea.placeholder = "Nhập nội dung...";
        const lines = (content || "").split("\n").length;
        statusBar.textContent = `🗂️ ${folder} › 🗒️ ${fname} · ${lines} dòng`;
      }
    } catch (e) {
      textarea.value = "";
      textarea.placeholder = "File chưa tồn tại — nhập nội dung rồi bấm Save để tạo";
      statusBar.textContent = `${path}: chưa tồn tại`;
    }
    updateLineNums();
    lastLoadedContent = textarea.value;
    if (tableMode) renderTable();
  }

  // ─── Save ───
  async function saveFile() {
    if (!activePath) return;
    if (tableMode) textarea.value = tableToText();
    try {
      await api.writeFile(device.udid, activePath, textarea.value);
      statusBar.textContent = `🌟 Đã lưu ${activePath}`;
      const [folder, fname] = activePath.split("/");
      await loadFile(folder, fname);
    } catch (e) {
      statusBar.textContent = `Lỗi lưu: ${e}`;
    }
  }

  // ─── Clear ───
  async function clearFile() {
    if (!activePath) return;
    if (!confirm(`Xóa toàn bộ nội dung ${activePath}?`)) return;
    textarea.value = "";
    await saveFile();
  }

  // ─── Line Numbers ───
  function updateLineNums() {
    const lines = textarea.value.split("\n").length;
    lineNums.innerHTML = Array.from({ length: lines }, (_, i) =>
      `<div class="dm-line-num">${i + 1}</div>`
    ).join("");
  }
  textarea.addEventListener("input", updateLineNums);
  textarea.addEventListener("scroll", () => { lineNums.scrollTop = textarea.scrollTop; });

  // ─── Table View ───
  function escHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function renderTable() {
    const text = textarea.value || "";
    const rows = text.split("\n").filter(l => l.trim());
    if (rows.length === 0) {
      tableWrap.innerHTML = '<div style="padding:20px;color:#888;text-align:center">Không có dữ liệu</div>';
      return;
    }
    const maxCols = Math.max(...rows.map(r => r.split("|").length));
    const colLetter = (i) => String.fromCharCode(65 + i);
    let html = '<table class="dm-table"><thead><tr><th class="dm-th-row">#</th>';
    for (let ci = 0; ci < maxCols; ci++) html += `<th class="dm-th-col">${colLetter(ci)}</th>`;
    html += '</tr></thead><tbody>';
    rows.forEach((row, ri) => {
      html += `<tr><td class="dm-td-row">${ri + 1}</td>`;
      const cols = row.split("|");
      for (let ci = 0; ci < maxCols; ci++) {
        html += `<td contenteditable="true">${escHtml(cols[ci] || "")}</td>`;
      }
      html += "</tr>";
    });
    html += "</tbody></table>";
    tableWrap.innerHTML = html;
  }

  function tableToText() {
    const trs = tableWrap.querySelectorAll("tbody tr");
    const lines = [];
    trs.forEach(tr => {
      const cells = Array.from(tr.querySelectorAll("td:not(.dm-td-row)")).map(td => td.textContent);
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length > 0) lines.push(cells.join("|"));
    });
    return lines.join("\n");
  }

  function toggleTable() {
    tableMode = !tableMode;
    if (tableMode) {
      renderTable();
      editorWrap.style.display = "none";
      tableWrap.style.display = "block";
      toggleBtn.textContent = "📝 Dạng Text";
    } else {
      textarea.value = tableToText();
      updateLineNums();
      editorWrap.style.display = "flex";
      tableWrap.style.display = "none";
      toggleBtn.textContent = "📊 Dạng Bảng";
    }
  }

  // ─── Confirm Dialog ───
  function showConfirm() {
    return new Promise((resolve) => {
      confirmEl.style.display = "flex";
      modal.querySelector("#dm-fs-confirm-yes").onclick = () => { confirmEl.style.display = "none"; resolve("save"); };
      modal.querySelector("#dm-fs-confirm-no").onclick = () => { confirmEl.style.display = "none"; resolve("discard"); };
      modal.querySelector("#dm-fs-confirm-cancel").onclick = () => { confirmEl.style.display = "none"; resolve("cancel"); };
    });
  }

  // ─── Close ───
  let isMaximized = false;
  function closeModal() {
    document.removeEventListener("keydown", onKeyDown);
    modal.remove();
  }

  async function handleClose() {
    if (activePath && textarea.value !== lastLoadedContent) {
      const result = await showConfirm();
      if (result === "save") { await saveFile(); closeModal(); }
      else if (result === "discard") { closeModal(); }
      // cancel → stay
    } else {
      closeModal();
    }
  }

  // ─── Zoom ───
  function toggleZoom() {
    isMaximized = !isMaximized;
    if (isMaximized) {
      modal.classList.add("dm-fs-maximized");
    } else {
      modal.classList.remove("dm-fs-maximized");
    }
  }

  // ─── Button Handlers ───
  modal.querySelector("#dm-fs-save").onclick = saveFile;
  modal.querySelector("#dm-fs-pull").onclick = () => activePath && loadFile(...activePath.split("/"));
  modal.querySelector("#dm-fs-clear").onclick = clearFile;
  toggleBtn.onclick = toggleTable;
  modal.querySelector("#dm-fs-zoom").onclick = toggleZoom;
  modal.querySelector("#dm-fs-close").onclick = handleClose;

  // ─── Ctrl+S ───
  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (activePath) saveFile();
    }
    if (e.key === "Escape") handleClose();
  }
  document.addEventListener("keydown", onKeyDown);

  // ─── Init ───
  renderSidebar();
}
