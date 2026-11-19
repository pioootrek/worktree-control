/** One aggregate owner for browser work and the future operations cookie path. */
export class AuthenticationRequestBudget {
  #active = 0;
  #stopped = false;
  constructor(readonly maxInFlight: number, readonly reservedCompletionSlots: number) {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64
      || !Number.isSafeInteger(reservedCompletionSlots) || reservedCompletionSlots < 0 || reservedCompletionSlots >= maxInFlight) {
      throw new Error("Invalid authentication capacity.");
    }
    Object.freeze(this);
  }

  get active(): number { return this.#active; }
  /** Synchronous fence. Already acquired slots keep their ownership. */
  stop(): void { this.#stopped = true; }

  acquire(kind: "initiating" | "completion"): AuthenticationRequestSlot | null {
    const reserved = kind === "initiating" ? this.reservedCompletionSlots : 0;
    if (this.#stopped || this.#active >= this.maxInFlight - reserved) return null;
    this.#active++;
    let responseFinished = false, workFinished = false, released = false;
    let settlement: Promise<void> | undefined;
    const release = () => {
      if (!released && responseFinished && workFinished) { released = true; this.#active--; }
    };
    return Object.freeze({
      responseFinished() { responseFinished = true; release(); },
      settle(work: Promise<unknown>) {
        if (settlement) throw new Error("Authentication request settlement must be called exactly once.");
        // A failed settlement is not proof of cleanup; retain the slot.
        return settlement = work.then(() => { workFinished = true; release(); });
      },
    });
  }
}

export interface AuthenticationRequestSlot {
  /** Call on response finish OR close, including an already closed response. */
  responseFinished(): void;
  /** Call exactly once, with all started work joined, including resolveRequest().settled, after the handler ends. */
  settle(work: Promise<unknown>): Promise<void>;
}
