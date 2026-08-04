import { DatabaseService } from './DatabaseService';
import { SyncService } from './SyncService';

interface StorageMaintenanceDependencies {
  currentEventId(): Promise<number | null>;
  maintain(input: { activeEventId: number | null; now: number }): Promise<void>;
  now(): number;
}

const defaultDependencies: StorageMaintenanceDependencies = {
  currentEventId: () => SyncService.getCurrentEventId(),
  maintain: (input) => DatabaseService.performStorageMaintenance(input),
  now: () => Date.now(),
};

export class StorageMaintenanceServiceClass {
  private inFlight: Promise<void> | null = null;

  constructor(private readonly dependencies: StorageMaintenanceDependencies = defaultDependencies) {}

  run(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const operation = this.dependencies.currentEventId()
      .then((activeEventId) => this.dependencies.maintain({
        activeEventId,
        now: this.dependencies.now(),
      }))
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = operation;
    return operation;
  }
}

export const StorageMaintenanceService = new StorageMaintenanceServiceClass();
