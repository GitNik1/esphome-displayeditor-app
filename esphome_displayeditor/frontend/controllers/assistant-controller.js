// @ts-check

/** @typedef {import("../api/client.js").ApiClient} ApiClient */

/**
 * Treat the API response as untrusted at the DOM boundary, same principle
 * as mcp-tokens-controller.js.
 * @param {any} payload
 */
export function normalizeAssistantReply(payload) {
  const proposals = Array.isArray(payload?.proposals)
    ? payload.proposals.filter((/** @type {any} */ item) => item && typeof item === "object" && item.change_set_id)
    : [];
  return {
    reply: typeof payload?.reply === "string" ? payload.reply : "",
    proposals: proposals.map((/** @type {any} */ item) => ({
      change_set_id: String(item.change_set_id),
      tool: typeof item.tool === "string" ? item.tool : "",
      preview: item.preview && typeof item.preview === "object" ? item.preview : {},
    })),
  };
}

/**
 * Compact, tool-agnostic summary of a proposal's preview - mirrors the
 * generic-by-shape rendering already used by the MCP Apps Change-Set
 * Review view (backend/mcp/apps/changeset-review.html), kept in sync in
 * spirit rather than sharing code across the Python/JS boundary.
 * @param {any} preview
 */
export function summarizeAssistantProposal(preview) {
  const parts = [];
  if (Array.isArray(preview?.added_widget_ids) && preview.added_widget_ids.length) {
    parts.push({ kind: "added", items: preview.added_widget_ids });
  }
  if (Array.isArray(preview?.removed_widget_ids) && preview.removed_widget_ids.length) {
    parts.push({ kind: "removed", items: preview.removed_widget_ids });
  }
  if (Array.isArray(preview?.added_binding_ids) && preview.added_binding_ids.length) {
    parts.push({ kind: "added", items: preview.added_binding_ids });
  }
  if (Array.isArray(preview?.removed_binding_ids) && preview.removed_binding_ids.length) {
    parts.push({ kind: "removed", items: preview.removed_binding_ids });
  }
  const issueCounts = preview?.issue_counts && typeof preview.issue_counts === "object"
    ? preview.issue_counts
    : {};
  const issueTotal = Object.values(issueCounts).reduce(
    (sum, count) => sum + (typeof count === "number" ? count : 0),
    0,
  );
  return { parts, issueTotal };
}

/** @param {ApiClient} api */
export function createAssistantController(api) {
  return {
    /** @param {{project_name: string, message: string}} input */
    async ask(input) {
      return normalizeAssistantReply(
        await api("assistant/ask", {
          method: "POST",
          body: JSON.stringify({
            project_name: input.project_name,
            message: input.message.trim(),
          }),
        }),
      );
    },
    /** @param {string} changeSetId */
    apply(changeSetId) {
      return api(`assistant/changesets/${encodeURIComponent(changeSetId)}/apply`, {
        method: "POST",
      });
    },
  };
}
