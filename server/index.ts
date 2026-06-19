import { loadConfig, type AppConfig } from './config';
import { createPrDashboardBackend } from './backend';
import { dataDir, configPath } from './paths';

async function main() {
  // Resolve config from the standard configPath() so a malformed file fails fast
  // and clearly here (the factory would otherwise throw on a later loadConfig).
  const cfgPath = configPath();
  let config: AppConfig;
  try {
    config = loadConfig(cfgPath);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // Standalone keeps the SAME externally-observable behavior as before:
  //  - serveStatic in production (dist/public)
  //  - the built-in same-origin guard ON (trustHostAuth: false)
  //  - the REAL restart exit (process.exit) so the systemd unit restarts us
  //  - the config FILE path is writable (so PUT /api/config persists)
  // We do NOT pass githubApp → the factory falls back to config.app.privateKeyPath.
  let be;
  try {
    be = await createPrDashboardBackend({
      config: { path: cfgPath },
      dataDir: dataDir(),
      serveStatic: process.env.NODE_ENV === 'production',
      trustHostAuth: false,
      restartExit: (code: number) => process.exit(code),
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const app = be.router;
  be.startPoller();

  // One listener per bind host (default loopback only; add a Tailscale IP to
  // reach the dashboard across the tailnet). A non-loopback bind that fails
  // (e.g. tailscaled not up yet) is logged and skipped so loopback still serves.
  const isLoopback = (h: string) => h === '127.0.0.1' || h === '::1' || h === 'localhost';
  for (const host of config.bindHosts) {
    const server = app.listen(config.port, host, () => {
      console.log(`pr-dashboard on http://${host}:${config.port}`);
    });
    server.on('error', (e: NodeJS.ErrnoException) => {
      console.error(`[bind] could not listen on ${host}:${config.port} — ${e.message}`);
      if (isLoopback(host)) process.exit(1); // loopback is essential
    });
  }
  if (config.webhooks.enabled) {
    console.log(`[webhooks] receiver enabled at POST ${config.webhooks.path} (loopback — use a tunnel for ingress)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
