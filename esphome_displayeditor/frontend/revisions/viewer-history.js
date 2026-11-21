// @ts-check

import { sourceMove } from "../project/resync-view.js";
import {
  actionKey,
  carriesContent,
  entryModifier,
  formatRevisionDate,
  originKey,
  parseCompareTarget,
  versionTitle,
} from "../project/revisions-view.js";

/** @typedef {import("../project/revisions-view.js").CompareTarget} CompareTarget */
/** @typedef {import("./dialog.js").RevisionsController} RevisionsController */
/** @typedef {import("./dialog.js").PreviewRequest} PreviewRequest */
/** @typedef {import("./dialog.js").Translate} Translate */
/** @typedef {import("./dialog.js").Notify} Notify */
/** @typedef {import("../viewer/viewer.js").ViewerController} ViewerController */
/** @typedef {{name: string, versions: any[], exists: boolean, inspectedId: number,
 *   compareTo: CompareTarget, cache: Record<string, any>,
 *   side: "version" | "compare"}} ViewerHistory */
/**
 * @typedef {{
 *   bar: HTMLElement, label: HTMLElement, date: HTMLElement,
 *   versionButton: HTMLButtonElement, compare: HTMLSelectElement, back: HTMLButtonElement,
 *   viewerDialog: HTMLDialogElement, graphNodes: HTMLElement, graphEdges: SVGSVGElement,
 * }} ViewerHistoryElements
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * An earlier version in the viewer: the history bar to flip between it and
 * a comparison target, and the graph of all versions with the restores
 * drawn as arcs back to where their content came from.
 * @param {{
 *   els: ViewerHistoryElements, t: Translate, toast: Notify, language: () => string,
 *   revisions: RevisionsController, loadCurrent: (name: string) => Promise<any>,
 *   viewer: () => ViewerController, hideScenarios: () => void,
 *   reopenDialog: (name: string, id: number, compareTo: CompareTarget) => Promise<void>,
 * }} deps
 */
