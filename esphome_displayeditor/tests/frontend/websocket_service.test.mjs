import assert from "node:assert/strict";
import test from "node:test";
import { createJsonSocket, websocketUrl } from "../../frontend/services/websocket.js";

class FakeSocket {
  listeners = {};
  constructor(url) { this.url = url; FakeSocket.instances.push(this); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  emit(type, value = {}) { this.listeners[type]?.(value); }
  close() { this.closed = true; }
}
FakeSocket.instances = [];

test("websocket URLs preserve ingress paths and protocol", () => {
  assert.equal(websocketUrl({ protocol: "https:", host: "ha", pathname: "/ingress/token" }, "jobs/events"), "wss://ha/ingress/token/api/v1/jobs/events");
});

test("JSON socket parses messages and schedules reconnect", () => {
  FakeSocket.instances = [];
  const messages = [];
  let scheduled;
  const client = createJsonSocket({ path: "events", onMessage: (value) => messages.push(value), location: { protocol: "http:", host: "local", pathname: "/" }, WebSocketClass: FakeSocket, schedule: (callback) => { scheduled = callback; return 1; } });
  const first = client.connect();
  first.emit("message", { data: "not-json" });
  first.emit("message", { data: '{"ok":true}' });
  first.emit("close");
  assert.deepEqual(messages, [{ ok: true }]);
  scheduled();
  assert.equal(FakeSocket.instances.length, 2);
  client.stop();
});
