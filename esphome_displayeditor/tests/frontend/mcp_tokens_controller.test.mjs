import assert from "node:assert/strict";
import test from "node:test";
import {
  createMcpTokensController,
  defaultMcpTokenScopes,
  mcpClientConfigurations,
  mcpEndpoint,
  normalizeMcpTokenListing,
  sortedMcpTokenClients,
} from "../../frontend/controllers/mcp-tokens-controller.js";

test("MCP token controller owns normalized administrator transport", async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push([path, options]);
    if (!options.method) return {
      clients: [{ id: "one", status: "active" }, null],
      allowed_scopes: ["server:read", "server:read", 4],
      maximum: 100,
    };
    return { client: { id: "one" }, token: "one-time-secret" };
  };
  const controller = createMcpTokensController(api);

  await controller.status();
  await controller.test();
  assert.deepEqual(await controller.list(), {
    clients: [{ id: "one", status: "active" }],
    allowed_scopes: ["server:read"],
    maximum: 100,
  });
  await controller.create({
    name: "  Claude Code  ",
    scopes: ["server:read", "server:read"],
    expires_in_seconds: 86400,
  });
  await controller.revoke("client/one");

  assert.deepEqual(calls[0], ["admin/mcp/status", {}]);
  assert.deepEqual(calls[1], ["admin/mcp/test", { method: "POST" }]);
  assert.equal(calls[3][0], "admin/mcp/tokens");
  assert.equal(calls[3][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[3][1].body), {
    name: "Claude Code",
    scopes: ["server:read"],
    expires_in_seconds: 86400,
  });
  assert.deepEqual(calls[4], [
    "admin/mcp/tokens/client%2Fone",
    { method: "DELETE" },
  ]);
});

test("MCP client configurations use the LAN endpoint and environment placeholder", () => {
  assert.equal(mcpEndpoint("homeassistant.local"), "http://homeassistant.local:8100/mcp");
  assert.equal(mcpEndpoint("fd00::42", 9000), "http://[fd00::42]:9000/mcp");
  const generated = mcpClientConfigurations(
    "http://homeassistant.local:8100/mcp",
    "mcp_one-time-secret",
  );
  assert.match(generated.claude_code, /Authorization: Bearer mcp_one-time-secret/);
  const project = JSON.parse(generated.project_json);
  assert.doesNotMatch(generated.project_json, /mcp_one-time-secret/);
  assert.equal(
    project.mcpServers["esphome-display-editor"].headers.Authorization,
    "Bearer ${ESPHOME_EDITOR_MCP_TOKEN}",
  );
  assert.equal(
    project.mcpServers["esphome-display-editor"].url,
    "http://homeassistant.local:8100/mcp",
  );
});

test("MCP token helpers select read scopes and put active clients first", () => {
  assert.deepEqual(defaultMcpTokenScopes([
    "project:write", "device:read", "server:read",
  ]), ["server:read", "device:read"]);
  assert.deepEqual(
    sortedMcpTokenClients([
      { id: "revoked", status: "revoked", created_at: "2026-03-01" },
      { id: "old", status: "active", created_at: "2026-01-01" },
      { id: "new", status: "active", created_at: "2026-02-01" },
    ]).map((client) => client.id),
    ["new", "old", "revoked"],
  );
  assert.deepEqual(normalizeMcpTokenListing(null), {
    clients: [], allowed_scopes: [], maximum: 0,
  });
});
