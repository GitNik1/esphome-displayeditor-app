import assert from "node:assert/strict";
import test from "node:test";

import { blobToBase64, uploadImageAsset } from "../../frontend/api/assets.js";

test("blob conversion preserves binary bytes across chunks", async () => {
  const bytes = Uint8Array.from({ length: 9000 }, (_, index) => index % 256);
  const encoded = await blobToBase64(new Blob([bytes]));
  assert.deepEqual(Buffer.from(encoded, "base64"), Buffer.from(bytes));
});

test("image upload sends the expected JSON payload", async () => {
  let request;
  const api = async (...args) => {
    request = args;
    return { path: "images/flow.png" };
  };
  const path = await uploadImageAsset(api, "flow.png", new Blob([Uint8Array.of(0, 1, 2)]));
  assert.equal(path, "images/flow.png");
  assert.equal(request[0], "designer/assets/images");
  assert.equal(request[1].method, "POST");
  assert.deepEqual(JSON.parse(request[1].body), {
    name: "flow.png",
    content_base64: "AAEC",
  });
});

