#!/usr/bin/env node
"use strict";

const { once } = require("node:events");

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 300_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const LEGACY_GET_CUTOFF = "2026-07-28";

let endpoint;
let accessToken;
let sessionId = null;
let protocolVersion = null;
let inputBuffer = "";
let outputTail = Promise.resolve();
let shuttingDown = false;
let shutdownStarted = false;
let getStreamController = null;

const inFlight = new Set();
const postControllers = new Set();

class RemoteProtocolError extends Error {}

function diagnostic(message) {
  process.stderr.write(`[esphome-display-editor] ${message}\n`);
}

function loadConfiguration(environment) {
  const rawUrl = String(environment.ESPHOME_EDITOR_MCP_URL || "").trim();
  const token = String(environment.ESPHOME_EDITOR_MCP_TOKEN || "");
  if (!rawUrl) {
    throw new Error("ESPHOME_EDITOR_MCP_URL is required.");
  }
  if (
    token.length < 32 ||
    token.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw new Error("ESPHOME_EDITOR_MCP_TOKEN must be a valid secret.");
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("ESPHOME_EDITOR_MCP_URL must be an absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https MCP URLs are supported.");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("The MCP URL must not contain credentials, query, or fragment.");
  }
  if (!url.hostname || url.pathname === "/") {
    throw new Error("The MCP URL must include an endpoint path such as /mcp.");
  }
  return { url, token };
}

function baseHeaders(message = null) {
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  if (protocolVersion) {
    headers["Mcp-Protocol-Version"] = protocolVersion;
  }
  if (message && typeof message.method === "string") {
    headers["Mcp-Method"] = message.method;
  }
  if (
    message?.method === "tools/call" &&
    typeof message?.params?.name === "string"
  ) {
    headers["Mcp-Name"] = message.params.name;
  }
  return headers;
}

function hasRequestId(message) {
  return Object.prototype.hasOwnProperty.call(message, "id");
}

function isRequest(message) {
  return typeof message.method === "string" && hasRequestId(message);
}

function isResponse(message) {
  return (
    hasRequestId(message) &&
    (Object.prototype.hasOwnProperty.call(message, "result") ||
      Object.prototype.hasOwnProperty.call(message, "error"))
  );
}

function validateMessage(message) {
  return (
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    message.jsonrpc === "2.0" &&
    (typeof message.method === "string" || isResponse(message))
  );
}

function emitJson(message) {
  let payload;
  try {
    payload = JSON.stringify(message);
  } catch {
    return Promise.reject(
      new RemoteProtocolError("Remote MCP message is not serializable."),
    );
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_RESPONSE_BYTES) {
    return Promise.reject(
      new RemoteProtocolError("Remote MCP message exceeds the bridge limit."),
    );
  }
  const line = `${payload}\n`;

  outputTail = outputTail.then(async () => {
    if (!process.stdout.write(line)) {
      await once(process.stdout, "drain");
    }
  });
  return outputTail;
}

function errorForRequest(message, text) {
  if (!isRequest(message)) {
    diagnostic(text);
    return Promise.resolve();
  }
  return emitJson({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32000, message: text },
  });
}

function statusError(status) {
  if (status === 401 || status === 403) {
    return "Remote MCP authentication failed.";
  }
  if (status === 413) {
    return "The MCP request exceeds the remote server limit.";
  }
  if (status === 429) {
    return "The remote MCP rate limit was exceeded.";
  }
  return `The remote MCP server returned HTTP ${status}.`;
}

function createTimedController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    controller,
    close() {
      clearTimeout(timer);
    },
  };
}

