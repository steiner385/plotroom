#!/usr/bin/env node
// Standalone-daemon preflight: refuse to start when node_modules was built
// against a different Node than the one this unit runs under.
//
// better-sqlite3 is a native addon, so its build is pinned to a NODE_MODULE_VERSION.
// `pnpm install` compiles it with whichever Node is first on the *installing*
// shell's PATH — a pnpm-managed Node 22, say — while the unit runs the system
// Node 20. The mismatch only surfaces at require() time, and because the unit is
// Restart=always/RestartSec=10 the daemon then crash-loops indefinitely with
// nothing but a NODE_MODULE_VERSION stack trace in the journal. One such loop
// ran to 23,043 restarts before anyone read it.
//
// Exiting non-zero here turns that into a single actionable line, and the unit's
// StartLimitBurst puts the service into `failed` where `systemctl --user
// list-units --state=failed` will actually show it.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

try {
  // better-sqlite3 loads its addon lazily, so a bare require() does NOT touch
  // the native binding and would pass even against a mismatched build. Opening
  // an in-memory database is what actually forces the .node file to load.
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  process.stderr.write(
    `pr-dashboard preflight: native modules are not loadable under ${process.version} ` +
      `(NODE_MODULE_VERSION ${process.versions.modules}).\n` +
      `Rebuild them with the same Node this unit runs:\n` +
      `  cd "${process.cwd()}" && PATH=/usr/local/bin:/usr/bin:/bin pnpm rebuild\n\n` +
      `${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
