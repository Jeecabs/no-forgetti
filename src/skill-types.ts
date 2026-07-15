export const SKILL_STORE_VERSION = 1;
export const DEFAULT_SKILL_REVIEW_INTERVAL = 10;
export const DEFAULT_SKILL_REVIEW_SIGNAL_THRESHOLD = 4;
export const DEFAULT_SKILL_RETENTION_SESSIONS = 20;
export const MAX_SKILL_DESCRIPTION_CHARS = 60;
export const MAX_SKILL_CONTENT_CHARS = 32_000;

export type SkillWriteOrigin = "foreground" | "background_review";
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

export interface SkillProposal {
  version: number;
  id: string;
  createdAt: string;
  sourceSessionId?: string;
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

export interface SkillReviewState {
  version: number;
  turnsSinceReview: number;
  signalScore: number;
  consecutiveFailures: number;
  lastReviewedAt?: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
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
