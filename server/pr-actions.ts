/**
 * PR write-actions (issue: "flip draft → ready + auto-merge").
 *
 * The dashboard's normal path is read-only. This is the one place it mutates a
 * PR: mark a draft ready-for-review, then arm GitHub's native auto-merge so the
 * PR merges itself once its required checks pass. Both steps are GraphQL
 * mutations run through the same per-owner GithubClient the poller uses.
 *
 * Requires the App installation to hold `pull_requests: write` (the manifest
 * declares it as of this feature). On an installation that hasn't been granted
 * the upgraded permission yet, GitHub answers the mutation with a FORBIDDEN
 * GraphQL error ("Resource not accessible by integration") — the caller maps
 * that to actionable guidance rather than a 500.
 */

/** Minimal slice of GithubClient this module needs — keeps it unit-testable. */
export interface GraphqlClient {
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export type MergeMethod = 'SQUASH' | 'MERGE' | 'REBASE';

export interface ReadyMergeInput {
  owner: string;
  repo: string;
  number: number;
  /** Defaults to SQUASH (the convention across the watched repos). */
  mergeMethod?: MergeMethod;
}

export interface ReadyMergeResult {
  /** We flipped draft → ready (false when the PR was already non-draft). */
  markedReady: boolean;
  /** Auto-merge is now armed (or was already armed). */
  autoMergeArmed: boolean;
  /** Auto-merge was already armed before we touched it. */
  alreadyArmed: boolean;
  /** GitHub refused auto-merge because the PR is already mergeable now (nothing
   *  to wait on) — the PR was readied but there's nothing left to queue. */
  cleanReadyToMerge: boolean;
  /** mergeStateStatus after the mutations, for the response/UI. */
  state: string | null;
}

interface PrLookup {
  repository: {
    pullRequest: {
      id: string;
      isDraft: boolean;
      state: string;
      mergeStateStatus: string | null;
      autoMergeRequest: { __typename: string } | null;
    } | null;
  } | null;
}

const PR_LOOKUP = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      id isDraft state mergeStateStatus
      autoMergeRequest { __typename }
    }
  }
}`;

const MARK_READY = `mutation($id:ID!){
  markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest{ id isDraft } }
}`;

const ENABLE_AUTOMERGE = `mutation($id:ID!,$method:PullRequestMergeMethod!){
  enablePullRequestAutoMerge(input:{pullRequestId:$id, mergeMethod:$method}){
    pullRequest{ id mergeStateStatus }
  }
}`;

/** Error this module throws when the App lacks the write permission. The route
 *  maps it to a 403 + a fix-it hint. */
export class PermissionError extends Error {
  constructor(message: string) { super(message); this.name = 'PermissionError'; }
}

/** Heuristic: GitHub's FORBIDDEN / "not accessible by integration" wording for a
 *  mutation the installation isn't permitted to run. */
function isPermissionDenied(message: string): boolean {
  return /not accessible by integration|forbidden|must have admin|resource protected|permission/i.test(message);
}

/** GitHub's wording when auto-merge is rejected because the PR is already in a
 *  clean (immediately-mergeable) state. */
function isCleanStatus(message: string): boolean {
  return /clean status|not in the correct state|pull request is in/i.test(message);
}

/**
 * Mark a draft PR ready (if it is one) and arm auto-merge. Idempotent: a
 * non-draft PR skips the ready step; an already-armed PR skips the enable step.
 */
export async function readyAndAutoMerge(
  client: GraphqlClient,
  input: ReadyMergeInput,
): Promise<ReadyMergeResult> {
  const method: MergeMethod = input.mergeMethod ?? 'SQUASH';

  let look: PrLookup;
  try {
    look = await client.graphql<PrLookup>(PR_LOOKUP, {
      owner: input.owner, repo: input.repo, number: input.number,
    });
  } catch (e) {
    throw mapError(e);
  }

  const pr = look.repository?.pullRequest;
  if (!pr) {
    throw new Error(`PR ${input.owner}/${input.repo}#${input.number} not found`);
  }
  if (pr.state !== 'OPEN') {
    throw new Error(`PR #${input.number} is ${pr.state}, not OPEN — nothing to do`);
  }

  let markedReady = false;
  if (pr.isDraft) {
    try {
      await client.graphql(MARK_READY, { id: pr.id });
      markedReady = true;
    } catch (e) {
      throw mapError(e);
    }
  }

  const alreadyArmed = pr.autoMergeRequest != null;
  let autoMergeArmed = alreadyArmed;
  let cleanReadyToMerge = false;
  if (!alreadyArmed) {
    try {
      await client.graphql(ENABLE_AUTOMERGE, { id: pr.id, method });
      autoMergeArmed = true;
    } catch (e) {
      const err = mapError(e);
      // PR became immediately mergeable (e.g. checks already green) — GitHub
      // won't queue an auto-merge with nothing to wait on. The ready flip still
      // happened; report it so the UI can say "mergeable now".
      if (!(err instanceof PermissionError) && isCleanStatus(err.message)) {
        cleanReadyToMerge = true;
      } else {
        throw err;
      }
    }
  }

  return {
    markedReady,
    autoMergeArmed,
    alreadyArmed,
    cleanReadyToMerge,
    state: pr.mergeStateStatus,
  };
}

function mapError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (isPermissionDenied(message)) {
    return new PermissionError(
      'GitHub App lacks pull_requests:write. Approve the permission upgrade for '
      + 'the installation in GitHub → Settings → Applications, then retry.',
    );
  }
  return e instanceof Error ? e : new Error(message);
}
