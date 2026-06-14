import { describe, it, expect } from 'vitest';
import { modelBatchSizes } from '../estimator/batch-advisor';

describe('modelBatchSizes (issue #52)', () => {
  it('derives per-PR eject prob from the observed per-group rate + current batch', () => {
    // P(group of 3 ejects) = 0.36 → q = 1 − (1−0.36)^(1/3) ≈ 0.138
    const a = modelBatchSizes({ arrivalPerHour: 2, trainDurationSecs: 900,
      ejectProbPerGroup: 0.36, currentBatch: 3 });
    expect(a.ejectProbPerPr).toBeCloseTo(0.138, 2);
  });

  it('with no ejects, throughput rises monotonically → recommend the max batch (headroom)', () => {
    const a = modelBatchSizes({ arrivalPerHour: 1, trainDurationSecs: 600,
      ejectProbPerGroup: 0, currentBatch: 1 });
    expect(a.ejectProbPerPr).toBe(0);
    for (let i = 1; i < a.curve.length; i++) {
      expect(a.curve[i]!.throughputPerHour).toBeGreaterThan(a.curve[i - 1]!.throughputPerHour);
    }
    // batch is a cap; with no eject cost, the sweet spot is the largest batch
    expect(a.recommendedBatch).toBe(12);
  });

  it('with high ejects, throughput peaks at an interior batch → recommend that peak', () => {
    // heavy ejects: per-group 0.5 at batch 6 → sizable per-PR q
    const a = modelBatchSizes({ arrivalPerHour: 1, trainDurationSecs: 600,
      ejectProbPerGroup: 0.5, currentBatch: 6 });
    const peak = a.curve.reduce((b, c) => c.throughputPerHour > b.throughputPerHour ? c : b, a.curve[0]!);
    expect(peak.batch).toBeGreaterThan(1);
    expect(peak.batch).toBeLessThan(12);          // rework caps the sweet spot below max
    expect(a.recommendedBatch).toBe(peak.batch);  // recommend the throughput sweet spot
  });

  it('marks batches unstable (null time) when arrival exceeds capacity', () => {
    // very high arrival vs a slow train → small batches can't keep up
    const a = modelBatchSizes({ arrivalPerHour: 60, trainDurationSecs: 1200,
      ejectProbPerGroup: 0.1, currentBatch: 4 });
    expect(a.curve.some((c) => !c.stable && c.timeInQueueSecs === null)).toBe(true);
    // the recommendation is a real batch in range
    expect(a.recommendedBatch).toBeGreaterThanOrEqual(1);
    expect(a.recommendedBatch).toBeLessThanOrEqual(12);
  });

  it('recommends the stable batch with the highest sustainable throughput', () => {
    const a = modelBatchSizes({ arrivalPerHour: 3, trainDurationSecs: 600,
      ejectProbPerGroup: 0.2, currentBatch: 3 });
    const stable = a.curve.filter((c) => c.stable);
    const maxThroughput = Math.max(...stable.map((c) => c.throughputPerHour));
    expect(a.curve.find((c) => c.batch === a.recommendedBatch)!.throughputPerHour).toBe(maxThroughput);
  });
});
