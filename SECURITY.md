# Security policy

## Reporting

Please report vulnerabilities through GitHub's **Security → Report a vulnerability** flow. Do not open a public issue for undisclosed vulnerabilities.

Include the affected version, impact, reproduction steps, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Security model

No Forgetti is a Pi extension and therefore runs with the same filesystem, process, and network permissions as Pi. Review the source before installation.

Project memory and generated skill state stay under `$PI_CODING_AGENT_DIR/no-forgetti/` by default. Embedded background reviews call the active model provider. Opt-in external review uses a dedicated persistent reviewer profile and a local durable spool; jobs never contain resolved credentials, thinking, images, raw tool arguments/results, user bash, provider headers, or diagnostics. Evidence is bounded to 32,000 sanitized characters and stored with restrictive permissions. Terminal retention is enforced periodically while the worker runs. To forget all queued/outcome evidence, stop the worker and delete `$PI_CODING_AGENT_DIR/no-forgetti/review-spool/` plus `$PI_CODING_AGENT_DIR/no-forgetti/review-ledger.sqlite*`; the ledger uses SQLite secure deletion and WAL truncation during normal retention.

The external worker is separately managed and does not start during installation. Its first release is tool-less: no shell, project filesystem, generic read/write, or network tools are exposed to conversation evidence. Existing project JSON remains canonical; proposals pass the same validators and compare-and-swap checks before mutation. Validated live memory refinements may apply automatically; skill review remains in Pi, with patches and archives requiring explicit approval. Memory keeps an append-only review/undo journal, and undo refuses to overwrite conflicting later writes.

Only the latest release and current `main` branch receive security fixes.
