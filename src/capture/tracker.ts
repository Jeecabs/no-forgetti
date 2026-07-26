import { createHash } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { canonicalEvidenceDigest, canonicalizeEvidenceEntry } from "./sanitizer.ts";
import {
  CAPTURE_PROTOCOL_VERSION,
  CAPTURE_SANITIZER_VERSION,
  type CaptureCheckpoint,
  type CaptureDelta,
  type CaptureFrontier,
} from "./types.ts";

export interface CaptureIdentity {
  project: CaptureDelta["project"];
  producer: CaptureDelta["producer"];
  sessionId: string;
  generation: string;
  persistedPath?: string;
}

function opaqueSessionKey(sessionId: string): string {
  if (!sessionId.trim()) throw new Error("Capture session ID cannot be empty.");
  return createHash("sha256").update(`no-forgetti-session\0${sessionId}`).digest("hex").slice(0, 32);
}

export class CaptureDeltaBuilder {
  private readonly identity: CaptureIdentity;
  private frontier: CaptureFrontier;

  constructor(identity: CaptureIdentity, frontier?: CaptureFrontier) {
    this.identity = identity;
    const sessionKey = opaqueSessionKey(identity.sessionId);
    if (frontier && (frontier.sessionKey !== sessionKey || frontier.generation !== identity.generation)) {
      throw new Error("Capture frontier belongs to a different session generation.");
    }
    this.frontier = frontier ?? {
      sessionKey,
      generation: identity.generation,
      knownEntryCount: 0,
      nodeDigests: {},
    };
  }

  snapshot(): CaptureFrontier {
    return { ...this.frontier, nodeDigests: { ...this.frontier.nodeDigests } };
  }

  build(entries: readonly SessionEntry[], checkpoint: CaptureCheckpoint): CaptureDelta {
    if (entries.length < this.frontier.knownEntryCount) {
      throw new Error("Session entry sequence shrank; start a new capture generation.");
    }
    if (this.frontier.knownEntryCount > 0) {
      const observed = entries[this.frontier.knownEntryCount - 1]?.id;
      if (observed !== this.frontier.lastEntryId) {
        throw new Error("Session entry prefix changed; start a new capture generation.");
      }
    }

    const digests = { ...this.frontier.nodeDigests };
    const suffix = entries.slice(this.frontier.knownEntryCount);
    const canonicalEntries = suffix.map((entry) => {
      const parentNodeDigest = entry.parentId === null ? null : digests[entry.parentId];
      if (entry.parentId !== null && !parentNodeDigest) {
        throw new Error(`Capture graph is missing parent '${entry.parentId}' for '${entry.id}'.`);
      }
      const canonical = canonicalizeEvidenceEntry(entry, parentNodeDigest ?? null);
      if (!canonical) throw new Error(`Session entry '${entry.id}' could not be canonicalized.`);
      digests[entry.id] = canonical.nodeDigest;
      return canonical;
    });
    if (!digests[checkpoint.leafId] && !canonicalEntries.some((entry) => entry.sourceEntryId === checkpoint.leafId)) {
      throw new Error(`Capture checkpoint leaf '${checkpoint.leafId}' is not present in the graph.`);
    }

    const body = {
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      sanitizerVersion: CAPTURE_SANITIZER_VERSION,
      producer: this.identity.producer,
      project: this.identity.project,
      session: {
        key: this.frontier.sessionKey,
        generation: this.frontier.generation,
        ...(this.identity.persistedPath ? { persistedPath: this.identity.persistedPath } : {}),
      },
      ...(this.frontier.lastEntryId ? { afterEntryId: this.frontier.lastEntryId } : {}),
      entries: canonicalEntries,
      checkpoint,
    };
    const contentDigest = canonicalEvidenceDigest({
      ...body,
      checkpoint: { ...checkpoint, settledAt: undefined },
    });
    const captureId = canonicalEvidenceDigest({
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      sanitizerVersion: CAPTURE_SANITIZER_VERSION,
      projectKey: this.identity.project.key,
      sessionKey: this.frontier.sessionKey,
      generation: this.frontier.generation,
      leafId: checkpoint.leafId,
      memoryBranch: checkpoint.memoryBranch,
      reason: checkpoint.reason,
      contentDigest,
    });
    return { ...body, captureId, contentDigest };
  }

  /** Advance only after the delta has a durable local or daemon acknowledgement. */
  acknowledge(delta: CaptureDelta): CaptureFrontier {
    if (delta.session.key !== this.frontier.sessionKey || delta.session.generation !== this.frontier.generation) {
      throw new Error("Cannot acknowledge a different session generation.");
    }
    if ((delta.afterEntryId ?? undefined) !== (this.frontier.lastEntryId ?? undefined)) {
      throw new Error("Capture acknowledgement does not extend the current frontier.");
    }
    const nodeDigests = { ...this.frontier.nodeDigests };
    for (const entry of delta.entries) nodeDigests[entry.sourceEntryId] = entry.nodeDigest;
    const knownEntryCount = this.frontier.knownEntryCount + delta.entries.length;
    this.frontier = {
      ...this.frontier,
      knownEntryCount,
      ...(delta.entries.at(-1)?.sourceEntryId
        ? { lastEntryId: delta.entries.at(-1)!.sourceEntryId }
        : this.frontier.lastEntryId
          ? { lastEntryId: this.frontier.lastEntryId }
          : {}),
      nodeDigests,
    };
    return this.snapshot();
  }
}
