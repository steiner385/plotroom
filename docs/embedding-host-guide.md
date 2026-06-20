# Embedding Plotroom in a host app

This is the integration guide for a host application (e.g. `admin.kindash.com`)
that embeds **Plotroom** (npm: [`plotroom`](https://www.npmjs.com/package/plotroom)).

**Architecture (source-only, host-hosted).** Plotroom is consumed as a dependency
and the host hosts **both tiers in-process** — there is **no separate Plotroom
service and no cross-service proxy**. Two mountable surfaces:

- **`plotroom/embed`** — the React UI (`<PrDashboard/>`), content-only.
- **`plotroom/server`** — a mountable Express backend (`createPrDashboardBackend()`),
  no `app.listen()`; the host owns the HTTP server, auth, and the SQLite volume.

Because the host serves both tiers under its own origin, the frontend calls the
backend **same-origin** — no proxy, no shared secret, no CORS.

---

## 1. Install

```bash
npm i plotroom
```

The published package ships **prebuilt** `dist/embed` (frontend) and `dist/server`
(backend) — no build step at install time.

- **React 19 is a peer dependency.** The host provides the single React instance;
  ensure your bundler **dedupes React** — a second copy makes the embed's contexts
  resolve to the wrong instance (symptoms: a blank panel, or
  `useSectionRoute must be used within a RouterProvider` thrown at runtime).
- The `plotroom/server` ESM uses explicit `.js` import specifiers and is importable
  under plain `node`, `tsx`, or any bundler.

---

## 2. Backend — mount the API + poller in your Express server

```ts
import { createPrDashboardBackend } from 'plotroom/server';

const prdash = await createPrDashboardBackend({
  config,                              // a resolved AppConfig object, OR { path: '/etc/plotroom/config.json' }
  dataDir: '/data/prdash',             // YOUR persistent volume: history.db / workspace.db / clones
  githubApp: { appId, privateKey },    // PEM *string* from YOUR env (not a file path); App-mode only
  // serveStatic defaults false (you serve the frontend via ./embed)
  // trustHostAuth defaults true  (your middleware is the gate — see §4)
});

app.use('/bff/ops/prdash', requireAdminSession, prdash.router); // YOUR auth gates it
const stopPoller = prdash.startPoller();   // run the poller in-process; call stopPoller() on shutdown
```

**Returns** `{ router, startPoller, store }`:
- `router` — the Express app, mountable under any sub-path, **no `.listen()`**.
- `startPoller()` — starts the in-process poller (+ first-run backfill + daily
  digest); returns a `stop()` you call on host shutdown.
- `store` — `{ history, workspace }` if you need direct read access.

### Operational requirements

- **Single instance + a persistent volume** at `dataDir`. better-sqlite3 is a
  single-writer embedded DB — **do not horizontally scale** the backend/poller
  (two writers corrupt the DB). One instance, one volume.
- **`trustHostAuth` (default `true`)** skips Plotroom's built-in same-origin guard
  on mutations, because **your** middleware (`requireAdminSession`) is the gate.
  There is no shared secret. Leave it true when your auth wraps the mount.
- **`/api/admin/restart` is a no-op** when mounted — it never `process.exit`es your
  host (the standalone uses it for a systemd restart; the mount injects a no-op).
- **Inline App credentials:** when you pass `githubApp.privateKey` inline, pass
  `config` as an **object** (not `{ path }`) — or, with `{ path }`, the loader
  accepts a missing `app.privateKeyPath` because the inline key supplies it.
- **GitHub App vs token:** `config.tokenSource: 'app'` watches every installation
  of your App. Provide `appId` + the PEM via `githubApp`. (`gh`/`env` token modes
  also work for single-account setups.)

### SSE under a sub-path

`GET <mount>/api/events` is a long-lived `text/event-stream`. It honors the mount
base (relative paths), so it works under any sub-path. The backend sends
`X-Accel-Buffering: no`; if you front the host with a proxy, ensure it **does not
buffer** that route and its read timeout exceeds the 25 s keep-alive ping.

---

## 3. Frontend — mount the component

```tsx
import { PrDashboard } from 'plotroom/embed';
import 'plotroom/embed/style.css';

// The API lives under `${mount}/api`, so apiBase = your mount path + /api.
<PrDashboard apiBase="/bff/ops/prdash/api" basename="/ops/prdash" routerMode="path" />
```

### Props

```ts
interface PrDashboardProps {
  apiBase?: string;        // default '/api' — root for ALL data + SSE; point at your backend mount
  basename?: string;       // default ''    — URL prefix the embed lives under
  routerMode?: 'path' | 'hash';  // default 'path'
  focusedRepo?: string;    // optional controlled repo; omit for the in-content switcher
  onFocusChange?: (repo: string) => void;
  className?: string;      // appended to the .prdash-root wrapper (layout/sizing)
  withCredentials?: boolean; // default false — SSE cookie mode (same-origin; see §4)
}
```

The five sections (URL segment after `basename`): `health` (default), `pipeline`,
`diagnose`, `model-edit`, `insights`. Retired aliases still resolve:
`metrics`/`tune` → `insights`; `model`/`optimize`/`build` → `model-edit`.

### What the embed renders vs. what the host owns

The embed is **content-only**. It renders a compact in-content **StatusStrip**
(pipeline switcher, live/stale indicator, ingestion-health dot, a `?` Legend) and
the active **section view**. It deliberately does **not** render — **the host owns
these**:

- **Page chrome:** the outer header, the page `h1`, and the **`<main>` landmark**.
  The embed emits no `banner`/`navigation`/`main` landmark and its section
  headings start at `<h2>` — provide the `h1` and `<main>` for a correct a11y tree.
- **Section navigation** (see §4) — there is no nav rail.
- **Auth** (see §4).
- **Settings** and the **⌘K command palette** are intentionally absent when
  embedded (no global keybinding to collide with your command bar).

---

## 4. Routing — READ THIS (nested-router gotcha)

In `routerMode="path"` (the default), the embed derives the active section from
`location.pathname` (the first segment after `basename`) and:
- updates on the browser **`popstate`** event (back/forward), and
- on **in-content navigation** (e.g. a Health-lane chip) it calls
  `history.pushState` to `${basename}/${section}` and updates itself.

**The catch:** `history.pushState` does **not** fire `popstate`. So if your host
router navigates with `pushState` (every SPA router does), the embed won't observe
it, and vice-versa — two History routers on the same path space don't see each
other's pushes. This is the classic nested-router problem, not an embed bug.

**Pick one integration pattern:**

1. **Host drives sections, with a popstate bridge (recommended).** Let your nav
   update the URL, then tell the embed to re-read it:
   ```ts
   function goToCiSection(section: string) {
     history.pushState({}, '', `/ops/prdash/${section}`);   // or your router's navigate()
     window.dispatchEvent(new PopStateEvent('popstate'));    // <-- wakes the embed
   }
   ```
2. **Give Plotroom a dedicated subtree** and don't mirror its section in host
   state. Mount at `basename="/ops/prdash"`, route your shell to that page, and let
   the user switch sections via your nav using pattern (1). Read the current
   section from the URL when you need it; don't keep a separate host copy.
3. **`routerMode="hash"`** reads/writes `location.hash` and **won't collide** with a
   host *path* router (it will collide with a host *hash* router). Path mode is the
   default for exactly this reason.

(A controlled `section` prop + `onSectionChange` is a deliberate non-goal today;
ask if your UX needs tight bidirectional router integration.)

---

## 5. Auth

**Auth is the host's job.** The embed never shows a login UI; it just calls
`apiBase`. Because the backend is mounted in your own server behind your
middleware (`app.use(mount, requireAdminSession, prdash.router)`), every request —
data, mutations, and SSE — is already gated by your session. With `trustHostAuth`
left at its default `true`, Plotroom's built-in same-origin guard steps aside and
your middleware is the sole gate (no shared secret, no CORS — it's same-origin).

Native `EventSource` can't set headers, but since the mount is **same-origin**,
the SSE carries your session cookie automatically; set `withCredentials` only if
your setup needs explicit credentialed mode.

---

## 6. Styling & theming

- Import `plotroom/embed/style.css` once. Every rule is scoped under
  **`.prdash-root`** (the embed's wrapper), so nothing leaks into your page and the
  embed sets no `body`/`html` styles.
- Design tokens are CSS custom properties on `.prdash-root` (remapped from `:root`
  at build time, including the dark-mode block). To theme, override those variables
  on `.prdash-root` (or a wrapping selector). This includes the **`--z-*` layer
  tokens** (`--z-popover`, `--z-overlay`, `--z-drawer`, `--z-command-palette`, …) —
  override them if Plotroom's stacking needs to sit relative to your own chrome.
- The embed inherits your page **font** by default (sets no `font-family` on body).
- Pass `className` to add a wrapper class for layout (sizing/positioning the embed).

---

## 7. React / SSR / multi-instance constraints

- **Client-only.** The providers read `window`/`location` at init. If your shell
  SSRs, render `<PrDashboard>` **client-side only** (e.g. a dynamic import with SSR
  disabled).
- **Single React 19 instance**, deduped (see §1).
- **One embed ↔ one backend.** The backend is single-tenant (one owners list, one
  SQLite). For multiple tenants, run one backend per tenant (each with its own
  `dataDir`) and mount one embed each with its own `apiBase`.

---

## 8. Host checklist

- [ ] `npm i plotroom`; confirm React is deduped to a single v19.
- [ ] Mount the backend: `app.use('<mount>', requireAdminSession, prdash.router)`;
      run `prdash.startPoller()`; stop it on shutdown.
- [ ] Provision a **single instance** + a **persistent volume** at `dataDir`.
- [ ] Provide GitHub App creds (`appId` + PEM) from env via `githubApp`.
- [ ] Mount `<PrDashboard apiBase="<mount>/api" basename="<mount>" />`, client-side
      only, inside your `<main>` with your own `h1`.
- [ ] Provide section nav via the **popstate bridge** (§4 pattern 1).
- [ ] If a proxy fronts the host, don't buffer the SSE route; long read timeout.
