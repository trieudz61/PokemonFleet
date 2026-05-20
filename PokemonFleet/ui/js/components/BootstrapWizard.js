// Bootstrap wizard — uploads PokemonLoader.lue and shows UDID for key creation.

import * as api from "../api.js";
import { el, showModal, toast, copyToClipboard } from "../utils.js";

export async function openBootstrapWizard(device) {
  const status = el("p", { class: "muted" }, ["Đang tải PokemonLoader.lue lên thiết bị..."]);
  const progress = el("div", { style: "height:4px;background:var(--bg-input);border-radius:2px;overflow:hidden;margin:12px 0;" }, [
    el("div", { style: "height:100%;width:30%;background:var(--accent);transition:width 400ms;" }),
  ]);

  const body = el("div", {}, [
    el("h3", {}, [`⚡ Setup ${device.label || device.name}`]),
    status,
    progress,
  ]);

  const modal = showModal({
    title: "New device setup",
    body,
    footer: [],
    width: "560px",
  });

  // Kick off install.
  let result;
  try {
    result = await api.installPokemonLoader(device.udid, true);
  } catch (e) {
    status.textContent = "Cài đặt thất bại: " + e;
    status.classList.add("error");
    return;
  }

  if (!result.success) {
    status.textContent = "Cài đặt thất bại: " + (result.message || "unknown");
    status.classList.add("error");
    return;
  }

  // Create data folders + files for Data Manager
  try {
    await api.writeFile(device.udid, "Chuysen/account.txt", "TK|MK\n");
    await api.writeFile(device.udid, "Chuysen/Success.txt", "");
    await api.writeFile(device.udid, "Chuysen/Failed.txt", "");
    await api.writeFile(device.udid, "Register/account.txt", "TK|Ten|NgonNgu|Nam|Thang|Ngay|GioiTinh|ZipCode|Address1|Address2|SDT|Password\n");
    await api.writeFile(device.udid, "Register/Success.txt", "");
    await api.writeFile(device.udid, "Register/Failed.txt", "");
  } catch (e) {
    console.warn("[Setup] Could not create data files:", e);
  }

  // Mark device as having loader in local state + schedule UI refresh
  device.has_loader = true;
  // Dispatch custom event so app.js can re-render
  window.dispatchEvent(new CustomEvent("pkm-device-patched", { detail: device }));

  // Replace body with success state showing UDID.
  modal.body.innerHTML = "";
  const udidBox = el("div", {
    style: "background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;font-family:var(--font-mono);font-size:12px;word-break:break-all;",
  }, [device.udid]);

  const successContent = el("div", {}, [
    el("h3", { style: "color:var(--success);" }, ["✅ Cài đặt xong!"]),
    el("p", { class: "muted" }, [
      `PokemonLoader.lue đã được cài lên ${device.label || device.name}.`,
      result.uploaded_template ? " Pokemon_Config.txt template cũng được seed." : "",
    ]),
    el("hr", { style: "margin:18px 0;border-color:var(--border);" }),
    el("p", {}, ["Bước tiếp theo — tạo license key cho UDID này:"]),
    udidBox,
    el("div", { style: "display:flex;gap:8px;margin-top:12px;" }, [
      el("button", {
        class: "btn btn-ghost",
        onclick: async () => {
          await copyToClipboard(device.udid);
          toast("UDID copied to clipboard", "success");
        },
      }, ["📋 Copy UDID"]),
      el("button", {
        class: "btn btn-ghost",
        onclick: () => modal.close(),
      }, ["Đóng"]),
    ]),
    el("p", { class: "muted", style: "margin-top:18px;font-size:12px;" }, [
      "Sau khi tạo key xong, bấm nút \"Config\" trên thiết bị này và điền LICENSE_KEY + MAIL_SERVER.",
    ]),
  ]);
  modal.body.appendChild(successContent);
}
