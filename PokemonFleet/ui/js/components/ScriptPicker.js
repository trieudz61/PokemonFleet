// Toolbar script picker.
//
// Two modes:
//   * Loader (default) — single option that runs PokemonLoader.lue on the
//                         device and lets the user pick a feature from the
//                         on-device popup menu.
//   * Fast Run         — list pulled live from
//                         https://pokemon.ioscontrol.com/api/scripts/list
//                         (the same public endpoint the admin web uses).
//                         Picking one + clicking Run skips the loader menu
//                         and runs the chosen script directly.
//
// `setMode("fast")` triggers a refresh of the list.

import { el } from "../utils.js";

const LIST_URL = "https://pokemon.ioscontrol.com/api/scripts/list";

const LOADER_SCRIPTS = [
  { id: "loader", name: "🎮 Pokemon Loader (mở menu trên iPhone)", filename: "PokemonLoader.lue" },
];

export class ScriptPicker {
  constructor(selectEl) {
    this.select = selectEl;
    this.mode = "loader";
    this.fastScripts = [];      // populated lazily on first switch to fast mode
    this.fastLoaded = false;
    this._render();
  }

  /** Switch between "loader" and "fast" modes. */
  async setMode(mode) {
    this.mode = mode === "fast" ? "fast" : "loader";
    if (this.mode === "fast" && !this.fastLoaded) {
      await this._loadFastScripts();
    }
    this._render();
  }

  /** Force-refresh the Fast Run list. Used by the toolbar refresh button so
   *  newly-added or removed scripts on the admin panel show up immediately. */
  async refresh() {
    if (this.mode === "fast") {
      this.fastLoaded = false;
      await this._loadFastScripts();
      this._render();
    }
  }

  /** Kept for backwards-compat with app.js boot sequence. */
  async loadFromWorker() { this._render(); }

  async _loadFastScripts() {
    try {
      const res = await fetch(LIST_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const arr = data.scripts || data || [];
      this.fastScripts = arr
        .map((s) => ({
          id:      s.script_id || s.id,
          name:    s.name || s.script_id,
          version: s.version || "",
        }))
        .filter((s) => s.id);
      this.fastLoaded = true;
    } catch (e) {
      console.warn("Could not fetch script list:", e);
      this.fastScripts = [];
      this.fastLoaded = false;
    }
  }

  _list() {
    return this.mode === "fast" ? this.fastScripts : LOADER_SCRIPTS;
  }

  _render() {
    this.select.innerHTML = "";
    if (this.mode === "fast") {
      const placeholder = this.fastScripts.length === 0
        ? "(Không tải được danh s\u00e1ch script)"
        : "— Chọn script chạy nhanh —";
      this.select.appendChild(el("option", { value: "" }, [placeholder]));
      for (const s of this._list()) {
        const label = s.version
          ? `⚡ ${s.name} (v${s.version})`
          : `⚡ ${s.name}`;
        this.select.appendChild(el("option", { value: s.id }, [label]));
      }
    } else {
      // Loader mode — only one option, pre-select it so users don't need to
      // open the dropdown for the common case.
      for (const s of this._list()) {
        this.select.appendChild(el("option", { value: s.id }, [s.name]));
      }
      const first = this._list()[0];
      if (first) this.select.value = first.id;
    }
  }

  selectedScriptId() {
    return this.select.value || null;
  }

  /** Display label for the chosen script, used in toasts + log buffer. */
  selectedLabel() {
    const id = this.selectedScriptId();
    if (!id) return null;
    return this._list().find((s) => s.id === id)?.name || id;
  }

  /** Filename used by the loader path (only meaningful when mode=loader). */
  filenameFor(scriptId) {
    const found = LOADER_SCRIPTS.find((s) => s.id === scriptId);
    return found ? found.filename : "PokemonLoader.lue";
  }
}
