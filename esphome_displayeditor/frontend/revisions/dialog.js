// @ts-check

import { renderUnifiedDiff } from "../configurations/diff-view.js";
import { canUndoImport, replacedVersion, sourceMove } from "../project/resync-view.js";
import {
  actionKey,
  actorLabel,
  carriesContent,
  entryModifier,
  formatRevisionDate,
  groupFeedByDay,
  lockQuota,
  originKey,
  parseCompareTarget,
  versionTitle,
} from "../project/revisions-view.js";

/** @typedef {import("../project/revisions-view.js").CompareTarget} CompareTarget */
/** @typedef {ReturnType<typeof import("../controllers/revisions-controller.js").createRevisionsController>} RevisionsController */
/** @typedef {(key: string, params?: Record<string, unknown>) => string} Translate */
/** @typedef {(message: string, error?: boolean, details?: unknown) => void} Notify */
/** @typedef {{name: string | null, listing: any, selectedId: number | null,
 *   compareTo: CompareTarget}} RevisionSelection */
/** What the viewer needs to show a version; `closeDialog` once it is loaded.
 * @typedef {{name: string, versions: any[], exists: boolean, version: any,
 *   compareTo: CompareTarget, closeDialog: () => void}} PreviewRequest */
/**
 * @typedef {{
 *   dialog: HTMLDialogElement, open: HTMLButtonElement, close: HTMLButtonElement,
 *   closeFooter: HTMLButtonElement, list: HTMLElement, diff: HTMLElement,
 *   lockQuota: HTMLElement, label: HTMLInputElement, saveLabel: HTMLButtonElement,
 *   toggleLock: HTMLButtonElement, preview: HTMLButtonElement, restore: HTMLButtonElement,
 *   undoImport: HTMLButtonElement, compare: HTMLSelectElement, feed: HTMLElement,
 *   refreshFeed: HTMLButtonElement,
 * }} RevisionDialogElements
 */

/** @returns {RevisionSelection} */
const emptySelection = () => ({ name: null, listing: null, selectedId: null, compareTo: "current" });

/**
 * The version history of a stored project: the list, comparing two states,
 * labels, locks, restoring and taking back an import - plus the feed of
 * recent changes across all projects on the System page.
 * @param {{
 *   els: RevisionDialogElements,
 *   state: {capabilities: Record<string, unknown>, projectName: string | null,
 *     projectRevision: string | null},
 *   t: Translate, toast: Notify, confirm: (message: string) => boolean,
 *   controller: RevisionsController, language: () => string,
 *   selectedProjectName: () => string,
 *   onOpen: () => void,
 *   onRestored: (name: string) => Promise<void>,
 *   onPreview: (request: PreviewRequest) => Promise<void>,
 * }} deps
 */
