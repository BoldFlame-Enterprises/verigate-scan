/* eslint-disable import/first */
jest.mock('@/services/ApiClient', () => ({
  ApiClient: { loadTokens: jest.fn() },
}));
jest.mock('@/services/DatabaseService', () => ({
  DatabaseService: {
    initDatabase: jest.fn(),
    markRuntimeActive: jest.fn(),
    markCleanShutdown: jest.fn(),
  },
}));
jest.mock('@/services/DeregistrationAuditService', () => ({
  DeregistrationAuditService: { resume: jest.fn() },
}));
jest.mock('@/services/StorageMaintenanceService', () => ({
  StorageMaintenanceService: { run: jest.fn() },
}));

import {
  appInitializationReducer,
  initialAppInitializationState,
} from '../AppInitializationContext';

describe('application initialization state', () => {
  it('does not become route-ready until initialization succeeds', () => {
    const started = appInitializationReducer(initialAppInitializationState, { type: 'start' });
    expect(started).toMatchObject({ status: 'initializing', attempt: 1, error: null });

    const ready = appInitializationReducer(started, { type: 'success' });
    expect(ready).toMatchObject({ status: 'ready', attempt: 1, error: null });
  });

  it('allows two bounded retries before making repeated failure terminal', () => {
    let state = initialAppInitializationState;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      state = appInitializationReducer(state, { type: 'start' });
      state = appInitializationReducer(state, {
        type: 'failure',
        error: `failure-${attempt}`,
      });
    }

    expect(state).toEqual({
      status: 'terminal-error',
      attempt: 3,
      error: 'failure-3',
    });
    expect(appInitializationReducer(state, { type: 'start' })).toBe(state);
  });
});
