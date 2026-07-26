export type ClaimId = string;
export type EvidenceId = string;
export type MemoryId = string;
export type KnowledgeEventId = string;
export type ISODateString = string;

/** A probability in [0, 1]. Values remain separate; callers must not hide them in one score. */
export type Probability = number;

export interface EpistemicConfidence {
  truth: Probability;
  extraction: Probability;
  scope: Probability;
}

export type EvidenceSourceKind =
  | "observation"
  | "user"
  | "tool"
  | "document"
  | "test"
  | "memory";

export interface EvidenceSource {
  kind: EvidenceSourceKind;
  /** Stable identity of the actual source, not the copied evidence record. */
  id: string;
}

export interface Evidence {
  id: EvidenceId;
  content: string;
  observedAt: ISODateString;
  source: EvidenceSource;
  confidence: EpistemicConfidence;
  /** Evidence that a rule is common. Not evidence that the rule is important. */
  commonness: Probability;
  /** Explicit provenance prevents a memory copy from becoming new evidence. */
  derivedFromMemory?: readonly MemoryId[];
  derivedFromEvidence?: readonly EvidenceId[];
  /** Copies or dependent observations share this key. */
  independenceKey?: string;
}

export type Locus =
  | { kind: "universal" }
  | { kind: "project"; projectId: string }
  | { kind: "directory"; projectId: string; path: string }
  | { kind: "file"; projectId: string; path: string };

export interface ApplicabilitySelector {
  projects?: readonly string[];
  exactFiles?: readonly string[];
  directories?: readonly string[];
  excludeExactFiles?: readonly string[];
  excludeDirectories?: readonly string[];
  tasks?: readonly string[];
  languages?: readonly string[];
  commands?: readonly string[];
  tagsAll?: readonly string[];
  tagsAny?: readonly string[];
}

export type ClaimValidity =
  | {
      status: "current";
      validFrom?: ISODateString;
      validUntil?: ISODateString;
    }
  | {
      status: "contested";
      since: ISODateString;
      evidenceIds?: readonly EvidenceId[];
      reason?: string;
    }
  | {
      status: "superseded";
      at: ISODateString;
      byClaimId: ClaimId;
    }
  | {
      status: "retracted";
      at: ISODateString;
      reason?: string;
    };

export type Validity = ClaimValidity;
export type Importance = "critical" | "high" | "normal" | "low";

export interface Freshness {
  /** Time represented by the claim, distinct from record creation time. */
  asOf: ISODateString;
  /** Absolute and relative bounds may coexist; the earlier one wins. */
  staleAfter?: ISODateString;
  maxAgeMs?: number;
}

export interface Claim {
  id: ClaimId;
  /** Claims with the same key are alternatives; narrower applicable loci take precedence. */
  key: string;
  statement: string;
  locus: Locus;
  validity: ClaimValidity;
  evidenceIds: readonly EvidenceId[];

  // Keep epistemic, priority, applicability, time, and payoff dimensions independent.
  commonness: Probability;
  confidence: EpistemicConfidence;
  importance: Importance;
  applicability: ApplicabilitySelector;
  freshness: Freshness;
  utility: number;
}

export interface RuntimeApplicability {
  projectId?: string;
  filePath?: string;
  task?: string;
  language?: string;
  command?: string;
  tags?: readonly string[];
  /** Explicit evaluation time keeps policy results reproducible. */
  at?: ISODateString;
}

interface KnowledgeEventBase {
  id: KnowledgeEventId;
  claimId: ClaimId;
  at: ISODateString;
  sessionId?: string;
}

export interface ExposureEvent extends KnowledgeEventBase {
  type: "exposure";
  surface?: string;
}

export interface SelectedEvent extends KnowledgeEventBase {
  type: "selected";
  rank?: number;
}

export interface AppliedEvent extends KnowledgeEventBase {
  type: "applied";
  locus?: Locus;
}

export interface VerifiedEvent extends KnowledgeEventBase {
  type: "verified";
  evidenceId?: EvidenceId;
}

export interface CorrectedEvent extends KnowledgeEventBase {
  type: "corrected";
  replacementClaimId?: ClaimId;
  reason?: string;
}

export type KnowledgeEvent =
  | ExposureEvent
  | SelectedEvent
  | AppliedEvent
  | VerifiedEvent
  | CorrectedEvent;
