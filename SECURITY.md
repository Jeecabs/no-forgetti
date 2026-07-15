# Security policy

## Reporting

Please report vulnerabilities through GitHub's **Security → Report a vulnerability** flow. Do not open a public issue for undisclosed vulnerabilities.

Include the affected version, impact, reproduction steps, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Security model

No Forgetti is a Pi extension and therefore runs with the same filesystem, process, and network permissions as Pi. Review the source before installation.

Project memory and generated skill proposals stay under `$PI_CODING_AGENT_DIR/no-forgetti/` by default. Background reviews call the currently configured model provider. Generated skills do not become active until explicitly approved.

Only the latest release and current `main` branch receive security fixes.
