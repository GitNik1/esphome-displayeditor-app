import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient, encodedName } from "../../frontend/api/client.js";

test("configuration names encode segments without losing path separators", () => {
  assert.equal(encodedName("rooms/Küche display.yaml"), "rooms/K%C3%BCche%20display.yaml");
});

test("API client builds ingress-relative URLs and merges headers", async () => {
  let request;
  const api = createApiClient({
    pathname: "/api/hassio_ingress/token",
    fetchImpl: async (...args) => {
      request = args;
      return { status: 200, ok: true, json: async () => ({ status: "ok" }) };
    },
  });
  assert.deepEqual(await api("health", { headers: { "Idempotency-Key": "abc" } }), { status: "ok" });
  assert.equal(request[0], "/api/hassio_ingress/token/api/v1/health");
  assert.deepEqual(request[1].headers, {
    "Content-Type": "application/json",
    "Idempotency-Key": "abc",
  });
});

test("API client handles empty successful responses", async () => {
  const api = createApiClient({
    pathname: "/",
    fetchImpl: async () => ({ status: 204, ok: true }),
  });
  assert.equal(await api("draft", { method: "DELETE" }), null);
});

test("API client exposes structured backend errors", async () => {
  const api = createApiClient({
    pathname: "/",
    fetchImpl: async () => ({
      status: 409,
      ok: false,
      json: async () => ({ message: "Revision changed", error: "revision_conflict", details: { expected: "old" } }),
    }),
  });
  await assert.rejects(api("draft"), (error) => {
    assert.equal(error.message, "Revision changed");
    assert.equal(error.code, "revision_conflict");
    assert.deepEqual(error.details, { expected: "old" });
    return true;
  });
});


function rateLimited(retryAfter) {
  return {
    status: 429,
    ok: false,
    json: async () => ({ error: "rate_limit_exceeded", message: "Too many", details: { retry_after: retryAfter } }),
  };
}

test("API client retries a rate-limited read once after a short wait", async () => {
  const responses = [rateLimited(2), { status: 200, ok: true, json: async () => ({ fine: true }) }];
  const waits = [];
  const api = createApiClient({
    pathname: "/",
    fetchImpl: async () => responses.shift(),
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(await api("designer/projects"), { fine: true });
  assert.deepEqual(waits, [2000]);
});

test("API client never repeats a rate-limited write, nor waits long", async () => {
  let calls = 0;
  const waits = [];
  const api = createApiClient({
    pathname: "/",
    fetchImpl: async () => { calls += 1; return rateLimited(calls === 1 ? 1 : 30); },
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  await assert.rejects(api("draft", { method: "PUT" }), (error) => error.code === "rate_limit_exceeded");
  assert.equal(calls, 1);
  await assert.rejects(api("designer/projects"), (error) => error.code === "rate_limit_exceeded");
  assert.equal(calls, 2);
  assert.deepEqual(waits, []);
});

test("API client lets the UI translate known backend error codes", async () => {
  const api = createApiClient({
    pathname: "/",
    fetchImpl: async () => ({
      status: 422, ok: false,
      json: async () => ({ error: "merge_failed", message: "line 3: bad", details: { line: 3 } }),
    }),
    describeError: (code, message) => (code === "merge_failed" ? `Zusammenführen: ${message}` : message),
  });
  await assert.rejects(api("designer/projects/merge-draft", { method: "POST" }), (error) => {
    assert.equal(error.message, "Zusammenführen: line 3: bad");
    assert.equal(error.code, "merge_failed");
    assert.deepEqual(error.details, { line: 3 });
    return true;
  });
});
