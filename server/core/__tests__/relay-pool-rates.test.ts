// Guards the payload handoff in scripts/relay-pool-rates.sh. The script itself
// needs AWS Cost Explorer + a running dashboard, so it is operator-run (see the
// script header); what is asserted here is the one property that silently broke
// it in production, which is visible in the source alone.
//
// Regression: CE and METRICS were passed to python3 as environment variables.
// METRICS grows with the number of tracked buckets, and once it crossed the
// kernel's per-string limit (MAX_ARG_STRLEN, 128 KiB) execve failed E2BIG —
// which bash reports as exit 126 with no output at all. The timer went red and
// the pool rates silently stopped updating. Payloads now go via temp files.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const script = readFileSync(join(__dirname, '../../../scripts/relay-pool-rates.sh'), 'utf8');

describe('relay-pool-rates.sh payload handoff', () => {
  it('never passes the CE or METRICS payloads through the environment', () => {
    // The E2BIG shape: `VAR="$VAR" python3` for an unbounded payload.
    expect(script).not.toMatch(/CE="\$CE"/);
    expect(script).not.toMatch(/METRICS="\$METRICS"/);
    expect(script).not.toMatch(/os\.environ\["CE"\]/);
    expect(script).not.toMatch(/os\.environ\["METRICS"\]/);
  });

  it('hands both payloads to python as files', () => {
    expect(script).toMatch(/CE_FILE="\$CE_FILE"/);
    expect(script).toMatch(/METRICS_FILE="\$METRICS_FILE"/);
    expect(script).toMatch(/json\.load\(open\(os\.environ\["CE_FILE"\]\)\)/);
    expect(script).toMatch(/json\.load\(open\(os\.environ\["METRICS_FILE"\]\)\)/);
  });

  it('cleans the temp files up on exit', () => {
    expect(script).toMatch(/mktemp/);
    expect(script).toMatch(/trap 'rm -f "\$CE_FILE" "\$METRICS_FILE"' EXIT/);
  });
});
