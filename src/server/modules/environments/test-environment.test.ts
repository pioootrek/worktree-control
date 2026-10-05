import type { Project, TestEnvironmentProfile, Worktree } from "@/shared/contracts";
import { describe, expect, it } from "vitest";
import { resolveTestEnvironment, systemEnvironment } from "./test-environment";

function worktreeOf(path: string): Worktree {
  return { path, head: "abcdef123456", shortHead: "abcdef1", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
}

function profile(overrides: Partial<TestEnvironmentProfile> = {}): TestEnvironmentProfile {
  return {
    name: "unit",
    policy: { mode: "clean", serverProfile: null },
    environment: {},
    nodeEnv: "test",
    requiredVariables: [],
    ...overrides,
  };
}

describe("systemEnvironment", () => {
  it("keeps only allowlisted names and drops everything else", () => {
    expect(systemEnvironment({
      PATH: "/usr/bin", HOME: "/home/dev", LC_ALL: "C", TZ: "UTC",
      PLAYWRIGHT_E2E: "1", AWS_SECRET_ACCESS_KEY: "secret", NODE_OPTIONS: "--inspect", SSH_AUTH_SOCK: "/tmp/agent",
      UNDEFINED_ENTRY: undefined,
    })).toEqual({ PATH: "/usr/bin", HOME: "/home/dev", LC_ALL: "C", TZ: "UTC" });
  });
});

describe("resolveTestEnvironment", () => {
  const project = {
    id: "project-1",
    port: 3400,
    tlsMode: "off",
    environmentProfiles: [{ name: "qa-shots", environment: { PLAYWRIGHT_E2E: "1" } }],
  } as unknown as Project;

  it("keeps a clean profile free of the selected server profile", () => {
    const resolved = resolveTestEnvironment({
      project, worktree: worktreeOf("/code/web"), profile: profile(), controllerEnvironment: { PATH: "/usr/bin", PLAYWRIGHT_E2E: "1" },
    });
    expect(resolved.environment.PLAYWRIGHT_E2E).toBeUndefined();
    expect(resolved.environment.NODE_ENV).toBe("test");
    expect(resolved.mode).toBe("clean");
    expect(resolved.inheritedServerProfile).toBeNull();
    expect(resolved.environment.WORKTREE_CONTROL_SERVER_URL).toBe("http://127.0.0.1:3400");
    // The pre-rename name stays available to existing project scripts.
    expect(resolved.environment.WORKTREE_SWITCHER_SERVER_URL).toBe("http://127.0.0.1:3400");
  });

  it("inherits a named server profile only when the policy says so", () => {
    const resolved = resolveTestEnvironment({
      project,
      worktree: worktreeOf("/code/web"),
      profile: profile({ name: "e2e", policy: { mode: "inherit-server-profile", serverProfile: "qa-shots" }, nodeEnv: null }),
      controllerEnvironment: { PATH: "/usr/bin" },
    });
    expect(resolved.environment.PLAYWRIGHT_E2E).toBe("1");
    expect(resolved.environment.NODE_ENV).toBeUndefined();
    expect(resolved.inheritedServerProfile).toBe("qa-shots");
  });

  it("rejects inheritance without an explicit server profile name", () => {
    expect(() => resolveTestEnvironment({
      project,
      worktree: worktreeOf("/code/web"),
      profile: profile({ policy: { mode: "inherit-server-profile", serverProfile: null } }),
      controllerEnvironment: {},
    })).toThrow("wskazywać profil po nazwie");
  });

  it("rejects an unknown server profile and missing required variables", () => {
    expect(() => resolveTestEnvironment({
      project,
      worktree: worktreeOf("/code/web"),
      profile: profile({ policy: { mode: "inherit-server-profile", serverProfile: "missing" } }),
      controllerEnvironment: {},
    })).toThrow("nie istnieje");
    expect(() => resolveTestEnvironment({
      project,
      worktree: worktreeOf("/code/web"),
      profile: profile({ requiredVariables: ["E2E_RESET_DB_CONFIRM"] }),
      controllerEnvironment: {},
    })).toThrow("E2E_RESET_DB_CONFIRM");
  });
});
