import assert from "node:assert/strict";
import test from "node:test";

import { designerShortcut } from "../../frontend/designer/shortcuts.js";

const widgets = {
  typing: false, dialogOpen: false, canvasMode: "widgets",
  hasSelection: true, drawing: false, hasSelectedStroke: false,
};
const command = (event, context = widgets) => designerShortcut(event, context)?.command ?? null;

test("Shift+Mod+Z is redo, and Cmd works like Ctrl", () => {
  assert.equal(command({ key: "z", ctrlKey: true }), "undo");
  assert.equal(command({ key: "Z", ctrlKey: true, shiftKey: true }), "redo");
  assert.equal(command({ key: "y", ctrlKey: true }), "redo");
  assert.equal(command({ key: "z", metaKey: true }), "undo");
  assert.equal(command({ key: "z", metaKey: true, shiftKey: true }), "redo");
});

test("Mod+S saves into the app; Shift+Mod+S downloads the file", () => {
  assert.equal(command({ key: "s", ctrlKey: true }), "save");
  assert.equal(command({ key: "s", metaKey: true, shiftKey: true }), "download");
});

test("nothing fires while a dialog is open", () => {
  const behindDialog = { ...widgets, dialogOpen: true };
  assert.equal(command({ key: "Delete" }, behindDialog), null);
  assert.equal(command({ key: "ArrowLeft" }, behindDialog), null);
  assert.equal(command({ key: "z", ctrlKey: true }, behindDialog), null);
});

test("while typing only Mod+S fires - the field keeps its own undo", () => {
  const typing = { ...widgets, typing: true };
  assert.equal(command({ key: "z", ctrlKey: true }, typing), null);
  assert.equal(command({ key: "Delete" }, typing), null);
  assert.equal(command({ key: "Backspace" }, typing), null);
  assert.equal(command({ key: "s", ctrlKey: true }, typing), "save");
});

test("Delete and Backspace delete, arrows nudge with Shift for 10px", () => {
  assert.equal(command({ key: "Delete" }), "delete");
  assert.equal(command({ key: "Backspace" }), "delete");
  assert.deepEqual(designerShortcut({ key: "ArrowUp", shiftKey: true }, widgets), { command: "nudge", step: 10 });
  assert.deepEqual(designerShortcut({ key: "ArrowUp" }, widgets), { command: "nudge", step: 1 });
  assert.equal(command({ key: "Escape" }), "deselect");
  assert.equal(command({ key: "ArrowUp" }, { ...widgets, hasSelection: false }), null);
});

test("copy, paste, duplicate and select-all", () => {
  assert.equal(command({ key: "c", ctrlKey: true }), "copy");
  assert.equal(command({ key: "v", metaKey: true }), "paste");
  assert.equal(command({ key: "d", ctrlKey: true }), "duplicate");
  assert.equal(command({ key: "a", ctrlKey: true }), "selectAll");
  const nothingSelected = { ...widgets, hasSelection: false };
  assert.equal(command({ key: "c", ctrlKey: true }, nothingSelected), null);
  assert.equal(command({ key: "v", ctrlKey: true }, nothingSelected), "paste");
});

test("glow-line mode keeps its own keys", () => {
  const lines = { ...widgets, canvasMode: "lines", hasSelection: false };
  assert.equal(command({ key: "p" }, lines), "line.toolDraw");
  assert.equal(command({ key: "V" }, lines), "line.toolSelect");
  assert.equal(command({ key: "Escape" }, lines), "line.escape");
  assert.equal(command({ key: "Backspace" }, { ...lines, drawing: true }), "line.removePoint");
  assert.equal(command({ key: "Enter" }, { ...lines, drawing: true }), "line.finish");
  assert.equal(command({ key: "Delete" }, { ...lines, hasSelectedStroke: true }), "line.deleteStroke");
  assert.equal(command({ key: "ArrowUp" }, lines), null);
  assert.equal(command({ key: "c", ctrlKey: true }, lines), null);
});

test("zoom keys and unknown combinations", () => {
  assert.equal(command({ key: "0", ctrlKey: true }), "fit");
  assert.equal(command({ key: "1", ctrlKey: true }), "zoomReset");
  assert.equal(command({ key: "=", ctrlKey: true }), "zoomIn");
  assert.equal(command({ key: "-", ctrlKey: true }), "zoomOut");
  assert.equal(command({ key: "q", ctrlKey: true }), null);
  assert.equal(command({ key: "z", ctrlKey: true, altKey: true }), null);
});
