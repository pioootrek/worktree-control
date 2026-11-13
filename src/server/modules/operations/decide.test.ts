import { describe, expect, it } from "vitest";
import { FRESH_LOGIN_WINDOW_MS } from "@/shared/contracts/operations";
import type { Actor, CoordinationSessionRef, CurrentAuthority, ProviderEvidence } from "./authentication-context";
import { decide, freshLoginState } from "./decide";
import { A, InMemoryGrants, P } from "./operations-fixture";
import {
  allOf, authenticated, claimHolder, installation, onProject, runOriginatingSession, workerAssignment,
  type OperationRequirement, type ResolvedResource, type ResourceRelation,
} from "./requirements";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const alice = A("alice");
const bot = A("bot");
const projectA = P("project-a");
const projectB = P("project-b");
const mySession: CoordinationSessionRef = { id: "s-1", generation: 1, credentialId: "c-1" };
const otherSession: CoordinationSessionRef = { id: "s-2", generation: 1, credentialId: "c-2" };

function authority(actor: Actor, extra: { evidence?: ProviderEvidence | null; session?: CoordinationSessionRef | null } = {}): CurrentAuthority {
  return { actor, mode: "better-auth", listener: "api", evidence: extra.evidence ?? null, coordinationSession: extra.session === undefined ? mySession : extra.session };
}
const human = (evidence: ProviderEvidence | null = { authenticatedAt: NOW - 1_000 }) => authority({ kind: "human", accountId: alice }, { evidence });
const agent = () => authority({ kind: "agent", accountId: bot });
const installationActor = () => authority({ kind: "installation" });
const operatorActor = () => authority({ kind: "operator", via: "unix" });

function resource(kind: ResolvedResource["ref"]["kind"], id: string, projectId = projectA, relation: ResourceRelation | null = null): ResolvedResource {
  return { ref: { kind, id }, projectId, version: 1, relation };
}
function grants() {
  return new InMemoryGrants().account(alice, "human").account(bot, "agent");
}
const check = (who: CurrentAuthority, requirement: OperationRequirement, resources: Record<string, ResolvedResource>, g = grants(), now = NOW) =>
  decide({ authority: who, requirement, resources, grants: g, now });
const verdict = (decision: ReturnType<typeof decide>) => decision.allowed ? "allowed" : `${decision.category}:${decision.reason}`;

describe("fresh login", () => {
  const freshOnly: OperationRequirement = { require: authenticated(), freshLogin: true };
  it.each<[string, number, string]>([
    ["at the moment of login", 0, "allowed"],
    ["one millisecond before the window closes", FRESH_LOGIN_WINDOW_MS - 1, "allowed"],
    ["exactly at the window", FRESH_LOGIN_WINDOW_MS, "login_stale:fresh_login_required"],
    ["after the window", FRESH_LOGIN_WINDOW_MS + 1, "login_stale:fresh_login_required"],
    ["with evidence from the future (negative skew)", -1, "login_stale:fresh_login_required"],
  ])("%s", (_name, age, result) => {
    expect(verdict(check(human({ authenticatedAt: NOW - age }), freshOnly, {}))).toBe(result);
  });

  it("denies missing or malformed evidence", () => {
    expect(verdict(check(human(null), freshOnly, {}))).toBe("login_stale:fresh_login_required");
    expect(verdict(check(human({ authenticatedAt: Number.NaN }), freshOnly, {}))).toBe("login_stale:fresh_login_required");
    expect(verdict(check(human(), freshOnly, {}, grants(), Number.NaN))).toBe("login_stale:fresh_login_required");
  });

  it("exempts full authority and is unavailable to agents", () => {
    expect(verdict(check(installationActor(), freshOnly, {}))).toBe("allowed");
    expect(verdict(check(operatorActor(), freshOnly, {}))).toBe("allowed");
    expect(verdict(check(agent(), freshOnly, {}))).toBe("forbidden:fresh_login_unavailable");
    expect(freshLoginState(installationActor(), NOW)).toBe("exempt");
    expect(freshLoginState(agent(), NOW)).toBe("unavailable");
  });

  it("does not let freshness replace a permission", () => {
    const requirement: OperationRequirement = { require: installation("accounts:manage"), agents: false, freshLogin: true };
    expect(verdict(check(human(), requirement, {}))).toBe("forbidden:permission_denied");
    const admin = grants().grant({ accountId: alice, role: "admin", scope: { kind: "installation" } });
    expect(verdict(check(human(), requirement, {}, admin))).toBe("allowed");
    expect(verdict(check(human({ authenticatedAt: NOW - FRESH_LOGIN_WINDOW_MS }), requirement, {}, admin))).toBe("login_stale:fresh_login_required");
  });
});

