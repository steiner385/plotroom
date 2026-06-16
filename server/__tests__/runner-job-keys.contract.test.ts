import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { RUNNER_JOB_KEYS, RUNNER_JOB_META } from '../estimator/runner-plan';

/** Fetch a cairnea/KinDash workflow file (the cross-repo contract). Returns null
 *  when gh is unreachable/unauthed so the test skips rather than fails in CI. */
function workflow(name: string): string | null {
  try {
    const env = { ...process.env }; delete env.GITHUB_TOKEN; delete env.GH_TOKEN;
    const b64 = execFileSync('gh',
      ['api', `repos/cairnea/KinDash/contents/.github/workflows/${name}`, '--jq', '.content'],
      { env, encoding: 'utf8' });
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch { return null; }
}

describe('RUNNER_JOB_KEYS / RUNNER_JOB_META contract', () => {
  it('RUNNER_JOB_META covers exactly the RUNNER_JOB_KEYS keys', () => {
    expect(Object.keys(RUNNER_JOB_META).sort()).toEqual(Object.keys(RUNNER_JOB_KEYS).sort());
  });

  // Cross-repo wiring audit. This reaches over the network to cairnea/KinDash
  // main, so it is NON-HERMETIC and subject to cross-repo merge timing (the
  // workflow wiring lands in a separate KinDash PR). It therefore only WARNS on a
  // missing/unwired key — it never fails the suite on the state of another repo's
  // main branch. The hard contract is the key-set equality above; renaming a key
  // is caught there. Run it manually after the KinDash wiring lands to confirm.
  it('audits (warn-only) that each key is wired in its declared workflow on KinDash main', () => {
    const cache = new Map<string, string | null>();
    const read = (name: string): string | null => {
      if (!cache.has(name)) cache.set(name, workflow(name));
      return cache.get(name) ?? null;
    };

    const unwired: string[] = [];
    let checked = 0;
    for (const [key, meta] of Object.entries(RUNNER_JOB_META)) {
      const yml = read(meta.workflow);
      if (yml == null) continue; // gh unreachable for this file — can't audit
      checked++;
      // The exact wiring shipped in KinDash PR #10110:
      //   ... || fromJSON(vars.RUNNER_MAP || '{}')['<key>'] || 'kindash-arc-spot'
      if (!yml.includes(`fromJSON(vars.RUNNER_MAP || '{}')['${key}']`)) {
        unwired.push(`${key} (${meta.workflow})`);
      }
    }
    if (checked === 0) console.warn('runner-routing wiring audit skipped — gh/workflows unreachable');
    else if (unwired.length) {
      console.warn(`runner-routing wiring NOT YET on KinDash main (in-flight PR?): ${unwired.join(', ')}`);
    }
    expect(true).toBe(true); // informational only — see comment above
  });
});
