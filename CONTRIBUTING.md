# Contributing to pr-dashboard

Thanks for your interest! Contributions are welcome — bug reports, fixes, and
focused features alike.

> **Maintainer bandwidth is best-effort.** This is a personal side project;
> reviews and releases happen as time allows. Small, well-tested PRs get
> looked at fastest.

## Dev setup

Requirements: Node 20+, [pnpm](https://pnpm.io) (this repo is pnpm-only — do
not use npm or yarn; only `pnpm-lock.yaml` is maintained).

```bash
git clone https://github.com/steiner385/plotroom.git
cd pr-dashboard
pnpm install

pnpm test          # full unit/integration suite (vitest)
pnpm dev           # Vite on :5173 with HMR, proxying /api to :4400
pnpm build         # compile frontend → dist/public
pnpm start         # production mode on http://127.0.0.1:4400
```

You'll need a GitHub token for live data: `gh auth login` (default token
source) or `tokenSource: "env"` + `GITHUB_TOKEN`. See the README for the full
config reference. To hack against public data without touching your own
config, point the env overrides at a scratch directory:

```bash
PRDASH_CONFIG=/tmp/demo/config.json PRDASH_DATA_DIR=/tmp/demo/data pnpm start
```

## Workflow and quality gates

We practice TDD: write or extend a failing test first, then make it pass.
Every change is expected to come with tests for the new behavior.

Before pushing, all three gates must pass locally (CI runs the same set):

```bash
pnpm test                # 100% pass, no skipped tests left behind
pnpm exec tsc --noEmit   # zero type errors
pnpm build               # frontend must compile
```

## Pull requests

- Keep PRs small and single-purpose; split unrelated changes.
- Describe **what** changed and **why** — link the issue if one exists.
- Include tests demonstrating the fix/feature (a regression test for bug
  fixes).
- Don't commit generated artifacts (`dist/`, `data/`), credentials, or
  screenshots of private repositories.
- New config fields need: validation, a `config.example.json` entry, and a row
  in the README config reference table.

## Reporting bugs / requesting features

Use the issue templates. For bugs, include your Node/pnpm versions, relevant
log output (`/tmp` or journalctl), and a redacted config if config-related.
Never paste tokens or private repo data into issues.
