import assert from "node:assert/strict";
import test from "node:test";

import { applyViewerAction, evaluateViewerCondition } from "../../frontend/viewer/action-interpreter.js";
import { ViewerSimulation, describeCondition, triggerPayloadMatches } from "../../frontend/viewer/simulation.js";

/** The test-2 flow: a state machine walked by NEXT/STOP, a switch showing buttons. */
const SCENARIOS = [
  { name: "AUTO", actions: [{ "lvgl.label.update": { id: "next_label", text: "START" } }] },
  { name: "TR0", actions: [{ "lvgl.label.update": { id: "next_label", text: "TR0" } }] },
  { name: "TR1", actions: [{ "lvgl.label.update": { id: "next_label", text: "TR1" } }] },
  {
    name: "Eingang NEXT", actions: [], initial: "AUTO",
    on: { name: "state_machine.transition", payload: "NEXT" },
    transitions: { AUTO: "TR0", TR0: "TR1", TR1: "AUTO" },
  },
  {
    name: "Eingang STOP", actions: [],
    on: { name: "state_machine.transition", payload: "STOP" },
    transitions: { TR0: "AUTO", TR1: "AUTO" },
  },
  {
    name: "board_detected an", actions: [{ "lvgl.widget.show": "next_button" }],
    on: { name: "switch.turn_on", payload: "board_detected" },
  },
];

test("transition tables walk from the initial state", () => {
  const sim = new ViewerSimulation();
  sim.setScenarios(SCENARIOS);
  assert.equal(sim.state, "AUTO");

  const first = sim.triggered("state_machine.transition", "NEXT");
  assert.deepEqual(first.plays.map((p) => p.scenario.name), ["TR0"]);
  sim.played(first.plays[0].scenario);
  assert.equal(sim.state, "TR0");

  const stop = sim.triggered("state_machine.transition", "STOP");
  assert.deepEqual(stop.plays.map((p) => p.scenario.name), ["AUTO"]);
  sim.played(stop.plays[0].scenario);

  // A real state machine ignores STOP while idle.
  const idle = sim.triggered("state_machine.transition", "STOP");
  assert.deepEqual(idle.plays, []);
  assert.deepEqual(idle.ignored.map((s) => s.name), ["Eingang STOP"]);
});

test("switch actions are remembered and answer switch conditions", () => {
  const sim = new ViewerSimulation();
  sim.setScenarios(SCENARIOS);
  assert.equal(sim.resolveCondition({ "switch.is_on": "board_detected" }).known, false);

  const plays = sim.triggered("switch.turn_on", "board_detected").plays;
  assert.deepEqual(plays.map((p) => p.scenario.name), ["board_detected an"]);
  assert.deepEqual(sim.resolveCondition({ "switch.is_on": "board_detected" }), { known: true, value: true });
  assert.deepEqual(sim.resolveCondition({ "switch.is_off": { id: "board_detected" } }), { known: true, value: false });

  sim.reset();
  assert.equal(sim.resolveCondition({ "switch.is_on": "board_detected" }).known, false);
});

test("answers are kept per condition until reset", () => {
  const sim = new ViewerSimulation();
  const condition = { lambda: 'return id(light).state == "gut";' };
  const open = sim.resolveCondition(condition);
  assert.equal(open.known, false);
  assert.equal(open.label, 'return id(light).state == "gut";');
  sim.answer(open.known ? "" : open.key, true);
  assert.deepEqual(sim.resolveCondition(condition), { known: true, value: true });
});

test("and/or/not combine, and known parts decide without asking", () => {
  const sim = new ViewerSimulation();
  const context = { resolveCondition: (/** @type {any} */ c) => sim.resolveCondition(c) };
  const unknown = { lambda: "return millis() > 2000;" };

  const pending = evaluateViewerCondition({ and: [unknown, { lambda: "return x;" }] }, { ...context, x: true });
  assert.equal(pending.supported, false);
  assert.equal(pending.pending?.label, "return millis() > 2000;");

  // A known false decides an `and`; a known true decides an `or`.
  assert.deepEqual(evaluateViewerCondition({ and: [unknown, { lambda: "return x;" }] }, { ...context, x: false }),
    { supported: true, value: false });
  assert.deepEqual(evaluateViewerCondition({ or: [unknown, { lambda: "return x;" }] }, { ...context, x: true }),
    { supported: true, value: true });
  assert.deepEqual(evaluateViewerCondition({ not: { lambda: "return x;" } }, { x: true }),
    { supported: true, value: false });
});

test("an if with an open condition reports it instead of skipping", () => {
  const sim = new ViewerSimulation();
  const action = { if: { condition: [{ lambda: "return ready();" }], then: [{ "lvgl.page.next": {} }] } };
  const context = { resolveCondition: (/** @type {any} */ c) => sim.resolveCondition(c) };

  const result = applyViewerAction({ pages: [] }, action, {}, context);

  assert.equal(result.handled, false);
  assert.equal(result.pending?.label, "return ready();");
});

test("unsupported actions are offered to the simulation first", () => {
  const seen = [];
  const result = applyViewerAction({ pages: [] }, { "state_machine.transition": "NEXT" }, {}, {
    onUnsupportedAction: (/** @type {string} */ name, /** @type {any} */ payload) => {
      seen.push([name, payload]);
      return { handled: true, changed: true, message: "played" };
    },
  });
  assert.deepEqual(seen, [["state_machine.transition", "NEXT"]]);
  assert.equal(result.message, "played");
});

test("trigger payloads match by value, id or input", () => {
  assert.equal(triggerPayloadMatches("NEXT", "NEXT"), true);
  assert.equal(triggerPayloadMatches("NEXT", { id: "sm", input: "NEXT" }), true);
  assert.equal(triggerPayloadMatches(null, "anything"), true);
  assert.equal(triggerPayloadMatches("NEXT", "STOP"), false);
  assert.equal(describeCondition({ "switch.is_on": "x" }), "switch.is_on: x");
});
