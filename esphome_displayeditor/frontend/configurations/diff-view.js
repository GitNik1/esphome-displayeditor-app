// @ts-check

/** @typedef {{text: string, kind: "header"|"hunk"|"context"|"added"|"deleted"|"changed-old"|"changed-new"}} DiffLine */

/** Parse unified diff text and pair adjacent remove/add runs as modifications.
 * @param {string} text @returns {DiffLine[]} */
export function parseUnifiedDiff(text) {
  /** @type {DiffLine[]} */
  const lines = text.split("\n").map((line) => ({
    text: line,
    kind: line.startsWith("@@") ? "hunk"
      : line.startsWith("---") || line.startsWith("+++") ? "header"
        : line.startsWith("+") ? "added"
          : line.startsWith("-") ? "deleted" : "context",
  }));
  for (let index = 0; index < lines.length;) {
    if (lines[index].kind !== "deleted") { index += 1; continue; }
    const deletedStart = index;
    while (lines[index]?.kind === "deleted") index += 1;
    const addedStart = index;
    while (lines[index]?.kind === "added") index += 1;
    if (addedStart === index) continue;
    for (let cursor = deletedStart; cursor < addedStart; cursor += 1) lines[cursor].kind = "changed-old";
    for (let cursor = addedStart; cursor < index; cursor += 1) lines[cursor].kind = "changed-new";
  }
  return lines;
}

/** @param {HTMLElement} output @param {string} diff @param {(key: string) => string} translate */
export function renderUnifiedDiff(output, diff, translate) {
  output.replaceChildren();
  output.classList.add("diff-output");
  const legend = document.createElement("div");
  legend.className = "diff-legend";
  [
    ["added", translate("diff.legend.added")],
    ["deleted", translate("diff.legend.deleted")],
    ["changed", translate("diff.legend.changed")],
  ].forEach(([kind, label]) => {
    const item = document.createElement("span");
    item.className = `diff-legend-item ${kind}`;
    item.textContent = label;
    legend.append(item);
  });
  output.append(legend);
  const body = document.createElement("code");
  body.className = "diff-lines";
  parseUnifiedDiff(diff).forEach((line) => {
    const row = document.createElement("span");
    row.className = `diff-line diff-${line.kind}`;
    row.textContent = line.text || " ";
    body.append(row);
  });
  output.append(body);
}
