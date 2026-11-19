import { expectTypeOf, it } from "vitest";
import type { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import type { AgentCredentialReader } from "./agent-token-verifier";
import type { InstallationPolicyReader } from "./installation-verifier";

it("assigns the store's structural ports to the credential readers", () => {
  expectTypeOf<ReturnType<SqliteStateStore["machineCredentialReader"]>>().toMatchTypeOf<AgentCredentialReader>();
  expectTypeOf<SqliteStateStore>().toMatchTypeOf<InstallationPolicyReader>();
});
