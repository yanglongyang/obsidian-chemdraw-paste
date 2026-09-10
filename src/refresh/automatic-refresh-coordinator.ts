import { SerialRefreshQueue } from "./serial-refresh-queue";

export function shouldRefreshStalePreview(sourceMtime: number | null, previewMtime: number | null): boolean {
  return previewMtime === null || (sourceMtime !== null && sourceMtime > previewMtime);
}

interface RefreshState {
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  pending: boolean;
}

/** Debounces each source while serializing all renderer work globally. */
export class AutomaticRefreshCoordinator {
  private readonly states = new Map<string, RefreshState>();
  private readonly queue: SerialRefreshQueue;

  constructor(
    private readonly enabled: () => boolean,
    run: (sourcePath: string) => Promise<void>,
    private readonly defaultDelay = 750,
  ) {
    this.queue = new SerialRefreshQueue(async (sourcePath) => {
      const state = this.states.get(sourcePath);
      if (!state || !this.enabled()) return;
      state.running = true;
      try { await run(sourcePath); }
      finally {
        state.running = false;
        if (state.pending) {
          state.pending = false;
          this.schedule(sourcePath, 0);
        }
      }
    });
  }

  schedule(sourcePath: string, delay = this.defaultDelay): void {
    if (!this.enabled()) return;
    const state = this.states.get(sourcePath) ?? { running: false, pending: false };
    this.states.set(sourcePath, state);
    if (state.running) { state.pending = true; return; }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (state.running) { state.pending = true; return; }
      this.queue.enqueue(sourcePath);
    }, delay);
  }

  clear(): void {
    for (const state of this.states.values()) if (state.timer) clearTimeout(state.timer);
    this.states.clear();
    this.queue.clear();
  }
}
