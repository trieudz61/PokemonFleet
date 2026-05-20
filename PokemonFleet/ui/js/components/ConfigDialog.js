// Pokemon_Config.txt editor — form-based, with "apply to all selected" toggle.

import * as api from "../api.js";
import { el, showModal, toast } from "../utils.js";

const KNOWN_KEYS = [
  ["LICENSE_KEY", "License key admin gửi cho bạn"],
  ["MAIL_SERVER", "URL mail server (https://...)"],
];

const TOGGLE_KEYS = [
  ["CHANGE_IP", "✈️ Đổi IP mỗi vòng (Airplane Mode)", "Bật nếu không dùng iCloud Private Relay"],
];

export async function openConfigDialog(device, allSelected = []) {
  let config;
  try {
    config = await api.readConfig(device.udid);
  } catch (e) {
    toast("Could not read config: " + e, "error");
    return;
  }

  const formBody = el("div");
  const inputs = {};

  for (const [key, hint] of KNOWN_KEYS) {
    const value = config[key] ?? "";
    const input = el("input", {
      type: "text",
      value,
      placeholder: hint,
      "data-cfg-key": key,
      autocomplete: "off",
    });
    inputs[key] = input;
    formBody.appendChild(el("div", { class: "form-row" }, [
      el("label", {}, [key]),
      input,
    ]));
  }

  // Toggle options (checkboxes)
  const toggleInputs = {};
  for (const [key, label, hint] of TOGGLE_KEYS) {
    const checked = (config[key] || "").toLowerCase() === "true";
    const checkbox = el("input", { type: "checkbox", "data-cfg-key": key });
    if (checked) checkbox.checked = true;
    toggleInputs[key] = checkbox;
    formBody.appendChild(el("div", { class: "checkbox-row" }, [
      checkbox,
      el("span", {}, [label]),
      hint ? el("span", { class: "cfg-hint" }, [" — " + hint]) : null,
    ].filter(Boolean)));
  }

  // Preserve any extra keys in the file (not shown to user) so they don't get wiped on save.
  const allKnown = [...KNOWN_KEYS.map(k => k[0]), ...TOGGLE_KEYS.map(k => k[0])];
  const extras = Object.entries(config).filter(([k]) => !allKnown.includes(k));

  const applyAll = el("input", { type: "checkbox" });
  if (allSelected.length > 1) {
    formBody.appendChild(el("div", { class: "checkbox-row" }, [
      applyAll,
      `Apply same config to all ${allSelected.length} selected devices`,
    ]));
  }

  const saveButton = el("button", {
    class: "btn btn-success",
    onclick: async () => {
      const newCfg = {};
      // Preserve extra keys user doesn't see
      for (const [k, v] of extras) newCfg[k] = v;
      // Overwrite with user-edited fields
      for (const [key, input] of Object.entries(inputs)) {
        newCfg[key] = input.value;
      }
      // Toggle options
      for (const [key, checkbox] of Object.entries(toggleInputs)) {
        newCfg[key] = checkbox.checked ? "true" : "false";
      }
      const targets = applyAll.checked ? allSelected : [device];
      let ok = 0, fail = 0;
      for (const t of targets) {
        try { await api.writeConfig(t.udid, newCfg); ok++; }
        catch { fail++; }
      }
      modal.close();
      toast(
        `💾 Config saved to ${ok}/${ok + fail} device${ok + fail > 1 ? "s" : ""}`,
        fail ? "error" : "success",
      );
    },
  }, ["💾 Save"]);

  const modal = showModal({
    title: `⚙ Config — ${device.label || device.name}`,
    body: formBody,
    width: "640px",
    footer: [
      el("button", { class: "btn btn-ghost", onclick: () => modal.close() }, ["Cancel"]),
      saveButton,
    ],
  });
}
