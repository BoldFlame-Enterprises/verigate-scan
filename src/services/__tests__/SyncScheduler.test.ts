/* eslint-disable import/first */
jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));
jest.mock('../SyncService', () => ({
  SyncService: { syncNow: jest.fn() },
}));

import { ForegroundSyncScheduler } from '../SyncScheduler';

class FakeAppState {
  currentState: 'active' | 'background' = 'active';
  listener: ((state: 'active' | 'background') => void) | null = null;
  remove = jest.fn();

  addEventListener(_type: 'change', listener: (state: 'active' | 'background') => void) {
    this.listener = listener;
    return { remove: this.remove };
  }

  change(state: 'active' | 'background') {
    this.currentState = state;
    this.listener?.(state);
  }
}

const flushPromises = () => jest.advanceTimersByTimeAsync(0);

describe('ForegroundSyncScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs immediately, repeats every 10 seconds, and removes timers and listeners on stop', async () => {
    const synchronize = jest.fn(async () => ({ success: true }));
    const appState = new FakeAppState();
    const scheduler = new ForegroundSyncScheduler(synchronize, appState, () => 0);

    scheduler.start();
    expect(synchronize).toHaveBeenCalledTimes(1);
    await flushPromises();
    jest.advanceTimersByTime(9_999);
    expect(synchronize).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(synchronize).toHaveBeenCalledTimes(2);
    await flushPromises();

    scheduler.stop();
    jest.advanceTimersByTime(60_000);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(appState.remove).toHaveBeenCalledTimes(1);
  });

  it('pauses in the background and synchronizes immediately on foreground resume', async () => {
    const synchronize = jest.fn(async () => ({ success: true }));
    const appState = new FakeAppState();
    const scheduler = new ForegroundSyncScheduler(synchronize, appState, () => 0);

    scheduler.start();
    await flushPromises();
    appState.change('background');
    jest.advanceTimersByTime(60_000);
    expect(synchronize).toHaveBeenCalledTimes(1);

    appState.change('active');
    expect(synchronize).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('joins manual requests to an in-flight automatic run without overlap', async () => {
    let resolveSync!: (result: { success: boolean }) => void;
    const synchronize = jest.fn(() => new Promise<{ success: boolean }>((resolve) => {
      resolveSync = resolve;
    }));
    const scheduler = new ForegroundSyncScheduler(synchronize, new FakeAppState(), () => 0);
    const onSuccess = jest.fn();

    scheduler.start({ onSuccess });
    const firstManual = scheduler.syncNow();
    const secondManual = scheduler.syncNow();

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(firstManual).toBe(secondManual);
    resolveSync({ success: true });
    await firstManual;
    expect(onSuccess).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('keeps automatic failures silent and retries with bounded exponential backoff', async () => {
    const synchronize = jest.fn()
      .mockResolvedValueOnce({ success: false, error: 'offline' })
      .mockResolvedValueOnce({ success: false, error: 'offline' })
      .mockResolvedValueOnce({ success: true });
    const scheduler = new ForegroundSyncScheduler(synchronize, new FakeAppState(), () => 0);
    const onSuccess = jest.fn();

    scheduler.start({ onSuccess });
    await flushPromises();
    jest.advanceTimersByTime(10_000);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(19_999);
    expect(synchronize).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(synchronize).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('does not notify or schedule after stopping an in-flight run', async () => {
    let resolveSync!: (result: { success: boolean }) => void;
    const synchronize = jest.fn(() => new Promise<{ success: boolean }>((resolve) => {
      resolveSync = resolve;
    }));
    const scheduler = new ForegroundSyncScheduler(synchronize, new FakeAppState(), () => 0);
    const onSuccess = jest.fn();

    scheduler.start({ onSuccess });
    scheduler.stop();
    resolveSync({ success: true });
    await flushPromises();
    jest.advanceTimersByTime(60_000);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(synchronize).toHaveBeenCalledTimes(1);
  });
});
