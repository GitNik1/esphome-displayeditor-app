// @ts-check

const INFO_MILLISECONDS = 3500;
const MAX_VISIBLE = 4;

/**
 * Messages at the bottom right of the app.
 *
 * - Every message is its own entry: a success notice no longer replaces an
 *   error nobody has read yet. Errors stay until dismissed (a validation or
 *   compile error is often longer than a few seconds of reading) and are
 *   announced as alerts; other messages fade out.
 * - The text is selectable, and error details the backend sent get a
 *   collapsible block instead of being dropped.
 * - A modal dialog makes everything outside it inert and draws over it, so
 *   while one is open the region lives inside the topmost one - and leaves it
 *   again when it closes, so a message shown right before closing stays.
 *
 * @param {{region: HTMLElement, closeLabel: () => string, detailsLabel: () => string}} options
 */
export function createNotifications({ region, closeLabel, detailsLabel }) {
  const doc = region.ownerDocument;

  function host() {
    const modals = doc.querySelectorAll("dialog:modal");
    return modals.length ? modals[modals.length - 1] : doc.body;
  }

  function place() {
    const target = host();
    if (region.parentElement !== target) target.append(region);
  }

  doc.addEventListener("close", (event) => {
    if (event.target instanceof HTMLDialogElement && event.target.contains(region)) place();
  }, true);

  /** @param {Element} item */
  function remove(item) {
    item.remove();
  }

  /**
   * @param {string} message
   * @param {{error?: boolean, details?: unknown}} [options]
   */
  function show(message, { error = false, details } = {}) {
    place();
    // The same message again (a retried action, a repeated click) refreshes
    // the newest entry instead of stacking copies.
    const newest = region.lastElementChild;
    if (newest && newest.querySelector(".toast-message")?.textContent === message
        && newest.classList.contains("error") === error) {
      newest.remove();
    }
    const item = doc.createElement("div");
    item.className = error ? "toast-item error" : "toast-item";
    item.setAttribute("role", error ? "alert" : "status");
    const text = doc.createElement("span");
    text.className = "toast-message";
    text.textContent = message;
    item.append(text);
    if (error && details !== undefined && details !== null) {
      const block = doc.createElement("details");
      block.className = "toast-details";
      const summary = doc.createElement("summary");
      summary.textContent = detailsLabel();
      const pre = doc.createElement("pre");
      pre.textContent = typeof details === "string" ? details : JSON.stringify(details, null, 2);
      block.append(summary, pre);
      item.append(block);
    }
    if (error) {
      const close = doc.createElement("button");
      close.type = "button";
      close.className = "toast-dismiss";
      close.textContent = "×";
      close.setAttribute("aria-label", closeLabel());
      close.addEventListener("click", () => remove(item));
      item.append(close);
    } else {
      setTimeout(() => remove(item), INFO_MILLISECONDS);
    }
    region.append(item);
    // Oldest notices make room first; an error only goes when nothing else is left.
    while (region.childElementCount > MAX_VISIBLE) {
      const children = [...region.children];
      (children.find((child) => !child.classList.contains("error")) || children[0]).remove();
    }
  }

  return { show };
}
