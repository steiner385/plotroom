# CLAUDE.md — pr-dashboard

pr-dashboard is a CI/CD pipeline dashboard (React 19 + Vite frontend, Express/tsx + better-sqlite3 backend, GitHub App auth). It runs **two ways** and both must keep working:
- **Standalone** — the existing local/systemd daemon (`pnpm start`), unchanged.
- **Embeddable** — consumed as **source** by a host application that hosts BOTH tiers.

## Architecture intent (source-only, host-hosted) — IMPORTANT

pr-dashboard is a **source-only repository**: a consuming app (e.g. `admin.kindash.com`) clones/mirrors it and **hosts both its front-end and back-end itself**. When embedded, pr-dashboard **must NOT require its own server or deployment** — the host runs it in-process.
- Front-end: shipped via the `./embed` export → `<PrDashboard apiBase basename routerMode/>` (content-only; CSS scoped to `.prdash-root`).
- Back-end: should be exposed as a **mountable factory** (an Express router/app with **no `app.listen()`**, plus a poller the host starts in-process and a store the host gives a `dataDir`). `server/api.ts` already has `createApp()`; `server/index.ts` is the thin standalone wrapper.
- Never reintroduce a separate-service / cross-service-proxy design for the embedded case.

## Cross-session coordination

Multiple Claude Code sessions may work on pr-dashboard and its host integration concurrently. **If your task touches the embed, the `./server` backend export, or the admin.kindash.com integration**, coordinate via the shared channel (same machine):

  `/home/tony/.config/kindash/coordination/pr-dashboard-integration.md`

Read its **DECISIONS** + **OPEN REQUESTS** at task start; append status/replies to the append-only **LOG** (`### <ISO-time> · from:pr-dashboard · <topic>`); curate DECISIONS/OPEN REQUESTS. The host session watches this file and reacts automatically.
