// @ts-check

/**
 * A one-field question in an app dialog instead of the browser's prompt():
 * prompt() blocks the page, cannot be styled or translated consistently and
 * is suppressed entirely in some embedded browsers (the Home Assistant
 * companion app among them). Enter confirms, Escape cancels.
 *
 * @param {HTMLDialogElement} dialog the `#text-prompt-dialog` element
 * @param {{title: string, label: string, value?: string, validate?: (value: string) => string}} options
 *   `validate` returns an error message, or "" when the value is fine.
 * @returns {Promise<string | null>} the trimmed value, or null when cancelled
 */
export function askText(dialog, { title, label, value = "", validate = () => "" }) {
  const heading = /** @type {HTMLElement} */ (dialog.querySelector("[data-role=title]"));
  const caption = /** @type {HTMLElement} */ (dialog.querySelector("[data-role=label]"));
  const input = /** @type {HTMLInputElement} */ (dialog.querySelector("[data-role=value]"));
  const error = /** @type {HTMLElement} */ (dialog.querySelector("[data-role=error]"));
  heading.textContent = title;
  caption.textContent = label;
  input.value = value;
  error.textContent = "";
  return new Promise((resolve) => {
    /** @param {string | null} result */
    const finish = (result) => {
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("cancel", onCancel);
      input.removeEventListener("keydown", onKey);
      dialog.close();
      resolve(result);
    };
    const confirm = () => {
      const text = input.value.trim();
      const problem = text ? validate(text) : "";
      if (!text || problem) {
        error.textContent = problem;
        input.focus();
        return;
      }
      finish(text);
    };
    /** @param {Event} event */
    const onClick = (event) => {
      const action = /** @type {HTMLElement | null} */ (
        /** @type {HTMLElement | null} */ (event.target)?.closest("[data-action]")
      )?.dataset.action;
      if (action === "ok") confirm();
      if (action === "cancel") finish(null);
    };
    /** @param {KeyboardEvent} event */
    const onKey = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        confirm();
      }
    };
    /** @param {Event} event */
    const onCancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("cancel", onCancel);
    input.addEventListener("keydown", onKey);
    dialog.showModal();
    input.select();
  });
}
