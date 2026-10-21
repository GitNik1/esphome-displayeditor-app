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
  if (condition && typeof condition === "object" && !Array.isArray(condition)
      && Object.keys(condition).length === 1) {
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

/** Union the state names of transition tables that share a state.
 * @param {SimScenario[]} scenarios @returns {Map<string, number>} */
function groupStates(scenarios) {
  /** @type {Map<string, string>} */
  const parent = new Map();
  const find = (/** @type {string} */ name) => {
    let root = name;
    while (parent.get(root) !== root) root = /** @type {string} */ (parent.get(root));
    parent.set(name, root);
    return root;
  };
  const add = (/** @type {string} */ name) => { if (!parent.has(name)) parent.set(name, name); };
  for (const scenario of scenarios) {
    const names = Object.entries(scenario.transitions || {}).flat();
    if (scenario.transitions && scenario.initial) names.push(scenario.initial);
    names.forEach(add);
    for (let index = 1; index < names.length; index += 1) {
      const a = find(names[0]);
      const b = find(names[index]);
      if (a !== b) parent.set(b, a);
    }
  }
  /** @type {Map<string, number>} */
  const groups = new Map();
  /** @type {Map<string, number>} */
  const ids = new Map();
  for (const name of parent.keys()) {
    const root = find(name);
    if (!ids.has(root)) ids.set(root, ids.size);
    groups.set(name, /** @type {number} */ (ids.get(root)));
  }
  return groups;
}

export class ViewerSimulation {
  constructor() {
    /** @type {SimScenario[]} */ this.scenarios = [];
    /** @type {Map<string, boolean>} */ this.answers = new Map();
    /** @type {Map<string, boolean>} */ this.switches = new Map();
    /** State name -> its group: the transition tables that share states
     * form one state machine; independent machines keep separate states.
     * @type {Map<string, number>} */ this.groupOf = new Map();
    /** @type {Map<number, string>} */ this.states = new Map();
  }

  /** The current state of the first state machine ("" without one). */
  get state() {
    return this.states.get(0) || "";
  }

  /** @param {SimScenario[]} scenarios */
  setScenarios(scenarios) {
    this.scenarios = Array.isArray(scenarios) ? scenarios : [];
    this.groupOf = groupStates(this.scenarios);
    this.reset();
  }

  reset() {
    this.answers.clear();
    this.switches.clear();
    this.states.clear();
    // Per machine: the first `initial:` any of its tables states, else the
    // first state of its first table.
    /** @type {Map<number, string>} */
    const declared = new Map();
    for (const table of this.scenarios) {
      const first = Object.keys(table.transitions || {})[0];
      const group = first === undefined ? undefined : this.groupOf.get(first);
      if (first === undefined || group === undefined) continue;
      if (!this.states.has(group)) this.states.set(group, first);
      if (table.initial && !declared.has(group)) declared.set(group, table.initial);
    }
    declared.forEach((name, group) => this.states.set(group, name));
  }

  /** Current state of the machine a transition table belongs to.
   * @param {SimScenario} table */
  stateFor(table) {
    const name = Object.keys(table.transitions || {})[0];
    const group = name === undefined ? undefined : this.groupOf.get(name);
    return group === undefined ? "" : this.states.get(group) || "";
  }

  /** @param {string} name @returns {SimScenario | undefined} */
  find(name) {
    return this.scenarios.find((scenario) => scenario.name === name);
  }

  /** Record that a scenario was played; a state scenario becomes the
   * current state of its machine.
   * @param {SimScenario} scenario */
  played(scenario) {
    const group = this.groupOf.get(scenario.name);
    if (group !== undefined) this.states.set(group, scenario.name);
  }

  /** A condition the interpreter could not evaluate natively.
   * @param {any} condition @returns {ConditionAnswer} */
  resolveCondition(condition) {
    if (condition && typeof condition === "object" && !Array.isArray(condition)
        && Object.keys(condition).length === 1) {
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

  /** Switch and machine states, to undo a run that stopped at a question:
   * replaying it must not toggle a switch or advance a machine twice.
   * Answers are deliberately not part of it - they are what the replay needs. */
  snapshot() {
    return { switches: new Map(this.switches), states: new Map(this.states) };
  }

  /** @param {{switches: Map<string, boolean>, states: Map<number, string>}} saved */
  restore(saved) {
    this.switches = new Map(saved.switches);
    this.states = new Map(saved.states);
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
    // A toggle runs the switch's own turn_on/turn_off action for the state
    // it ends up in.
    const names = new Set([name]);
    if (id && name === "switch.toggle") {
      const on = !this.switches.get(id);
      this.switches.set(id, on);
      names.add(on ? "switch.turn_on" : "switch.turn_off");
    }

    /** @type {{scenario: SimScenario, via?: SimScenario}[]} */
    const plays = [];
    /** @type {SimScenario[]} */
    const ignored = [];
    for (const scenario of this.scenarios) {
      if (!scenario.on || !names.has(scenario.on.name) || !triggerPayloadMatches(scenario.on.payload, payload)) continue;
      if (!scenario.transitions) {
        plays.push({ scenario });
        continue;
      }
      const target = scenario.transitions[this.stateFor(scenario)];
      const next = target ? this.find(target) : undefined;
      if (next) plays.push({ scenario: next, via: scenario });
      else ignored.push(scenario);
    }
    return { plays, ignored };
  }
}
