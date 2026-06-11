import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

export class DeployWatcher {
  constructor(private cloneRoot: string, private fetchFn: typeof fetch = fetch) {}

  /** GET a /health endpoint and extract its deployed-sha field (`shaKey`, default
   *  'commitSha'); null on any failure or a non-string value. */
  async health(url: string, shaKey = 'commitSha'): Promise<string | null> {
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown> | null;
      const sha = body?.[shaKey];
      return typeof sha === 'string' && sha ? sha : null;
    } catch {
      return null;
    }
  }

  cloneDir(repo: string): string {
    return join(this.cloneRoot, `${repo.replace('/', '__')}.git`);
  }

  async ensureClone(repo: string, cloneUrl: string): Promise<void> {
    if (existsSync(this.cloneDir(repo))) return;
    mkdirSync(this.cloneRoot, { recursive: true });
    await run('git', ['clone', '--bare', '--filter=blob:none', cloneUrl, this.cloneDir(repo)]);
  }

  async fetchClone(repo: string): Promise<void> {
    await run('git', ['--git-dir', this.cloneDir(repo), 'fetch', '--prune', 'origin',
      '+refs/heads/*:refs/heads/*']);
  }

  /**
   * Read a file's contents at the tip of a branch in the bare clone; null on any
   * failure (missing clone, branch, or path). Reads `refs/heads/<branch>` rather
   * than HEAD — after a fetch the bare clone's HEAD may not advance, but the
   * branch refs do (fetchClone maps +refs/heads/*:refs/heads/*).
   */
  async readFileAtHead(repo: string, path: string, branch = 'main'): Promise<string | null> {
    try {
      const { stdout } = await run('git', ['--git-dir', this.cloneDir(repo), 'show',
        `refs/heads/${branch}:${path}`]);
      return stdout;
    } catch {
      return null;
    }
  }

  private async hasCommit(repo: string, sha: string): Promise<boolean> {
    try {
      await run('git', ['--git-dir', this.cloneDir(repo), 'cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** 'missing' = sha unknown even after a fresh fetch → caller shows "propagating" */
  async isAncestor(repo: string, sha: string, deployedSha: string): Promise<'yes' | 'no' | 'missing'> {
    if (!(await this.hasCommit(repo, sha)) || !(await this.hasCommit(repo, deployedSha))) {
      await this.fetchClone(repo);
      if (!(await this.hasCommit(repo, sha)) || !(await this.hasCommit(repo, deployedSha))) return 'missing';
    }
    try {
      await run('git', ['--git-dir', this.cloneDir(repo), 'merge-base', '--is-ancestor', sha, deployedSha]);
      return 'yes';
    } catch (e) {
      if ((e as { code?: number }).code === 1) return 'no';
      throw e;
    }
  }
}
