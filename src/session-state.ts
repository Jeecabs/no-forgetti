import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { MAIN_MEMORY } from "./types.ts";

export const ACTIVE_MEMORY_ENTRY = "no-forgetti-active";
export const REVIEW_CURSOR_ENTRY = "no-forgetti-review";

interface ActiveMemoryState {
  name?: unknown;
}

interface ReviewCursorState {
  projectKey?: unknown;
  name?: unknown;
  throughEntryId?: unknown;
}

export function restoreActiveMemory(ctx: ExtensionContext): string {
  let active = MAIN_MEMORY;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ACTIVE_MEMORY_ENTRY) continue;
    const data: unknown = entry.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const name = (data as ActiveMemoryState).name;
    if (typeof name === "string" && name.trim()) active = name;
  }
  return active;
}

export function restoreReviewCursor(ctx: ExtensionContext, projectKey: string, name: string): string | undefined {
  let cursor: string | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== REVIEW_CURSOR_ENTRY) continue;
    const data: unknown = entry.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const state = data as ReviewCursorState;
    if (state.projectKey !== projectKey || state.name !== name || typeof state.throughEntryId !== "string") continue;
    cursor = state.throughEntryId;
  }
  return cursor;
}
