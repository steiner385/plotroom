import Database from 'better-sqlite3';
import { median, percentile } from './math';

export interface Expected { p50: number; p90: number; n: number; }
export interface MergedPrInput {
  repo: string; number: number; title: string; url: string;
  mergedAt: string; mergeCommitSha: string | null;
}
export interface MergedPrRecord extends MergedPrInput {
  qaLiveAt: string | null; prodLiveAt: string | null;
}

export class HistoryStore {
  private db: Database.Database;

  // ── Prepared statements (cached for performance) ──────────────────────────
  private readonly stmtInsertDuration: Database.Statement;
  private readonly stmtSelectDurations: Database.Statement;
  private readonly stmtSelectExpectedSet: Database.Statement;
  private readonly stmtUpsertPr: Database.Statement;
  private readonly stmtMarkQaLive: Database.Statement;
  private readonly stmtMarkProdLive: Database.Statement;
  private readonly stmtListTracked: Database.Statement;
  private readonly stmtInsertGap: Database.Statement;
  private readonly stmtSelectGaps: Database.Statement;
  private readonly stmtInsertGroupRun: Database.Statement;
  private readonly stmtSelectGroupRuns: Database.Statement;
  private readonly stmtInsertQueueWait: Database.Statement;
  private readonly stmtSelectQueueWaits: Database.Statement;
  private readonly stmtInsertRunnerWait: Database.Statement;
  private readonly stmtSelectRunnerWaits: Database.Statement;
  private readonly stmtSelectRunnerWaitsByEvent: Database.Statement;
  private readonly stmtInsertEtaAccuracy: Database.Statement;
  private readonly stmtSelectEtaAccuracy: Database.Statement;
  private readonly stmtGetMeta: Database.Statement;
  private readonly stmtSetMeta: Database.Statement;
  private readonly stmtDeleteMeta: Database.Statement;
  private readonly stmtListMeta: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS check_durations (
        repo TEXT NOT NULL, check_name TEXT NOT NULL, event TEXT NOT NULL,
        duration_secs REAL NOT NULL, completed_at TEXT NOT NULL, conclusion TEXT NOT NULL,
        UNIQUE(repo, check_name, event, completed_at)
      );
      CREATE INDEX IF NOT EXISTS idx_durations ON check_durations(repo, check_name, event, completed_at);
      CREATE TABLE IF NOT EXISTS merged_prs (
        repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
        merged_at TEXT NOT NULL, merge_commit_sha TEXT,
        qa_live_at TEXT, prod_live_at TEXT,
        PRIMARY KEY (repo, number)
      );
      CREATE TABLE IF NOT EXISTS deploy_gaps (
        repo TEXT NOT NULL, environment TEXT NOT NULL, gap_secs REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_runs (
        repo TEXT NOT NULL, duration_secs REAL NOT NULL, completed_at TEXT NOT NULL,
        UNIQUE(repo, completed_at)
      );
      CREATE TABLE IF NOT EXISTS queue_waits (
        repo TEXT NOT NULL, wait_secs REAL NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_waits (
        repo TEXT NOT NULL, check_name TEXT NOT NULL, event TEXT NOT NULL,
        wait_secs REAL NOT NULL, started_at TEXT NOT NULL,
        UNIQUE(repo, check_name, event, started_at)
      );
      CREATE INDEX IF NOT EXISTS idx_runner_waits ON runner_waits(repo, check_name, event, started_at);
      CREATE TABLE IF NOT EXISTS eta_accuracy (
        repo TEXT NOT NULL, stage TEXT NOT NULL,
        predicted_secs REAL NOT NULL, actual_secs REAL NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);

    // Prepare all statements after schema is guaranteed to exist.
    this.stmtInsertDuration = this.db.prepare(
      'INSERT OR IGNORE INTO check_durations (repo, check_name, event, duration_secs, completed_at, conclusion) VALUES (?,?,?,?,?,?)'
    );
    this.stmtSelectDurations = this.db.prepare(
      `SELECT duration_secs FROM check_durations
       WHERE repo=? AND check_name=? AND event=? AND conclusion='SUCCESS'
       ORDER BY completed_at DESC LIMIT 20`
    );
    this.stmtSelectExpectedSet = this.db.prepare(
      `SELECT DISTINCT check_name FROM check_durations
       WHERE repo=? AND event=? AND conclusion='SUCCESS' AND completed_at >= ?`
    );
    this.stmtUpsertPr = this.db.prepare(
      `INSERT INTO merged_prs (repo, number, title, url, merged_at, merge_commit_sha)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(repo, number) DO UPDATE SET title=excluded.title,
         merge_commit_sha=COALESCE(excluded.merge_commit_sha, merge_commit_sha)`
    );
    // Two separate statements — SQLite prepared statements cannot switch column names dynamically.
    this.stmtMarkQaLive = this.db.prepare(
      'UPDATE merged_prs SET qa_live_at=? WHERE repo=? AND number=? AND qa_live_at IS NULL'
    );
    this.stmtMarkProdLive = this.db.prepare(
      'UPDATE merged_prs SET prod_live_at=? WHERE repo=? AND number=? AND prod_live_at IS NULL'
    );
    this.stmtListTracked = this.db.prepare(
      'SELECT * FROM merged_prs WHERE merged_at >= ? ORDER BY merged_at DESC'
    );
    this.stmtInsertGap = this.db.prepare(
      'INSERT INTO deploy_gaps (repo, environment, gap_secs) VALUES (?,?,?)'
    );
    this.stmtSelectGaps = this.db.prepare(
      'SELECT gap_secs FROM deploy_gaps WHERE repo=? AND environment=? ORDER BY rowid DESC LIMIT 20'
    );
    this.stmtInsertGroupRun = this.db.prepare(
      'INSERT OR IGNORE INTO group_runs (repo, duration_secs, completed_at) VALUES (?,?,?)'
    );
    this.stmtSelectGroupRuns = this.db.prepare(
      'SELECT duration_secs FROM group_runs WHERE repo=? ORDER BY completed_at DESC LIMIT 20'
    );
    this.stmtInsertQueueWait = this.db.prepare(
      'INSERT INTO queue_waits (repo, wait_secs, observed_at) VALUES (?,?,?)'
    );
    this.stmtSelectQueueWaits = this.db.prepare(
      'SELECT wait_secs FROM queue_waits WHERE repo=? ORDER BY rowid DESC LIMIT 20'
    );
    this.stmtInsertRunnerWait = this.db.prepare(
      'INSERT OR IGNORE INTO runner_waits (repo, check_name, event, wait_secs, started_at) VALUES (?,?,?,?,?)'
    );
    this.stmtSelectRunnerWaits = this.db.prepare(
      `SELECT wait_secs FROM runner_waits
       WHERE repo=? AND check_name=? AND event=?
       ORDER BY started_at DESC LIMIT 20`
    );
    this.stmtSelectRunnerWaitsByEvent = this.db.prepare(
      'SELECT wait_secs FROM runner_waits WHERE repo=? AND event=? ORDER BY started_at DESC LIMIT 50'
    );
    this.stmtInsertEtaAccuracy = this.db.prepare(
      'INSERT INTO eta_accuracy (repo, stage, predicted_secs, actual_secs, observed_at) VALUES (?,?,?,?,?)'
    );
    this.stmtSelectEtaAccuracy = this.db.prepare(
      'SELECT predicted_secs, actual_secs FROM eta_accuracy WHERE repo=? AND stage=? ORDER BY rowid DESC LIMIT 20'
    );
    this.stmtGetMeta = this.db.prepare('SELECT value FROM meta WHERE key=?');
    this.stmtSetMeta = this.db.prepare(
      'INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    );
    this.stmtDeleteMeta = this.db.prepare('DELETE FROM meta WHERE key=?');
    this.stmtListMeta = this.db.prepare(
      "SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\' ORDER BY key"
    );
  }

  recordCheckDuration(repo: string, name: string, event: string,
    startedAt: string | null, completedAt: string | null, conclusion: string): boolean {
    if (!startedAt || !completedAt) return false;
    const secs = (Date.parse(completedAt) - Date.parse(startedAt)) / 1000;
    if (!(secs > 0)) return false; // rejects negative durations (SKIPPED placeholders) and NaN
    this.stmtInsertDuration.run(repo, name, event, secs, completedAt, conclusion);
    return true;
  }

  expected(repo: string, name: string, event: string): Expected | null {
    const rows = this.stmtSelectDurations.all(repo, name, event) as { duration_secs: number }[];
    if (rows.length === 0) return null;
    const sorted = rows.map((r) => r.duration_secs).sort((a, b) => a - b);
    return { p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), n: sorted.length };
  }

  /** Raw last-20 SUCCESS duration samples for (repo, check, event), newest first. */
  samples(repo: string, name: string, event: string): number[] {
    const rows = this.stmtSelectDurations.all(repo, name, event) as { duration_secs: number }[];
    return rows.map((r) => r.duration_secs);
  }

  expectedSet(repo: string, event: string, now: Date, windowDays = 14): string[] {
    const cutoff = new Date(now.getTime() - windowDays * 86400_000).toISOString();
    const rows = this.stmtSelectExpectedSet.all(repo, event, cutoff) as { check_name: string }[];
    return rows.map((r) => r.check_name);
  }

  upsertMergedPr(pr: MergedPrInput): void {
    this.stmtUpsertPr.run(pr.repo, pr.number, pr.title, pr.url, pr.mergedAt, pr.mergeCommitSha);
  }

  markEnvLive(repo: string, number: number, env: 'qa' | 'prod', at: string): void {
    // Defense in depth: untyped callers must never write an unknown env column.
    if (env !== 'qa' && env !== 'prod') {
      throw new Error(`markEnvLive: env must be 'qa' or 'prod', got '${String(env)}'`);
    }
    const stmt = env === 'qa' ? this.stmtMarkQaLive : this.stmtMarkProdLive;
    stmt.run(at, repo, number);
  }

  /**
   * Returns merged PRs within the retention window, ordered newest-first.
   *
   * NOTE: rows that already have `prodLiveAt` set are included — the caller
   * (classify layer) is responsible for dropping fully-deployed entries when
   * building the dashboard view.
   */
  listTrackedMerged(retentionDays: number, now: Date): MergedPrRecord[] {
    const cutoff = new Date(now.getTime() - retentionDays * 86400_000).toISOString();
    const rows = this.stmtListTracked.all(cutoff) as Record<string, unknown>[];
    return rows.map((r) => ({
      repo: r.repo as string, number: r.number as number, title: r.title as string,
      url: r.url as string, mergedAt: r.merged_at as string,
      mergeCommitSha: (r.merge_commit_sha as string) ?? null,
      qaLiveAt: (r.qa_live_at as string) ?? null, prodLiveAt: (r.prod_live_at as string) ?? null,
    }));
  }

  recordDeployGap(repo: string, env: string, gapSecs: number): void {
    this.stmtInsertGap.run(repo, env, gapSecs);
  }

  medianDeployGap(repo: string, env: string): number | null {
    const rows = this.stmtSelectGaps.all(repo, env) as { gap_secs: number }[];
    return rows.length ? median(rows.map((r) => r.gap_secs)) : null;
  }

  /** Observed wall-clock duration of a whole merge-group CI run. Rejects ≤0/NaN. */
  recordGroupRun(repo: string, durationSecs: number, completedAt: string): boolean {
    if (!(durationSecs > 0)) return false; // rejects ≤0 and NaN
    this.stmtInsertGroupRun.run(repo, durationSecs, completedAt);
    return true;
  }

  medianGroupRun(repo: string): number | null {
    const rows = this.stmtSelectGroupRuns.all(repo) as { duration_secs: number }[];
    return rows.length ? median(rows.map((r) => r.duration_secs)) : null;
  }

  /** Observed enqueue→merge wall-clock wait for a merge-queue PR. Rejects ≤0/NaN. */
  recordQueueWait(repo: string, waitSecs: number, observedAt: string): boolean {
    if (!(waitSecs > 0)) return false; // rejects ≤0 and NaN
    this.stmtInsertQueueWait.run(repo, waitSecs, observedAt);
    return true;
  }

  medianQueueWait(repo: string): number | null {
    const rows = this.stmtSelectQueueWaits.all(repo) as { wait_secs: number }[];
    return rows.length ? median(rows.map((r) => r.wait_secs)) : null;
  }

  /** Observed runner-pickup wait for a check (needs-complete → startedAt).
   *  Accepts 0 (same-second warm pickups are real samples; UNIQUE dedupes);
   *  rejects negative/NaN. */
  recordRunnerWait(repo: string, name: string, event: string,
    waitSecs: number, startedAt: string): boolean {
    if (!(waitSecs >= 0)) return false; // rejects <0 and NaN
    this.stmtInsertRunnerWait.run(repo, name, event, waitSecs, startedAt);
    return true;
  }

  /** Median runner-pickup wait over the last 20 samples for (repo, name, event). */
  expectedRunnerWait(repo: string, name: string, event: string): number | null {
    const rows = this.stmtSelectRunnerWaits.all(repo, name, event) as { wait_secs: number }[];
    return rows.length ? median(rows.map((r) => r.wait_secs)) : null;
  }

  /** Event-level fallback: median pickup wait over the last 50 samples across names.
   *  Null below 3 samples — one or two waits are too thin to generalize to other jobs. */
  expectedRunnerWaitForEvent(repo: string, event: string): number | null {
    const rows = this.stmtSelectRunnerWaitsByEvent.all(repo, event) as { wait_secs: number }[];
    return rows.length >= 3 ? median(rows.map((r) => r.wait_secs)) : null;
  }

  /** Predicted (first stage ETA) vs actual stage duration. Rejects bad inputs. */
  recordEtaAccuracy(repo: string, stage: string, predictedSecs: number, actualSecs: number,
    observedAt: string): boolean {
    if (!Number.isFinite(predictedSecs) || predictedSecs < 0 || !(actualSecs > 0)) return false;
    this.stmtInsertEtaAccuracy.run(repo, stage, predictedSecs, actualSecs, observedAt);
    return true;
  }

  /** Median |predicted − actual| over the last 20 samples for (repo, stage). */
  etaAccuracy(repo: string, stage: string): { medianAbsErrSecs: number; n: number } | null {
    const rows = this.stmtSelectEtaAccuracy.all(repo, stage) as
      { predicted_secs: number; actual_secs: number }[];
    if (!rows.length) return null;
    return {
      medianAbsErrSecs: median(rows.map((r) => Math.abs(r.predicted_secs - r.actual_secs))),
      n: rows.length,
    };
  }

  getMeta(key: string): string | null {
    const row = this.stmtGetMeta.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.stmtSetMeta.run(key, value);
  }

  deleteMeta(key: string): void {
    this.stmtDeleteMeta.run(key);
  }

  /** All meta rows whose key starts with `prefix` (LIKE wildcards in the prefix
   *  are escaped — `repoConfig:a_b/c` only matches itself). */
  listMeta(prefix: string): { key: string; value: string }[] {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.stmtListMeta.all(`${escaped}%`) as { key: string; value: string }[];
  }

  close(): void {
    this.db.close();
  }
}
