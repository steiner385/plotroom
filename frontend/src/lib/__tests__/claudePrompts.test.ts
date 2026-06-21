import { describe, it, expect } from 'vitest';
import { demotionPrompt, promotionPrompt, pipelineEditsPrompt, prefixesPrompt } from '../claudePrompts';
import type { DemotionCandidate, PromotionCandidate } from '../../types';

const demo: DemotionCandidate = {
  name: 'db-migrations / db: migrations', event: 'pull_request',
  currentTier: 'every PR push', suggestedTier: 'merge queue only',
  successRatePct: 100, runsInWindow: 120, minutesInWindow: 374,
  reason: '120/120 green · ~374 runner-min in window',
};
const promo: PromotionCandidate = {
  name: 'e2e / smoke', event: 'push', currentTier: 'every push to main', suggestedTier: 'every PR push',
  realFailures: 4, incidents: 2, failRatePct: 3.3, runsInWindow: 120,
  minutesInWindow: 800, reason: '4 real fails across 2 incidents',
};

describe('demotionPrompt', () => {
  it('names the repo, check, tier move, and the demote PR title', () => {
    const p = demotionPrompt('cairnea/KinDash', demo);
    expect(p).toContain('cairnea/KinDash');
    expect(p).toContain('"db-migrations / db: migrations"');
    expect(p).toContain('every PR push');
    expect(p).toContain('merge queue only');
    // carries the evidence + the canonical PR title
    expect(p).toContain('120/120 green');
    expect(p).toContain('ci: demote db-migrations / db: migrations');
    // safety rail: don't drop the gate
    expect(p.toLowerCase()).toContain('merge-queue gate');
  });
});

describe('promotionPrompt', () => {
  it('frames it as a shift-left with the real-failure evidence and the shift PR title', () => {
    const p = promotionPrompt('o/r', promo);
    expect(p).toContain('shift');
    expect(p).toContain('"e2e / smoke"');
    expect(p).toContain('4 real');
    expect(p).toContain('ci: shift e2e / smoke left');
    expect(p.toLowerCase()).toContain('flake');
  });
});

describe('pipelineEditsPrompt', () => {
  it('lists each structured mutation as an instruction + a multi-change PR title', () => {
    const p = pipelineEditsPrompt('o/r', [
      { op: 'timeout', jobId: 'build', minutes: 20 },
      { op: 'shift-left', jobId: 'integration' },
      { op: 'remove', jobId: 'legacy' },
      { op: 'runner', jobId: 'e2e', runsOn: 'ubuntu-latest-8' },
      { op: 'concurrency', group: 'ci-${{ github.ref }}' },
    ]);
    expect(p).toContain('timeout-minutes: 20');
    expect(p).toContain('`build`');
    expect(p.toLowerCase()).toContain('shift'); // shift-left integration
    expect(p).toContain('`integration`');
    expect(p).toContain('Remove');          // remove legacy
    expect(p).toContain('ubuntu-latest-8'); // runner
    expect(p).toContain('concurrency');
    expect(p).toContain('ci: pipeline changes (5 changes)');
    expect(p.toLowerCase()).toContain('required');
  });

  it('singularizes the title for one change', () => {
    expect(pipelineEditsPrompt('o/r', [{ op: 'shift-left', jobId: 'x' }]))
      .toContain('ci: pipeline changes (1 change)');
  });
});

describe('prefixesPrompt', () => {
  it('lists the prefixes as YAML under requiredCheckPrefixes and preserves other keys', () => {
    const p = prefixesPrompt('o/r', ['ci /', 'build', 'lint: eslint']);
    expect(p).toContain('requiredCheckPrefixes');
    expect(p).toContain('.pr-dashboard.yml');
    expect(p).toContain('- ci /');
    expect(p).toContain('- build');
    expect(p.toLowerCase()).toContain('preserve');
  });
});
