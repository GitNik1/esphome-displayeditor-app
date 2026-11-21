// @ts-check

import { encodedName } from "../api/client.js";
import { renderUnifiedDiff } from "./diff-view.js";
import { createYamlEditor } from "./yaml-editor.js";

/** @typedef {import("../api/client.js").ApiClient} ApiClient */
/** @typedef {import("./yaml-editor.js").Translate} Translate */
/** @typedef {import("./yaml-editor.js").YamlEditorElements} YamlEditorElements */
/** @typedef {(message: string, error?: boolean, details?: unknown) => void} Notify */
/** @typedef {{name: string, size: number, has_draft: boolean}} ConfigurationEntry */
/**
 * @typedef {{
 *   activeConfig: string | null, activeRevision: string | null, hasDraft: boolean,
 *   draftRevision: string | null, yamlDirty: boolean, yamlLoadedContent: string,
 *   configurations: ConfigurationEntry[], capabilities: Record<string, unknown>,
 * }} WorkspaceState
 */
/**
 * @typedef {{
 *   view: HTMLElement, list: HTMLElement, refresh: HTMLButtonElement,
 *   backToList: HTMLButtonElement, title: HTMLElement, revision: HTMLElement,
 *   output: HTMLElement, checkYaml: HTMLButtonElement, showDiff: HTMLButtonElement,
 *   mergeDraft: HTMLButtonElement, saveDraft: HTMLButtonElement, publish: HTMLButtonElement,
 *   mergeDialog: HTMLDialogElement, mergeName: HTMLElement, mergeActive: HTMLTextAreaElement,
 *   mergeDraftSource: HTMLTextAreaElement, mergeResult: HTMLTextAreaElement,
 *   closeMerge: HTMLButtonElement, cancelMerge: HTMLButtonElement, saveMerge: HTMLButtonElement,
 *   editor: YamlEditorElements,
 * }} WorkspaceElements
 */

/**
 * The configuration workspace: the file list, opening a file, saving and
 * merging drafts, the syntax check, the diff and publishing. The Device
 * Builder actions next to them live in builder/view.js.
 * @param {{
 *   els: WorkspaceElements, state: WorkspaceState, api: ApiClient, t: Translate,
 *   toast: Notify, confirm: (message: string) => boolean,
 *   builder: {updateButtons: () => void},
 * }} deps
 */
