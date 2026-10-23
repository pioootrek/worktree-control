import { randomUUID } from "node:crypto";

import type {
  AssignRemoteVerificationAttemptInput,
  RemoteVerificationActor,
  RemoteVerificationAttempt,
  RemoteVerificationAttemptPhase,
  RemoteVerificationAttemptStore,
  RemoteVerificationRequestPhase,
  RemoteVerificationStore,
  ReportRemoteVerificationAttemptInput,
} from "./contracts";

export type RemoteVerificationAttemptErrorCode =
  | "invalid_request"
  | "request_unavailable"
  | "worker_forbidden"
  | "attempt_conflict"
  | "attempt_not_found"
  | "invalid_transition"
  | "stale_attempt"
  | "invalid_evidence";

export class RemoteVerificationAttemptError extends Error {
  constructor(readonly code: RemoteVerificationAttemptErrorCode, message: string) {
    super(message);
    this.name = "RemoteVerificationAttemptError";
  }
}

const TRANSITIONS: Record<RemoteVerificationAttemptPhase, ReadonlySet<RemoteVerificationAttemptPhase>> = {
  assigned: new Set(["preparing", "cancel_requested", "uncertain"]),
  preparing: new Set(["running", "failed", "cancel_requested", "uncertain"]),
  running: new Set(["succeeded", "failed", "cancel_requested", "uncertain"]),
  cancel_requested: new Set(["cancelled", "failed", "uncertain"]),
  uncertain: new Set(["uncertain", "preparing", "running", "succeeded", "failed", "cancel_requested", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const TERMINAL_PHASES = new Set<RemoteVerificationAttemptPhase>(["succeeded", "failed", "cancelled"]);
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new RemoteVerificationAttemptError("invalid_request", `${label} ma nieprawidłowy format.`);
  return normalized;
}

function requestPhaseFor(phase: RemoteVerificationAttemptPhase): RemoteVerificationRequestPhase {
  if (phase === "cancelled") return "cancelled";
  if (phase === "succeeded" || phase === "failed") return "completed";
  return "assigned";
}

export class RemoteVerificationAttemptService {
  constructor(
    private readonly store: RemoteVerificationStore & RemoteVerificationAttemptStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
  ) {}

  assign(input: AssignRemoteVerificationAttemptInput, actor: RemoteVerificationActor): RemoteVerificationAttempt {
    const requestId = requiredText(input.requestId, "Identyfikator zlecenia");
    const workerId = requiredText(input.workerId, "Identyfikator workera");
    const request = this.store.getRemoteVerificationRequest(requestId);
    if (!request) throw new RemoteVerificationAttemptError("request_unavailable", "Zlecenie zdalnej weryfikacji nie istnieje.");
    if (request.workerId !== workerId) {
      throw new RemoteVerificationAttemptError("worker_forbidden", "Zlecenie jest przypisane do innego workera.");
    }

    const worker = this.store.getRemoteWorker(workerId);
    const workerPrincipal = worker ? this.store.getRemotePrincipal(worker.principalId) : null;
    const grant = this.store.getRemoteWorkerProjectGrant(workerId, request.projectId);
    if (
      !worker || worker.status !== "active" || worker.principalId !== actor.principalId
      || !workerPrincipal || workerPrincipal.kind !== "worker" || workerPrincipal.status !== "active"
    ) {
      throw new RemoteVerificationAttemptError("worker_forbidden", "Worker zdalnej weryfikacji nie jest aktywny.");
    }
    if (!grant || grant.revokedAt !== null || !grant.presetIds.includes(request.presetId)) {
      throw new RemoteVerificationAttemptError("worker_forbidden", "Worker nie może wykonać tego presetu dla projektu.");
    }

    const existing = this.store.findRemoteVerificationAttemptForRequest(requestId);
    if (existing) {
      if (existing.workerId !== workerId) {
        throw new RemoteVerificationAttemptError("attempt_conflict", "Zlecenie ma już attempt przypisany do innego workera.");
      }
      return existing;
    }
    if (request.phase !== "pending") {
      throw new RemoteVerificationAttemptError("request_unavailable", "Zlecenie nie oczekuje już na przypisanie.");
    }

    const acceptedAt = this.now();
    const persisted = this.store.createOrReplayRemoteVerificationAttempt({
      id: this.createId(),
      requestId,
      workerId,
      sequence: 1,
      phase: "assigned",
      version: 1,
      localRunId: null,
      executedCommitSha: null,
      failureKind: null,
      errorCode: null,
      acceptedAt,
      lastReportedAt: acceptedAt,
      finishedAt: null,
    });
    if (!persisted) {
      throw new RemoteVerificationAttemptError("request_unavailable", "Zlecenie nie może zostać przypisane.");
    }
    if (persisted.workerId !== workerId) {
      throw new RemoteVerificationAttemptError("attempt_conflict", "Zlecenie ma już attempt przypisany do innego workera.");
    }
    return persisted;
  }

  report(input: ReportRemoteVerificationAttemptInput, actor: RemoteVerificationActor): RemoteVerificationAttempt {
    const attemptId = requiredText(input.attemptId, "Identyfikator attemptu");
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new RemoteVerificationAttemptError("invalid_request", "Wersja attemptu ma nieprawidłowy format.");
    }
    const current = this.store.getRemoteVerificationAttempt(attemptId);
    if (!current) throw new RemoteVerificationAttemptError("attempt_not_found", "Attempt zdalnej weryfikacji nie istnieje.");
    const worker = this.store.getRemoteWorker(current.workerId);
    const principal = worker ? this.store.getRemotePrincipal(worker.principalId) : null;
    if (
      !worker || worker.status !== "active" || worker.principalId !== actor.principalId
      || !principal || principal.kind !== "worker" || principal.status !== "active"
    ) {
      throw new RemoteVerificationAttemptError("worker_forbidden", "Tylko przypisany worker może raportować ten attempt.");
    }
    if (current.version !== input.expectedVersion) {
      throw new RemoteVerificationAttemptError("stale_attempt", "Raport dotyczy nieaktualnej wersji attemptu.");
    }
    if (!TRANSITIONS[current.phase].has(input.phase)) {
      throw new RemoteVerificationAttemptError("invalid_transition", `Niedozwolone przejście attemptu: ${current.phase} -> ${input.phase}.`);
    }

    const request = this.store.getRemoteVerificationRequest(current.requestId);
    if (!request) throw new RemoteVerificationAttemptError("request_unavailable", "Zlecenie attemptu nie istnieje.");
    const localRunId = this.mergeImmutableEvidence("Identyfikator lokalnego runu", current.localRunId, input.localRunId);
    const executedCommitSha = this.mergeImmutableEvidence("Wykonany commit", current.executedCommitSha, input.executedCommitSha);
    if (executedCommitSha && !SHA_PATTERN.test(executedCommitSha)) {
      throw new RemoteVerificationAttemptError("invalid_evidence", "Wykonany commit musi być pełnym identyfikatorem SHA.");
    }
    if (executedCommitSha && executedCommitSha.toLowerCase() !== request.commitSha.toLowerCase()) {
      throw new RemoteVerificationAttemptError("invalid_evidence", "Wykonany commit nie odpowiada zleconemu commitowi.");
    }
    if ((input.phase === "running" || input.phase === "succeeded") && !localRunId) {
      throw new RemoteVerificationAttemptError("invalid_evidence", "Uruchomiony attempt wymaga identyfikatora lokalnego runu.");
    }
    if (input.phase === "succeeded" && executedCommitSha?.toLowerCase() !== request.commitSha.toLowerCase()) {
      throw new RemoteVerificationAttemptError("invalid_evidence", "Nie można potwierdzić sukcesu dla innego commita.");
    }
    if (input.phase === "failed" && (!input.failureKind || !input.errorCode?.trim())) {
      throw new RemoteVerificationAttemptError("invalid_evidence", "Nieudany attempt wymaga rodzaju błędu i kodu błędu.");
    }
    if (input.phase === "failed" && current.phase === "preparing" && input.failureKind !== "setup") {
      throw new RemoteVerificationAttemptError("invalid_evidence", "Błąd przygotowania musi zostać zapisany jako setup.");
    }
    if (input.phase === "failed" && current.phase === "running" && input.failureKind !== "execution") {
      throw new RemoteVerificationAttemptError("invalid_evidence", "Błąd uruchomionego testu musi zostać zapisany jako execution.");
    }
    if (input.phase === "failed" && input.failureKind === "execution" && (!localRunId || executedCommitSha?.toLowerCase() !== request.commitSha.toLowerCase())) {
      throw new RemoteVerificationAttemptError("invalid_evidence", "Błąd wykonania wymaga lokalnego runu dla zleconego commita.");
    }
    if (input.phase !== "failed" && (input.failureKind !== undefined || input.errorCode !== undefined)) {
      throw new RemoteVerificationAttemptError("invalid_evidence", "Dane błędu są dozwolone tylko dla nieudanego attemptu.");
    }

    const reportedAt = this.now();
    const updated: RemoteVerificationAttempt = {
      ...current,
      phase: input.phase,
      version: current.version + 1,
      localRunId,
      executedCommitSha,
      failureKind: input.phase === "failed" ? input.failureKind! : null,
      errorCode: input.phase === "failed" ? input.errorCode!.trim() : null,
      lastReportedAt: reportedAt,
      finishedAt: TERMINAL_PHASES.has(input.phase) ? reportedAt : null,
    };
    const saved = this.store.updateRemoteVerificationAttempt(updated, current.version, requestPhaseFor(updated.phase));
    if (!saved) throw new RemoteVerificationAttemptError("stale_attempt", "Nowszy raport attemptu został już zapisany.");
    return updated;
  }

  recoverInterruptedAttempts(): number {
    return this.store.markRemoteVerificationAttemptsUncertain(this.now());
  }

  private mergeImmutableEvidence(label: string, current: string | null, supplied: string | undefined): string | null {
    if (supplied === undefined) return current;
    const normalized = requiredText(supplied, label);
    if (current !== null && current !== normalized) {
      throw new RemoteVerificationAttemptError("invalid_evidence", `${label} nie może zostać zmieniony.`);
    }
    return normalized;
  }
}
