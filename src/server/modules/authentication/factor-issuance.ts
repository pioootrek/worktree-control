import type { ProviderFactorLimits } from "./provider-contract";

interface Window { start: number; count: number }
/** Stale peers removed per call. A call therefore does a small, fixed amount of work. */
const PRUNE_BATCH = 8;

/**
 * Admission for generated options before any account is known. It runs before
 * the queue and any native allocation. Fixed windows live only in this process,
 * so a restart forgets them: the durable bound is the row capacity in
 * `AccountProtection`, checked again inside the borrow. A peer refused here
 * spends no global budget, and a full map refuses new peers rather than evicting
 * a live window.
 */
export class IssuanceWindow {
  readonly #peers = new Map<string, Window>();
  #global: Window = { start: 0, count: 0 };

  constructor(private readonly limits: ProviderFactorLimits["issuance"]) {}

  get peers(): number { return this.#peers.size; }

  admit(peer: string, now: number): boolean {
    const { perPeer, global, peers } = this.limits;
    let pruned = 0;
    // Insertion order is window order, because a renewed window is reinserted.
    for (const [key, window] of this.#peers) {
      if (pruned >= PRUNE_BATCH || now - window.start < perPeer.windowMs) break;
      this.#peers.delete(key); pruned++;
    }
    let current = this.#peers.get(peer);
    if (current && now - current.start >= perPeer.windowMs) { this.#peers.delete(peer); current = undefined; }
    if (current ? current.count >= perPeer.attempts : this.#peers.size >= peers) return false;
    if (now - this.#global.start >= global.windowMs) this.#global = { start: now, count: 0 };
    if (this.#global.count >= global.attempts) return false;
    this.#global.count++;
    if (current) current.count++;
    else this.#peers.set(peer, { start: now, count: 1 });
    return true;
  }
}
