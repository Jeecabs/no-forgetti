# Contributing

## Development

Requirements: Node.js 22.19+, pnpm 10, and Pi.

```bash
git clone https://github.com/Jeecabs/no-forgetti.git
cd no-forgetti
pnpm install --frozen-lockfile
pnpm check
pnpm test
pi -e .
```

Keep generated project memory and skills outside the repository. Add regression tests for behavior changes. Before opening a pull request, run:

```bash
pnpm check
pnpm test
git diff --check
```

## Pull requests

- Explain the user-visible behavior and why the change is needed.
- Keep persistent-state migrations backward compatible and fail closed on corrupt data.
- Preserve explicit approval for generated skill patches and archives; validated creates auto-apply.
- Never commit secrets, session transcripts, or No Forgetti's external state.
