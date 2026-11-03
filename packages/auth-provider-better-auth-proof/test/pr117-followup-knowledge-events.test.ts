import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStream } from "@/server/events";
import type { ProofFaultInjection } from "../src/index";
import { cleanupRoots } from "./fixture";
import { cleanupStrictRoots, closeStrictProof, pauseProvisioning, strictProof } from "./strict-fixture";

afterEach(() => { cleanupRoots(); cleanupStrictRoots(); });

describe("Knowledge delivery and queued revocation", () => {
  it.each(["grant", "credential"] as const)("delivers atomically before a queued %s revocation and denies subsequent events", async kind => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const events = new EventStream(f.store.admission);
    let hold: ReturnType<typeof pauseProvisioning> | undefined;
    try {
      const agent = await f.run(() => f.identity.createAgent(f.ownerActor));
      const issued = await f.run(() => f.identity.issueAgentToken({ principalId: agent.id, label: "event-reader" }, f.ownerActor));
      const actor = await f.run(() => f.identity.authenticateBearer(issued.token));
      const project = await f.run(() => {
        const project = f.identity.createKnowledgeProject({ name: "Private activity" }, f.ownerActor);
        f.identity.setKnowledgeGrant({ principalId: agent.id, projectId: project.id, permissions: ["knowledge:read"] }, f.ownerActor);
        return project;
      });
      const order: string[] = [], writes: string[] = [], admittedWrites: boolean[] = [];
      const client = {
        write: (message: string) => {
          if (message.startsWith("event: knowledge-changed")) {
            order.push("delivery"); writes.push(message);
            admittedWrites.push(f.store.admissionSnapshot().coreActive > 0);
          }
          return true;
        },
        once: () => client,
        end: () => undefined,
      } as unknown as ServerResponse;
      const authorize = vi.fn((id: string) => { f.identity.authorizeKnowledge(actor, id, "knowledge:read"); });
      events.add(client, authorize);
      hold = pauseProvisioning(f, faults, "commit");
      await hold.paused;
      events.publishKnowledge(project.id);
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(1));
      const revoked = f.run(() => {
        if (kind === "grant") f.identity.revokeKnowledgeGrant(agent.id, project.id, f.ownerActor);
        else f.identity.revokeCredential(issued.credential.id, f.ownerActor);
        order.push("revocation");
      });
      expect(f.store.admissionSnapshot().queuedCore).toBe(2);
      expect(writes).toEqual([]);
      hold.resume();
      expect(await hold.pending).toBe("committed");
      await revoked;
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      expect(order).toEqual(["delivery", "revocation"]);
      expect(admittedWrites).toEqual([true]);
      expect(JSON.parse(writes[0]!.split("data: ")[1]!)).toEqual({ projectIds: [project.id] });
      events.publishKnowledge(project.id);
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
      expect(writes).toHaveLength(1);
      expect(await f.run(() => {
        try { f.identity.authorizeKnowledge(actor, project.id, "knowledge:read"); return true; }
        catch { return false; }
      })).toBe(false);
    } finally {
      hold?.resume(); await hold?.pending;
      events.close(); await closeStrictProof(f);
    }
  });
});