export function createRevisionsDialog({
  els, state, t, toast, confirm, controller, language, selectedProjectName,
  onOpen, onRestored, onPreview,
}) {
  let selection = emptySelection();
  const document = els.list.ownerDocument;
  const notifyError = (/** @type {any} */ error) => toast(error.message, true, error.details);
  /** @param {string | null | undefined} value @param {boolean} [dateOnly] */
  const formatDate = (value, dateOnly = false) => formatRevisionDate(value, language(), dateOnly);
  const versions = () => selection.listing?.versions || [];

  function selectedVersion() {
    return versions().find((/** @type {any} */ item) => item.id === selection.selectedId) || null;
  }

  /** Chips shared by the dialog list and the global feed.
   * @param {any} entry @param {{current?: boolean, missingProject?: boolean}} [options] */
  function meta(entry, options = {}) {
    const box = document.createElement("div");
    box.className = "revision-meta";
    /** @param {string} text @param {string} [className] */
    const chip = (text, className) => {
      const item = document.createElement("span");
      if (className) item.className = className;
      item.textContent = text;
      box.append(item);
    };
    chip(entry.action === "delete" ? t(actionKey(entry.action)) : t(originKey(entry.origin)),
      `revision-chip ${entryModifier(entry)}`);
    if (options.current && entry.is_current) chip(t("revisions.current"), "revision-chip current");
    if (entry.locked) chip(t("revisions.lockedBadge"), "revision-chip locked");
    chip(actorLabel(entry.actor, t));
    if (entry.restored_from) chip(t("revisions.restoredFrom", { id: entry.restored_from }));
    const move = sourceMove(entry);
    if (move) {
      chip(move.changed
        ? t("revisions.sourceMoved", { name: move.name, from: move.from, to: move.to })
        : t("revisions.sourceSame", { name: move.name }), "revision-chip source");
      if (move.groups.length) {
        chip(move.groups.map((/** @type {string} */ key) => t(`resync.group.${key}`)).join(", "));
      }
    }
    if (options.missingProject) chip(t("revisions.feed.deletedProject"), "revision-chip delete");
    return box;
  }

  /** @param {any} version @param {number} index */
  function row(version, index) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "revision-row";
    item.setAttribute("role", "option");
    item.classList.toggle("selected", version.id === selection.selectedId);
    item.classList.toggle("locked", Boolean(version.locked));
    item.setAttribute("aria-selected", String(version.id === selection.selectedId));
    const title = document.createElement("strong");
    title.textContent = versionTitle(version, index, t);
    const when = document.createElement("small");
    when.textContent = formatDate(version.created_at);
    item.append(title, when, meta(version, { current: true }));
    item.addEventListener("click", () => select(version.id));
    return item;
  }

  function renderList() {
    const entries = versions();
    els.list.replaceChildren();
    els.list.classList.toggle("empty", !entries.length);
    if (!entries.length) {
      els.list.textContent = t("revisions.empty");
      els.lockQuota.textContent = "";
      return;
    }
    entries.forEach((/** @type {any} */ version, /** @type {number} */ index) => {
      els.list.append(row(version, index));
    });
    els.lockQuota.textContent = t("revisions.lockQuota", lockQuota(selection.listing || {}));
  }

  /** @param {number | null} selectedId @returns {CompareTarget} */
  function defaultCompareTarget(selectedId) {
    if (selection.listing?.exists) return "current";
    // A deleted project has no current state, so fall back to the newest
    // other version that still carries content.
    const other = versions().find(
      (/** @type {any} */ item) => item.id !== selectedId && carriesContent(item),
    );
    return other ? other.id : null;
  }

  /** @param {CompareTarget} target */
  function compareTargetLabel(target) {
    if (target === "current") return t("revisions.compareCurrent");
    const index = versions().findIndex((/** @type {any} */ item) => item.id === target);
    return index >= 0 ? versionTitle(versions()[index], index, t) : t("revisions.compareCurrent");
  }

  function renderCompareOptions() {
    const select = els.compare;
    select.replaceChildren();
    if (selection.listing?.exists) select.append(new Option(t("revisions.compareCurrent"), "current"));
    versions().forEach((/** @type {any} */ version, /** @type {number} */ index) => {
      if (version.id === selection.selectedId || !carriesContent(version)) return;
      select.append(new Option(versionTitle(version, index, t), String(version.id)));
    });
    select.value = String(selection.compareTo);
    // The stored target may have been pruned away or become the selection.
    if (!select.value) {
      selection.compareTo = select.options.length ? parseCompareTarget(select.options[0].value) : null;
      select.value = selection.compareTo === null ? "" : String(selection.compareTo);
    }
    select.disabled = select.options.length < 2;
  }

  function updateControls() {
    const version = selectedVersion();
    const canWrite = Boolean(state.capabilities["designer.project_write"]);
    const restorable = Boolean(version) && carriesContent(version) && !version.is_current;
    els.label.disabled = !version || !canWrite;
    els.saveLabel.disabled = !version || !canWrite;
    els.toggleLock.disabled = !version || !canWrite;
    els.toggleLock.textContent = version?.locked ? t("revisions.unlock") : t("revisions.lock");
    els.preview.disabled = !version || !carriesContent(version);
    els.restore.disabled = !restorable || !canWrite;
    els.restore.title = version && !carriesContent(version) ? t("revisions.noContent") : "";
    const undoable = canUndoImport(version, versions());
    // Shown only where it means something: an import whose predecessor is
    // still in the history. Once that has rotated out, restore is all there is.
    els.undoImport.classList.toggle("hidden", version?.origin !== "resync");
    els.undoImport.disabled = !undoable || !canWrite;
    els.undoImport.title = version?.origin === "resync" && !undoable ? t("revisions.undoImportGone") : "";
  }

  /** @param {string} text */
  function showDiffText(text) {
    els.diff.classList.remove("diff-output");
    els.diff.textContent = text;
  }

  async function loadDiff() {
    const version = selectedVersion();
    if (!selection.name || !version) return;
    if (!carriesContent(version)) return showDiffText(t("revisions.noContent"));
    if (selection.compareTo === null) return showDiffText(t("revisions.compareNone"));
    try {
      const result = await controller.diff(selection.name, version.id, selection.compareTo);
      if (!result.diff) {
        showDiffText(t("revisions.diffEmpty", { target: compareTargetLabel(selection.compareTo) }));
        return;
      }
      renderUnifiedDiff(els.diff, result.diff, t);
      if (result.diff_truncated) {
        const note = document.createElement("p");
        note.className = "hint";
        note.textContent = t("revisions.diffTruncated");
        els.diff.prepend(note);
      }
    } catch (/** @type {any} */ error) {
      showDiffText(error.message);
    }
  }

  /** @param {number} id */
  async function select(id) {
    selection.selectedId = id;
    // Nothing is compared with itself, so a target that just became the
    // selection has to give way.
    if (selection.compareTo === id) selection.compareTo = defaultCompareTarget(id);
    renderList();
    renderCompareOptions();
    els.label.value = selectedVersion()?.label || "";
    updateControls();
    await loadDiff();
  }

  /** @param {number} [preselectId] */
  async function load(preselectId) {
    const name = selection.name;
    if (!name) return;
    try {
      selection.listing = await controller.list(name);
      if (selection.compareTo === "current" && !selection.listing.exists) {
        selection.compareTo = defaultCompareTarget(selection.selectedId);
      }
      renderList();
      // Fall back to the newest when the requested version has since been
      // pruned out of the rolling window.
      const wanted = versions().find((/** @type {any} */ item) => item.id === preselectId);
      const target = wanted || versions()[0];
      if (target) await select(target.id);
      else updateControls();
    } catch (error) { notifyError(error); }
  }

  /** @param {string} [projectName] @param {number} [preselectId] @param {CompareTarget} [compareTo] */
  async function open(projectName, preselectId, compareTo) {
    const name = projectName || selectedProjectName();
    if (!name) return;
    selection = { ...emptySelection(), name, compareTo: compareTo === undefined ? "current" : compareTo };
    onOpen();
    els.list.replaceChildren();
    els.diff.replaceChildren();
    els.dialog.showModal();
    els.close.focus();
    await load(preselectId);
  }

  async function saveLabel() {
    const version = selectedVersion();
    if (!selection.name || !version) return;
    try {
      await controller.setLabel(selection.name, version.id, els.label.value);
      await load();
      await select(version.id);
      toast(t("toast.revisions.labelSaved"));
    } catch (error) { notifyError(error); }
  }

  async function toggleLock() {
    const version = selectedVersion();
    if (!selection.name || !version) return;
    const locked = !version.locked;
    if (!locked && !confirm(t("confirm.revisions.unlock"))) return;
    try {
      await controller.setLocked(selection.name, version.id, locked);
      await load();
      await select(version.id);
      toast(t(locked ? "toast.revisions.locked" : "toast.revisions.unlocked"));
    } catch (error) { notifyError(error); }
  }

  /** @param {any} version @param {string} question */
  async function restore(version, question) {
    const name = selection.name;
    if (!name || !version || !state.capabilities["designer.project_write"]) return;
    const exists = Boolean(selection.listing?.exists);
    if (!confirm(question)) return;
    // A project open in the editor may be further along than the listing, so
    // prefer its revision - the freshness rule deleteServerProject uses.
    const expectedRevision = !exists ? null
      : (state.projectName === name ? state.projectRevision : selection.listing.current_revision);
    try {
      await controller.restore(name, version.id, expectedRevision);
      await Promise.all([onRestored(name), load(version.id), loadFeed()]);
      toast(t("toast.revisions.restored"));
    } catch (/** @type {any} */ error) {
      toast(
        error.code === "revision_conflict" ? t("toast.revisions.conflict") : error.message,
        true,
        error.details,
      );
      await load();
    }
  }

  async function restoreSelected() {
    const version = selectedVersion();
    await restore(version, selection.listing?.exists
      ? t("confirm.revisions.restore", { date: formatDate(version?.created_at) })
      : t("confirm.revisions.restoreDeleted", { name: selection.name }));
  }

  /** Take back the import the selected version made, by restoring the state
   * it displaced. Ordinary restore underneath - the import is not rewound,
   * it is followed by its own reversal, which stays as undoable as anything. */
  async function undoImport() {
    const version = selectedVersion();
    const target = replacedVersion(version, versions());
    const move = sourceMove(version);
    if (!target || !move) return;
    await restore(target, t("confirm.revisions.undoImport", {
      name: move.name, date: formatDate(target.created_at),
    }));
  }

  async function preview() {
    const name = selection.name;
    const version = selectedVersion();
    if (!name || !version || !carriesContent(version)) return;
    await onPreview({
      name, versions: versions(), exists: Boolean(selection.listing?.exists),
      version, compareTo: selection.compareTo, closeDialog: () => els.dialog.close(),
    });
  }

  /** @param {any} event */
  function feedRow(event) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "revision-row";
    item.addEventListener("click", () => open(event.project_name, event.id));
    const title = document.createElement("strong");
    title.textContent = event.project_name;
    const when = document.createElement("small");
    when.textContent = formatDate(event.created_at);
    item.append(title, when, meta(event, { missingProject: !event.project_exists }));
    return item;
  }

  async function loadFeed() {
    if (!state.capabilities["designer.project"]) return;
    try {
      const events = await controller.feed(50);
      els.feed.replaceChildren();
      els.feed.classList.toggle("empty", !events.length);
      if (!events.length) {
        els.feed.textContent = t("revisions.feed.empty");
        return;
      }
      for (const group of groupFeedByDay(events)) {
        const heading = document.createElement("p");
        heading.className = "revision-feed-day";
        heading.textContent = formatDate(group.events[0].created_at, true);
        els.feed.append(heading, ...group.events.map(feedRow));
      }
    } catch (/** @type {any} */ error) {
      els.feed.textContent = error.message;
    }
  }

  return {
    bind() {
      // Wrapped, not passed directly: the listener would hand the
      // PointerEvent to the first parameter and the dialog would ask for a
      // project called "[object PointerEvent]".
      els.open.addEventListener("click", () => open());
      els.close.addEventListener("click", () => els.dialog.close());
      els.closeFooter.addEventListener("click", () => els.dialog.close());
      els.restore.addEventListener("click", restoreSelected);
      els.undoImport.addEventListener("click", undoImport);
      els.saveLabel.addEventListener("click", saveLabel);
      els.toggleLock.addEventListener("click", toggleLock);
      els.preview.addEventListener("click", preview);
      els.refreshFeed.addEventListener("click", () => loadFeed());
      els.dialog.addEventListener("close", () => { selection = emptySelection(); });
      els.compare.addEventListener("change", () => {
        selection.compareTo = parseCompareTarget(els.compare.value);
        loadDiff();
      });
    },
    open,
    loadFeed,
  };
}