describe("decision", () => {
  it("lets an account with zero roles pass only `authenticated`", () => {
    expect(verdict(check(human(), { require: authenticated() }, {}))).toBe("allowed");
    expect(verdict(check(agent(), { require: authenticated() }, {}))).toBe("allowed");
    expect(verdict(check(human(), { require: onProject("project:read", "p") }, { p: resource("project", projectA) }))).toBe("not_found:resource_not_found");
  });

  it("returns not_found for invisible and forbidden for visible resources", () => {
    const g = grants().grant({ accountId: alice, role: "reader", scope: { kind: "project", projectId: projectA } });
    const requirement = { require: onProject("runtime:control", "p") };
    expect(verdict(check(human(), requirement, { p: resource("project", projectA) }, g))).toBe("forbidden:permission_denied");
    expect(verdict(check(human(), requirement, { p: resource("project", projectB, projectB) }, g))).toBe("not_found:resource_not_found");
    expect(verdict(check(human(), requirement, {}, g))).toBe("not_found:resource_not_found");
  });

  it("treats a project without project:read as invisible even with another role there", () => {
    const g = grants().grant({ accountId: bot, role: "executor", scope: { kind: "project", projectId: projectA } });
    expect(verdict(check(agent(), { require: onProject("tests:read", "p") }, { p: resource("test_run", "r", projectA) }, g))).toBe("not_found:resource_not_found");
    // Masking comes first: without project:read the project is invisible, so even a permission it holds there is not_found.
    expect(verdict(check(agent(), { require: onProject("worker:execute", "p") }, { p: resource("project", projectA) }, g))).toBe("not_found:resource_not_found");
    g.grant({ accountId: bot, role: "reader", scope: { kind: "project", projectId: projectA } });
    expect(verdict(check(agent(), { require: onProject("worker:execute", "p") }, { p: resource("project", projectA) }, g))).toBe("allowed");
  });

  it("refuses agents on human-only operations whatever their grants, and lets full authority through", () => {
    const requirement: OperationRequirement = { require: authenticated(), agents: false };
    expect(verdict(check(agent(), requirement, {}))).toBe("forbidden:human_only");
    expect(verdict(check(human(), requirement, {}))).toBe("allowed");
    expect(verdict(check(installationActor(), requirement, {}))).toBe("allowed");
  });

  it("requires a conjunction on two resources for a move between projects", () => {
    const move: OperationRequirement = { require: allOf(onProject("project:manage", "source"), onProject("project:manage", "destination")), agents: false };
    const resources = { source: resource("registration", "reg-1", projectA), destination: resource("project", projectB, projectB) };
    const onlySource = grants().grant({ accountId: alice, role: "maintainer", scope: { kind: "project", projectId: projectA } });
    expect(verdict(check(human(), move, resources, onlySource))).toBe("not_found:resource_not_found");
    onlySource.grant({ accountId: alice, role: "reader", scope: { kind: "project", projectId: projectB } });
    expect(verdict(check(human(), move, resources, onlySource))).toBe("forbidden:permission_denied");
    onlySource.grant({ accountId: alice, role: "maintainer", scope: { kind: "project", projectId: projectB } });
    expect(verdict(check(human(), move, resources, onlySource))).toBe("allowed");
    // Conjunction of two permissions on one resource, e.g. project export.
    const exportRequirement = { require: allOf(onProject("knowledge:export", "p"), onProject("attachments:read", "p")) };
    const reader = grants().grant({ accountId: alice, role: "reader", scope: { kind: "project", projectId: projectA } });
    expect(verdict(check(human(), exportRequirement, { p: resource("project", projectA) }, reader))).toBe("forbidden:permission_denied");
  });

  it("protects foreign claims even from full authority", () => {
    const claim = (holder: CoordinationSessionRef | null) => ({ c: resource("claim", "claim-1", projectA, { kind: "claim", holder }) });
    const requirement = { require: allOf(onProject("runtime:control", "c"), claimHolder("c")) };
    const operatorGrants = grants().grant({ accountId: alice, role: "operator", scope: { kind: "project", projectId: projectA } });
    expect(verdict(check(human(), requirement, claim(mySession), operatorGrants))).toBe("allowed");
    expect(verdict(check(human(), requirement, claim(otherSession), operatorGrants))).toBe("claim_held:claim_held_by_another_session");
    expect(verdict(check(human(), requirement, claim({ ...mySession, generation: 2 }), operatorGrants))).toBe("claim_held:claim_held_by_another_session");
    expect(verdict(check(human(), requirement, claim(null), operatorGrants))).toBe("conflict:claim_not_held");
    expect(verdict(check(installationActor(), requirement, claim(otherSession)))).toBe("claim_held:claim_held_by_another_session");
    expect(verdict(check(authority({ kind: "installation" }, { session: null }), requirement, claim(mySession)))).toBe("claim_held:claim_held_by_another_session");
    // Without project:read the predicate failure must not reveal the claim.
    expect(verdict(check(human(), { require: claimHolder("c") }, claim(otherSession)))).toBe("not_found:resource_not_found");
  });

  it("allows ordinary cancel only from the originating session", () => {
    const run = (origin: { sessionId: string; credentialId: string } | null) => ({ r: resource("test_run", "run-1", projectA, { kind: "test_run", origin }) });
    const requirement = { require: allOf(onProject("tests:run", "r"), runOriginatingSession("r")) };
    expect(verdict(check(installationActor(), requirement, run({ sessionId: mySession.id, credentialId: mySession.credentialId })))).toBe("allowed");
    expect(verdict(check(installationActor(), requirement, run({ sessionId: otherSession.id, credentialId: otherSession.credentialId })))).toBe("forbidden:not_originating_session");
    expect(verdict(check(installationActor(), requirement, run({ sessionId: mySession.id, credentialId: "other-credential" })))).toBe("forbidden:not_originating_session");
    expect(verdict(check(installationActor(), requirement, run(null)))).toBe("forbidden:not_originating_session");
  });

  it("binds worker reports to the exact assignment", () => {
    const attempt = (assignee: { accountId: typeof bot | null; sessionId: string } | null) =>
      ({ a: resource("worker_attempt", "attempt-1", projectA, { kind: "worker_attempt", assignee }) });
    const requirement = { require: allOf(onProject("worker:execute", "a"), workerAssignment("a")) };
    const executor = grants().grant({ accountId: bot, role: "executor", scope: { kind: "project", projectId: projectA } })
      .grant({ accountId: bot, role: "reader", scope: { kind: "project", projectId: projectA } });
    expect(verdict(check(agent(), requirement, attempt({ accountId: bot, sessionId: mySession.id }), executor))).toBe("allowed");
    expect(verdict(check(agent(), requirement, attempt({ accountId: A("other-bot"), sessionId: mySession.id }), executor))).toBe("forbidden:not_assigned");
    expect(verdict(check(agent(), requirement, attempt({ accountId: bot, sessionId: otherSession.id }), executor))).toBe("forbidden:not_assigned");
    expect(verdict(check(installationActor(), requirement, attempt({ accountId: null, sessionId: mySession.id })))).toBe("allowed");
    expect(verdict(check(installationActor(), requirement, attempt({ accountId: null, sessionId: otherSession.id })))).toBe("forbidden:not_assigned");
    // Without executor on the attempt's project the agent is refused before the predicate.
    const readerOnly = grants().grant({ accountId: bot, role: "reader", scope: { kind: "project", projectId: projectA } });
    expect(verdict(check(agent(), requirement, attempt({ accountId: bot, sessionId: mySession.id }), readerOnly))).toBe("forbidden:permission_denied");
  });

  it("refuses a predicate on a resource of the wrong kind", () => {
    expect(verdict(check(installationActor(), { require: claimHolder("p") }, { p: resource("project", projectA) }))).toBe("forbidden:relation_unavailable");
  });
});

