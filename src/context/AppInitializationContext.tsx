import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { ApiClient } from '@/services/ApiClient';
import { DatabaseService } from '@/services/DatabaseService';
import { DeregistrationAuditService } from '@/services/DeregistrationAuditService';

const MAX_INITIALIZATION_ATTEMPTS = 3;

export type AppInitializationStatus =
  | 'initializing'
  | 'ready'
  | 'recoverable-error'
  | 'terminal-error';

export interface AppInitializationState {
  status: AppInitializationStatus;
  attempt: number;
  error: string | null;
}

export type AppInitializationAction =
  | { type: 'start' }
  | { type: 'success' }
  | { type: 'failure'; error: string };

export const initialAppInitializationState: AppInitializationState = {
  status: 'initializing',
  attempt: 0,
  error: null,
};

export function appInitializationReducer(
  state: AppInitializationState,
  action: AppInitializationAction
): AppInitializationState {
  if (action.type === 'start') {
    if (state.status === 'terminal-error') return state;
    return {
      status: 'initializing',
      attempt: state.attempt + 1,
      error: null,
    };
  }
  if (action.type === 'success') {
    return { ...state, status: 'ready', error: null };
  }
  return {
    status: state.attempt >= MAX_INITIALIZATION_ATTEMPTS
      ? 'terminal-error'
      : 'recoverable-error',
    attempt: state.attempt,
    error: action.error,
  };
}

interface AppInitializationContextValue extends AppInitializationState {
  retry(): Promise<void>;
}

const AppInitializationContext = createContext<AppInitializationContextValue | null>(null);

export function AppInitializationProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appInitializationReducer, initialAppInitializationState);
  const inFlight = useRef<Promise<void> | null>(null);
  const started = useRef(false);

  const initialize = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (state.status === 'terminal-error') return Promise.resolve();

    dispatch({ type: 'start' });
    const operation = Promise.all([
      DatabaseService.initDatabase(),
      ApiClient.loadTokens(),
    ]).then(() => {
      void DeregistrationAuditService.resume({
        maximumPasses: 4,
        foregroundBudgetMs: 1_500,
      }).catch(() => undefined);
      dispatch({ type: 'success' });
    }).catch((error: unknown) => {
      dispatch({
        type: 'failure',
        error: error instanceof Error ? error.message : 'Secure initialization failed',
      });
    }).finally(() => {
      inFlight.current = null;
    });
    inFlight.current = operation;
    return operation;
  }, [state.status]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void initialize();
  }, [initialize]);

  const value = useMemo(() => ({ ...state, retry: initialize }), [initialize, state]);
  return (
    <AppInitializationContext.Provider value={value}>
      {children}
    </AppInitializationContext.Provider>
  );
}

export function useAppInitialization(): AppInitializationContextValue {
  const context = useContext(AppInitializationContext);
  if (!context) {
    throw new Error('useAppInitialization must be used within AppInitializationProvider');
  }
  return context;
}
