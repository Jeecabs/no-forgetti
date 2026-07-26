# ADR 0001: Durable explicit review spool

- Status: accepted
- Date: 2026-07-26

## Context

In-process reviews start after `agent_settled` but are aborted during `session_shutdown`. Project review cadence is shared while evidence cursors are session-local. A global Pi-session watcher cannot reliably determine settlement, active leaf, memory branch, child-agent isolation, or ephemeral history.

## Decision

The extension writes a deterministic, versioned, bounded, sanitized review job to a local atomic spool before returning from successful settlement. A shared `review --once` engine processes the same job format manually or from a separately managed user daemon.

The spool is the durability seam. A socket may wake the daemon but is never the sole source of durability. The daemon never edits Pi session files.

Once an enqueue is durably accepted in external authority mode, only the service may review that event. Foreground memory commands remain immediate through the existing canonical JSON store.

## Consequences

- Accepted review work survives Pi shutdown.
- Duplicate delivery is expected and idempotent.
- Evidence becomes briefly persistent and therefore needs restrictive permissions, TTL, deletion, and explicit privacy documentation.
- Provider credentials must come from a dedicated persistent reviewer profile, never from job payloads.
- Service management, protocol compatibility, budgets, and crash recovery become product responsibilities.
- Kill before `agent_settled` and killed ephemeral sessions remain outside the guarantee.

## Rejected alternatives

- Extension child process: either dies with Pi or becomes an unmanaged daemon.
- Global session watcher: cannot establish authoritative settlement or branch binding.
- Socket-only delivery: connection failure loses accepted work.
- Default historical scan: unexpected privacy, cost, and resource expansion.
