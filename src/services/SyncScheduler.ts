import { AppState, AppStateStatus } from 'react-native';
import { SyncResult, SyncService } from './SyncService';

const BASE_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_JITTER_MS = 2_000;

interface AppStateSource {
  currentState: AppStateStatus;
  addEventListener: (
    type: 'change',
    listener: (state: AppStateStatus) => void,
  ) => { remove: () => void };
}

interface SchedulerCallbacks {
  onSuccess?: (result: SyncResult) => void | Promise<void>;
}

export class ForegroundSyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private subscription: { remove: () => void } | null = null;
  private inFlight: Promise<SyncResult> | null = null;
  private callbacks: SchedulerCallbacks = {};
  private activeState: AppStateStatus;
  private running = false;
  private lifecycle = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly synchronize: () => Promise<SyncResult> = () => SyncService.syncNow(),
    private readonly appState: AppStateSource = AppState,
    private readonly random: () => number = Math.random,
  ) {
    this.activeState = appState.currentState;
  }

  start(callbacks: SchedulerCallbacks = {}): void {
    this.stop();
    this.running = true;
    this.callbacks = callbacks;
    this.activeState = this.appState.currentState;
    const lifecycle = this.lifecycle;
    this.subscription = this.appState.addEventListener('change', (state) => {
      const wasActive = this.activeState === 'active';
      this.activeState = state;

      if (state !== 'active') {
        this.clearTimer();
      } else if (!wasActive) {
        this.clearTimer();
        void this.runCycle(lifecycle);
      }
    });

    if (this.activeState === 'active') {
      void this.runCycle(lifecycle);
    }
  }

  stop(): void {
    this.running = false;
    this.lifecycle += 1;
    this.clearTimer();
    this.subscription?.remove();
    this.subscription = null;
    this.callbacks = {};
    this.consecutiveFailures = 0;
  }

  syncNow(): Promise<SyncResult> {
    if (this.inFlight) return this.inFlight;

    const lifecycle = this.lifecycle;
    this.inFlight = this.synchronize()
      .then(async (result) => {
        this.consecutiveFailures = result.success ? 0 : this.consecutiveFailures + 1;
        if (result.success && this.running && lifecycle === this.lifecycle && this.activeState === 'active') {
          await Promise.resolve(this.callbacks.onSuccess?.(result)).catch(() => undefined);
        }
        return result;
      })
      .catch((error: unknown) => {
        this.consecutiveFailures += 1;
        return { success: false, error: error instanceof Error ? error.message : 'Sync failed' };
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async runCycle(lifecycle: number): Promise<void> {
    await this.syncNow();
    if (!this.running || lifecycle !== this.lifecycle || this.activeState !== 'active') return;
    this.scheduleNext(lifecycle);
  }

  private scheduleNext(lifecycle: number): void {
    this.clearTimer();
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    const backoff = Math.min(BASE_INTERVAL_MS * (2 ** exponent), MAX_BACKOFF_MS);
    const jitter = Math.floor(this.random() * (MAX_JITTER_MS + 1));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle(lifecycle);
    }, backoff + jitter);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export const SyncScheduler = new ForegroundSyncScheduler();
