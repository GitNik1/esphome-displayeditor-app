import assert from "node:assert/strict";
import test from "node:test";
import { createBasicPropertyControl } from "../../frontend/properties/view.js";

class FakeOption { constructor(text, value) { this.text = text; this.value = value; } }
globalThis.Option = FakeOption;
const document = { createElement: (tag) => ({ tag, append(...items) { this.items = [...(this.items || []), ...items]; } }) };

test("basic property view creates boolean and numeric controls", () => {
  const bool = createBasicPropertyControl(document, { kind: "bool", default: false }, true);
  const number = createBasicPropertyControl(document, { kind: "float", default: 1 }, 2.5);
  assert.equal(bool.checked, true);
  assert.equal(number.type, "number");
  assert.equal(number.step, "any");
});

test("basic property view preserves unknown enum values and lists", () => {
  const select = createBasicPropertyControl(document, { kind: "enum", enum_values: ["A"] }, "B");
  const list = createBasicPropertyControl(document, { kind: "text_list", default: null }, ["a", "b"]);
  assert.equal(select.items.at(-1).value, "B");
  assert.equal(list.value, "a, b");
});

test("basic property view creates formatted JSON textareas", () => {
  const control = createBasicPropertyControl(document, { kind: "json", default: [] }, [{ range_from: 0 }]);
  assert.equal(control.tag, "textarea");
  assert.deepEqual(JSON.parse(control.value), [{ range_from: 0 }]);
});
