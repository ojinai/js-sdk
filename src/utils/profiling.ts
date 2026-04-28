/** Track frames-per-second statistics for streaming workloads. */
export class FPSTracker {
  private lastUpdateTime: number;
  private totalFrames = 0;
  private totalFramesTime = 0;
  private partialFrames = 0;
  private lastPartialTime: number;
  private totalPartialTime = 0;

  readonly fpsHistory: number[] = [];
  readonly partialFpsHistory: number[] = [];

  constructor(public readonly id: string) {
    this.lastUpdateTime = performance.now() - 40;
    this.lastPartialTime = performance.now() - 40;
    this.start();
  }

  /** Reset timing baselines so the next `update()` measures from now. */
  start(): void {
    this.lastUpdateTime = performance.now() - 40;
    this.lastPartialTime = performance.now() - 40;
  }

  /** Stop tracking and reset all counters. */
  stop(): void {
    this.partialFpsHistory.length = 0;
    this.fpsHistory.length = 0;
    this.partialFrames = 0;
    this.totalPartialTime = 0;
    this.totalFrames = 0;
    this.totalFramesTime = 0;
    this.lastUpdateTime = 0;
  }

  /** Record newly produced frames and update timing. */
  update(numFrames: number): void {
    const now = performance.now();
    this.totalFrames += numFrames;
    this.totalFramesTime += now - this.lastUpdateTime;
    this.lastUpdateTime = now;
    this.partialFrames += numFrames;
    this.totalPartialTime += now - this.lastPartialTime;
    this.lastPartialTime = now;
  }

  /** Return the overall average FPS since the tracker started. */
  get averageFps(): number {
    if (this.totalFrames <= 1) return 0;
    return (this.totalFrames / this.totalFramesTime) * 1000;
  }

  /** Return the partial-window average FPS. */
  get partialAverageFps(): number {
    if (this.partialFrames <= 1) return 0;
    return (this.partialFrames / this.totalPartialTime) * 1000;
  }

  /** Reset the partial-window counters. */
  resetPartialAverage(): void {
    this.partialFrames = 0;
    this.totalPartialTime = 0;
    this.lastPartialTime = performance.now();
  }

  /** Snapshot current average and partial FPS into the history lists. */
  registerHistory(): void {
    this.fpsHistory.push(this.averageFps);
    this.partialFpsHistory.push(this.partialAverageFps);
  }

  /** Log current statistics. */
  log(): void {
    console.log(
      `${this.id} : FPS=${this.averageFps.toFixed(4)} PartialFPS: ${this.partialAverageFps.toFixed(4)} total_frames:${this.totalFrames} partial_frames:${this.partialFrames}`,
    );
    this.partialFrames = 0;
    this.totalPartialTime = 0;
    this.lastPartialTime = performance.now();
  }
}

// ─── Latency tracking ─────────────────────────────────────────────────────────

interface LatencyMeasure {
  id: string;
  startTime: number;
  endTime: number;
}

/** Tracker that collects latency measurements by ID. */
// biome-ignore lint/complexity/noStaticOnlyClass: public profiling API intentionally exposes static utility methods.
export class LatencyTracker {
  // Backing fields — undefined until first access so that importing this module
  // has no top-level side effects (required for Rollup preserveModules tree-shaking).
  private static _measures?: Map<string, LatencyMeasure[]>;
  private static _sampleCounts?: Map<string, number>;
  private static _sampleTotals?: Map<string, number>;
  private static _sampleMax?: Map<string, number>;
  private static _sampleMin?: Map<string, number>;