async function readBoundedText(body, limit) {
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > limit) {
        throw new RemoteProtocolError(
          "Remote MCP response exceeds the bridge limit.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block) {
  let eventName = "message";
  let eventId = null;
  const data = [];
  for (const line of block.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      eventName = value;
    } else if (field === "id") {
      eventId = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  return { eventName, eventId, data: data.join("\n") };
}

async function consumeSse(body, onMessage, { stopOnResponse = false } = {}) {
  if (!body) {
    throw new RemoteProtocolError("Remote MCP SSE response has no body.");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let lastEventId = null;
  let completed = false;

  async function consumeBlock(block) {
    const event = parseSseBlock(block);
    if (event.eventId !== null) {
      lastEventId = event.eventId;
    }
    if ((event.eventName === "message" || !event.eventName) && event.data) {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        throw new RemoteProtocolError("Remote MCP SSE contained invalid JSON.");
      }
      completed = Boolean(await onMessage(parsed));
    }
  }

  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        throw new RemoteProtocolError(
          "Remote MCP SSE event exceeds the bridge limit.",
        );
      }

      let separator = buffer.match(/\r?\n\r?\n/u);
      while (separator) {
        const index = separator.index;
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + separator[0].length);
        await consumeBlock(block);
        if (completed && stopOnResponse) {
          await reader.cancel();
          return { completed: true, lastEventId };
        }
        separator = buffer.match(/\r?\n\r?\n/u);
      }
    }
    buffer += decoder.decode();
    if (!completed && buffer.trim()) {
      await consumeBlock(buffer);
    }
    return { completed, lastEventId };
  } finally {
    reader.releaseLock();
  }
}

async function forwardRemoteMessage(remoteMessage, sourceMessage) {
  if (!validateMessage(remoteMessage)) {
    throw new RemoteProtocolError(
      "Remote MCP response is not a valid JSON-RPC message.",
    );
  }

  const forwarded = { ...remoteMessage };
  if (isRequest(sourceMessage) && isResponse(forwarded)) {
    forwarded.id = sourceMessage.id;
  }
  if (
    sourceMessage.method === "initialize" &&
    forwarded.result &&
    typeof forwarded.result.protocolVersion === "string"
  ) {
    protocolVersion = forwarded.result.protocolVersion;
  }
  await emitJson(forwarded);
  return isResponse(forwarded);
}

async function handleJsonResponse(response, sourceMessage) {
  const body = await readBoundedText(response.body, MAX_RESPONSE_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RemoteProtocolError("Remote MCP response contained invalid JSON.");
  }
  await forwardRemoteMessage(parsed, sourceMessage);
}

async function postMessage(message) {
  const timed = createTimedController(REQUEST_TIMEOUT_MS);
  postControllers.add(timed.controller);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...baseHeaders(message),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
      signal: timed.controller.signal,
      redirect: "error",
    });

    if (message.method === "initialize") {
      const receivedSession = response.headers.get("mcp-session-id");
      if (receivedSession) {
        sessionId = receivedSession;
      }
    }

    if (response.status === 202) {
      if (isRequest(message)) {
        await errorForRequest(
          message,
          "The remote MCP server accepted a request without returning a response.",
        );
      }
      return;
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok) {
      if (isRequest(message) && contentType.startsWith("application/json")) {
        try {
          await handleJsonResponse(response, message);
          return;
        } catch {
          // Fall back to a bounded, status-only error below.
        }
      }
      await errorForRequest(message, statusError(response.status));
      return;
    }

    if (!isRequest(message)) {
      if (response.body) {
        await response.body.cancel();
      }
      return;
    }
    if (contentType.startsWith("application/json")) {
      await handleJsonResponse(response, message);
      return;
    }
    if (contentType.startsWith("text/event-stream")) {
      const result = await consumeSse(
        response.body,
        (remote) => forwardRemoteMessage(remote, message),
        { stopOnResponse: true },
      );
      if (!result.completed) {
        await errorForRequest(
          message,
          "The remote MCP event stream ended without a response.",
        );
      }
      return;
    }
    await errorForRequest(message, "The remote MCP server returned an unsupported content type.");
  } catch (error) {
    if (!shuttingDown) {
      let text = "The remote MCP server could not be reached.";
      if (error && error.name === "AbortError") {
        text = "The remote MCP request timed out.";
      } else if (error instanceof RemoteProtocolError) {
        text = error.message;
      }
      await errorForRequest(message, text);
    }
  } finally {
    timed.close();
    postControllers.delete(timed.controller);
  }
}

