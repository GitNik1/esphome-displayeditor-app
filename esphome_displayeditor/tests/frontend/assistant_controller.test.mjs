import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantController,
  normalizeAssistantReply,
  summarizeAssistantProposal,
} from "../../frontend/controllers/assistant-controller.js";

test("assistant controller normalizes the reply and posts trimmed input", async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push([path, options]);
    if (path === "assistant/ask") {
      return {
        reply: "Added a label.",
        proposals: [
          { change_set_id: "cs_1", tool: "propose_layout_change", preview: { added_widget_ids: ["a"] } },
          { change_set_id: null, tool: "ignored" },
          "not-an-object",
        ],
      };
    }
    return { status: "applied", applied_revision: "sha256:abc" };
  };
  const controller = createAssistantController(api);

  const result = await controller.ask({ project_name: "display.lvgldesign", message: "  add a label  " });
  assert.deepEqual(result, {
    reply: "Added a label.",
    proposals: [
      { change_set_id: "cs_1", tool: "propose_layout_change", preview: { added_widget_ids: ["a"] } },
    ],
  });
  assert.equal(calls[0][0], "assistant/ask");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    project_name: "display.lvgldesign",
    message: "add a label",
  });

  await controller.apply("cs_1/weird");
  assert.deepEqual(calls[1], ["assistant/changesets/cs_1%2Fweird/apply", { method: "POST" }]);
});

test("normalizeAssistantReply tolerates a malformed or empty payload", () => {
  assert.deepEqual(normalizeAssistantReply(null), { reply: "", proposals: [] });
  assert.deepEqual(normalizeAssistantReply({ reply: 42, proposals: "nope" }), {
    reply: "",
    proposals: [],
  });
});

test("summarizeAssistantProposal collects added/removed ids and issue counts", () => {
  const widgetSummary = summarizeAssistantProposal({
    added_widget_ids: ["label_1"],
    removed_widget_ids: ["old_button"],
    issue_counts: { warning: 2, error: 1 },
  });
  assert.deepEqual(widgetSummary.parts, [
    { kind: "added", items: ["label_1"] },
    { kind: "removed", items: ["old_button"] },
  ]);
  assert.equal(widgetSummary.issueTotal, 3);

  const bindingSummary = summarizeAssistantProposal({
    added_binding_ids: ["heater_binding"],
  });
  assert.deepEqual(bindingSummary.parts, [{ kind: "added", items: ["heater_binding"] }]);
  assert.equal(bindingSummary.issueTotal, 0);

  assert.deepEqual(summarizeAssistantProposal(null), { parts: [], issueTotal: 0 });
});
