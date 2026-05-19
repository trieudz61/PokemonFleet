// Device row + table renderer.
//
// Receives a `state` object with onAction callbacks so this component stays
// purely presentational — actual API calls live in app.js.

import { el, escape, fmtRelTime } from "../utils.js";

export class DeviceTable {
  constructor(opts) {
    this.tbody = opts.tbody;
    this.onSelectionChange = opts.onSelectionChange || (() => {});
    this.onAction = opts.onAction; // (kind, device) => void
    this.devices = [];
    this.selected = new Set();
    this.logTails = new Map(); // udid -> latest line
  }

  render(devices) {
    this.devices = devices;
    // Drop selections for devices that disappeared.
    for (const u of [...this.selected]) {
      if (!devices.find((d) => d.udid === u)) this.selected.delete(u);
    }

    this.tbody.innerHTML = "";
    if (devices.length === 0) {
      this.tbody.appendChild(this._emptyRow());
      this._fireSelection();
      return;
    }
    devices.forEach((d, idx) => {
      this.tbody.appendChild(this._row(d, idx + 1));
    });
    this._fireSelection();
  }

  setLogTail(udid, line) {
    this.logTails.set(udid, line);
    const cell = this.tbody.querySelector(`[data-log-udid="${CSS.escape(udid)}"]`);
    if (cell) cell.textContent = line;
  }

  setSelected(udid, sel) {
    if (sel) this.selected.add(udid);
    else this.selected.delete(udid);
    const cb = this.tbody.querySelector(
      `input[data-check-udid="${CSS.escape(udid)}"]`
    );
    if (cb) cb.checked = sel;
    this._fireSelection();
  }

  selectAllOnline() {
    for (const d of this.devices) {
      if (d.online) this.selected.add(d.udid);
    }
    this._refreshChecks();
    this._fireSelection();
  }

  deselectAll() {
    this.selected.clear();
    this._refreshChecks();
    this._fireSelection();
  }

  selectedDevices() {
    return this.devices.filter((d) => this.selected.has(d.udid));
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  _row(d, ordinal) {
    const tr = el("tr", { class: "device-row", "data-udid": d.udid });

    // Make the entire row act as a big toggle target. Clicks that originate
    // from an action button (Run/Stop/Config/etc), input or link inside the
    // row are ignored — we only flip selection on "empty" clicks.
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button, a, input, .btn")) return;
      const next = !this.selected.has(d.udid);
      if (next) this.selected.add(d.udid);
      else this.selected.delete(d.udid);
      this._refreshChecks();
      this._fireSelection();
    });

    // Ordinal
    tr.appendChild(el("td", { class: "col-ord" }, [
      el("span", { class: "ord-bubble" }, [String(ordinal)]),
    ]));

    // Checkbox
    const cb = el("input", {
      type: "checkbox",
      class: "big-check",
      "data-check-udid": d.udid,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        if (e.target.checked) this.selected.add(d.udid);
        else this.selected.delete(d.udid);
        this._fireSelection();
      },
    });
    cb.checked = this.selected.has(d.udid);
    tr.appendChild(el("td", { class: "col-check" }, [cb]));

    // Name + UDID
    const displayName = d.label || d.name || "iPhone";
    const subtitle = `${d.product_type || "?"} · iOS ${d.ios_version || "?"} · ${shortUdid(d.udid)}`;
    tr.appendChild(el("td", { class: "col-name" }, [
      el("div", { class: "device-name" }, [
        el("span", { class: "primary" }, [displayName]),
        el("span", { class: "secondary" }, [subtitle]),
      ]),
    ]));

    // Status
    const statusBadge = d.online
      ? el("span", { class: "status-badge online" }, [el("span", { class: "dot" }), "Online"])
      : el("span", { class: "status-badge offline" }, [el("span", { class: "dot" }), "Offline"]);
    tr.appendChild(el("td", { class: "col-status" }, [statusBadge]));

    // Running script
    const running = d.running_script
      ? el("span", { class: "running-pill" }, [d.running_script])
      : el("span", { class: "muted" }, ["—"]);
    tr.appendChild(el("td", { class: "col-running" }, [running]));

    // License
    let licText = "—", licClass = "unknown";
    if (d.license_summary) {
      if (d.license_summary.licensed) {
        licText = d.license_summary.plan || "PRO";
        if (d.license_summary.days_left != null) {
          licText += ` · ${d.license_summary.days_left}d`;
        }
        licClass = "licensed";
      } else {
        licText = "Inactive";
        licClass = "unlicensed";
      }
    }
    tr.appendChild(el("td", { class: "col-license" }, [
      el("span", { class: `license-badge-mini ${licClass}` }, [licText]),
    ]));

    // Log tail (last seen line)
    const logCell = el("td", { class: "col-log" }, [
      el("span", {
        class: "log-tail",
        "data-log-udid": d.udid,
        title: "Latest log line",
      }, [this.logTails.get(d.udid) || ""]),
    ]);
    tr.appendChild(logCell);

    // Actions — 3 columns x 2 rows grid for a tidy block.
    const actions = el("div", { class: "actions actions-grid" });

    if (d.online && !d.has_loader) {
      // Single big setup CTA spanning the whole grid.
      actions.classList.add("actions-setup");
      actions.appendChild(this._btn("⚡ Setup iPhone", "btn-primary btn-block", "setup", d));
    } else if (d.online) {
      if (d.running_script) {
        actions.appendChild(this._btn("■ Stop", "btn-danger", "stop", d));
      } else {
        actions.appendChild(this._btn("▶ Run", "btn-success", "run", d));
      }
      actions.appendChild(this._btn("Config",  "btn-ghost", "config", d));
      actions.appendChild(this._btn("View Screen", "btn-ghost", "ide", d));
      actions.appendChild(this._btn("Data",    "btn-ghost", "data",   d));
      actions.appendChild(this._btn("Log",     "btn-ghost", "log",    d));
      actions.appendChild(this._btn("ℹ Info",  "btn-ghost", "info",   d));
    } else {
      actions.appendChild(el("span", { class: "muted" }, ["device offline"]));
    }
    tr.appendChild(el("td", { class: "col-actions" }, [actions]));

    return tr;
  }

  _btn(label, klass, kind, device) {
    return el("button", {
      class: `btn ${klass}`,
      onclick: () => this.onAction(kind, device),
    }, [label]);
  }

  _emptyRow() {
    return el("tr", { class: "empty-row" }, [
      el("td", { colspan: "8" }, [
        el("div", { class: "empty-state" }, [
          el("span", { class: "emoji" }, ["🔌"]),
          el("p", {}, ["No devices connected"]),
          el("p", { class: "muted" }, [
            "Plug in iPhones via USB. They'll appear here automatically.",
          ]),
        ]),
      ]),
    ]);
  }

  _refreshChecks() {
    for (const cb of this.tbody.querySelectorAll("input[data-check-udid]")) {
      cb.checked = this.selected.has(cb.dataset.checkUdid);
    }
  }

  _fireSelection() {
    this.onSelectionChange(this.selectedDevices());
  }
}

function shortUdid(udid = "") {
  if (udid.length <= 14) return udid;
  return udid.slice(0, 6) + "…" + udid.slice(-4);
}
