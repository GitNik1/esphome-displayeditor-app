// @ts-check

/** @typedef {{path: string} | {url: string}} ImageSourceChoice */

/**
 * Pick a new image source: one already in the configuration's images/
 * folder, or an http(s) URL. Replaces a prompt() that listed the existing
 * images as numbered text and expected their number typed back.
 *
 * @param {HTMLDialogElement} dialog the `#image-source-dialog` element
 * @param {{existing: string[]}} options paths like "images/panel_bg.png"
 * @returns {Promise<ImageSourceChoice | null>} null when cancelled
 */
export function askImageSource(dialog, { existing }) {
  const list = /** @type {HTMLSelectElement} */ (dialog.querySelector("[data-role=existing]"));
  const listLabel = /** @type {HTMLElement} */ (dialog.querySelector("[data-role=existing-label]"));
  const url = /** @type {HTMLInputElement} */ (dialog.querySelector("[data-role=url]"));
  list.replaceChildren(...existing.map((path) => new Option(path, path)));
  listLabel.hidden = !existing.length;
  url.value = "";
  return new Promise((resolve) => {
    /** @param {ImageSourceChoice | null} choice */
    const finish = (choice) => {
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("cancel", onCancel);
      list.removeEventListener("dblclick", apply);
      list.removeEventListener("change", clearUrl);
      url.removeEventListener("input", clearSelection);
      dialog.close();
      resolve(choice);
    };
    const apply = () => {
      if (list.value) return finish({ path: list.value });
      const typed = url.value.trim();
      if (typed && typed !== "https://") return finish({ url: typed });
      url.focus();
      return undefined;
    };
    const clearUrl = () => { url.value = ""; };
    const clearSelection = () => { list.value = ""; };
    /** @param {Event} event */
    const onClick = (event) => {
      const action = /** @type {HTMLElement | null} */ (
        /** @type {HTMLElement | null} */ (event.target)?.closest("[data-action]")
      )?.dataset.action;
      if (action === "apply") apply();
      if (action === "cancel") finish(null);
    };
    /** @param {Event} event */
    const onCancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("cancel", onCancel);
    list.addEventListener("dblclick", apply);
    list.addEventListener("change", clearUrl);
    url.addEventListener("input", clearSelection);
    dialog.showModal();
    (existing.length ? list : url).focus();
  });
}
