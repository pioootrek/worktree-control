import type Database from "better-sqlite3";

import type { AuthenticationPolicy, AuthenticationStore } from "@/server/modules/authentication";

const MODES = new Set(["legacy", "open", "token", "better-auth"]);

function parsePolicy(value: string): AuthenticationPolicy {
  const parsed = JSON.parse(value) as Partial<AuthenticationPolicy>;
  const token = parsed.token;
  const validToken = token === null || (
    typeof token === "object" && token !== undefined
    && typeof token.id === "string" && typeof token.prefix === "string"
    && typeof token.verifierHash === "string" && typeof token.createdAt === "string"
  );
  if (!MODES.has(parsed.mode as string) || !validToken || !Number.isInteger(parsed.generation) || parsed.generation! < 0) {
    throw new Error("Zapisana polityka uwierzytelniania jest nieprawidłowa.");
  }
  return parsed as AuthenticationPolicy;
}

export class AuthenticationQueries implements AuthenticationStore {
  constructor(private readonly database: Database.Database) {}

  /** Fails closed: a missing or corrupted policy never degrades to a weaker mode. */
  getAuthenticationPolicy(): AuthenticationPolicy {
    const row = this.database.prepare("SELECT value_json FROM controller_settings WHERE key = 'authentication'")
      .get() as { value_json: string } | undefined;
    if (!row) throw new Error("Brak zapisanej polityki uwierzytelniania.");
    return parsePolicy(row.value_json);
  }

  saveAuthenticationPolicy(policy: AuthenticationPolicy, event: string, actor: string): void {
    this.database.transaction(() => {
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO controller_settings(key, value_json, updated_at)
        VALUES ('authentication', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(JSON.stringify(policy), now);
      this.database.prepare(`
        INSERT INTO controller_audit_events(event_type, actor, details_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(event, actor, JSON.stringify({
        mode: policy.mode,
        tokenPrefix: policy.token?.prefix ?? null,
        generation: policy.generation,
      }), now);
    }).immediate();
  }
}
