/**
 * One-click GitHub App registration via the manifest flow (`pnpm app:setup [name]`).
 *
 * Starts a one-shot localhost listener, opens (well, prints) the GitHub
 * "create from manifest" URL, exchanges the redirect code for the App's
 * credentials, writes the PEM + webhook secret under ~/.config/pr-dashboard
 * (mode 0600), and patches the active config file to tokenSource 'app'.
 *
 * All parseable/pure logic lives in server/app-manifest.ts (tested); this
 * script is thin interactive glue.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../server/config';
import { configPath } from '../server/paths';
import { deriveRestBase } from '../server/auth';
import {
  applyAppToConfig, buildManifest, buildManifestPostPage, parseConversion, webBaseFromApiUrl,
} from '../server/app-manifest';

function writeSecretFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600); // mode option only applies on create — enforce on overwrite too
}

async function main(): Promise<void> {
  const cfgPath = configPath();
  const config = loadConfig(cfgPath);
  const restBase = deriveRestBase(config.apiUrl);
  const createUrl = `${webBaseFromApiUrl(config.apiUrl)}/settings/apps/new`;
  const name = process.argv[2] ?? 'pr-dashboard';

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        const { port } = server.address() as AddressInfo;
        const manifest = buildManifest({
          name,
          url: `http://127.0.0.1:${config.port}`, // homepage: the operator's own dashboard
          redirectUrl: `http://127.0.0.1:${port}/callback`,
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildManifestPostPage(manifest, createUrl));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('missing ?code= — restart pnpm app:setup and try again');
          return;
        }
        // Exchange the one-time code for the App's credentials (no auth required).
        const r = await fetch(`${restBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
          method: 'POST',
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'pr-dashboard' },
        });
        if (r.status !== 201) {
          throw new Error(`manifest conversion exchange failed: HTTP ${r.status} (the code is one-time and expires in 1h — rerun pnpm app:setup)`);
        }
        const conv = parseConversion(await r.json());

        const keyDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'pr-dashboard');
        mkdirSync(keyDir, { recursive: true });
        const pemPath = join(keyDir, `${conv.slug}.private-key.pem`);
        writeSecretFile(pemPath, conv.pem);
        if (conv.webhookSecret) {
          writeSecretFile(join(keyDir, `${conv.slug}.webhook-secret`), conv.webhookSecret);
        }

        // Read-modify-write the active config file: only tokenSource + app change.
        const existing: Record<string, unknown> = existsSync(cfgPath)
          ? (JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>)
          : {};
        mkdirSync(dirname(cfgPath), { recursive: true });
        writeFileSync(cfgPath,
          `${JSON.stringify(applyAppToConfig(existing, { appId: conv.id, privateKeyPath: pemPath }), null, 2)}\n`);

        const installUrl = `${conv.htmlUrl}/installations/new`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>pr-dashboard — App created</title>
<h1>✓ App "${conv.slug}" created (id ${conv.id})</h1>
<p>Private key saved; config switched to <code>tokenSource: "app"</code>.</p>
<p><strong>Last step:</strong> <a href="${installUrl}">install the App</a> on the account/repos the dashboard should watch, then restart the dashboard.</p>`);

        console.log(`\n✓ App created: ${conv.htmlUrl} (id ${conv.id}, slug ${conv.slug})`);
        console.log(`✓ Private key: ${pemPath} (0600)`);
        if (conv.webhookSecret) console.log(`✓ Webhook secret: ${join(keyDir, `${conv.slug}.webhook-secret`)} (0600)`);
        console.log(`✓ Config patched: ${cfgPath} → tokenSource "app", app.appId ${conv.id}`);
        console.log('\nNext steps:');
        console.log(`  1. Install the App: ${installUrl}`);
        console.log('  2. Restart the dashboard (it will auto-discover the installation).');
        server.close();
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    })().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`app-setup: ${msg}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`app-setup failed: ${msg}`);
      process.exitCode = 1;
      server.close();
    });
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    console.log('pr-dashboard GitHub App setup (manifest flow)');
    console.log(`\nOpen this URL in your browser to create the App "${name}":\n`);
    console.log(`  http://127.0.0.1:${port}/\n`);
    console.log('(GitHub will show a pre-filled "Create GitHub App" page; the name is editable there.');
    console.log(' After you confirm, GitHub redirects back here and setup completes automatically.)');
  });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