export function createConfigurationWorkspace({ els, state, api, t, toast, confirm, builder }) {
  const editor = createYamlEditor(els.editor, state, t, () => updateDraftButtons());
  /** Requests in flight; their buttons stay disabled until they return. */
  const busy = new Set();
  /** The draft the merge dialog shows. The editor keeps its own
   * state.draftRevision: cancelling the dialog must not make an editor
   * based on an older draft look current. @type {string | null} */
  let mergeDraftRevision = null;

  /** @param {string} name @param {string} [suffix] */
  const configurationPath = (name, suffix = "") => `configurations/${encodedName(name)}${suffix}`;
  const notifyError = (/** @type {any} */ error) => toast(error.message, true, error.details);
  const notifyDraftError = (/** @type {any} */ error) => {
    if (error.code === "revision_conflict" && error.details?.target === "configuration_draft") {
      toast(t("toast.draft.changedElsewhere"), true, error.details);
    } else notifyError(error);
  };

  // A full "sha256:<64 hex chars>" is diagnostic detail, not something anyone
  // reads at a glance next to the filename - short like a git commit, full
  // value still one hover away.
  /** @param {string | null} revision */
  function showRevision(revision) {
    els.revision.textContent = String(revision || "").replace(/^sha256:/, "").slice(0, 7);
    els.revision.title = revision || "";
  }

  // Whether a button is usable depends on several independent things -
  // a file and a draft, the role, unsaved edits - none of which a plain
  // greyed-out button shows; every disabled one names what is missing.
  function updateDraftButtons() {
    const hasConfig = Boolean(state.activeConfig);
    const canWrite = Boolean(state.capabilities["configuration.write_draft"]);
    const canPublish = Boolean(state.capabilities["configuration.publish"]);
    const noConfig = t("configs.hint.noConfig");

    els.saveDraft.disabled = !hasConfig || !canWrite || busy.has("save");
    els.saveDraft.title = !hasConfig ? noConfig : !canWrite ? t("configs.hint.noPermission") : "";

    els.showDiff.disabled = !state.hasDraft;
    els.showDiff.title = !hasConfig ? noConfig : !state.hasDraft ? t("configs.hint.noDraft") : "";

    els.mergeDraft.disabled = !state.hasDraft || !canWrite;
    els.mergeDraft.title = !hasConfig ? noConfig
      : !state.hasDraft ? t("configs.hint.noDraft")
      : !canWrite ? t("configs.hint.noPermission")
      : "";

    // Publishing sends the saved draft; with unsaved edits in the editor
    // it would publish something other than what is on screen.
    els.publish.disabled = !state.hasDraft || !canPublish || state.yamlDirty || busy.has("publish");
    els.publish.title = !hasConfig ? noConfig
      : !state.hasDraft ? t("configs.hint.noDraft")
      : !canPublish ? t("configs.hint.noPermission")
      : state.yamlDirty ? t("configs.hint.saveDraftFirst")
      : "";
  }

  async function loadList() {
    try {
      const result = await api("configurations");
      /** @type {ConfigurationEntry[]} */
      const configurations = result.configurations;
      state.configurations = configurations;
      els.list.replaceChildren();
      els.list.classList.toggle("empty", configurations.length === 0);
      if (!configurations.length) {
        els.list.textContent = t("configs.noFilesFound");
        return;
      }
      const document = els.list.ownerDocument;
      for (const configuration of configurations) {
        const button = document.createElement("button");
        button.className = `config-item${state.activeConfig === configuration.name ? " active" : ""}`;
        const name = document.createElement("span");
        name.textContent = configuration.name;
        const meta = document.createElement("small");
        meta.textContent = `${Math.ceil(configuration.size / 1024)} KiB${configuration.has_draft ? t("configs.listDraftSuffix") : ""}`;
        if (configuration.has_draft) meta.className = "draft-dot";
        button.append(name, meta);
        button.addEventListener("click", () => {
          els.view.classList.remove("showing-list");
          open(configuration);
        });
        els.list.append(button);
      }
    } catch (error) { notifyError(error); }
  }

  /** @param {ConfigurationEntry} configuration */
  async function open(configuration) {
    if (
      state.yamlDirty
      && state.activeConfig
      && state.activeConfig !== configuration.name
      && !confirm(t("confirm.yaml.discardAndLoad"))
    ) return;
    try {
      const active = await api(configurationPath(configuration.name));
      state.activeConfig = configuration.name;
      state.activeRevision = active.revision;
      state.hasDraft = configuration.has_draft;
      // The draft this view shows; saving or publishing names it, so a draft
      // changed meanwhile (another tab, an MCP client) is refused, not lost.
      state.draftRevision = null;
      let content = active.content;
      if (configuration.has_draft) {
        const draft = await api(configurationPath(configuration.name, "/draft"));
        content = draft.content;
        state.draftRevision = draft.revision;
      }
      els.title.textContent = configuration.name;
      showRevision(active.revision);
      editor.load(content, Boolean(state.capabilities["configuration.write_draft"]));
      els.checkYaml.disabled = false;
      els.checkYaml.title = "";
      els.output.classList.add("hidden");
      builder.updateButtons();
      await loadList();
    } catch (error) { notifyError(error); }
  }

  async function saveDraft() {
    const name = state.activeConfig;
    if (!name || els.saveDraft.disabled) return;
    // What is sent is what counts as saved; typing on meanwhile stays unsaved.
    const content = editor.content();
    busy.add("save");
    updateDraftButtons();
    try {
      const result = await api(configurationPath(name, "/draft"), {
        method: "PUT",
        body: JSON.stringify({ content, expected_draft_revision: state.draftRevision }),
      });
      state.hasDraft = true;
      state.draftRevision = result.revision;
      editor.markSaved(content);
      builder.updateButtons();
      toast(t("toast.draft.saved"));
      await loadList();
    } catch (error) { notifyDraftError(error); }
    finally {
      busy.delete("save");
      updateDraftButtons();
    }
  }

  async function checkYaml() {
    const name = state.activeConfig;
    if (!name) return;
    try {
      const source = state.hasDraft ? "draft" : "active";
      const result = await api(configurationPath(name, `/check-yaml?source=${source}`), { method: "POST" });
      els.output.classList.remove("diff-output");
      els.output.textContent = result.valid
        ? t("config.output.yamlValid", { revision: result.revision })
        : t("config.output.yamlError", { line: result.line, column: result.column, error: result.error });
      els.output.classList.remove("hidden");
      if (!result.valid) editor.jumpTo(result.line, result.column);
    } catch (error) { notifyError(error); }
  }

  async function showDiff() {
    const name = state.activeConfig;
    if (!name || !state.hasDraft) return;
    try {
      const result = await api(configurationPath(name, "/diff"));
      if (result.diff) renderUnifiedDiff(els.output, result.diff, t);
      else {
        els.output.classList.remove("diff-output");
        els.output.textContent = t("config.output.noDifferences");
      }
      els.output.classList.remove("hidden");
    } catch (error) { notifyError(error); }
  }

  async function openMerge() {
    const name = state.activeConfig;
    if (!name || !state.hasDraft) return;
    try {
      const [active, draft] = await Promise.all([
        api(configurationPath(name)),
        api(configurationPath(name, "/draft")),
      ]);
      state.activeRevision = active.revision;
      showRevision(active.revision);
      mergeDraftRevision = draft.revision;
      els.mergeName.textContent = name;
      els.mergeActive.value = active.content;
      els.mergeDraftSource.value = draft.content;
      els.mergeResult.value = draft.content;
      els.mergeDialog.showModal();
    } catch (error) { notifyError(error); }
  }

  async function saveMerged() {
    const name = state.activeConfig;
    if (!name) return;
    const content = els.mergeResult.value;
    try {
      const result = await api(configurationPath(name, "/draft"), {
        method: "PUT", body: JSON.stringify({ content, expected_draft_revision: mergeDraftRevision }),
      });
      state.hasDraft = true;
      state.draftRevision = result.revision;
      editor.replace(content);
      els.mergeDialog.close();
      builder.updateButtons();
      await loadList();
      toast(t("toast.draft.mergedSaved"));
    } catch (error) { notifyDraftError(error); }
  }

  async function publish() {
    const name = state.activeConfig;
    if (!name || !state.hasDraft || state.yamlDirty) return;
    if (!confirm(t("confirm.config.publish", { name }))) return;
    busy.add("publish");
    updateDraftButtons();
    try {
      const result = await api(configurationPath(name, "/publish"), {
        method: "POST",
        body: JSON.stringify({
          expected_revision: state.activeRevision, expected_draft_revision: state.draftRevision,
        }),
      });
      state.activeRevision = result.revision;
      state.hasDraft = false;
      state.draftRevision = null;
      showRevision(result.revision);
      // The saved draft is now the active file; edits made since stay unsaved.
      editor.markSaved(state.yamlLoadedContent);
      builder.updateButtons();
      toast(t("toast.config.published"));
      await loadList();
    } catch (error) { notifyDraftError(error); }
    finally {
      busy.delete("publish");
      updateDraftButtons();
    }
  }

  return {
    bind() {
      editor.bind();
      els.refresh.addEventListener("click", () => loadList());
      els.saveDraft.addEventListener("click", saveDraft);
      els.checkYaml.addEventListener("click", checkYaml);
      els.showDiff.addEventListener("click", showDiff);
      els.mergeDraft.addEventListener("click", openMerge);
      els.publish.addEventListener("click", publish);
      els.closeMerge.addEventListener("click", () => els.mergeDialog.close());
      els.cancelMerge.addEventListener("click", () => els.mergeDialog.close());
      els.saveMerge.addEventListener("click", saveMerged);
      // Phone layout only: list <-> detail is one pane at a time there, so
      // this is what "leaving" the detail view means. A no-op above the
      // breakpoint, where both panels show side by side regardless.
      els.backToList.addEventListener("click", () => els.view.classList.add("showing-list"));
    },
    loadList,
    open,
    updateDraftButtons,
  };
}
