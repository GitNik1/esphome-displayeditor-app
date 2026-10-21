// @ts-check

/**
 * What the Viewer remembers while simulating a device it cannot run:
 *
 * - answers to conditions the browser cannot evaluate (a C++ lambda,
 *   `lvgl.is_paused`), asked once and kept until "Reset";
 * - template switch states, learnt from `switch.turn_on/off/toggle`, so
 *   `switch.is_on` conditions answer themselves;
 * - the current state of scenario transition tables (`transitions:`), so a
 *   trigger like `state_machine.transition: NEXT` walks AUTO -> TR0 -> TR1;
 * - which scenarios a skipped action (`on:`) should play instead.
 *
 * Pure: no DOM, no network. The ViewerController owns one instance.
 */

/** @typedef {{name: string, payload: any}} ScenarioTrigger */
/** @typedef {{name: string, actions: any[], on?: ScenarioTrigger,
 * transitions?: Record<string, string>, initial?: string}} SimScenario */
/** @typedef {{known: true, value: boolean} | {known: false, key: string, label: string}} ConditionAnswer */

/** @param {unknown} value */
function stable(value) {
  return JSON.stringify(value, (_key, item) => (
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  ));
}

/** Readable form of a condition for the question shown to the user.
 * @param {any} condition @returns {string} */
export function describeCondition(condition) {
  if (typeof condition === "string") return condition;
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    const [[name, payload]] = Object.entries(condition);
    if (name === "lambda") {
      const code = payload && typeof payload === "object" ? payload.__esphome_lambda__ : payload;
      return String(code ?? "").trim();
    }
    return `${name}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`;
  }
  return JSON.stringify(condition);
}

/** Whether an action's payload matches a trigger's: equal, or the trigger
 * names the action's `id`/`input` (`state_machine.transition: {input: NEXT}`).
 * @param {any} wanted @param {any} actual */
export function triggerPayloadMatches(wanted, actual) {
  if (wanted === null || wanted === undefined) return true;
  if (stable(wanted) === stable(actual)) return true;
  if (typeof wanted === "string" && actual && typeof actual === "object") {
    return actual.input === wanted || actual.id === wanted;
  }
  return false;
}

/** @param {any} payload @returns {string} */
function switchId(payload) {
  if (typeof payload === "string") return payload;
  return payload && typeof payload === "object" && typeof payload.id === "string" ? payload.id : "";
}

export class ViewerSimulation {
  constructor() {
    /** @type {SimScenario[]} */ this.scenarios = [];
    /** @type {Map<string, boolean>} */ this.answers = new Map();
    /** @type {Map<string, boolean>} */ this.switches = new Map();
    this.state = "";
  }

  /** @param {SimScenario[]} scenarios */
  setScenarios(scenarios) {
    this.scenarios = Array.isArray(scenarios) ? scenarios : [];
    this.reset();
  }

  reset() {
    this.answers.clear();
    this.switches.clear();
    const table = this.scenarios.find((scenario) => scenario.transitions);
    this.state = table ? (table.initial || Object.keys(table.transitions || {})[0] || "") : "";
  }

  /** @param {string} name @returns {SimScenario | undefined} */
  find(name) {
    return this.scenarios.find((scenario) => scenario.name === name);
  }

  /** Scenario names that act as states of some transition table. */
  stateNames() {
    const names = new Set();
    this.scenarios.forEach((scenario) => {
      Object.entries(scenario.transitions || {}).forEach(([from, to]) => { names.add(from); names.add(to); });
    });
    return names;
  }

  /** Record that a scenario was played; a state scenario becomes current.
   * @param {SimScenario} scenario */
  played(scenario) {
    if (this.stateNames().has(scenario.name)) this.state = scenario.name;
  }

  /** A condition the interpreter could not evaluate natively.
   * @param {any} condition @returns {ConditionAnswer} */
  resolveCondition(condition) {
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      const [[name, payload]] = Object.entries(condition);
      const id = switchId(payload);
      if ((name === "switch.is_on" || name === "switch.is_off") && this.switches.has(id)) {
        const on = Boolean(this.switches.get(id));
        return { known: true, value: name === "switch.is_on" ? on : !on };
      }
    }
    const key = stable(condition);
    if (this.answers.has(key)) return { known: true, value: Boolean(this.answers.get(key)) };
    return { known: false, key, label: describeCondition(condition) };
  }

  /** @param {string} key @param {boolean} value */
  answer(key, value) {
    this.answers.set(key, value);
  }

  /**
   * The scenarios to play for an action the browser cannot run, in order,
   * and the transition tables that had no entry for the current state (a
   * real state machine ignores such an input, too). Also learns switch
   * states from switch actions.
   * @param {string} name @param {any} payload
   * @returns {{plays: {scenario: SimScenario, via?: SimScenario}[], ignored: SimScenario[]}}
   */
  triggered(name, payload) {
    const id = switchId(payload);
    if (id && name === "switch.turn_on") this.switches.set(id, true);
    if (id && name === "switch.turn_off") this.switches.set(id, false);
    if (id && name === "switch.toggle") this.switches.set(id, !this.switches.get(id));

    /** @type {{scenario: SimScenario, via?: SimScenario}[]} */
    const plays = [];
    /** @type {SimScenario[]} */
    const ignored = [];
    for (const scenario of this.scenarios) {
      if (!scenario.on || scenario.on.name !== name || !triggerPayloadMatches(scenario.on.payload, payload)) continue;
      if (!scenario.transitions) {
        plays.push({ scenario });
        continue;
      }
      const target = scenario.transitions[this.state];
      const next = target ? this.find(target) : undefined;
      if (next) plays.push({ scenario: next, via: scenario });
      else ignored.push(scenario);
    }
    return { plays, ignored };
  }
}
