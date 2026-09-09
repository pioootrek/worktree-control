import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { expectUnavailable, startControllerFixture, type ControllerFixture } from "../support/controller-fixture";

let fixture: ControllerFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

describe("real multi-project controller", () => {
  it("switches one worktree without restarting the other projects and reuses capacity", async () => {
    fixture = await startControllerFixture();
    const [alpha, beta, gamma] = fixture.projects;
    expect((await fixture.request("/api/settings/capacity", { method: "POST", body: JSON.stringify({ enabled: true, limit: 2 }) })).ok).toBe(true);
    expect((await fixture.operate(alpha, "start")).ok).toBe(true);
    expect((await fixture.operate(beta, "start")).ok).toBe(true);
    const alphaMain = await fixture.identity(alpha);
    const betaBefore = await fixture.identity(beta);

    const blocked = await fixture.operate(gamma, "start");
    expect(blocked.status).toBe(409);
    await expectUnavailable(gamma);

    expect((await fixture.operate(alpha, "switch", alpha.worktrees[1])).ok).toBe(true);
    const alphaFeature = await fixture.identity(alpha);
    const betaAfter = await fixture.identity(beta);
    expect(alphaFeature).toMatchObject({ marker: "alpha:feature" });
    expect(alphaFeature.boot).not.toBe(alphaMain.boot);
    expect(betaAfter).toEqual(betaBefore);

    expect((await fixture.operate(alpha, "stop")).ok).toBe(true);
    await expectUnavailable(alpha);
    expect((await fixture.operate(gamma, "start")).ok).toBe(true);
    expect(await fixture.identity(gamma)).toMatchObject({ marker: "gamma:main" });
    expect(await fixture.identity(beta)).toEqual(betaBefore);
    expect((await fixture.dashboard()).capacity).toMatchObject({ used: 2, available: 0 });
  });

  it("admits exactly one concurrent start into the last slot", async () => {
    fixture = await startControllerFixture();
    const [alpha, beta] = fixture.projects;
    await fixture.request("/api/settings/capacity", { method: "POST", body: JSON.stringify({ enabled: true, limit: 1 }) });
    const results = await Promise.all([fixture.operate(alpha, "start"), fixture.operate(beta, "start")]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
    const running = results[0].ok ? alpha : beta;
    const stopped = results[0].ok ? beta : alpha;
    expect(await fixture.identity(running)).toMatchObject({ marker: `${running.name}:main` });
    await expectUnavailable(stopped);
    expect((await fixture.dashboard()).capacity).toMatchObject({ used: 1, available: 0 });
  });

  it("does not claim or terminate an unrelated port owner", async () => {
    fixture = await startControllerFixture();
    const gamma = fixture.projects[2];
    const unrelated = createServer((_, response) => response.end("unrelated"));
    await new Promise<void>((resolve, reject) => unrelated.listen(gamma.port, "127.0.0.1", resolve).once("error", reject));
    try {
      const response = await fixture.operate(gamma, "start");
      expect(response.status).toBe(400);
      expect(await (await fetch(`http://127.0.0.1:${gamma.port}`)).text()).toBe("unrelated");
      expect((await fixture.dashboard()).capacity).toMatchObject({ used: 0 });
    } finally {
      await new Promise<void>((resolve, reject) => unrelated.close((error) => error ? reject(error) : resolve()));
    }
  });
});
