import { describe, it } from "vitest";
import { realResticAvailable } from "../support/restic-fixture";
import { remoteRebindAcceptance } from "../support/remote-rebind-acceptance";

describe.skipIf(!realResticAvailable)("real HTTPS repository rebind and durable history reconciliation", () => {
  it("preserves old pins, explicitly protects the new target and resumes >32 candidates across restart", async () => {
    console.log(JSON.stringify(await remoteRebindAcceptance()));
  }, 240000);
});
