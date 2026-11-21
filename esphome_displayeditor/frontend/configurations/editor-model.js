// @ts-check

/** @param {string} content */
export function lineNumbers(content) {
  return Array.from(
    { length: content.split("\n").length },
    (_unused, index) => String(index + 1),
  ).join("\n");
}

/**
 * @param {string | null} activeConfig
 * @param {string} content
 * @param {string} loadedContent
 */
export function editorIsDirty(activeConfig, content, loadedContent) {
  return Boolean(activeConfig) && content !== loadedContent;
}

/** @param {string} content @param {number} selectionStart */
export function cursorPosition(content, selectionStart) {
  const lines = content.slice(0, selectionStart).split("\n");
  return { line: lines.length, column: (lines.at(-1) ?? "").length + 1 };
}

/**
 * @param {string} content
 * @param {string} query
 * @param {number} selectionStart
 * @param {number} direction
 */
export function findMatch(content, query, selectionStart, direction) {
  if (!query) return { count: 0, selected: -1, index: -1 };
  const haystack = content.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  /** @type {number[]} */
  const matches = [];
  for (
    let index = haystack.indexOf(needle);
    index >= 0;
    index = haystack.indexOf(needle, index + Math.max(needle.length, 1))
  ) {
    matches.push(index);
  }
  if (!matches.length) return { count: 0, selected: -1, index: -1 };
  let selected = matches.findIndex((index) => index >= selectionStart);
  if (direction > 0) selected = matches.findIndex((index) => index > selectionStart);
  if (direction < 0) {
    selected = -1;
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      if (matches[index] < selectionStart) {
        selected = index;
        break;
      }
    }
  }
  if (selected < 0) selected = direction < 0 ? matches.length - 1 : 0;
  return { count: matches.length, selected, index: matches[selected] };
}

/**
 * The text offset of a 1-based line and column - the YAML parser's own
 * convention, and what its error message tells the user to look for.
 * Positions past the end land on the end.
 * @param {string} content @param {number} line @param {number} column
 */
export function offsetForLineColumn(content, line, column) {
  const lines = content.split("\n");
  let offset = 0;
  for (let index = 0; index < Math.min(Math.max(line, 1) - 1, lines.length); index += 1) {
    offset += lines[index].length + 1;
  }
  offset += Math.max(0, (Number(column) || 1) - 1);
  return Math.min(offset, content.length);
}
