import { describe, expect, it } from "vitest";
import {
  installationPermissions, permissions, permissionScope, projectPermissions, roleDefinitions, roles,
  type Permission, type Role,
} from "@/shared/contracts/operations";
import { effectivePermissions } from "./grants";
import { A, InMemoryGrants, P } from "./operations-fixture";
import type { Actor } from "./authentication-context";

/**
 * Independently written expectation from contract v1 (Knowledge reply
 * 032aa386 amending efa8c8e5). Do not derive it from `roleDefinitions`.
 */
const READER = "project:read logs:read storage:read config:read tests:read knowledge:read attachments:read";
const OPERATOR = `${READER} claims:manage runtime:control tests:run profiles:select knowledge:write attachments:write`;
const MAINTAINER = `${OPERATOR} config:write storage:manage roles:manage knowledge:approve knowledge:export knowledge:import project:manage runtime:administer`;
const INSTALLATION = "accounts:manage projects:create capacity:read capacity:write settings:write backups:manage workers:manage diagnostics:read vault:recover";
const expected: Record<Role, { human: string; agent: string }> = {
  reader: { human: READER, agent: READER },
  operator: { human: OPERATOR, agent: OPERATOR },
  maintainer: { human: MAINTAINER, agent: "" },
  secrets: { human: "secrets:read secrets:write", agent: "secrets:read secrets:write" },
  executor: { human: "", agent: "worker:execute" },
  admin: { human: `${MAINTAINER} ${INSTALLATION}`, agent: "" },
};
const set = (value: string) => value.split(" ").filter(Boolean).sort();

const PROJECT = P("project-a");
/** Generated table: role x actor kind x permission, from the role data through grant evaluation. */
function generated(role: Role, kind: "human" | "agent"): string[] {
  const id = A(`${kind}-account`);
  const grants = new InMemoryGrants().account(id, kind);
  const definition = roleDefinitions[role];
  grants.grant({ accountId: id, role, scope: definition.scope === "installation" ? { kind: "installation" } : { kind: "project", projectId: PROJECT } });
  const actor: Actor = { kind, accountId: id };
  const effective = effectivePermissions(actor, grants);
  return permissions.filter((permission: Permission) => permissionScope(permission) === "installation"
    ? effective.installation.has(permission as never)
    : effective.project(PROJECT).has(permission as never)).sort();
}

describe("role table", () => {
  it("has exactly the closed permission list of contract v1", () => {
    expect(set([...projectPermissions].join(" "))).toEqual(set(`${MAINTAINER} secrets:read secrets:write worker:execute`));
    expect(set([...installationPermissions].join(" "))).toEqual(set(INSTALLATION));
    expect(new Set(permissions).size).toBe(permissions.length);
    expect([...roles]).toEqual(["reader", "operator", "maintainer", "secrets", "executor", "admin"]);
  });

  it.each<[Role, "human" | "agent"]>(roles.flatMap(role => (["human", "agent"] as const).map((kind): [Role, "human" | "agent"] => [role, kind])))("%s granted to a %s matches the expectation", (role, kind) => {
    expect(generated(role, kind)).toEqual(set(expected[role][kind]));
  });

  it("keeps capacity:read out of reader and every project role", () => {
    for (const role of roles.filter(role => roleDefinitions[role].scope === "project")) {
      expect(roleDefinitions[role].permissions).not.toContain("capacity:read");
    }
  });

  it("declares scope and recipient kind of every role", () => {
    expect(Object.fromEntries(roles.map(role => [role, `${roleDefinitions[role].scope}/${roleDefinitions[role].recipient}`]))).toEqual({
      reader: "project/any", operator: "project/any", maintainer: "project/human", secrets: "project/any", executor: "project/agent", admin: "installation/human",
    });
  });

  it("gives full authority every permission on every project without grants", () => {
    const grants = new InMemoryGrants();
    for (const actor of [{ kind: "installation" }, { kind: "operator", via: "unix" }, { kind: "operator", via: "offline" }] as Actor[]) {
      const effective = effectivePermissions(actor, grants);
      expect([...effective.project(P("any-project"))].sort()).toEqual([...projectPermissions].sort());
      expect([...effective.installation].sort()).toEqual([...installationPermissions].sort());
    }
  });
});
