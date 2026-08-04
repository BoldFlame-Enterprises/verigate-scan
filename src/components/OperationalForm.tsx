import React from 'react';
import { Text } from 'react-native';
import * as Crypto from 'expo-crypto';

export const OPERATIONAL_FIELD_LIMITS = {
  email: 254,
  reason: 500,
  description: 2_000,
} as const;

export type OperationalFailureKind =
  | 'local-persistence'
  | 'server-rejection'
  | 'timeout'
  | 'unknown-outcome';

export class OperationalSubmissionError extends Error {
  constructor(readonly kind: OperationalFailureKind, message: string) {
    super(message);
    this.name = 'OperationalSubmissionError';
  }
}

export function normalizeOperationalText(
  value: string,
  input: { label: string; min: number; max: number; optional?: boolean }
): string | null {
  const normalized = value.trim();
  if (!normalized && input.optional) return null;
  if (normalized.length < input.min) throw new Error(`${input.label} is too short`);
  if (normalized.length > input.max) throw new Error(`${input.label} is too long`);
  return normalized;
}

export function normalizeOperationalEmail(value: string, optional = false): string | null {
  const email = normalizeOperationalText(value, {
    label: 'Email',
    min: 3,
    max: OPERATIONAL_FIELD_LIMITS.email,
    optional,
  });
  if (email == null) return null;
  const normalized = email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Email is invalid');
  }
  return normalized;
}

export function operationalFailureMessage(error: unknown): string {
  if (error instanceof OperationalSubmissionError) {
    if (error.kind === 'local-persistence') {
      return 'Local persistence failed. The action was not confirmed; retry uses the same operation ID.';
    }
    if (error.kind === 'server-rejection') return `The server rejected this action: ${error.message}`;
    if (error.kind === 'timeout') return 'The request timed out. Its outcome is unknown; retry uses the same operation ID.';
  }
  return 'The action outcome is unknown. Retry uses the same operation ID for safe reconciliation.';
}

export class StableOperationalSubmission {
  private operationId: string | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly createId: () => string = () => Crypto.randomUUID()) {}

  get currentOperationId(): string | null {
    return this.operationId;
  }

  submit(operation: (operationId: string) => Promise<void>): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const operationId = this.operationId ?? this.createId();
    this.operationId = operationId;
    const pending = operation(operationId)
      .then(() => {
        this.operationId = null;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = pending;
    return pending;
  }

  abandon(): boolean {
    if (this.inFlight) return false;
    this.operationId = null;
    return true;
  }
}

export function OperationalFormStatus({ message, busy }: { message: string; busy: boolean }) {
  return (
    <Text
      accessibilityLiveRegion="polite"
      accessibilityRole="text"
      accessibilityState={{ busy }}
      style={{ color: '#f9fafb', marginBottom: message ? 8 : 0 }}
    >
      {message}
    </Text>
  );
}
