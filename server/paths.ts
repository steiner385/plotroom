import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the package root (the directory containing package.json).
 * Resolved from this file's location: server/paths.ts → server/ → ../
 * This anchors all runtime paths to the package root regardless of the CWD
 * from which the server is started.
 */
export const APP_ROOT: string = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Directory for runtime data (SQLite DB, git clones, etc.).
 * Override with PRDASH_DATA_DIR env var.
 */
export function dataDir(): string {
  return process.env.PRDASH_DATA_DIR ?? join(APP_ROOT, 'data');
}

/**
 * Path to the config.json file. Resolution order (first existing wins):
 *   1. PRDASH_CONFIG env var (always wins, even if the file doesn't exist yet)
 *   2. <repo>/config.json
 *   3. $XDG_CONFIG_HOME/pr-dashboard/config.json (XDG_CONFIG_HOME defaults to ~/.config)
 * When none exist, the repo-level path is returned (loadConfig then uses DEFAULTS).
 * `appRoot` is parameterized for tests only.
 */
export function configPath(appRoot: string = APP_ROOT): string {
  if (process.env.PRDASH_CONFIG) return process.env.PRDASH_CONFIG;
  const repoPath = join(appRoot, 'config.json');
  if (existsSync(repoPath)) return repoPath;
  const xdgBase = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const xdgPath = join(xdgBase, 'pr-dashboard', 'config.json');
  if (existsSync(xdgPath)) return xdgPath;
  return repoPath;
}

/**
 * Resolve a user-supplied config path the same way other runtime paths are
 * anchored: `~/` expands to the home directory, relative paths anchor to the
 * package root (NOT the CWD — the server can be started from anywhere).
 */
export function resolveUserPath(p: string, appRoot: string = APP_ROOT): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : join(appRoot, p);
}

/**
 * Path to the built frontend static files (production mode only).
 */
export function staticDir(): string {
  return join(APP_ROOT, 'dist', 'public');
}
