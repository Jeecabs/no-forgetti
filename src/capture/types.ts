export const CAPTURE_PROTOCOL_VERSION = 1;
export const CAPTURE_SANITIZER_VERSION = "1";

export type CaptureOutcome = "success" | "error" | "aborted";
export type CaptureReason = "agent_settled" | "shutdown" | "tree" | "recovery";

export interface CanonicalEvidenceEntry {
  sourceEntryId: string;
  parentSourceEntryId: string | null;
  parentNodeDigest: string | null;
  nodeDigest: string;
  timestamp: string;
  kind: "user" | "assistant" | "tool" | "compaction" | "branch_summary" | "state";
  payload: Record<string, unknown>;
}

export interface CaptureCheckpoint {
  leafId: string;
  memoryBranch: string;
  selectionBoundaryId?: string;
  outcome: CaptureOutcome;
  reason: CaptureReason;
  settledAt: string;
}

export interface CaptureDelta {
  protocolVersion: number;
  sanitizerVersion: string;
  producer: {
    piVersion: string;
    extensionVersion: string;
  };
  project: {
    key: string;
    canonicalRoot: string;
    trusted: boolean;
  };
  session: {
    key: string;
    generation: string;
    persistedPath?: string;
  };
  afterEntryId?: string;
  entries: CanonicalEvidenceEntry[];
  checkpoint: CaptureCheckpoint;
  captureId: string;
  contentDigest: string;
}

export interface CaptureFrontier {
  sessionKey: string;
  generation: string;
  lastEntryId?: string;
  knownEntryCount: number;
  nodeDigests: Record<string, string>;
}
