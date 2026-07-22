# Security policy

## Reporting

Please report vulnerabilities through GitHub's **Security → Report a vulnerability** flow. Do not open a public issue for undisclosed vulnerabilities.

Include the affected version, impact, reproduction steps, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Security model

No Forgetti is a Pi extension and therefore runs with the same filesystem, process, and network permissions as Pi. Review the source before installation.

Project memory and generated skill state stay under `$PI_CODING_AGENT_DIR/no-forgetti/` by default. Background reviews call the currently configured model provider. Validated memory refinements and new skills apply automatically; skill patches and archives still require explicit approval. Memory keeps one bounded pre-review snapshot for `/memory undo`.

Only the latest release and current `main` branch receive security fixes.
