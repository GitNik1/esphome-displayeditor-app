export function cloneProject(project) {
  return JSON.parse(JSON.stringify(project));
}

export function pushHistory(undo, project, limit = 50) {
  const next = [...undo];
  const serialized = JSON.stringify(project);
  if (next[next.length - 1] !== serialized) next.push(serialized);
  while (next.length > limit) next.shift();
  return next;
}

export function undoHistory(undo, redo, currentProject) {
  if (!undo.length) return null;
  const nextUndo = [...undo];
  const project = JSON.parse(nextUndo.pop());
  return {
    project,
    undo: nextUndo,
    redo: [...redo, JSON.stringify(currentProject)],
  };
}

export function redoHistory(undo, redo, currentProject) {
  if (!redo.length) return null;
  const nextRedo = [...redo];
  const project = JSON.parse(nextRedo.pop());
  return {
    project,
    undo: [...undo, JSON.stringify(currentProject)],
    redo: nextRedo,
  };
}

