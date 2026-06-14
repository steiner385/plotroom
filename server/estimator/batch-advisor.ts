/**
 * Batch-size what-if advisor (issue #52). Queueing-theory replay over observed
 * arrival rate, train duration, and eject probability → modeled throughput +
 * median time-in-queue at batch sizes 1..N, with a recommendation.
 *
 * Model (deliberately analytic, no Monte Carlo):
 *  - Per-PR eject prob `q` is derived from the OBSERVED per-group eject prob at
 *    the current batch B0:  P(group of B0 ejects) = 1 − (1−q)^B0.
 *  - A batch of B succeeds (merges all B) with prob s = (1−q)^B. On any eject the
 *    batch re-runs, so the effective service time per merged batch is D/s
 *    (geometric retries). Throughput (capacity) = 3600·B·s/D PRs/hr.
 *  - Batch size is a CAP, not a target: a low-traffic queue can't fill a big
 *    batch, so the effective batch is min(B, arrivals-during-one-train). This is
 *    the key fidelity point — a larger cap adds throughput headroom at NO latency
 *    cost while traffic is light, until eject rework `(1−q)^B` erodes capacity.
 *  - Time-in-queue = batch-formation wait (over the effective batch) + M/D/1
 *    queue wait + effective service. Unstable (ρ ≥ 1) batches report null time.
 *
 * Recommendation = the throughput sweet spot: the stable batch that maximises
 * sustainable capacity (B·s before eject rework dominates). Because batch is a
 * cap, this never hurts latency at light traffic; it gives the most burst
 * headroom the eject rate allows. Falls back to max throughput if none stable.
 */

export interface BatchInputs {
  /** Observed PR merge/arrival rate, PRs per hour (λ). */
  arrivalPerHour: number;
  /** Observed whole-train (group_run) p50 duration, seconds (D). */
  trainDurationSecs: number;
  /** Observed P(a group ejects) at the current batch size, 0..1. */
  ejectProbPerGroup: number;
  /** Batch size that produced `ejectProbPerGroup`. */
  currentBatch: number;
  /** Sweep 1..maxBatch (default 12). */
  maxBatch?: number;
}

export interface BatchPoint {
  batch: number;
  throughputPerHour: number;
  /** Median time-in-queue, seconds; null when the queue is unstable at this batch. */
  timeInQueueSecs: number | null;
  stable: boolean;
}

export interface BatchAdvice {
  /** Per-PR eject probability derived from the observed per-group rate. */
  ejectProbPerPr: number;
  curve: BatchPoint[];
  recommendedBatch: number;
}

export function modelBatchSizes(inp: BatchInputs): BatchAdvice {
  const maxBatch = inp.maxBatch ?? 12;
  const D = inp.trainDurationSecs;
  const lambda = Math.max(0, inp.arrivalPerHour);
  const B0 = Math.max(1, Math.round(inp.currentBatch));
  const pGroup = Math.min(0.99, Math.max(0, inp.ejectProbPerGroup));
  // Invert P(group of B0 ejects) = 1 − (1−q)^B0 for the per-PR prob q.
  const q = 1 - Math.pow(1 - pGroup, 1 / B0);

  // PRs that arrive during one train — caps how big a batch the queue can fill
  // when there's no standing backlog. Below this, raising the batch CAP does
  // nothing (batches don't reach it); above it, the cap binds.
  const arrivalsPerTrain = D > 0 ? (lambda * D) / 3600 : 0;

  const curve: BatchPoint[] = [];
  for (let B = 1; B <= maxBatch; B++) {
    // Capacity headroom uses the FULL batch B (what the queue sustains when
    // saturated): 3600·B·(1−q)^B / D.
    const sFull = Math.pow(1 - q, B);
    const throughputPerHour = D > 0 ? (3600 * B * sFull) / D : 0;

    // Latency uses the EFFECTIVE batch the queue actually forms (cap vs traffic).
    // The eject rework + service apply to the bEff-sized batch that really runs,
    // NOT the cap — so a larger cap the queue can't fill costs no extra latency.
    const bEff = Math.min(B, Math.max(1, arrivalsPerTrain));
    const sEff = Math.pow(1 - q, bEff);
    const Deff = sEff > 0 ? D / sEff : Infinity;                 // effective service per batch
    const rho = Number.isFinite(Deff) ? (lambda / 3600 / bEff) * Deff : Infinity;
    const stable = rho < 1 && Number.isFinite(Deff) && lambda > 0;
    let timeInQueueSecs: number | null = null;
    if (stable) {
      const fillWaitSecs = ((bEff - 1) / (2 * lambda)) * 3600;   // form the effective batch
      const wqSecs = (rho * Deff) / (2 * (1 - rho));             // M/D/1 mean queue wait
      timeInQueueSecs = Math.round(fillWaitSecs + wqSecs + Deff);
    }
    curve.push({
      batch: B,
      throughputPerHour: Math.round(throughputPerHour * 10) / 10,
      timeInQueueSecs, stable,
    });
  }

  // Throughput sweet spot: the stable batch with the most sustainable capacity
  // (B·s, before eject rework erodes it). Batch is a cap, so this never hurts
  // latency at light traffic. Tie-break toward the LOWER batch (less rework risk
  // per incident). Fall back to max throughput if no batch is stable.
  const stablePts = curve.filter((c) => c.stable);
  const pool = stablePts.length ? stablePts : curve;
  const recommendedBatch = pool.reduce((best, c) =>
    c.throughputPerHour > best.throughputPerHour + 1e-9 ? c : best, pool[0]!).batch;

  return { ejectProbPerPr: Math.round(q * 1000) / 1000, curve, recommendedBatch };
}
