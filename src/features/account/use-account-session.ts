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
 * Non-secret intent marker recording that the user asked to sign out and the
 * server has not confirmed it yet. It is written before the first sign-out
 * request and cleared only on the server's proof, so a reload or a closed tab
 * during a stalled request keeps the intent. It is never authority: the
 * HttpOnly cookie and the server's answers remain the sole proof of session
 * state. A reload that finds both the marker and a live session finishes the
 * sign-out before any account data renders, so a logout never silently resumes.
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
/** Each attempt is abandoned after this long, so a stalled server reaches the unconfirmed state in bounded time. */
export const SIGN_OUT_ATTEMPT_TIMEOUT_MS = 15_000;

/** One bounded attempt. A timer (not `AbortSignal.timeout`) bounds it so the page clock governs it in tests. */
async function attemptSignOut(outer?: AbortSignal): Promise<"confirmed" | "failed" | "aborted"> {
  if (outer?.aborted) return "aborted";
  const attempt = new AbortController();
  const timer = window.setTimeout(() => attempt.abort(), SIGN_OUT_ATTEMPT_TIMEOUT_MS);
  const forward = () => attempt.abort();
  outer?.addEventListener("abort", forward, { once: true });
  try {
    await signOutRequest(attempt.signal);
    return "confirmed";
  } catch (cause) {
    if (outer?.aborted) return "aborted";
    // A timeout, a network error, a 5xx or a body without the sign-out proof are all unconfirmed.
    return cause instanceof AccountApiError && cause.status === 401 ? "confirmed" : "failed";
  } finally {
    window.clearTimeout(timer);
    outer?.removeEventListener("abort", forward);
  }
}

async function requestConfirmedSignOut(signal?: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < SIGN_OUT_ATTEMPTS; attempt += 1) {
    const outcome = await attemptSignOut(signal);
    if (outcome === "confirmed") return true;
    if (outcome === "aborted") return false;
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
      // getSession throws on anything but the contract DTO, so a malformed 200 never clears the marker.
      const session = await getSession(signal);
      if (signal?.aborted) return;
      if (!session.authenticated) {
        // The literal {authenticated:false} proves there is nothing left to sign out; any marker is resolved.
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
  /**
   * Sign out with bounded attempts. The intent is recorded before the first
   * request and survives until the server proves the sign-out; on final
   * failure the honest unconfirmed state replaces any fake anonymous view.
   */
  const end = useCallback(async () => {
    generation.current += 1;
    const current = generation.current;
    writeSignOutMarker(true);
    setState({ phase: "signingOut" });
    const confirmed = await requestConfirmedSignOut();
    if (confirmed) writeSignOutMarker(false);
    if (generation.current !== current) return;
    setState(confirmed ? { phase: "anonymous" } : { phase: "signOutUnconfirmed", generation: current });
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
