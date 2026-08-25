// Guards the standalone systemd unit template. These properties are what keep a
// broken daemon *visible*; each one has failed in production before.
//
// Regression: node_modules built under a pnpm-managed Node 22 could not load
// under the unit's system Node 20. Restart=always + RestartSec=10 never trips
// systemd's default start limit, so the unit looped 23,043 times while staying
// `activating` — it never appeared in `--state=failed` and nothing alerted.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const template = readFileSync(join(ROOT, 'deploy/pr-dashboard.service.template'), 'utf8');

describe('pr-dashboard.service.template', () => {
  it('keeps the __APP_ROOT__ placeholder install-service.sh substitutes', () => {
    expect(template).toMatch(/WorkingDirectory=__APP_ROOT__/);
    // The preflight is invoked by absolute path, so it needs the placeholder too.
    expect(template).toMatch(/__APP_ROOT__\/scripts\/preflight-native\.mjs/);
  });

  it('pins the runtime PATH so the daemon cannot pick up a different Node', () => {
    const path = template.match(/^Environment=PATH=(.+)$/m)?.[1];
    expect(path).toBeDefined();
    // Everything the daemon shells out to (gh, git) must be reachable.
    expect(path).toContain('/usr/bin');
    // A user-local Node ahead of the system one is the exact failure mode.
    expect(path).not.toContain('.local/share/pnpm');
  });

  it('bounds the restart loop so a dead daemon lands in `failed`', () => {
    const burst = Number(template.match(/^StartLimitBurst=(\d+)$/m)?.[1]);
    const interval = Number(template.match(/^StartLimitIntervalSec=(\d+)$/m)?.[1]);
    const restartSec = Number(template.match(/^RestartSec=(\d+)$/m)?.[1]);
    expect(burst).toBeGreaterThan(0);
    // The window must be wide enough to actually catch `burst` retries spaced
    // RestartSec apart — otherwise the limit can never trip (the original bug).
    expect(interval).toBeGreaterThan(burst * restartSec);
  });

  it('preflights native modules before starting', () => {
    expect(template).toMatch(/ExecStartPre=.*preflight-native\.mjs/);
  });
});

describe('preflight-native.mjs', () => {
  const preflight = readFileSync(join(ROOT, 'scripts/preflight-native.mjs'), 'utf8');

  it('forces the native addon to load, not just require the wrapper', () => {
    // better-sqlite3 loads its addon lazily: a bare require() succeeds even
    // against a mismatched build, which would make this check useless. Opening
    // a database is what actually pulls in the .node file.
    expect(preflight).toMatch(/new Database\(':memory:'\)/);
  });

  it('exits non-zero so systemd treats a mismatch as a start failure', () => {
    expect(preflight).toMatch(/process\.exit\(1\)/);
  });
});
