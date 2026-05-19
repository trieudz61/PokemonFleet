// Pokemon_Config.txt editor — form-based, with "apply to all selected" toggle.

import * as api from "../api.js";
import { el, showModal, toast } from "../utils.js";

const KNOWN_KEYS = [
  ["LICENSE_KEY", "License key admin gửi cho bạn"],
  ["MAIL_SERVER", "URL mail server (https://...)"],
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

  // Custom-key support — anything user adds beyond known keys is preserved.
  const extras = Object.entries(config).filter(([k]) => !KNOWN_KEYS.find(([kk]) => kk === k));
  if (extras.length > 0) {
    formBody.appendChild(el("div", { class: "section-title" }, ["Other keys"]));
    for (const [key, value] of extras) {
      const input = el("input", { type: "text", value, "data-cfg-key": key, autocomplete: "off" });
      inputs[key] = input;
      formBody.appendChild(el("div", { class: "form-row" }, [
        el("label", {}, [key]),
        input,
      ]));
    }
  }

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
      for (const [key, input] of Object.entries(inputs)) {
        newCfg[key] = input.value;
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
