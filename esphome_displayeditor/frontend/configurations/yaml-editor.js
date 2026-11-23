// @ts-check

import {
  cursorPosition,
  editorIsDirty,
  findMatch,
  lineNumbers,
  offsetForLineColumn,
} from "./editor-model.js";

/** @typedef {(key: string, params?: Record<string, unknown>) => string} Translate */
/** @typedef {{activeConfig: string | null, hasDraft: boolean, yamlDirty: boolean,
 * yamlLoadedContent: string}} YamlEditorState */
/**
 * @typedef {{
 *   editor: HTMLTextAreaElement, lineNumbers: HTMLElement, dirtyStatus: HTMLElement,
 *   stateBadge: HTMLElement, cursorStatus: HTMLElement, search: HTMLInputElement,
 *   searchResult: HTMLElement, searchPrevious: HTMLButtonElement, searchNext: HTMLButtonElement,
 * }} YamlEditorElements
 */
/** @typedef {ReturnType<typeof createYamlEditor>} YamlEditor */

/**
 * The YAML text editor of the configuration view: line numbers, cursor
 * position, search, Tab indentation and the unsaved / draft / active status.
 * `onChange` runs whenever that status may have changed.
 * @param {YamlEditorElements} els @param {YamlEditorState} state
 * @param {Translate} t @param {() => void} [onChange]
 */
export function createYamlEditor(els, state, t, onChange = () => {}) {
  const { editor } = els;

  function updateCursorStatus() {
    els.cursorStatus.textContent = t(
      "configs.cursorStatus",
      cursorPosition(editor.value, editor.selectionStart),
    );
  }

  function refresh() {
    els.lineNumbers.textContent = lineNumbers(editor.value);
    state.yamlDirty = editorIsDirty(state.activeConfig, editor.value, state.yamlLoadedContent);
    els.dirtyStatus.classList.toggle("dirty", state.yamlDirty);
    els.dirtyStatus.textContent = !state.activeConfig
      ? t("configs.noFileLoaded")
      : state.yamlDirty
        ? t("configs.unsavedChanges")
        : state.hasDraft ? t("configs.savedDraft") : t("configs.activeState");
    const loaded = Boolean(state.activeConfig);
    els.stateBadge.classList.toggle("hidden", !loaded);
    els.stateBadge.classList.toggle("active-state", loaded && !state.hasDraft);
    els.stateBadge.classList.toggle("draft-state", loaded && state.hasDraft);
    els.stateBadge.textContent = state.hasDraft ? t("configs.savedDraft") : t("configs.activeState");
    updateCursorStatus();
    onChange();
  }

  /** @param {number} direction 1 next, -1 previous, 0 the nearest from the cursor on */
  function find(direction) {
    const query = els.search.value;
    if (!query) {
      els.searchResult.textContent = "";
      return;
    }
    const match = findMatch(editor.value, query, editor.selectionStart, direction);
    if (!match.count) {
      els.searchResult.textContent = t("configs.searchNoMatch");
      return;
    }
    editor.focus();
    editor.setSelectionRange(match.index, match.index + query.length);
    els.searchResult.textContent = t("configs.searchMatchCount", {
      selected: match.selected + 1, count: match.count,
    });
    updateCursorStatus();
  }

  /** `content` - by default the editor's text - is now what is saved; the
   * editor stays unsaved if its text differs. @param {string} [content] */
  function markSaved(content = editor.value) {
    state.yamlLoadedContent = content;
    refresh();
  }

  return {
    bind() {
      editor.addEventListener("input", refresh);
      for (const type of ["click", "keyup", "select"]) {
        editor.addEventListener(type, updateCursorStatus);
      }
      editor.addEventListener("scroll", () => {
        els.lineNumbers.scrollTop = editor.scrollTop;
      });
      editor.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
        refresh();
      });
      els.searchNext.addEventListener("click", () => find(1));
      els.searchPrevious.addEventListener("click", () => find(-1));
      els.search.addEventListener("input", () => find(0));
      els.search.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        find(event.shiftKey ? -1 : 1);
      });
    },
    refresh,
    markSaved,
    /** The text in the editor now, saved or not. */
    content() { return editor.value; },
    /** Show a configuration's saved text. @param {string} content @param {boolean} writable */
    load(content, writable) {
      editor.value = content;
      editor.disabled = !writable;
      for (const control of [els.search, els.searchPrevious, els.searchNext]) control.disabled = false;
      markSaved(content);
    },
    /** Replace the text with one that is already saved. @param {string} content */
    replace(content) {
      editor.value = content;
      markSaved(content);
    },
    /** Put the cursor on a 1-based line and column. @param {number} line @param {number} column */
    jumpTo(line, column) {
      const offset = offsetForLineColumn(editor.value, line, column);
      editor.focus();
      editor.setSelectionRange(offset, offset);
      updateCursorStatus();
    },
  };
}
