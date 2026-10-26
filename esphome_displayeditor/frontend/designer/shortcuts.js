// @ts-check

/**
 * @typedef {{key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean}} KeyLike
 * @typedef {{
 *   typing: boolean,
 *   dialogOpen: boolean,
 *   canvasMode: string,
 *   hasSelection: boolean,
 *   drawing: boolean,
 *   hasSelectedStroke: boolean,
 * }} ShortcutContext
 * @typedef {{command: string, step?: number}} Shortcut
 */

/** Mod+key commands; the value after a "/" is the Shift variant. */
/** @type {Record<string, [string, string?]>} */
const MOD_COMMANDS = {
  z: ["undo", "redo"],
  y: ["redo"],
  s: ["save", "download"],
  o: ["open"],
  n: ["new"],
  e: ["export"],
  d: ["duplicate"],
  c: ["copy"],
  v: ["paste"],
  a: ["selectAll"],
  0: ["fit"],
  1: ["zoomReset"],
  "+": ["zoomIn"],
  "=": ["zoomIn"],
  "-": ["zoomOut"],
};

/**
 * Which designer command a key press means, or null to leave it to the
 * browser.
 *
 * - Nothing fires while a dialog is open: Delete or the arrows used to act on
 *   the selected widget behind the Viewer.
 * - While a text field has focus only Mod+S does: Ctrl+Z there is the
 *   field's own undo, not the whole project's.
 * - Cmd counts like Ctrl, so the shortcuts work on a Mac; Shift+Mod+Z is
 *   redo (it used to undo, because Shift was not looked at).
 *
 * @param {KeyLike} event @param {ShortcutContext} context
 * @returns {Shortcut | null}
 */
export function designerShortcut(event, context) {
  if (context.dialogOpen) return null;
  const mod = Boolean(event.ctrlKey || event.metaKey);
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (mod) {
    if (event.altKey) return null;
    if (context.typing && key !== "s") return null;
    const entry = MOD_COMMANDS[key];
    if (!entry) return null;
    const command = event.shiftKey && entry[1] ? entry[1] : entry[0];
    const needsWidgets = command === "duplicate" || command === "copy" || command === "selectAll";
    if (needsWidgets && context.canvasMode !== "widgets") return null;
    if ((command === "duplicate" || command === "copy") && !context.hasSelection) return null;
    return { command };
  }
  if (context.typing || event.altKey) return null;

  if (context.canvasMode === "lines") {
    if (key === "Escape") return { command: "line.escape" };
    if (key === "Backspace" && context.drawing) return { command: "line.removePoint" };
    if (key === "Enter" && context.drawing) return { command: "line.finish" };
    if (key === "Delete" && context.hasSelectedStroke && !context.drawing) {
      return { command: "line.deleteStroke" };
    }
    if (key === "p") return { command: "line.toolDraw" };
    if (key === "v") return { command: "line.toolSelect" };
    if (key === "Delete") return { command: "delete" };
    return null;
  }

  if (key === "Delete" || key === "Backspace") return { command: "delete" };
  if (!context.hasSelection) return null;
  if (key === "Escape") return { command: "deselect" };
  if (key.startsWith("Arrow")) return { command: "nudge", step: event.shiftKey ? 10 : 1 };
  return null;
}
