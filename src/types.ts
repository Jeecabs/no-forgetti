export const STORE_VERSION = 1;
export const MAIN_MEMORY = "main";
export const DEFAULT_MAX_CHARS = 4_000;
export const MEMORY_REFINEMENT_TARGET_RATIO = 0.75;
export const DEFAULT_MAX_ENTRY_CHARS = 800;
export const DEFAULT_REVIEW_INTERVAL = 10;
export const DEFAULT_REVIEW_SIGNAL_THRESHOLD = 4;

export type MemoryWriteOrigin = "assistant_tool" | "background_review";
export type MemoryImportance = "high" | "normal" | "low";

export interface MemoryEntry {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  sourceSessionId?: string;
  createdBy?: MemoryWriteOrigin;
  updatedBy?: MemoryWriteOrigin;
  importance: MemoryImportance;
  importanceAssessedAt?: string;
}

export interface MemoryBranch {
  version: number;
  name: string;
  parent?: string;
  createdAt: string;
  updatedAt: string;
  entries: MemoryEntry[];
}

export interface ProjectMetadata {
  version: number;
  projectRoot: string;
  projectKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewState {
  version: number;
  turnsSinceReview: number;
  signalScore: number;
  consecutiveFailures: number;
  lastReviewedAt?: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  inFlightUntil?: string;
}

export type MemoryAction = "list" | "add" | "replace" | "remove";

export interface MemoryOperation {
  action: Exclude<MemoryAction, "list">;
  content?: string;
  oldText?: string;
  importance?: MemoryImportance;
}

export type ReviewOperation =
  | { action: "add"; content: string; importance: MemoryImportance }
  | { action: "replace"; entryId: string; content: string; importance: MemoryImportance }
  | { action: "remove"; entryId: string }
  | { action: "merge"; entryIds: string[]; content: string; importance: MemoryImportance }
  | { action: "assess"; entryId: string; importance: MemoryImportance };

export interface MutationResult {
  changed: boolean;
  message: string;
  branch: MemoryBranch;
}

export interface ReviewPlan {
  operations: ReviewOperation[];
}