function shouldOpenLegacyGetStream() {
  if (!sessionId || !protocolVersion) {
    return false;
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(protocolVersion)) {
    return protocolVersion < LEGACY_GET_CUTOFF;
  }
  return true;
}

async function runLegacyGetStream() {
  let lastEventId = null;
  for (let attempt = 0; attempt < 2 && !shuttingDown; attempt += 1) {
    const controller = new AbortController();
    getStreamController = controller;
    try {
      const headers = baseHeaders();
      if (lastEventId) {
        headers["Last-Event-ID"] = lastEventId;
      }
      const response = await fetch(endpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!response.ok || !contentType.startsWith("text/event-stream")) {
        return;
      }
      const result = await consumeSse(response.body, async (message) => {
        if (!validateMessage(message)) {
          throw new RemoteProtocolError(
            "Remote MCP stream contained an invalid JSON-RPC message.",
          );
        }
        await emitJson(message);
        return false;
      });
      lastEventId = result.lastEventId || lastEventId;
    } catch {
      if (shuttingDown || controller.signal.aborted) {
        return;
      }
    } finally {
      if (getStreamController === controller) {
        getStreamController = null;
      }
    }
    if (!shuttingDown && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function startLegacyGetStream() {
  if (getStreamController || !shouldOpenLegacyGetStream()) {
    return;
  }
  const task = runLegacyGetStream();
  inFlight.add(task);
  task.finally(() => inFlight.delete(task));
}

function dispatch(message) {
  const task = postMessage(message).then(() => {
    if (message.method === "notifications/initialized") {
      startLegacyGetStream();
    }
  });
  inFlight.add(task);
  task.finally(() => inFlight.delete(task));
}

async function terminateRemoteSession() {
  if (!sessionId) {
    return;
  }
  const timed = createTimedController(SHUTDOWN_TIMEOUT_MS);
  try {
    await fetch(endpoint, {
      method: "DELETE",
      headers: baseHeaders(),
      signal: timed.controller.signal,
      redirect: "error",
    });
  } catch {
    // Session cleanup is best effort during client shutdown.
  } finally {
    timed.close();
  }
}

async function shutdown(exitCode = 0) {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  shuttingDown = true;
  if (getStreamController) {
    getStreamController.abort();
  }
  for (const controller of postControllers) {
    controller.abort();
  }
  await Promise.allSettled([...inFlight]);
  await terminateRemoteSession();
  await outputTail.catch(() => undefined);
  process.exitCode = exitCode;
}

function protocolError(id, code, message) {
  return emitJson({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleLine(line) {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    void protocolError(null, -32700, "Parse error");
    return;
  }
  if (!validateMessage(message)) {
    const id = message && hasRequestId(message) ? message.id : null;
    void protocolError(id, -32600, "Invalid Request");
    return;
  }
  dispatch(message);
}

async function main() {
  try {
    const configuration = loadConfiguration(process.env);
    endpoint = configuration.url;
    accessToken = configuration.token;
  } catch (error) {
    diagnostic(error.message);
    process.exitCode = 2;
    return;
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (shuttingDown) {
      return;
    }
    inputBuffer += chunk;
    let newline = inputBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = inputBuffer.slice(0, newline).replace(/\r$/u, "");
      inputBuffer = inputBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_INPUT_BYTES) {
        diagnostic("The stdio MCP message exceeds the 1 MiB bridge limit.");
        void shutdown(2);
        return;
      }
      handleLine(line);
      newline = inputBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(inputBuffer, "utf8") > MAX_INPUT_BYTES) {
      diagnostic("The stdio MCP message exceeds the 1 MiB bridge limit.");
      void shutdown(2);
    }
  });
  process.stdin.on("end", () => {
    if (inputBuffer.trim()) {
      handleLine(inputBuffer.replace(/\r$/u, ""));
      inputBuffer = "";
    }
    void shutdown();
  });
  process.stdin.on("error", () => void shutdown(2));
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
