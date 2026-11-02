import type { BrowserLifetime } from "./browser-operations";

/**
 * One minted session no client has received, as a bare ID. It never holds a
 * cookie, response body or actor, so cleanup that cannot finish retains nothing
 * a caller could use. `issuing`: its operation still runs. `held`: a release may
 * deliver it. `retained`: only cleanup may end it.
 */
export interface UnreleasedSession {
  readonly sessionId: string;
  phase: "issuing" | "held" | "retained";
  cleaning: BrowserLifetime<void> | null;
}

/**
 * The runtime's bounded ownership of those sessions. An entry leaves only when
 * its session was released or its row is known to be gone. Nothing here expires
 * or evicts one, so reaching the bound refuses new issuers instead of forgetting
 * a session that may still exist.
 */
export class UnreleasedSessions {
  readonly #sessions = new Set<UnreleasedSession>();
  constructor(private readonly bound: number) {}

  get full(): boolean { return this.#sessions.size >= this.bound; }
  get size(): number { return this.#sessions.size; }
  has(session: UnreleasedSession): boolean { return this.#sessions.has(session); }
  all(): UnreleasedSession[] { return [...this.#sessions]; }

  /** Callers check `full` in the borrow that mints, so this never needs to refuse. */
  add(sessionId: string): UnreleasedSession {
    const session: UnreleasedSession = { sessionId, phase: "issuing", cleaning: null };
    this.#sessions.add(session);
    return session;
  }
  remove(session: UnreleasedSession): void { this.#sessions.delete(session); }
}
