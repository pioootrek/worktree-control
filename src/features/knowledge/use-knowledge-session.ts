"use client";

import { useEffect, useMemo } from "react";
import { ACCOUNT_SESSION, createAccountKnowledgeSession, type KnowledgeCredential } from "./knowledge-client";

/** Keep the original generation-bound callback with every read and mutation. */
export function useKnowledgeSession(token: string, onSessionLost?: () => void): KnowledgeCredential {
  const session = useMemo(() => token === ACCOUNT_SESSION && onSessionLost
    ? createAccountKnowledgeSession(onSessionLost) : null, [token, onSessionLost]);
  useEffect(() => session?.activate(), [session]);
  return session?.credential ?? token;
}
