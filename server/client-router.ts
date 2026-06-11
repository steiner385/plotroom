import { AppTokenSource, type InstallationRegistry } from './auth';
import { GithubClient, type GithubClientOptions } from './github';

export interface ClientRouterOptions extends GithubClientOptions {
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Routes GraphQL requests to the GithubClient that can see a given owner.
 * `GithubClient` stays single-token — multiplicity lives here:
 *
 * - `forSingle(client)` (tokenSource 'gh'/'env'): one shared client answers for
 *   every owner.
 * - `forRegistry(registry, options)` (tokenSource 'app'): one client per
 *   installation, created lazily, each with its own `AppTokenSource` (sharing
 *   the registry's JWT signer) and its own rate-limit bookkeeping.
 *
 * `clientFor(owner)` returns null for an owner no installation covers — the
 * caller logs once and skips (config mismatch, not an outage).
 */
export class ClientRouter {
  private readonly byInstallation = new Map<number, GithubClient>();

  private constructor(
    private readonly single: GithubClient | null,
    private readonly registry: InstallationRegistry | null,
    private readonly options: ClientRouterOptions,
  ) {}

  static forSingle(client: GithubClient): ClientRouter {
    return new ClientRouter(client, null, {});
  }

  static forRegistry(registry: InstallationRegistry, options: ClientRouterOptions = {}): ClientRouter {
    return new ClientRouter(null, registry, options);
  }

  /** The client whose installation token covers `owner`; null when none does. */
  clientFor(owner: string): GithubClient | null {
    if (this.single) return this.single;
    const id = this.registry!.installationFor(owner);
    if (id == null) return null;
    let client = this.byInstallation.get(id);
    if (!client) {
      const tokens = new AppTokenSource({
        signer: this.registry!.signer,
        installationId: id,
        apiUrl: this.options.apiUrl,
        fetchFn: this.options.fetchFn,
      });
      client = new GithubClient(tokens, this.options.fetchFn ?? fetch, {
        apiUrl: this.options.apiUrl,
        onPartialErrors: this.options.onPartialErrors,
      });
      this.byInstallation.set(id, client);
    }
    return client;
  }

  /** Every client created so far (single mode: the one client). */
  allClients(): GithubClient[] {
    return this.single ? [this.single] : [...this.byInstallation.values()];
  }

  /**
   * Smallest rate-limit budget across all clients that have reported one —
   * each installation token has its own budget, so throttles key off the worst.
   * Null until any client has seen a rateLimit payload.
   */
  minRemaining(): number | null {
    const vals = this.allClients()
      .map((c) => c.remaining)
      .filter((r): r is number => r != null);
    return vals.length ? Math.min(...vals) : null;
  }
}
