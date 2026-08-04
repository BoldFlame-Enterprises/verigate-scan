import {
  normalizeOperationalEmail,
  normalizeOperationalText,
  operationalFailureMessage,
  OperationalSubmissionError,
  StableOperationalSubmission,
} from '../OperationalForm';

describe('operational form contracts', () => {
  it('normalizes bounded fields and rejects whitespace, malformed email, and overlong input', () => {
    expect(normalizeOperationalEmail('  PERSON@Example.com ')).toBe('person@example.com');
    expect(normalizeOperationalEmail('   ', true)).toBeNull();
    expect(() => normalizeOperationalEmail('not-an-email')).toThrow(/invalid/i);
    expect(() => normalizeOperationalText('   ', { label: 'Reason', min: 3, max: 10 })).toThrow(/short/i);
    expect(() => normalizeOperationalText('12345678901', { label: 'Reason', min: 3, max: 10 })).toThrow(/long/i);
  });

  it('coalesces double submit and preserves the operation ID after ambiguous failure', async () => {
    let reject!: (error: Error) => void;
    const operation = jest.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const submission = new StableOperationalSubmission(() => 'stable-operation-id');

    const first = submission.submit(operation);
    const second = submission.submit(operation);
    expect(first).toBe(second);
    expect(operation).toHaveBeenCalledTimes(1);
    reject(new OperationalSubmissionError('timeout', 'deadline exceeded'));
    await expect(first).rejects.toThrow('deadline exceeded');
    expect(submission.currentOperationId).toBe('stable-operation-id');

    await submission.submit(async (id) => {
      expect(id).toBe('stable-operation-id');
    });
    expect(submission.currentOperationId).toBeNull();
  });

  it('distinguishes known failure classes from unknown outcomes', () => {
    expect(operationalFailureMessage(
      new OperationalSubmissionError('local-persistence', 'disk unavailable')
    )).toMatch(/Local persistence failed/i);
    expect(operationalFailureMessage(
      new OperationalSubmissionError('server-rejection', 'not allowed')
    )).toMatch(/server rejected/i);
    expect(operationalFailureMessage(new Error('connection lost'))).toMatch(/unknown/i);
  });
});
