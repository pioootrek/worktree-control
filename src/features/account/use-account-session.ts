"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserSession } from "@/shared/contracts/authentication";
import { getSession, signOut as signOutRequest } from "./account-client";

export type AccountSession = Extract<BrowserSession, { authenticated: true }>;
export type AccountSessionState =
  | { phase: "loading" }
  | { phase: "anonymous" }
  | { phase: "authenticated"; session: AccountSession; generation: number };

/**
 * The account session state machine. The cookie is the sole authority, so
 * state is only ever what `get-session` last proved; a reload re-probes it
 * and any 401 reported by a child drops back to anonymous. `generation`
 * remounts session-scoped UI so no stale data survives a user switch.
 */
export function useAccountSession() {
  const [state, setState] = useState<AccountSessionState>({ phase: "loading" });
  const generation = useRef(0);

  const probe = useCallback(async (signal?: AbortSignal) => {
    try {
      const session = await getSession(signal);
      if (signal?.aborted) return;
      if (session.authenticated) {
        generation.current += 1;
        setState({ phase: "authenticated", session, generation: generation.current });
      } else {
        setState({ phase: "anonymous" });
      }
    } catch {
      if (!signal?.aborted) setState({ phase: "anonymous" });
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void probe(abort.signal);
    return () => abort.abort();
  }, [probe]);

  /** A completed sign-in ceremony minted the cookie; re-prove it before rendering account data. */
  const established = useCallback(() => probe(), [probe]);
  /** Any child that saw a 401 invalidates the local view; the cookie may already be gone server-side. */
  const lost = useCallback(() => { generation.current += 1; setState({ phase: "anonymous" }); }, []);
  const end = useCallback(async () => {
    generation.current += 1;
    setState({ phase: "anonymous" });
    try { await signOutRequest(); } catch { /* The local session is already discarded; a failed sign-out leaves nothing usable. */ }
  }, []);

  return { state, established, lost, end };
}
