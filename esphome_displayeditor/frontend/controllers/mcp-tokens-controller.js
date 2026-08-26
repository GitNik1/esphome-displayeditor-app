// @ts-check

/** @typedef {import("../api/client.js").ApiClient} ApiClient */

export const MCP_READ_SCOPES = Object.freeze([
  "server:read",
  "project:read",
  "configuration:read",
  "device:read",
]);

const STATUS_ORDER = Object.freeze({ active: 0, expired: 1, revoked: 2, invalid: 3 });

/** @param {unknown} value */
function statusOrder(value) {
  if (typeof value !== "string" || !Object.hasOwn(STATUS_ORDER, value)) return 4;
  return STATUS_ORDER[/** @type {keyof typeof STATUS_ORDER} */ (value)];
}

/** @param {unknown} value @returns {string[]} */
function stringList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string"))]
    : [];
}

/**
 * Treat the API response as untrusted at the DOM boundary. The backend owns
 * the full record schema; this keeps a partial response from breaking the
 * administration view.
 * @param {any} payload
 */
export function normalizeMcpTokenListing(payload) {
  return {
    clients: Array.isArray(payload?.clients)
      ? payload.clients.filter((/** @type {any} */ client) => client && typeof client === "object")
      : [],
    allowed_scopes: stringList(payload?.allowed_scopes),
    maximum: Number.isSafeInteger(payload?.maximum) && payload.maximum > 0
      ? payload.maximum
      : 0,
  };
}

/** @param {string[]} allowedScopes */
export function defaultMcpTokenScopes(allowedScopes) {
  const allowed = new Set(allowedScopes);
  return MCP_READ_SCOPES.filter((scope) => allowed.has(scope));
}

/** @param {any[]} clients */
export function sortedMcpTokenClients(clients) {
  return [...clients].sort((left, right) => {
    const status = statusOrder(left?.status) - statusOrder(right?.status);
    if (status) return status;
    return String(right?.created_at || "").localeCompare(String(left?.created_at || ""));
  });
}

/** @param {string} hostname @param {number} [port] */
export function mcpEndpoint(hostname, port = 8100) {
  let host = String(hostname || "").trim() || "homeassistant.local";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  const safePort = Number.isSafeInteger(port) && port > 0 && port <= 65535
    ? port
    : 8100;
  return `http://${host}:${safePort}/mcp`;
}

/** @param {string} endpoint @param {string} token */
export function mcpClientConfigurations(endpoint, token) {
  const url = String(endpoint);
  const secret = String(token);
  return {
    claude_code: `claude mcp add --transport http --scope user --header "Authorization: Bearer ${secret}" esphome-display-editor ${url}`,
    project_json: JSON.stringify({
      mcpServers: {
        "esphome-display-editor": {
          type: "http",
          url,
          headers: {
            Authorization: "Bearer ${ESPHOME_EDITOR_MCP_TOKEN}",
          },
        },
      },
    }, null, 2),
  };
}

/** @param {ApiClient} api */
export function createMcpTokensController(api) {
  return {
    status() { return api("admin/mcp/status"); },
    test() { return api("admin/mcp/test", { method: "POST" }); },
    async list() {
      return normalizeMcpTokenListing(await api("admin/mcp/tokens"));
    },
    /** @param {{name: string, scopes: string[], expires_in_seconds: number}} input */
    create(input) {
      return api("admin/mcp/tokens", {
        method: "POST",
        body: JSON.stringify({
          name: input.name.trim(),
          scopes: stringList(input.scopes),
          expires_in_seconds: input.expires_in_seconds,
        }),
      });
    },
    /** @param {string} id */
    revoke(id) {
      return api(`admin/mcp/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}
