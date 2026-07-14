import assert from "node:assert/strict";
import test from "node:test";

import { isNonPrimaryAgent } from "../src/runtime.ts";

test("disables memory for gang/pi-subagents child processes", () => {
  assert.equal(isNonPrimaryAgent({}), false);
  assert.equal(isNonPrimaryAgent({ PI_SUBAGENT_CHILD_AGENT: "reviewer" }), true);
  assert.equal(isNonPrimaryAgent({ PI_SUBAGENT_RUN_ID: "run-123" }), true);
  assert.equal(isNonPrimaryAgent({ PI_SUBAGENT_CHILD_AGENT: "   ", PI_SUBAGENT_RUN_ID: "" }), false);
});
