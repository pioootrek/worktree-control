import { expectTypeOf, it } from "vitest";
import type { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { sqliteGrants, type AccountGrantsReader } from "@/server/modules/operations/adapters/sqlite-grants";
import { SqliteResourceResolver, type ProjectDirectoryReader } from "@/server/modules/operations/adapters/sqlite-resolver";

// Checked by the repository-wide typecheck. Kept outside src so the operations
// module's unchanged unmounted guard continues to forbid all source importers.
it("assigns the store's structural ports to the operations readers", () => {
  expectTypeOf<ReturnType<SqliteStateStore["accountGrantsReader"]>>().toMatchTypeOf<AccountGrantsReader>();
  expectTypeOf<ReturnType<SqliteStateStore["projectDirectoryReader"]>>().toMatchTypeOf<ProjectDirectoryReader>();
});

/** Test-only composition also checks assignment at the actual adapter calls. */
export function storeReaderAdapters(store: SqliteStateStore) {
  const grants: AccountGrantsReader = store.accountGrantsReader();
  const directory: ProjectDirectoryReader = store.projectDirectoryReader();
  return { grants: sqliteGrants(grants), resolver: new SqliteResourceResolver(directory) };
}
