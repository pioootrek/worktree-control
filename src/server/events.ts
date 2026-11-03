import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { DashboardChangeEvent, DashboardChangeKind } from "@/shared/contracts";
import { admitNowOrLater, databaseAdmissionFailure, directAdmission, type DatabaseAdmission } from "./database-admission";

const MAX_PENDING_PROJECT_IDS = 128;

export interface ChangeInput {
  kinds?: DashboardChangeKind[];
  projectIds?: string[];
}

export class EventStream {
  private readonly clients = new Set<ServerResponse>();
  private readonly knowledgeReaders = new Map<ServerResponse, (projectId: string) => void>();
  private readonly knowledgePending = new Set<string>();
  private knowledgeTimer: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private readonly epoch = randomUUID();
  private revision = 0;
  private readonly pendingKinds = new Set<DashboardChangeKind>();
  private readonly pendingProjectIds = new Set<string>();
  private allProjects = false;
  private flushing = false;
  private closed = false;

  /** Knowledge delivery authorizes each subscriber with its own admission, never inherited from a publisher. */
  constructor(private readonly admission: DatabaseAdmission = directAdmission) {}

  add(response: ServerResponse, authorizeKnowledge?: (projectId: string) => void): void {
    if (authorizeKnowledge) this.knowledgeReaders.set(response, authorizeKnowledge);
    this.clients.add(response);
    response.write(`event: ready\ndata: ${JSON.stringify(this.version())}\n\n`);
    response.once("close", () => { this.clients.delete(response); this.knowledgeReaders.delete(response); });
  }

  publish = (input: ChangeInput = {}): void => {
    for (const kind of input.kinds ?? ["topology"]) this.pendingKinds.add(kind);
    for (const projectId of input.projectIds ?? []) {
      if (this.pendingProjectIds.size >= MAX_PENDING_PROJECT_IDS) {
        this.pendingProjectIds.clear();
        this.allProjects = true;
        break;
      }
      this.pendingProjectIds.add(projectId);
    }
    if (!input.projectIds?.length) this.allProjects = true;
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      const event: DashboardChangeEvent = {
        ...this.version(true),
        kinds: [...this.pendingKinds],
        projectIds: [...this.pendingProjectIds],
        allProjects: this.allProjects,
        at: new Date().toISOString(),
      };
      this.pendingKinds.clear();
      this.pendingProjectIds.clear();
      this.allProjects = false;
      const message = `event: changed\ndata: ${JSON.stringify(event)}\n\n`;
      for (const client of this.clients) {
        if (!client.write(message)) {
          this.clients.delete(client);
          client.end();
        }
      }
    }, 250);
    this.pending.unref();
  };

  publishKnowledge = (projectId: string): void => {
    // While a pass waits for admission, pending IDs stay bounded.
    if (this.knowledgePending.size >= MAX_PENDING_PROJECT_IDS * 4 && !this.knowledgePending.has(projectId)) return;
    this.knowledgePending.add(projectId);
    // Bound batches independently of runtime events. Never send unscoped IDs.
    if (this.knowledgePending.size >= MAX_PENDING_PROJECT_IDS) this.flushKnowledge();
    if (this.knowledgeTimer) return;
    this.knowledgeTimer = setTimeout(() => this.flushKnowledge(), 250);
    this.knowledgeTimer.unref();
  };

  private flushKnowledge(): void {
    if (this.knowledgeTimer) clearTimeout(this.knowledgeTimer);
    this.knowledgeTimer = null;
    if (this.flushing || this.closed || !this.knowledgePending.size) return;
    const batch = [...this.knowledgePending];
    this.knowledgePending.clear();
    this.flushing = true;
    const settled = () => {
      this.flushing = false;
      if (this.knowledgePending.size && !this.closed && !this.knowledgeTimer) {
        this.knowledgeTimer = setTimeout(() => this.flushKnowledge(), 250);
        this.knowledgeTimer.unref();
      }
    };
    // Filter and write synchronously in the same admitted phase. A queued
    // revocation must not commit between the access check and event delivery.
    admitNowOrLater(this.admission, () => {
      const deliveries: Array<[ServerResponse, string[]]> = [];
      for (const [client, authorize] of this.knowledgeReaders) {
        deliveries.push([client, batch.filter(id => {
          try { authorize(id); return true; } catch (error) {
            // Only an authorization denial filters a project; a database fault aborts the whole pass.
            if (databaseAdmissionFailure(error)) throw error;
            return false;
          }
        })]);
      }
      for (const [client, projectIds] of deliveries) {
        if (!this.knowledgeReaders.has(client)) continue;
        if (projectIds.length && !client.write(`event: knowledge-changed\ndata: ${JSON.stringify({ projectIds })}\n\n`)) {
          this.knowledgeReaders.delete(client);
          this.clients.delete(client);
          client.end();
        }
      }
    }, settled, () => {
      // Contention or shutdown: keep the batch (bounded) for the next attempt instead of dropping it.
      for (const id of batch) if (this.knowledgePending.size < MAX_PENDING_PROJECT_IDS) this.knowledgePending.add(id);
      settled();
    });
  }

  /** Ends current subscriptions, which reconnect under the current authentication policy. */
  disconnectAll(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.knowledgeReaders.clear();
  }

  close(): void {
    this.closed = true;
    if (this.knowledgeTimer) clearTimeout(this.knowledgeTimer);
    this.knowledgeReaders.clear();
    this.knowledgePending.clear();
    if (this.pending) clearTimeout(this.pending);
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.pendingKinds.clear();
    this.pendingProjectIds.clear();
  }

  version(increment = false): Pick<DashboardChangeEvent, "epoch" | "revision"> {
    if (increment) this.revision += 1;
    return { epoch: this.epoch, revision: this.revision };
  }
}
