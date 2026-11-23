// @ts-check

/** @typedef {{action: "overwrite"} | {action: "rename", name: string} | {action: "cancel"}} SaveConflictChoice */

/** "display.lvgldesign" -> "display_2.lvgldesign": a free-looking default for "save as". */
/** @param {string} name */
export function suggestedCopyName(name) {
  const match = /^(.*?)(?:_(\d+))?(\.lvgldesign)$/.exec(name);
  if (!match) return `${name}_2`;
  const [, base, number, extension] = match;
  return `${base}_${number ? Number(number) + 1 : 2}${extension}`;
}

/**
 * Ask what to do when saving hits a newer stored version of the same name -
 * saved from another tab or by the MCP server, or a restored autosave that
 * never knew which version it was based on. Escape counts as "cancel".
 *
 * @param {HTMLDialogElement} dialog the `#save-conflict-dialog` element
 * @param {{message: string, suggestedName: string}} options
 * @returns {Promise<SaveConflictChoice>}
 */
export function askSaveConflict(dialog, { message, suggestedName }) {
  const text = /** @type {HTMLElement} */ (dialog.querySelector("[data-role=message]"));
  const input = /** @type {HTMLInputElement} */ (dialog.querySelector("[data-role=new-name]"));
  text.textContent = message;
  input.value = suggestedName;
  return new Promise((resolve) => {
    /** @param {SaveConflictChoice} choice */
    const finish = (choice) => {
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("cancel", onCancel);
      dialog.close();
      resolve(choice);
    };
    /** @param {Event} event */
    const onClick = (event) => {
      const target = /** @type {HTMLElement | null} */ (event.target);
      const action = /** @type {HTMLElement | null} */ (target?.closest("[data-action]"))?.dataset.action;
      if (action === "overwrite" || action === "cancel") finish({ action });
      if (action === "rename") {
        const name = input.value.trim();
        if (name) finish({ action, name });
        else input.focus();
      }
    };
    /** @param {Event} event */
    const onCancel = (event) => {
      event.preventDefault();
      finish({ action: "cancel" });
    };
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
  });
}
