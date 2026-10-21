import assert from "node:assert/strict";
import test from "node:test";

import { customActionYaml, namedParams } from "../../frontend/actions/custom-yaml.js";
import { createCustomActionView } from "../../frontend/actions/view.js";
import { createCustomActionController } from "../../frontend/controllers/custom-action-controller.js";
import { createDebouncer } from "../../frontend/services/debounce.js";

// --- a minimal DOM, enough for the view ---------------------------------------

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.className = "";
    this.value = "";
    this.textContent = "";
    this.checked = false;
    this.listeners = {};
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
  }

  append(...items) {
    items.forEach((item) => { item.parent = this; this.children.push(item); });
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }

  replaceChildren() { this.children = []; }

  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }

  fire(type) { (this.listeners[type] || []).forEach((listener) => listener()); }

  querySelectorAll(selector) {
    const wanted = selector.slice(1);
    const found = [];
    const walk = (node) => node.children.forEach((child) => {
      if (child.className.split(" ").includes(wanted)) found.push(child);
      walk(child);
    });
    walk(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const fakeDocument = { createElement: (tag) => new FakeElement(tag) };
const t = (key) => key;

function elements() {
  return {
    nameField: new FakeElement(), nameInput: new FakeElement("input"),
    paramsContainer: new FakeElement(), addParamButton: new FakeElement("button"),
    rawToggle: new FakeElement("input"), rawField: new FakeElement(),
    rawTextarea: new FakeElement("textarea"), preview: new FakeElement(), error: new FakeElement(),
  };
}

/** Let pending promise callbacks (the API answer, the view update) run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A debouncer whose pending task the test runs by hand. */
function manualDebouncer() {
  let pending = null;
  return {
    run(task) { pending = task; },
    cancel() { pending = null; },
    flush() { const task = pending; pending = null; task?.(); },
    get pending() { return pending; },
  };
}

function setup(apiImpl) {
  const els = elements();
  const view = createCustomActionView(fakeDocument, els, t);
  const calls = [];
  const api = async (path, init) => {
    calls.push({ path, content: JSON.parse(init.body).content });
    return apiImpl(JSON.parse(init.body).content);
  };
  const debouncer = manualDebouncer();
  const editor = createCustomActionController(view, api, debouncer);
  return { els, view, editor, calls, debouncer };
}

// --- the YAML spelling ----------------------------------------------------------

test("the YAML spells name and named parameters, the raw text wins in raw mode", () => {
  const params = [{ name: " brightness ", value: "50%" }, { name: "  ", value: "dropped" }];

  assert.equal(customActionYaml({ raw: false, rawText: "", name: " light.turn_on ", params }),
    "light.turn_on:\n  brightness: 50%");
  assert.equal(customActionYaml({ raw: false, rawText: "", name: "script.execute", params: [] }),
    "script.execute:");
  assert.equal(customActionYaml({ raw: false, rawText: "", name: "  ", params }), "");
  assert.equal(customActionYaml({ raw: true, rawText: "a: {b: 1}", name: "ignored", params }), "a: {b: 1}");
  assert.deepEqual(namedParams(params), [{ name: "brightness", value: "50%" }]);
});

// --- the timer service ------------------------------------------------------------

test("the debouncer runs only the last task, once", () => {
  const timers = new Map();
  let next = 1;
  const debouncer = createDebouncer(250, {
    setTimer: (task, delay) => { assert.equal(delay, 250); timers.set(next, task); return next++; },
    clearTimer: (handle) => timers.delete(handle),
  });
  const ran = [];

  debouncer.run(() => ran.push("first"));
  debouncer.run(() => ran.push("second"));
  assert.equal(timers.size, 1);
  const [[handle, task]] = timers;  // a fired timer is gone, like a real one
  timers.delete(handle);
  task();
  assert.deepEqual(ran, ["second"]);

  debouncer.run(() => ran.push("third"));
  debouncer.cancel();
  assert.equal(timers.size, 0);
});

// --- the view -------------------------------------------------------------------------

test("the view adds, reports and removes parameter rows", () => {
  const els = elements();
  const view = createCustomActionView(fakeDocument, els, t);
  let changes = 0;

  const row = view.addParamRow(() => { changes += 1; });
  const [nameInput, valueInput, remove] = row.children;
  assert.equal(nameInput.placeholder, "actions.custom.paramName");
  nameInput.value = "id";
  valueInput.value = "my_light";
  nameInput.fire("input");
  els.nameInput.value = "light.toggle";

  assert.deepEqual(view.fields(), {
    raw: false, rawText: "", name: "light.toggle", params: [{ name: "id", value: "my_light" }],
  });
  remove.fire("click");
  assert.deepEqual(view.params(), []);
  assert.equal(changes, 2);
});

test("the view switches raw mode and shows preview, error and reset", () => {
  const els = elements();
  const view = createCustomActionView(fakeDocument, els, t);

  view.setRawMode(true);
  assert.equal(els.rawToggle.checked, true);
  assert.equal(els.rawField.classList.contains("hidden"), false);
  assert.equal(els.nameField.classList.contains("hidden"), true);

  view.showError("kaputt");
  assert.equal(els.error.textContent, "kaputt");
  assert.equal(els.error.classList.contains("hidden"), false);
  view.showPreview("a: 1");
  assert.equal(els.preview.textContent, "a: 1");
  assert.equal(els.error.classList.contains("hidden"), true);

  view.addParamRow(() => {});
  view.reset();
  assert.equal(els.preview.textContent, "");
  assert.equal(els.paramsContainer.children.length, 0);
  assert.equal(els.rawToggle.checked, false);
});

// --- the controller ---------------------------------------------------------------------

test("a scheduled preview validates the typed action through the API", async () => {
  const { els, editor, calls, debouncer } = setup(async () => ({ yaml: "light.toggle:\n  id: lamp\n" }));
  els.nameInput.value = "light.toggle";
  const row = editor.addParamRow();
  row.children[0].value = "id";
  row.children[1].value = "lamp";

  editor.schedulePreview();
  debouncer.flush();
  await settle();

  assert.deepEqual(calls, [{ path: "designer/bindings/custom-yaml/validate", content: "light.toggle:\n  id: lamp" }]);
  assert.equal(els.preview.textContent, "light.toggle:\n  id: lamp\n");
  assert.deepEqual(editor.paramRows(), [{ name: "id", value: "lamp" }]);
});

test("a rejected preview shows the backend's message", async () => {
  const { els, editor, debouncer } = setup(async () => { throw new Error("Unbekannte Aktion"); });
  els.nameInput.value = "nonsense";

  editor.schedulePreview();
  debouncer.flush();
  await settle();

  assert.equal(els.error.textContent, "Unbekannte Aktion");
  assert.equal(els.error.classList.contains("hidden"), false);
  assert.equal(els.preview.textContent, "");
});

test("an empty editor clears the preview without calling the API", async () => {
  const { els, editor, calls } = setup(async () => ({ yaml: "x" }));
  els.preview.textContent = "stale";

  await editor.renderPreview();

  assert.deepEqual(calls, []);
  assert.equal(els.preview.textContent, "");
});

test("validateAndBuild returns the parsed action and refuses an empty editor", async () => {
  const { els, editor } = setup(async () => ({ action: { "script.execute": "wake" } }));

  await assert.rejects(editor.validateAndBuild(), /missing_custom_action_name/);
  els.nameInput.value = "script.execute";
  assert.deepEqual(await editor.validateAndBuild(), { "script.execute": "wake" });
});

test("loading existing YAML opens raw mode and previews it", async () => {
  const { els, editor, calls } = setup(async () => ({ yaml: "a: 1\n" }));

  editor.loadFromYaml("a: 1");
  await settle();

  assert.equal(els.rawToggle.checked, true);
  assert.equal(els.rawTextarea.value, "a: 1");
  assert.deepEqual(calls.map((call) => call.content), ["a: 1"]);
});

test("reset drops a preview still waiting", () => {
  const { els, editor, debouncer } = setup(async () => ({ yaml: "x" }));
  els.nameInput.value = "light.toggle";

  editor.schedulePreview();
  editor.reset();

  assert.equal(debouncer.pending, null);
  assert.equal(els.nameInput.value, "");
});
