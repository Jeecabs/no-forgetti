export const SKILL_STORE_VERSION = 1;
export const DEFAULT_SKILL_REVIEW_INTERVAL = 10;
export const DEFAULT_SKILL_REVIEW_SIGNAL_THRESHOLD = 4;
export const DEFAULT_SKILL_RETENTION_SESSIONS = 20;
export const MAX_SKILL_DESCRIPTION_CHARS = 500;
export const MAX_SKILL_CONTENT_CHARS = 32_000;

export type SkillWriteOrigin = "foreground" | "background_review";
export type SkillReviewOutcome = "success" | "failure" | "cancelled";
export type SkillState = "active" | "archived";
export type SkillOperationAction = "create" | "patch" | "archive";

export interface ProjectSkill {
  name: string;
  generationId: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  createdBy: SkillWriteOrigin;
  updatedBy: SkillWriteOrigin;
  state: SkillState;
  useCount: number;
  useSessionCount: number;
  viewCount: number;
  patchCount: number;
  createdSession: number;
  lastUsedSession?: number;
  lastRetentionSession?: number;
  lastUsedAt?: string;
  lastRetentionAt?: string;
  lastViewedAt?: string;
  lastPatchedAt?: string;
}

export interface SkillOperation {
  action: SkillOperationAction;
  name: string;
  description?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  reason?: string;
  evidence?: string[];
}

export interface SkillProposalBinding {
  generationId: string;
  contentDigest: string;
}

export interface SkillReviewerProfileReceipt {
  digest: string;
  provider: string;
  model: string;
  api: string;
  reasoningEffort: string;
  maxOutputTokens?: number;
}

export interface SkillReviewAttemptReceipt {
  ordinal: number;
  promptDigest: string;
  requestDigest: string;
  outputDigest: string;
  invalidOutput: boolean;
  provider: string;
  model: string;
  api: string;
  responseModel?: string;
  responseId?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costTotal: number;
}

export type SkillReviewTargetReceipt =
  | { kind: "absent"; name: string }
  | { kind: "existing"; name: string; generationId: string; contentDigest: string };

export interface SkillReviewReceipt {
  version: 1;
  jobId: string;
  jobDigest: string;
  promptVersion: 1;
  systemPromptDigest: string;
  initialPromptDigest: string;
  requestDigest: string;
  operationDigest: string;
  target: SkillReviewTargetReceipt;
  outcomeDigest: string;
  receiptDigest: string;
  profile: SkillReviewerProfileReceipt;
  attempts: SkillReviewAttemptReceipt[];
}

export interface SkillProposal {
  version: number;
  id: string;
  createdAt: string;
  sourceSessionId?: string;
  origin?: SkillWriteOrigin;
  binding?: SkillProposalBinding;
  review?: SkillReviewReceipt;
  retention?: boolean;
  retentionSession?: number;
  retentionAfterSessions?: number;
  operations: SkillOperation[];
}

export interface SkillSessionMaintenance {
  sessionCount: number;
  isNew: boolean;
  proposals: SkillProposal[];
}

export interface SkillUseResult {
  withdrawnRetentionProposals: number;
}

export interface SkillReviewPendingTurn {
  entryId: string;
  signalScore: number;
}

export interface SkillReviewSessionState {
  pending: SkillReviewPendingTurn[];
}

export interface SkillReviewClaim {
  generation: number;
  token: string;
  sessionKey: string;
  evidenceEntryIds: string[];
  capturedTurns: number;
  capturedSignalScore: number;
}

export interface SkillReviewState {
  version: number;
  sessions: Record<string, SkillReviewSessionState>;
  consecutiveFailures: number;
  generation?: number;
  activeClaim?: SkillReviewClaim;
  lastReviewedAt?: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  /** May temporarily fence v3 claims after migration from an unattributed v2 lease. */
  inFlightUntil?: string;
}

export interface SkillMutationResult {
  changed: boolean;
  message: string;
  skill?: ProjectSkill;
}

export interface SkillReviewPlan {
  operations: SkillOperation[];
}
