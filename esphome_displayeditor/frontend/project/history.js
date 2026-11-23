// @ts-check

/** @template T @param {T} project @returns {T} */
export function cloneProject(project) {
  return /** @type {T} */ (JSON.parse(JSON.stringify(project)));
}

/**
 * @param {string[]} undo
 * @param {unknown} project
 * @param {number} [limit]
 * @returns {string[]}
 */
export function pushHistory(undo, project, limit = 50) {
  const next = [...undo];
  const serialized = JSON.stringify(project);
  if (next[next.length - 1] !== serialized) next.push(serialized);
  while (next.length > limit) next.shift();
  return next;
}

/**
 * Turn a snapshot taken *before a possible change* into an undo step - only
 * if the project really differs from it now. Selecting a widget or focusing
 * a field takes such a snapshot just in case; committing it right away
 * emptied the redo stack on a mere click and pushed steps that undid
 * nothing.
 * @param {string[]} undo @param {string[]} redo
 * @param {string | null} pending serialized snapshot, or null
 * @param {unknown} currentProject @param {number} [limit]
 * @returns {{undo: string[], redo: string[], committed: boolean}}
 */
export function commitPendingUndo(undo, redo, pending, currentProject, limit = 50) {
  if (pending === null || pending === JSON.stringify(currentProject)) {
    return { undo, redo, committed: false };
  }
  const next = [...undo];
  if (next[next.length - 1] !== pending) next.push(pending);
  while (next.length > limit) next.shift();
  return { undo: next, redo: [], committed: true };
}

/**
 * @template T
 * @param {string[]} undo @param {string[]} redo @param {T} currentProject
 * @returns {{project: T, undo: string[], redo: string[]} | null}
 */
export function undoHistory(undo, redo, currentProject) {
  if (!undo.length) return null;
  const nextUndo = [...undo];
  const serialized = nextUndo.pop();
  if (serialized === undefined) return null;
  const project = /** @type {T} */ (JSON.parse(serialized));
  return {
    project,
    undo: nextUndo,
    redo: [...redo, JSON.stringify(currentProject)],
  };
}

/**
 * @template T
 * @param {string[]} undo @param {string[]} redo @param {T} currentProject
 * @returns {{project: T, undo: string[], redo: string[]} | null}
 */
export function redoHistory(undo, redo, currentProject) {
  if (!redo.length) return null;
  const nextRedo = [...redo];
  const serialized = nextRedo.pop();
  if (serialized === undefined) return null;
  const project = /** @type {T} */ (JSON.parse(serialized));
  return {
    project,
    undo: [...undo, JSON.stringify(currentProject)],
    redo: nextRedo,
  };
}
