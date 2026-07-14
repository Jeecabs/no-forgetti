import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  ACTIVE_MEMORY_ENTRY,
  REVIEW_CURSOR_ENTRY,
  restoreActiveMemory,
  restoreReviewCursor,
} from "../src/session-state.ts";

function contextWithBranch(entries: unknown[]): ExtensionContext {
  return {
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionContext;
}

test("restores branch binding and project-scoped review cursor from active path", () => {
  const ctx = contextWithBranch([
    { type: "custom", customType: REVIEW_CURSOR_ENTRY, data: { projectKey: "project-a", name: "main", throughEntryId: "user-1" } },
    { type: "custom", customType: ACTIVE_MEMORY_ENTRY, data: { name: "experiment" } },
    { type: "custom", customType: REVIEW_CURSOR_ENTRY, data: { projectKey: "project-a", name: "experiment", throughEntryId: "user-2" } },
    { type: "custom", customType: REVIEW_CURSOR_ENTRY, data: { projectKey: "project-b", name: "experiment", throughEntryId: "wrong-project" } },
  ]);

  assert.equal(restoreActiveMemory(ctx), "experiment");
  assert.equal(restoreReviewCursor(ctx, "project-a", "main"), "user-1");
  assert.equal(restoreReviewCursor(ctx, "project-a", "experiment"), "user-2");
  assert.equal(restoreReviewCursor(ctx, "project-a", "missing"), undefined);
});
