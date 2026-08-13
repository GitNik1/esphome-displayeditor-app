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

