"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserSession } from "@/shared/contracts/authentication";
import { AccountApiError, getSession, signOut as signOutRequest } from "./account-client";

export type AccountSession = Extract<BrowserSession, { authenticated: true }>;
export type AccountSessionState =
  | { phase: "loading" }
  | { phase: "anonymous" }
  | { phase: "authenticated"; session: AccountSession; generation: number }
  | { phase: "signingOut" }
  | { phase: "signOutUnconfirmed"; generation: number }
  /** The session probe itself failed; nothing is known, so neither account data nor a sign-in form renders. */
  | { phase: "unavailable" };

/**
 * Non-secret intent marker recording that the user asked to sign out but the
 * server never confirmed it. It is never authority: the HttpOnly cookie and
 * the server's answers remain the sole proof of session state. A reload that
 * finds both the marker and a live session finishes the sign-out before any
 * account data renders, so an apparent logout never silently resumes.
 */
export const SIGN_OUT_UNCONFIRMED_KEY = "worktree-control.signOutUnconfirmed";

function readSignOutMarker(): boolean {
  try {
    return window.localStorage.getItem(SIGN_OUT_UNCONFIRMED_KEY) !== null;
  } catch {
    return false;
  }
}

function writeSignOutMarker(unconfirmed: boolean): void {
  try {
    if (unconfirmed) window.localStorage.setItem(SIGN_OUT_UNCONFIRMED_KEY, "1");
    else window.localStorage.removeItem(SIGN_OUT_UNCONFIRMED_KEY);
  } catch {
    // Storage may be unavailable; the in-memory phase still blocks account UI.
  }
}

/** One user intent gets a bounded retry; a 401 means the session was already gone server-side, which is a confirmed sign-out. */
const SIGN_OUT_ATTEMPTS = 2;

async function requestConfirmedSignOut(signal?: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < SIGN_OUT_ATTEMPTS; attempt += 1) {
    try {
      await signOutRequest(signal);
      return true;
    } catch (cause) {
      if (signal?.aborted) return false;
      if (cause instanceof AccountApiError && cause.status === 401) return true;
    }
  }
  return false;
}

/**
 * The account session state machine. The cookie is the sole authority, so
 * state is only ever what `get-session` last proved; a reload re-probes it
 * and any 401 reported by a child drops back to anonymous. `generation`
 * remounts session-scoped UI so no stale data survives a user switch.
 * Sign-out is only treated as done when the server confirms it; otherwise a
 * blocking unconfirmed phase (plus the intent marker) keeps account data
 * hidden instead of faking an anonymous state. A failed session probe is
 * not an answer either: it never renders a sign-in form that would imply
 * the browser holds no session.
 */
export function useAccountSession() {
  const [state, setState] = useState<AccountSessionState>({ phase: "loading" });
  const generation = useRef(0);

  const probe = useCallback(async (signal?: AbortSignal) => {
    try {
      const session = await getSession(signal);
      if (signal?.aborted) return;
      if (!session.authenticated) {
        // The server proves there is nothing left to sign out; any marker is resolved.
        writeSignOutMarker(false);
        setState({ phase: "anonymous" });
        return;
      }
      if (readSignOutMarker()) {
        // A previous sign-out was never confirmed; finish it before showing anything.
        setState({ phase: "signingOut" });
        const confirmed = await requestConfirmedSignOut(signal);
        if (signal?.aborted) return;
        if (confirmed) {
          writeSignOutMarker(false);
          setState({ phase: "anonymous" });
        } else {
          generation.current += 1;
          setState({ phase: "signOutUnconfirmed", generation: generation.current });
        }
        return;
      }
      generation.current += 1;
      setState({ phase: "authenticated", session, generation: generation.current });
    } catch {
      if (signal?.aborted) return;
      if (readSignOutMarker()) {
        // The pending sign-out stays unconfirmed; the user may retry it from there.
        generation.current += 1;
        setState({ phase: "signOutUnconfirmed", generation: generation.current });
      } else {
        setState({ phase: "unavailable" });
      }
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    // Deferred past the effect body: probe renders only asynchronous updates.
    void Promise.resolve().then(() => probe(abort.signal));
    return () => abort.abort();
  }, [probe]);

  /**
   * A completed sign-in ceremony minted the cookie; re-prove it before
   * rendering account data. A fresh sign-in is a new explicit intent that
   * supersedes an older unconfirmed sign-out (its cookie was replaced), so the
   * marker must not end the session the user just established.
   */
  const established = useCallback(() => {
    writeSignOutMarker(false);
    return probe();
  }, [probe]);
  /**
   * A child of the given session generation saw a 401: the cookie is already
   * gone server-side. A late answer from an earlier generation (a previous
   * user, or a view already left for sign-out) is ignored so it can neither end
   * nor relabel the current state. Returns whether the loss was applied.
   */
  const lost = useCallback((ofGeneration: number) => {
    if (ofGeneration !== generation.current) return false;
    writeSignOutMarker(false);
    generation.current += 1;
    setState({ phase: "anonymous" });
    return true;
  }, []);
  /** Sign out with a bounded retry; on final failure show the honest unconfirmed state instead of faking anonymous. */
  const end = useCallback(async () => {
    generation.current += 1;
    const current = generation.current;
    setState({ phase: "signingOut" });
    const confirmed = await requestConfirmedSignOut();
    if (generation.current !== current) return;
    if (confirmed) {
      writeSignOutMarker(false);
      setState({ phase: "anonymous" });
    } else {
      writeSignOutMarker(true);
      setState({ phase: "signOutUnconfirmed", generation: current });
    }
  }, []);
  /** The user explicitly keeps the session: clear the intent marker and re-prove it. */
  const returnToAccount = useCallback(() => {
    writeSignOutMarker(false);
    setState({ phase: "loading" });
    void probe();
  }, [probe]);

  /** Re-run a session probe that failed; any pending sign-out marker is still honored. */
  const retry = useCallback(() => {
    setState({ phase: "loading" });
    void probe();
  }, [probe]);

  return { state, established, lost, end, returnToAccount, retry };
}