  private static get measures(): Map<string, LatencyMeasure[]> {
    if (LatencyTracker._measures === undefined) LatencyTracker._measures = new Map();
    return LatencyTracker._measures;
  }
  private static get sampleCounts(): Map<string, number> {
    if (LatencyTracker._sampleCounts === undefined) LatencyTracker._sampleCounts = new Map();
    return LatencyTracker._sampleCounts;
  }
  private static get sampleTotals(): Map<string, number> {
    if (LatencyTracker._sampleTotals === undefined) LatencyTracker._sampleTotals = new Map();
    return LatencyTracker._sampleTotals;
  }
  private static get sampleMax(): Map<string, number> {
    if (LatencyTracker._sampleMax === undefined) LatencyTracker._sampleMax = new Map();
    return LatencyTracker._sampleMax;
  }
  private static get sampleMin(): Map<string, number> {
    if (LatencyTracker._sampleMin === undefined) LatencyTracker._sampleMin = new Map();
    return LatencyTracker._sampleMin;
  }

  /** Clear accumulated latency state. */
  static reset(): void {
    // Null out backing fields rather than calling .clear() so that no Map is
    // allocated when reset() is called before the tracker has ever been used.
    LatencyTracker._measures = undefined;
    LatencyTracker._sampleCounts = undefined;
    LatencyTracker._sampleTotals = undefined;
    LatencyTracker._sampleMax = undefined;
    LatencyTracker._sampleMin = undefined;
  }

  private static recordSample(measureId: string, durationMs: number): void {
    const count = (LatencyTracker.sampleCounts.get(measureId) ?? 0) + 1;
    LatencyTracker.sampleCounts.set(measureId, count);
    LatencyTracker.sampleTotals.set(
      measureId,
      (LatencyTracker.sampleTotals.get(measureId) ?? 0) + durationMs,
    );
    LatencyTracker.sampleMax.set(
      measureId,
      Math.max(durationMs, LatencyTracker.sampleMax.get(measureId) ?? durationMs),
    );
    LatencyTracker.sampleMin.set(
      measureId,
      Math.min(durationMs, LatencyTracker.sampleMin.get(measureId) ?? durationMs),
    );
  }

  /** Begin a new latency measurement for the given ID. */
  static startLatencyMeasure(measureId: string): void {
    let existing = LatencyTracker.measures.get(measureId) ?? [];
    existing = existing.filter((m) => m.endTime === 0);

    if (existing.length > 0) {
      console.warn(`Latency measure ${measureId} is already running, discarding older one`);
      existing.pop();
    }

    existing.push({ id: measureId, startTime: performance.now(), endTime: 0 });
    LatencyTracker.measures.set(measureId, existing);
  }

  /** End the current latency measurement for the given ID. */
  static stopLatencyMeasure(measureId: string): void {
    const measures = LatencyTracker.measures.get(measureId);
    if (!measures || measures.length === 0) return;

    const last = measures[measures.length - 1];
    if (last.endTime === 0) {
      last.endTime = performance.now();
      const durationMs = last.endTime - last.startTime;
      LatencyTracker.recordSample(measureId, durationMs);
    }

    LatencyTracker.measures.set(
      measureId,
      measures.filter((m) => m.endTime === 0),
    );
  }

  /** Return the average latency (in ms) for the given measure ID. */
  static average(measureId: string): number {
    const count = LatencyTracker.sampleCounts.get(measureId) ?? 0;
    if (count === 0) return 0;
    return (LatencyTracker.sampleTotals.get(measureId) ?? 0) / count;
  }

  /** Return the maximum latency (in ms) for the given measure ID. */
  static max(measureId: string): number {
    return LatencyTracker.sampleMax.get(measureId) ?? 0;
  }

  /** Return the minimum latency (in ms) for the given measure ID. */
  static min(measureId: string): number {
    return LatencyTracker.sampleMin.get(measureId) ?? 0;
  }

  /** Log statistics for all measures. */
  static log(): void {
    for (const [measureId, count] of LatencyTracker.sampleCounts) {
      if (count === 0) continue;
      console.log(
        `Latency ${measureId} NumMeasures: ${count} Avg: ${(LatencyTracker.average(measureId)).toFixed(4)}ms Max: ${(LatencyTracker.max(measureId)).toFixed(4)}ms Min: ${(LatencyTracker.min(measureId)).toFixed(4)}ms`,
      );
    }
  }
}
