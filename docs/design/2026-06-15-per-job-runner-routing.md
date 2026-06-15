# Per-job spot/on-demand runner routing — design

**Date:** 2026-06-15
**Status:** approved design, pre-implementation
**Repos touched:** `pr-dashboard` (optimizer, API, UI, writer) + `cairnea/KinDash` (ci.yml consumes a variable)

## Goal

Route each PR-tier CI job to **spot** (`kindash-arc-spot`, cheap, reclaimable) or
**on-demand** (`kindash-arc`, reliable, pricier) automatically, optimized per job
from the live spot-reclaim rate, with **manual per-job overrides** and a single
**configurable aggressiveness knob**. Builds on the spot-reclaim-rate metric
already shipped (PR #122).

### What "real-time per job" means (and its hard constraint)

GitHub evaluates `runs-on` **when a workflow run starts** — a running job cannot
be migrated between pools. So "real-time" = **per-run routing from a decision map
that a controller keeps current**: the next CI run reflects conditions as of
seconds ago, but in-flight jobs are not moved. This is the closest GitHub allows
and is sufficient: the routing adapts run-to-run as spot health changes.

## Architecture & data flow

```
dashboard (dobby, localhost / tailnet)                cairnea/KinDash
┌───────────────────────────────────┐                ┌─────────────────────────┐
│ optimizer (cost model)             │   gh variable  │ vars.RUNNER_MAP (JSON)   │
│  • per-job p90 duration (history)  │   set, on      │                          │
│  • live spot-reclaim rate          │   change only  │ ci.yml runs-on reads:    │
│  • config: knob + overrides        │ ─────────────▶ │  merge_group → on-demand │
│ serves GET /api/runner-plan + UI   │   (gh keyring  │  PR → map[key] || spot   │
└───────────────────────────────────┘   token)       └─────────────────────────┘
```

**Why a push (dashboard → KinDash), not a pull:** the dashboard runs on the dev
host (localhost / tailnet); the CI runners are in EKS and cannot reach it. And
`runs-on` can only read a **repo variable** (set at trigger time). Writing an
Actions variable needs an elevated token — the dashboard's **gh keyring token
already has `repo` scope, which covers Actions variables**, so the dashboard
writes `RUNNER_MAP` directly. **No new permissions** (no GitHub App bump).

**Hybrid essence preserved:** dashboard = brains (it owns the data + the model);
KinDash only *consumes* the variable in its own ci.yml.

**merge_group invariant preserved:** merge_group / push:main jobs stay hard-pinned
to `kindash-arc` (on-demand) so the queue can never be spot-ejected. The map
governs **PR-event jobs only** (today's `kindash-arc-spot` tier).

## The cost model + the one knob

For each PR-tier job `j`:

- `expectedReworkMinutes(j) = reclaimRate × p90duration(j)` — expected minutes
  wasted if `j` is reclaimed. Longer jobs lose more; scales with the live rate.
- Decision: **on-demand when `expectedReworkMinutes(j) ≥ shedThreshold`**, else spot.
- **The one knob = `shedThreshold` (minutes).** Lower → sheds to on-demand sooner
  (reliability-leaning); higher → keeps more on spot (cost-leaning). It encodes
  the cost trade-off: *"pay the on-demand premium once a reclaim would be expected
  to waste more than N minutes of this job."*
- Equivalent intuition — at reclaim rate `p` the duration cutoff is
  `shedThreshold / p`: 1% → ~100 min (nothing flips, spot healthy); 9% → ~11 min
  (heavy shards flip); 30% → ~3 min (most flip). "Shed the longest jobs first as
  spot degrades."
- **Time-based on purpose:** durations are always tracked; $ rates are optional
  config. If `poolMeta` $ rates exist, the UI may *also* show dollars, but the
  decision uses the always-available time proxy.
- **Manual `overrides[j] ∈ {spot, ondemand}` win unconditionally.**

`reclaimRate` is the spot-reclaim rate (PR #122) over a configurable trailing
window (`reclaimWindow`, default e.g. 2h). `p90duration(j)` is the job's p90 over
the same history the cost/concurrency panels already use.

## Map schema + the ci.yml change

`RUNNER_MAP` repo variable = JSON object keyed by a **stable per-job key**:

```json
{ "unit": "kindash-arc", "integration": "kindash-arc-spot", "server": "kindash-arc-spot" }
```

Each PR-tier `runs-on` (ci.yml + reusable `_*.yml`) becomes:

```yaml
runs-on: ${{ github.event_name == 'merge_group' && 'kindash-arc'
             || fromJSON(vars.RUNNER_MAP || '{}')['unit']
             || 'kindash-arc-spot' }}
```

**Triple fail-safe:** missing var → `'{}'`; key absent → `|| 'kindash-arc-spot'`;
merge_group → hard-pinned on-demand. With no/empty map, CI behaves exactly as
today. Job keys are a fixed vocabulary agreed between the optimizer and ci.yml
(e.g. `unit`, `integration`, `server`, `build`, `build-test`, `tsc`, `db`,
`eslint`, `security`). The optimizer only emits keys it knows; unknown jobs fall
through to spot.

## Dashboard components

- **`server/estimator/runner-plan.ts`** — pure function:
  `(jobs: {key, p90Secs}[], reclaimRate, config) → { map: Record<key,label>, plan: PlanRow[] }`
  where `PlanRow = { key, p90Secs, score, decision, reason, source: 'auto'|'override' }`.
  Unit-tested in isolation (no I/O).
- **`GET /api/runner-plan`** — returns `{ plan, map, enabled, lastPushedAt, lastPushedHash }`
  for the UI and for debugging.
- **Writer** — in the poller cycle, recompute the map; **on change only** (hash
  compare) and only when `enabled`, push via
  `gh variable set RUNNER_MAP --repo <targetRepo> --body <json>` with the same
  `env -u GITHUB_TOKEN -u GH_TOKEN` hygiene the existing gh calls use. When
  `enabled` flips false, **delete** the variable (revert to all-spot).
- **Config** (`config.json`, editable via the Settings drawer + `PUT /api/config`):
  ```
  runnerRouting: {
    enabled: boolean,            // default false
    shedThresholdMinutes: number,// the knob, default e.g. 1.0
    reclaimWindow: string,       // e.g. '2h'
    overrides: Record<jobKey, 'spot'|'ondemand'>,
    targetRepo: string           // 'cairnea/KinDash'
  }
  ```
- **UI** — a "Runner routing" panel (Reliability section): per-job assignment,
  each job's score vs threshold + reason, the `shedThreshold` knob, override
  toggles, an enable/kill switch, and a "last pushed" status line.

## Safety / rollout (production CI)

Phased and **inert by default**:

1. **Merge the ci.yml read** (with the triple fallback) — a **no-op**; with no
   `RUNNER_MAP` nothing changes. Safe to land independently.
2. **Ship the dashboard optimizer + API + UI in read-only mode** (`enabled=false`)
   — observe the plan it *would* push, tune the knob, with zero CI effect.
3. **Flip `enabled=true`** once the plan looks right; the writer starts pushing.

Guards:

- **Kill switch:** `enabled=false` → dashboard deletes `RUNNER_MAP` → instant
  revert to all-spot.
- **Validation:** the writer only emits values ∈ {`kindash-arc`,`kindash-arc-spot`}
  and valid JSON; it never writes anything that could break `fromJSON`. The
  ci.yml `|| '{}'` / `|| 'kindash-arc-spot'` guards are belt-and-suspenders.
- **On-demand capacity:** shedding PR jobs to on-demand adds load to `kindash-arc`
  (shared with merge_group; ARC cap 100, AWS on-demand quota 534 vCPU). v1 only
  *notes* this; a shed-count cap is a later refinement.

## YAGNI / scope cuts

- No mid-run migration (impossible on GitHub Actions).
- Single `targetRepo` (no org-level / multi-repo).
- No auto-tuning of the knob — one manual knob + per-job overrides.
- No on-demand-capacity throttle in v1 (note it; add only if shedding overloads).

## Out-of-band step for go-live

The ci.yml change spans many jobs across `ci.yml` and the reusable `_*.yml`
workflows; it lands in `cairnea/KinDash` via its normal PR/merge-queue path,
independent of the dashboard work. The dashboard work (phases 2–3) lands in
`pr-dashboard`. Enabling the writer (`enabled=true`) is the final, reversible flip.
