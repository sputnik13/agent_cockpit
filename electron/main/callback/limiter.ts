/**
 * Token bucket for the per-project callback burst limit (requirement 10): the
 * bucket holds `capacity` tokens and refills continuously at `perSecond`, so a
 * burst of `capacity` requests is served and the steady rate is `perSecond`.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  /** Take one token if available. */
  tryTake(): boolean {
    const t = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (Math.max(0, t - this.last) / 1000) * this.perSecond,
    );
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
