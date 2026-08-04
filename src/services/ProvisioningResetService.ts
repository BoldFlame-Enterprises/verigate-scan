import { ApiClient } from './ApiClient';
import { DatabaseService } from './DatabaseService';
import { DeviceIdentityService } from './DeviceIdentityService';
import { OfflineSessionService } from './OfflineSessionService';
import { SyncService } from './SyncService';

export const PROVISIONING_RESET_CONFIRMATION = 'RESET SCANNER';

export interface ProvisioningResetAssessment {
  deviceState: 'active' | 'deregistered' | 'blacklisted' | 'unknown';
  unresolvedRecords: number;
  confirmation: string;
}

export type ProvisioningResetDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export function evaluateProvisioningReset(
  assessment: ProvisioningResetAssessment
): ProvisioningResetDecision {
  if (assessment.deviceState !== 'deregistered') {
    return { allowed: false, reason: 'The installation must be deregistered by an administrator first.' };
  }
  if (!Number.isSafeInteger(assessment.unresolvedRecords) || assessment.unresolvedRecords !== 0) {
    return { allowed: false, reason: 'Resolve or quarantine every audit record before reprovisioning.' };
  }
  if (assessment.confirmation !== PROVISIONING_RESET_CONFIRMATION) {
    return { allowed: false, reason: `Type ${PROVISIONING_RESET_CONFIRMATION} exactly to continue.` };
  }
  return { allowed: true };
}

async function performProvisioningReset(): Promise<void> {
  await Promise.allSettled([
    ApiClient.clearTokens(),
    OfflineSessionService.clear(),
    DatabaseService.clearScannerCredentials(),
  ]);
  await SyncService.clearEventSelection();
  await DatabaseService.resetForReprovisioning();
  await DeviceIdentityService.resetInstallationId();
}

export class ProvisioningResetServiceClass {
  private inFlight: Promise<void> | null = null;

  constructor(private readonly resetOperation: () => Promise<void> = performProvisioningReset) {}

  reset(assessment: ProvisioningResetAssessment): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const decision = evaluateProvisioningReset(assessment);
    if (!decision.allowed) return Promise.reject(new Error(decision.reason));

    const operation = this.resetOperation().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }
}

export const ProvisioningResetService = new ProvisioningResetServiceClass();
