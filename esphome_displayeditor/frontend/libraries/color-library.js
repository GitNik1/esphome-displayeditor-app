// @ts-check

import { colorReferenceLocations, normalizeLibraryHex, projectIdIsUsed } from "../project/colors.js";

/** @typedef {(key: string, params?: Record<string, unknown>) => string} Translate */
/** @typedef {(message: string, error?: boolean, details?: unknown) => void} Notify */
/** @typedef {{id: string, hex: string}} LibraryColor */
/**
 * @typedef {{
 *   list: HTMLElement, form: HTMLFormElement, id: HTMLInputElement, hex: HTMLInputElement,
 *   picker: HTMLInputElement, error: HTMLElement, save: HTMLButtonElement,
 *   cancel: HTMLButtonElement, exportHint: HTMLElement, options: HTMLDataListElement,
 * }} ColorLibraryElements
 */

const COLOR_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The project's colour library: named colours that widgets refer to by id.
 * Renaming a colour rewrites its references; deleting one that is in use
 * writes its value into them instead.
 * @param {{
 *   els: ColorLibraryElements,
 *   state: {project: any, editingColorId: string | null},
 *   t: Translate, toast: Notify, confirm: (message: string) => boolean,
 *   beginChange: () => void, commitChange: () => void, rerender: () => void,
 * }} deps
 */
export function createColorLibrary({
  els, state, t, toast, confirm, beginChange, commitChange, rerender,
}) {
  const document = els.list.ownerDocument;

  /** @returns {LibraryColor[]} */
  function colors() {
    if (!Array.isArray(state.project.colors)) state.project.colors = [];
    return state.project.colors;
  }

  /** @param {string} id */
  const find = (id) => colors().find((item) => item.id === id);
  /** @param {LibraryColor} entry */
  const hexOf = (entry) => normalizeLibraryHex(entry.hex) || "FFFFFF";

  function resetForm() {
    state.editingColorId = null;
    els.id.value = "";
    els.hex.value = "";
    els.picker.value = "#00a000";
    els.error.classList.add("hidden");
    els.save.textContent = t("colorlib.form.add");
    els.cancel.classList.add("hidden");
  }

  /** @param {string} id */
  function edit(id) {
    const entry = find(id);
    if (!entry) return;
    state.editingColorId = id;
    els.id.value = entry.id;
    els.hex.value = hexOf(entry);
    els.picker.value = `#${hexOf(entry)}`;
    els.error.classList.add("hidden");
    els.save.textContent = t("colorlib.form.save");
    els.cancel.classList.remove("hidden");
    els.id.focus();
  }

  /** @param {SubmitEvent} event */
  function save(event) {
    event.preventDefault();
    const id = els.id.value.trim();
    const hex = normalizeLibraryHex(els.hex.value);
    /** @param {string} message */
    const fail = (message) => {
      els.error.textContent = message;
      els.error.classList.remove("hidden");
    };
    if (!COLOR_ID.test(id)) return fail(t("validation.id.format"));
    if (!hex) return fail(t("validation.color.needsHex"));
    if (projectIdIsUsed(state.project, id, state.editingColorId)) {
      return fail(t("validation.id.usedInProject", { id }));
    }
    beginChange();
    if (state.editingColorId) {
      const entry = find(state.editingColorId);
      if (!entry) return resetForm();
      const previousId = entry.id;
      entry.id = id;
      entry.hex = hex;
      if (previousId !== id) colorReferenceLocations(state.project, previousId, id);
    } else {
      colors().push({ id, hex });
    }
    commitChange();
    resetForm();
    rerender();
    toast(t("toast.color.saved", { id }));
  }

  /** @param {string} id */
  function remove(id) {
    const entry = find(id);
    if (!entry) return;
    const references = colorReferenceLocations(state.project, id);
    if (references.length && !confirm(
      t("confirm.color.deleteWithRefs", { id, count: references.length, hex: entry.hex }),
    )) return;
    beginChange();
    if (references.length) {
      colorReferenceLocations(state.project, id, normalizeLibraryHex(entry.hex) || entry.hex);
    }
    state.project.colors = colors().filter((item) => item !== entry);
    if (state.editingColorId === id) resetForm();
    commitChange();
    rerender();
    toast(references.length
      ? t("toast.color.deletedWithRefs", { id, count: references.length })
      : t("toast.color.deleted", { id }));
  }

  /** @param {string} text @param {string} title @param {() => void} onClick */
  function iconButton(text, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.title = title;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  /** @param {LibraryColor} entry */
  function row(entry) {
    const item = document.createElement("div");
    item.className = "color-library-item";
    const swatch = document.createElement("span");
    swatch.className = "color-library-swatch";
    swatch.style.backgroundColor = `#${hexOf(entry)}`;
    const name = document.createElement("span");
    name.className = "color-library-name";
    name.textContent = entry.id;
    const value = document.createElement("small");
    value.textContent = `#${hexOf(entry)}`;
    name.append(value);
    item.append(
      swatch,
      name,
      iconButton("✎", t("library.editTooltip", { id: entry.id }), () => edit(entry.id)),
      iconButton("×", t("library.deleteTooltip", { id: entry.id }), () => remove(entry.id)),
    );
    return item;
  }

  return {
    bind() {
      els.form.addEventListener("submit", save);
      els.cancel.addEventListener("click", resetForm);
      els.picker.addEventListener("input", () => {
        els.hex.value = els.picker.value.slice(1).toUpperCase();
      });
      els.hex.addEventListener("input", () => {
        const hex = normalizeLibraryHex(els.hex.value);
        if (hex) els.picker.value = `#${hex}`;
      });
    },

    render() {
      els.list.replaceChildren(...colors().map(row));
      if (!colors().length) {
        const empty = document.createElement("p");
        empty.className = "color-library-empty";
        empty.textContent = t("colorlib.noProjectColors");
        els.list.append(empty);
      }
      els.options.replaceChildren(...colors().map((entry) => {
        const option = document.createElement("option");
        option.value = entry.id;
        option.label = `#${normalizeLibraryHex(entry.hex) || entry.hex}`;
        return option;
      }));
      els.exportHint.classList.toggle(
        "hidden", (state.project.export_sections || []).includes("color"),
      );
      if (state.editingColorId && !find(state.editingColorId)) resetForm();
    },
  };
}
