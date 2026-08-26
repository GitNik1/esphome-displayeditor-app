import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { computeLayout } from "../../frontend/layout.js";
import { surfaceLayoutProject } from "../../frontend/project/surfaces.js";

const fixtures = JSON.parse(readFileSync(
  new URL("../data/layout_parity.json", import.meta.url),
  "utf8",
));

function widgetsById(nodes, result = new Map()) {
  (nodes || []).forEach((widget) => {
    result.set(widget.id, widget);
    widgetsById(widget.children, result);
  });
  return result;
}

function normalized(box) {
  const rounded = (value) => Number(value.toFixed(6));
  return {
    left: rounded(box.left),
    top: rounded(box.top),
    width: rounded(box.width),
    height: rounded(box.height),
    managed: box.managed,
    origin_x: rounded(box.originX),
    origin_y: rounded(box.originY),
  };
}

function projectForFixture(fixture) {
  const key = fixture.surface || "root";
  if (key === "root") return fixture.project;
  const surface = key.startsWith("page:")
    ? fixture.project.pages.find((item) => item.id === key.slice(5))
    : fixture.project[`${key}_layer`];
  return surfaceLayoutProject(fixture.project, {
    kind: key.startsWith("page:") ? "page" : key,
    surface,
  });
}

fixtures.forEach((fixture) => {
  test(`browser layout matches shared fixture: ${fixture.name}`, () => {
    const project = projectForFixture(fixture);
    const boxes = computeLayout(project);
    const widgets = widgetsById(project.widgets);
    const actual = Object.fromEntries(
      [...widgets].map(([id, widget]) => [id, normalized(boxes.get(widget))]),
    );
    assert.deepEqual(actual, fixture.expected);
  });
});