describe("masking comes first", () => {
  const readerOnA = () => grants()
    .grant({ accountId: alice, role: "reader", scope: { kind: "project", projectId: projectA } })
    .grant({ accountId: bot, role: "reader", scope: { kind: "project", projectId: projectA } });
  const visible = { p: resource("registration", "reg-a", projectA) };
  const invisible = { p: resource("registration", "reg-b", projectB) };
  const missing = {};

  it("is identical for missing and invisible resources under agents: false", () => {
    const requirement: OperationRequirement = { require: onProject("runtime:control", "p"), agents: false };
    expect(verdict(check(agent(), requirement, invisible, readerOnA()))).toBe("not_found:resource_not_found");
    expect(verdict(check(agent(), requirement, missing, readerOnA()))).toBe("not_found:resource_not_found");
    expect(verdict(check(agent(), requirement, visible, readerOnA()))).toBe("forbidden:human_only");
  });

  it("is identical for missing and invisible resources under fresh login", () => {
    const requirement: OperationRequirement = { require: onProject("project:read", "p"), freshLogin: true };
    const stale = human({ authenticatedAt: NOW - FRESH_LOGIN_WINDOW_MS });
    expect(verdict(check(stale, requirement, invisible, readerOnA()))).toBe("not_found:resource_not_found");
    expect(verdict(check(stale, requirement, missing, readerOnA()))).toBe("not_found:resource_not_found");
    expect(verdict(check(stale, requirement, visible, readerOnA()))).toBe("login_stale:fresh_login_required");
    expect(verdict(check(agent(), requirement, invisible, readerOnA()))).toBe("not_found:resource_not_found");
    expect(verdict(check(agent(), requirement, visible, readerOnA()))).toBe("forbidden:fresh_login_unavailable");
  });

  it("does not depend on the order of conjunction branches", () => {
    const resources = { a: resource("registration", "reg-a", projectA), b: resource("registration", "reg-b", projectB) };
    const withoutB = { a: resources.a };
    for (const order of [["a", "b"], ["b", "a"]] as const) {
      const requirement: OperationRequirement = { require: allOf(onProject("runtime:control", order[0]), onProject("runtime:control", order[1])) };
      // a is visible but forbidden; b is invisible or missing: always the same not_found.
      expect(verdict(check(human(), requirement, resources, readerOnA()))).toBe("not_found:resource_not_found");
      expect(verdict(check(human(), requirement, withoutB, readerOnA()))).toBe("not_found:resource_not_found");
    }
    // A referenced resource that no branch names is masked too.
    expect(verdict(check(human(), { require: onProject("project:read", "a") }, resources, readerOnA()))).toBe("not_found:resource_not_found");
  });

  it("masks predicates the same way", () => {
    const claim = (projectId: typeof projectA) => ({ c: resource("claim", "claim-1", projectId, { kind: "claim", holder: otherSession }) });
    const requirement = { require: claimHolder("c") };
    expect(verdict(check(human(), requirement, claim(projectB), readerOnA()))).toBe("not_found:resource_not_found");
    expect(verdict(check(human(), requirement, {}, readerOnA()))).toBe("not_found:resource_not_found");
    expect(verdict(check(human(), requirement, claim(projectA), readerOnA()))).toBe("claim_held:claim_held_by_another_session");
  });
});