export function createViewerHistory({
  els, t, toast, language, revisions, loadCurrent, viewer, hideScenarios, reopenDialog,
}) {
  /** @type {ViewerHistory | null} */
  let history = null;
  const document = els.graphNodes.ownerDocument;
  const notifyError = (/** @type {any} */ error) => toast(error.message, true, error.details);

  /** @param {number} id */
  function versionAt(id) {
    const versions = history?.versions || [];
    const index = versions.findIndex((/** @type {any} */ item) => item.id === id);
    return index < 0 ? null : { version: versions[index], index };
  }

  /** @param {CompareTarget} target */
  function targetLabel(target) {
    if (target === "current" || target === null) return t("revisions.compareCurrent");
    const found = versionAt(target);
    return found ? versionTitle(found.version, found.index, t) : t("revisions.compareCurrent");
  }

  /** Fetch a version (or the current state) once and keep it, so moving
   * around the graph stays instant. @param {CompareTarget} target */
  async function loadProject(target) {
    if (!history || target === null) return false;
    const key = String(target);
    if (history.cache[key]) return true;
    try {
      history.cache[key] = target === "current"
        ? await loadCurrent(history.name)
        : (await revisions.read(history.name, target)).project;
      return true;
    } catch (error) {
      notifyError(error);
      return false;
    }
  }

  /** Open whichever side is active, keeping the user's zoom and rotation so
   * flipping actually compares like with like. */
  function openHistoric() {
    if (!history) return;
    const live = viewer();
    const { zoom, rotation, fitMode } = live;
    const showingCompare = history.side === "compare";
    const key = String(showingCompare ? history.compareTo : history.inspectedId);
    // Today's scenarios on a past layout would show a state that never existed.
    live.setScenarios([]);
    hideScenarios();
    live.open(history.cache[key], {
      name: t("viewer.history.versionTitle", {
        name: history.name,
        version: targetLabel(showingCompare ? history.compareTo : history.inspectedId),
      }),
      // Deliberately no runtime bindings either: a past layout with today's
      // live values would be a state that never existed.
      runtimeBindings: [],
    });
    if (!fitMode) {
      live.setZoom(zoom);
      live.setRotation(rotation);
    }
  }

  /** @param {"version" | "compare"} side */
  async function showSide(side) {
    if (!history || history.side === side) return;
    if (!(await loadProject(side === "compare" ? history.compareTo : history.inspectedId))) return;
    history.side = side;
    renderBar();
    openHistoric();
  }

  /** Choosing a target also shows it - picking something you then have to
   * click to see would be a pointless second step. @param {CompareTarget} target */
  async function setCompareTarget(target) {
    if (!history || target === null) return;
    if (!(await loadProject(target))) {
      renderBar();
      return;
    }
    history.compareTo = target;
    history.side = "compare";
    renderBar();
    openHistoric();
  }

  /** Move the inspected version, driven by the graph. @param {number} id */
  async function setInspected(id) {
    if (!history) return;
    if (history.inspectedId === id) {
      await showSide("version");
      return;
    }
    if (!(await loadProject(id))) return;
    history.inspectedId = id;
    // Nothing compares with itself.
    if (history.compareTo === id) history.compareTo = history.exists ? "current" : null;
    history.side = "version";
    renderBar();
    openHistoric();
  }

  function renderCompareOptions() {
    const select = els.compare;
    select.replaceChildren();
    // Held locally: `history` can change, so it is not narrowed in callbacks.
    const current = history;
    if (!current) return;
    if (current.exists) select.append(new Option(t("revisions.compareCurrent"), "current"));
    current.versions.forEach((/** @type {any} */ version, /** @type {number} */ index) => {
      if (version.id === current.inspectedId || !carriesContent(version)) return;
      select.append(new Option(versionTitle(version, index, t), String(version.id)));
    });
    select.value = current.compareTo === null ? "" : String(current.compareTo);
    select.disabled = !select.options.length;
  }

  function renderBar() {
    if (!history) {
      els.bar.classList.add("hidden");
      return;
    }
    const showingVersion = history.side === "version";
    const inspected = versionAt(history.inspectedId);
    els.label.textContent = targetLabel(history.inspectedId);
    els.date.textContent = inspected ? formatRevisionDate(inspected.version.created_at, language()) : "";
    els.versionButton.classList.toggle("active", showingVersion);
    els.versionButton.setAttribute("aria-pressed", String(showingVersion));
    renderCompareOptions();
    els.compare.classList.toggle("active", !showingVersion);
    renderGraph();
    els.bar.classList.remove("hidden");
  }

  // --- the graph -------------------------------------------------------------
  // The history is not a plain line: a restore creates a version whose content
  // comes from an older one, and that relationship is what the arcs show.
  // Nodes are real buttons so the graph is keyboard-navigable; the arcs are a
  // decorative SVG layer measured from those buttons after layout.

  /** @param {any} version @param {number} index @param {ViewerHistory} current */
  function graphNode(version, index, current) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `revision-node ${entryModifier(version)}`;
    node.dataset.revisionId = String(version.id);
    const showing = current.side === "version"
      ? version.id === current.inspectedId
      : version.id === current.compareTo;
    node.classList.toggle("showing", showing);
    node.classList.toggle("inspected", version.id === current.inspectedId);
    node.classList.toggle("target", version.id === current.compareTo);
    node.classList.toggle("locked", Boolean(version.locked));
    node.disabled = !carriesContent(version);

    // The configuration's own track: a flag above the node marks the version
    // that carried a YAML change in, so the graph shows two kinds of event on
    // one timeline rather than only the project following along. Rendered
    // inside the node so it needs no second measuring pass.
    const move = sourceMove(version);
    if (move) {
      const flag = document.createElement("span");
      flag.className = `revision-node-source${move.changed ? " moved" : ""}`;
      flag.textContent = move.changed ? "▲" : "▵";
      node.append(flag);
    }
    const dot = document.createElement("span");
    dot.className = "revision-node-dot";
    const caption = document.createElement("span");
    caption.className = "revision-node-caption";
    caption.textContent = versionTitle(version, index, t);
    node.append(dot, caption);

    node.title = [
      versionTitle(version, index, t),
      formatRevisionDate(version.created_at, language()),
      t(version.action === "delete" ? actionKey(version.action) : originKey(version.origin)),
      version.locked ? t("revisions.lockedBadge") : "",
      version.restored_from ? t("revisions.restoredFrom", { id: version.restored_from }) : "",
      move && (move.changed
        ? t("revisions.sourceMoved", { name: move.name, from: move.from, to: move.to })
        : t("revisions.sourceSame", { name: move.name })),
    ].filter(Boolean).join(" · ");

    if (!node.disabled) node.addEventListener("click", () => setInspected(version.id));
    return node;
  }

  function renderGraph() {
    els.graphNodes.replaceChildren();
    const current = history;
    if (!current) return;
    // Oldest on the left, so the graph reads in the direction time runs.
    [...current.versions].reverse().forEach((version) => {
      els.graphNodes.append(graphNode(version, current.versions.indexOf(version), current));
    });
    drawEdges();
  }

  /** Draw the restore relationships as arcs between measured node centres. */
  function drawEdges() {
    const svg = els.graphEdges;
    const row = els.graphNodes;
    svg.replaceChildren();
    if (!history) return;
    const box = row.getBoundingClientRect();
    if (!box.width) return;
    svg.setAttribute("viewBox", `0 0 ${Math.round(box.width)} 26`);
    /** @param {number} id */
    const centreOf = (id) => {
      const node = row.querySelector(`[data-revision-id="${id}"]`);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return rect.left - box.left + rect.width / 2;
    };
    history.versions.forEach((/** @type {any} */ version) => {
      if (!version.restored_from) return;
      const to = centreOf(version.id);
      const from = centreOf(version.restored_from);
      if (to === null || from === null) return;
      const path = document.createElementNS(SVG_NAMESPACE, "path");
      const lift = Math.min(22, Math.max(10, Math.abs(to - from) / 4));
      path.setAttribute("d", `M ${from} 24 C ${from} ${24 - lift}, ${to} ${24 - lift}, ${to} 24`);
      path.setAttribute("class", "revision-edge");
      svg.append(path);
    });
  }

  function clear() {
    history = null;
    els.bar.classList.add("hidden");
  }

  async function returnToRevisions() {
    const previous = history;
    viewer().close();
    if (!previous) return;
    // Carry both choices back, so the dialog shows what the viewer ended on.
    await reopenDialog(previous.name, previous.inspectedId, previous.compareTo);
  }

  return {
    bind() {
      els.versionButton.addEventListener("click", () => showSide("version"));
      els.compare.addEventListener("change", () => {
        setCompareTarget(parseCompareTarget(els.compare.value));
      });
      // Clicking the select without changing it should still switch sides.
      els.compare.addEventListener("click", () => showSide("compare"));
      els.back.addEventListener("click", returnToRevisions);
      // Covers every way out - the viewer's own close button, Escape, and
      // returnToRevisions - so the bar can never linger over a live preview.
      els.viewerDialog.addEventListener("close", clear);
      // Arcs are drawn from measured node positions, so they have to be
      // redrawn whenever the row is laid out again.
      new ResizeObserver(() => drawEdges()).observe(els.graphNodes);
    },

    /** Forget the version, e.g. before the ordinary live preview opens. */
    clear,

    /** Show a version from the history dialog; the dialog closes once the
     * version is loaded, so one modal replaces the other.
     * @param {PreviewRequest} request */
    async preview({ name, versions, exists, version, compareTo, closeDialog }) {
      try {
        const loaded = await revisions.read(name, version.id);
        history = {
          name, versions, exists, inspectedId: version.id, compareTo,
          cache: { [String(version.id)]: loaded.project }, side: "version",
        };
        closeDialog();
        renderBar();
        openHistoric();
      } catch (error) { notifyError(error); }
    },
  };
}
