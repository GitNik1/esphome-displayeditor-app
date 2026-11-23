import assert from "node:assert/strict";
import test from "node:test";

import { suggestedCopyName } from "../../frontend/dialogs/save-conflict.js";

test("the suggested name for saving a copy counts up", () => {
  assert.equal(suggestedCopyName("display.lvgldesign"), "display_2.lvgldesign");
  assert.equal(suggestedCopyName("display_2.lvgldesign"), "display_3.lvgldesign");
  assert.equal(suggestedCopyName("panel_v1_9.lvgldesign"), "panel_v1_10.lvgldesign");
  assert.equal(suggestedCopyName("odd"), "odd_2");
});
