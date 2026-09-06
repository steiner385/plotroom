import { parse } from 'yaml';
import type { DeployConfig, EnvConfig } from './config';

/** Path of the per-repo config file inside each watched repo. */
export const REPO_CONFIG_PATH = '.pr-dashboard.yml';

/**
 * Parsed `.pr-dashboard.yml` from a watched repo (the in-repo config layer).
 * All fields optional — precedence is instance override > in-repo > derived
 * (prefixes only) > defaults; see `effectiveRepoSettings` in config.ts.
 * `deploy` is fully normalized (cloneUrl/defaultBranch/auto/shaKey defaults
 * applied, env names lowercased) so it can be used as a DeployConfig directly.
 */
export interface RepoFileConfig {
  rollupJobId?: string;
  workflowPath?: string;
  requiredCheckPrefixes?: string[];
  batchSize?: number;
  deploy?: DeployConfig;
  /** Carry learned history across a check rename: `{ "old canonical name":
   *  "new canonical name" }`. Applied once per pair (see History.applyCheckAliases)
   *  so durations / pools / runner-waits / flake follow the rename instead of
   *  cold-starting. Declare it in the SAME PR as the workflow/job rename. */
  aliases?: Record<string, string>;
  /** Opt-in flag: when true, deploy environments for this repo may be
   *  auto-discovered from GitHub (Phase 2). Default false — off unless explicitly
   *  set. */
  autoDiscoverDeploy?: boolean;
  /** Human-readable notes for every invalid piece that was dropped. */
  warnings: string[];
}

const KNOWN_KEYS = new Set(['rollupJobId', 'workflowPath', 'requiredCheckPrefixes', 'batchSize', 'deploy', 'aliases', 'autoDiscoverDeploy']);

function isMapping(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Throw-free mirror of loadConfig's deploy normalization: invalid environments
 *  are dropped with a warning instead of throwing (a watched repo's file must
 *  never be able to crash the instance). */
function parseDeploy(repo: string, raw: unknown, warnings: string[]): DeployConfig | undefined {
  if (!isMapping(raw)) {
    warnings.push('deploy must be a mapping — dropped');
    return undefined;
  }
  const envsRaw = Array.isArray(raw.environments) ? raw.environments : [];
  if (raw.environments !== undefined && !Array.isArray(raw.environments)) {
    warnings.push('deploy.environments must be a list — treated as empty');
  }
  // Collect valid env names first to compute order and auto-default.
  const validEnvsRaw: Array<{ name: string; e: Record<string, unknown> }> = [];
  for (const e of envsRaw) {
    if (!isMapping(e)) {
      warnings.push('deploy environment must be a mapping — environment dropped');
      continue;
    }
    const name = String(e.name ?? '').toLowerCase();
    if (typeof e.healthUrl !== 'string' || !e.healthUrl) {
      warnings.push(`deploy environment "${name}" is missing healthUrl — environment dropped`);
      continue;
    }
    validEnvsRaw.push({ name, e });
  }
  const order = validEnvsRaw.map((v) => v.name);
  const firstEnvName = order[0] ?? '';
  const environments: EnvConfig[] = validEnvsRaw.map(({ name, e }) => ({
    name,
    healthUrl: e.healthUrl as string,
    auto: typeof e.auto === 'boolean' ? e.auto : name === firstEnvName,
    shaKey: typeof e.shaKey === 'string' && e.shaKey ? e.shaKey as string : 'commitSha',
  }));
  return {
    cloneUrl: typeof raw.cloneUrl === 'string' && raw.cloneUrl ? raw.cloneUrl : `https://github.com/${repo}.git`,
    defaultBranch: typeof raw.defaultBranch === 'string' && raw.defaultBranch ? raw.defaultBranch : 'main',
    environments,
    order,
  };
}

/**
 * Parse a repo's `.pr-dashboard.yml`. Null when the text is unparseable YAML or
 * not a mapping (the caller keeps whatever it knew before). Individual invalid
 * fields are dropped with a warning — never thrown — so one bad field cannot
 * take the rest of the file with it.
 */
export function parseRepoConfig(repo: string, yamlText: string): RepoFileConfig | null {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch {
    return null;
  }
  if (!isMapping(doc)) return null;
  const warnings: string[] = [];
  const out: RepoFileConfig = { warnings };

  for (const key of Object.keys(doc)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" ignored`);
  }
  for (const key of ['rollupJobId', 'workflowPath'] as const) {
    if (doc[key] === undefined) continue;
    if (typeof doc[key] === 'string' && doc[key]) out[key] = doc[key];
    else warnings.push(`${key} must be a non-empty string — dropped`);
  }
  if (doc.requiredCheckPrefixes !== undefined) {
    if (Array.isArray(doc.requiredCheckPrefixes)) {
      const strings = doc.requiredCheckPrefixes.filter((p): p is string => typeof p === 'string');
      if (strings.length < doc.requiredCheckPrefixes.length) {
        warnings.push('requiredCheckPrefixes: non-string entries dropped');
      }
      out.requiredCheckPrefixes = strings;
    } else {
      warnings.push('requiredCheckPrefixes must be an array of strings — dropped');
    }
  }
  if (doc.batchSize !== undefined) {
    if (typeof doc.batchSize === 'number' && Number.isInteger(doc.batchSize) && doc.batchSize >= 1) {
      out.batchSize = doc.batchSize;
    } else {
      warnings.push('batchSize must be a positive integer — dropped');
    }
  }
  if (doc.aliases !== undefined) {
    if (isMapping(doc.aliases)) {
      const clean: Record<string, string> = {};
      for (const [from, to] of Object.entries(doc.aliases)) {
        if (typeof to === 'string' && to && from && from !== to) clean[from] = to;
        else warnings.push(`aliases["${from}"] must map a non-empty name to a different non-empty name — dropped`);
      }
      if (Object.keys(clean).length) out.aliases = clean;
    } else {
      warnings.push('aliases must be a mapping of old-name -> new-name — dropped');
    }
  }
  if (doc.autoDiscoverDeploy !== undefined) {
    if (typeof doc.autoDiscoverDeploy === 'boolean') {
      out.autoDiscoverDeploy = doc.autoDiscoverDeploy;
    } else {
      warnings.push('autoDiscoverDeploy must be a boolean — dropped');
    }
  }
  if (doc.deploy !== undefined) {
    const deploy = parseDeploy(repo, doc.deploy, warnings);
    if (deploy) out.deploy = deploy;
  }
  return out;
}
