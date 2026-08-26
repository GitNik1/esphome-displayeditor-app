import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const BRIDGE = path.join(
  ROOT,
  "clients",
  "claude-desktop",
  "server",
  "index.cjs",
);
const TOKEN = "mcp_test_0123456789abcdefghijklmnopqrstuvwxyz";

function lineQueue(stream) {
  let buffered = "";
  const waiting = [];
  const queued = [];

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      const waiter = waiting.shift();
      if (waiter) {
        waiter.resolve(line);
      } else {
        queued.push(line);
      }
      newline = buffered.indexOf("\n");
    }
  });

  return {
    next(timeoutMs = 3000) {
      if (queued.length) {
        return Promise.resolve(queued.shift());
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiting.push(waiter);
        const timer = setTimeout(() => {
          const index = waiting.indexOf(waiter);
          if (index !== -1) {
            waiting.splice(index, 1);
          }
          reject(new Error("Timed out waiting for bridge output."));
        }, timeoutMs);
        waiter.resolve = (line) => {
          clearTimeout(timer);
          resolve(line);
        };
      });
    },
  };
}

async function readBody(request) {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : null;
}

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function startBridge(url, token = TOKEN) {
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ESPHOME_EDITOR_MCP_URL: url,
      ESPHOME_EDITOR_MCP_TOKEN: token,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return { child, lines: lineQueue(child.stdout), stderr: () => stderr };
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

test("MCPB bridge forwards JSON and SSE responses with negotiated headers", async (t) => {
  const requests = [];
  const { server, url } = await listen(async (request, response) => {
    const message = request.method === "POST" ? await readBody(request) : null;
    requests.push({
      method: request.method,
      message,
      authorization: request.headers.authorization,
      session: request.headers["mcp-session-id"],
      protocol: request.headers["mcp-protocol-version"],
      mcpMethod: request.headers["mcp-method"],
      mcpName: request.headers["mcp-name"],
    });

    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    if (message?.method === "initialize") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "session-123",
      });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2026-07-28",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        },
      }));
      return;
    }
    if (message?.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    if (message?.method === "tools/list") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "display_projects" }] },
        })}\n\n`,
      );
      return;
    }
    if (message?.method === "tools/call") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "ok" }] },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => closeServer(server));

  const bridge = startBridge(url);
  t.after(() => bridge.child.kill());
  send(bridge.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  const initialized = JSON.parse(await bridge.lines.next());
  assert.equal(initialized.result.protocolVersion, "2026-07-28");

  send(bridge.child, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  send(bridge.child, {
    jsonrpc: "2.0",
    id: "tools-1",
    method: "tools/list",
    params: {},
  });
  const tools = JSON.parse(await bridge.lines.next());
  assert.equal(tools.id, "tools-1");
  assert.equal(tools.result.tools[0].name, "display_projects");

  send(bridge.child, {
    jsonrpc: "2.0",
    id: "call-1",
    method: "tools/call",
    params: { name: "display_projects", arguments: {} },
  });
  const called = JSON.parse(await bridge.lines.next());
  assert.equal(called.id, "call-1");

  bridge.child.stdin.end();
  const [exitCode] = await once(bridge.child, "close");
  assert.equal(exitCode, 0);
  assert.equal(bridge.stderr(), "");
  assert.ok(requests.every((entry) => entry.authorization === `Bearer ${TOKEN}`));

  const initializeRequest = requests.find(
    (entry) => entry.message?.method === "initialize",
  );
  assert.equal(initializeRequest.session, undefined);
  assert.equal(initializeRequest.protocol, undefined);
  assert.equal(initializeRequest.mcpMethod, "initialize");

  const toolsRequest = requests.find((entry) => entry.message?.method === "tools/list");
  assert.equal(toolsRequest.session, "session-123");
  assert.equal(toolsRequest.protocol, "2026-07-28");
  assert.equal(toolsRequest.mcpMethod, "tools/list");
  const callRequest = requests.find((entry) => entry.message?.method === "tools/call");
  assert.equal(callRequest.mcpMethod, "tools/call");
  assert.equal(callRequest.mcpName, "display_projects");
  assert.ok(requests.some((entry) => entry.method === "DELETE"));
  assert.ok(!requests.some((entry) => entry.method === "GET"));
});

test("MCPB bridge relays legacy server notifications over the GET stream", async (t) => {
  let getOpened;
  const opened = new Promise((resolve) => {
    getOpened = resolve;
  });
  const { server, url } = await listen(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `id: event-1\nevent: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        })}\n\n`,
      );
      getOpened();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    const message = await readBody(request);
    if (message.method === "initialize") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "legacy-session",
      });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "test", version: "1" },
        },
      }));
      return;
    }
    response.writeHead(202).end();
  });
  t.after(() => closeServer(server));

  const bridge = startBridge(url);
  t.after(() => bridge.child.kill());
  send(bridge.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {} },
  });
  await bridge.lines.next();
  send(bridge.child, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });

  await opened;
  const notification = JSON.parse(await bridge.lines.next());
  assert.equal(notification.method, "notifications/tools/list_changed");
  bridge.child.stdin.end();
  const [exitCode] = await once(bridge.child, "close");
  assert.equal(exitCode, 0);
  assert.equal(bridge.stderr(), "");
});

test("MCPB bridge rejects unsafe configuration without disclosing its token", async () => {
  const secret = "do-not-print-this-secret-01234567890123456789";
  const bridge = startBridge("file:///tmp/mcp", secret);
  const [exitCode] = await once(bridge.child, "close");

  assert.equal(exitCode, 2);
  assert.match(bridge.stderr(), /Only http and https/u);
  assert.doesNotMatch(bridge.stderr(), new RegExp(secret, "u"));
});

test("MCPB bridge rejects a remote response above 512 KiB", async (t) => {
  const { server, url } = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("x".repeat(512 * 1024 + 1));
  });
  t.after(() => closeServer(server));

  const bridge = startBridge(url);
  t.after(() => bridge.child.kill());
  send(bridge.child, {
    jsonrpc: "2.0",
    id: "bounded-response",
    method: "tools/list",
    params: {},
  });

  const failure = JSON.parse(await bridge.lines.next());
  assert.equal(failure.id, "bounded-response");
  assert.match(failure.error.message, /exceeds the bridge limit/u);
  bridge.child.stdin.end();
  const [exitCode] = await once(bridge.child, "close");
  assert.equal(exitCode, 0);
  assert.equal(bridge.stderr(), "");
});
