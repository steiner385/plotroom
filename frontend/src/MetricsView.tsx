import { useEffect, useState, type ReactNode } from 'react';
import type { MetricsPayload } from './types';
import { Sparkline, Bars, DualLine, type ChartPoint } from './charts';
import { formatDur } from './format';

const WINDOWS = [7, 14, 30] as const;
type WindowDays = (typeof WINDOWS)[number];

/** The window's UTC dates (YYYY-MM-DD), oldest first — the shared x-axis. */
function windowDates(windowDays: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    out.push(new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Align sparse day buckets onto the full window axis; missing days → null gaps. */
function alignDays<T extends { date: string }>(dates: string[], days: T[],
  pick: (d: T) => number): ChartPoint[] {
  const byDate = new Map(days.map((d) => [d.date, pick(d)]));
  return dates.map((date) => ({ label: date, value: byDate.get(date) ?? null }));
}

/** Bars want a count for every day — missing days are real zeroes, not gaps. */
function alignCounts(dates: string[], days: { date: string; count: number }[]):
  { label: string; value: number }[] {
  const byDate = new Map(days.map((d) => [d.date, d.count]));
  return dates.map((date) => ({ label: date, value: byDate.get(date) ?? 0 }));
}

/** Lower median (same convention as server/math.ts). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

const fmtHours = (h: number): string => formatDur(h * 3600);

function Panel({ title, empty, children }: {
  title: string; empty: boolean; children: ReactNode;
}) {
  return (
    <section className="metric-panel">
      <h2>{title}</h2>
      {empty ? <p className="metric-empty">no data yet</p> : children}
    </section>
  );
}

function MetricStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function MetricsView() {
  const [windowDays, setWindowDays] = useState<WindowDays>(14);
  const [payload, setPayload] = useState<MetricsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/metrics?windowDays=${windowDays}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<MetricsPayload>;
      })
      .then((data) => { if (!cancelled) setPayload(data); })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [windowDays, refreshTick]);

  const controls = (
    <div className="metrics-controls">
      {WINDOWS.map((w) => (
        <button key={w} type="button" className="metrics-window-btn"
          aria-pressed={windowDays === w} onClick={() => setWindowDays(w)}>
          {w}d
        </button>
      ))}
      <button type="button" className="metrics-refresh" aria-label="Refresh metrics"
        onClick={() => setRefreshTick((t) => t + 1)}>
        ↻
      </button>
    </div>
  );

  if (error) {
    return (
      <div className="metrics">
        {controls}
        <p className="metrics-error">metrics fetch failed: {error}</p>
      </div>
    );
  }
  if (!payload) {
    return (
      <div className="metrics">
        {controls}
        <p className="loading">Loading metrics…</p>
      </div>
    );
  }

  const dates = windowDates(payload.windowDays);

  // group runner waits by repo so each repo renders one sub-section with its event tiers
  const runnerByRepo = new Map<string, typeof payload.runnerWaits>();
  for (const rw of payload.runnerWaits) {
    if (!rw.days.length) continue;
    runnerByRepo.set(rw.repo, [...(runnerByRepo.get(rw.repo) ?? []), rw]);
  }

  const queueRepos = payload.queue.filter((q) =>
    q.mergesPerDay.length || q.queueWaitDays.length || q.groupRunDays.length);
  const jobRepos = payload.slowestJobs.filter((r) => r.jobs.length);
  const velocityRepos = payload.velocity.filter((v) =>
    v.mergedPerDay.length || v.mergeToQaDays.length || v.avgLifespanDays.length);
  const trendRepos = payload.trends.filter((t) => t.samples.length);

  return (
    <div className="metrics">
      {controls}

      <Panel title="Runner-wait health" empty={runnerByRepo.size === 0}>
        {[...runnerByRepo.entries()].map(([repo, tiers]) => (
          <div key={repo} className="metric-repo">
            <h3>{repo}</h3>
            <div className="metric-row">
              {tiers.map((tier) => (
                <div key={tier.event} className="metric-cell">
                  <MetricStat label={tier.event}
                    value={formatDur(median(tier.days.map((d) => d.p50)))} />
                  <DualLine
                    a={alignDays(dates, tier.days, (d) => d.p50)}
                    b={alignDays(dates, tier.days, (d) => d.p90)}
                    format={formatDur}
                    label={`${repo} ${tier.event} runner wait p50/p90 by day`} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </Panel>

      <Panel title="Queue throughput" empty={queueRepos.length === 0}>
        {queueRepos.map((q) => (
          <div key={q.repo} className="metric-repo">
            <h3>{q.repo}</h3>
            <div className="metric-row">
              <div className="metric-cell">
                <span className="metric-label">merges / day</span>
                <Bars points={alignCounts(dates, q.mergesPerDay)}
                  label={`${q.repo} merges per day`} />
              </div>
              <div className="metric-cell">
                <span className="metric-label">time in queue (p50)</span>
                <Sparkline points={alignDays(dates, q.queueWaitDays, (d) => d.p50)}
                  format={formatDur} label={`${q.repo} time in queue p50 by day`} />
              </div>
              <div className="metric-cell">
                <span className="metric-label">group run (p50)</span>
                <Sparkline points={alignDays(dates, q.groupRunDays, (d) => d.p50)}
                  format={formatDur} label={`${q.repo} merge-group run p50 by day`} />
              </div>
            </div>
          </div>
        ))}
      </Panel>

      <Panel title="Slowest / most-variable jobs" empty={jobRepos.length === 0}>
        {jobRepos.map((r) => (
          <div key={r.repo} className="metric-repo">
            <h3>{r.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>job</th><th>event</th><th>p50</th><th>p90</th>
                  <th>p90/p50</th><th>n</th><th>trend</th>
                </tr>
              </thead>
              <tbody>
                {r.jobs.map((j) => (
                  <tr key={`${j.name}/${j.event}`}>
                    <td className="metric-job-name">{j.name}</td>
                    <td>{j.event}</td>
                    <td>{formatDur(j.p50)}</td>
                    <td>{formatDur(j.p90)}</td>
                    <td className={j.variability > 2 ? 'var-high' : undefined}>
                      {j.variability.toFixed(1)}×
                    </td>
                    <td>{j.n}</td>
                    <td>
                      <Sparkline points={alignDays(dates, j.trend, (d) => d.p50)}
                        width={90} height={20} format={formatDur}
                        label={`${j.name} p50 trend`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Panel>

      <Panel title="Merge velocity + deploy lag" empty={velocityRepos.length === 0}>
        {velocityRepos.map((v) => (
          <div key={v.repo} className="metric-repo">
            <h3>{v.repo}</h3>
            <div className="metric-row">
              <div className="metric-cell">
                <span className="metric-label">merged / day</span>
                <Bars points={alignCounts(dates, v.mergedPerDay)}
                  label={`${v.repo} merged per day`} />
              </div>
              <div className="metric-cell">
                <span className="metric-label">merge → QA (p50)</span>
                <Sparkline points={alignDays(dates, v.mergeToQaDays, (d) => d.p50)}
                  format={formatDur} label={`${v.repo} merge to QA p50 by day`} />
              </div>
              <div className="metric-cell">
                <span className="metric-label">avg PR lifespan</span>
                <Sparkline points={alignDays(dates, v.avgLifespanDays, (d) => d.meanHours)}
                  format={fmtHours} label={`${v.repo} average PR lifespan by day`} />
              </div>
            </div>
          </div>
        ))}
      </Panel>

      <Panel title="Trends" empty={trendRepos.length === 0}>
        {trendRepos.map((t) => {
          const counters = ['open', 'ci', 'queue', 'failed'] as const;
          const latest = t.samples[t.samples.length - 1]!;
          return (
            <div key={t.repo} className="metric-repo">
              <h3>{t.repo}</h3>
              <div className="metric-row">
                {counters.map((counter) => (
                  <div key={counter} className="metric-cell">
                    <MetricStat label={counter} value={String(latest[counter])} />
                    <Sparkline
                      points={t.samples.map((s) => ({
                        label: new Date(s.at).toLocaleString(), value: s[counter] }))}
                      format={(v) => String(Math.round(v))}
                      label={`${t.repo} ${counter} PRs over time`} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </Panel>
    </div>
  );
}
