"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OwnerVaultSession, type VaultOperation } from "./owner-session";
import type { OwnerIdentity } from "./vault-client";
import { VAULT_IDLE_LOCK_MS } from "./vault-model";

export type { VaultOperation } from "./owner-session";
export type OwnerConnection = { status: "locked"; reason: "idle" | "manual" | null } | { status: "connected"; identity: Omit<OwnerIdentity, "skewMs"> };

/** React binding for the transient owner session: idle lock, and forgetting the key on unmount. */
export function useOwnerSession() {
  const [session] = useState(() => new OwnerVaultSession());
  const idleTimer = useRef<number | null>(null);
  const [connection, setConnection] = useState<OwnerConnection>({ status: "locked", reason: null });

  const stopTimer = useCallback(() => {
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = null;
  }, []);
  const lock = useCallback((reason: "idle" | "manual" | null = "manual") => {
    session.lock();
    stopTimer();
    setConnection({ status: "locked", reason });
  }, [session, stopTimer]);
  const touch = useCallback(() => {
    stopTimer();
    idleTimer.current = window.setTimeout(() => lock("idle"), VAULT_IDLE_LOCK_MS);
  }, [lock, stopTimer]);
  // Leaving the section, a dashboard sign-out (remount) or a page change forgets the key.
  useEffect(() => () => { session.lock(); stopTimer(); }, [session, stopTimer]);

  const connect = useCallback(async (token: string, keyText: string) => {
    stopTimer();
    setConnection({ status: "locked", reason: null });
    const identity = await session.connect(token, keyText);
    setConnection({ status: "connected", identity });
    touch();
  }, [session, stopTimer, touch]);
  const run = useCallback((projectId: string, intent: string, operation: VaultOperation) => {
    if (session.connected) touch();
    return session.run(projectId, intent, operation);
  }, [session, touch]);
  const ownerToken = useCallback(() => session.ownerToken(), [session]);
  return { connection, connect, lock, run, ownerToken };
}
