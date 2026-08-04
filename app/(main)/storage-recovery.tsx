import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { router } from 'expo-router';
import { DatabaseService, NativeIntegrityResult } from '@/services/DatabaseService';
import { DeviceControlService } from '@/services/DeviceControlService';
import {
  PROVISIONING_RESET_CONFIRMATION,
  ProvisioningResetService,
} from '@/services/ProvisioningResetService';
import { StorageMaintenanceService } from '@/services/StorageMaintenanceService';

export function integritySummary(result: NativeIntegrityResult): string {
  return result.cipherCheck === 'unsupported'
    ? 'SQLite quick check passed. A separate SQLCipher integrity result is unavailable on this build.'
    : 'SQLite and SQLCipher integrity checks passed.';
}

export default function StorageRecoveryScreen() {
  const [status, setStatus] = useState('No maintenance or integrity check has run on this screen.');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (operation: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus(await operation());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Storage operation failed.');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => run(async () => {
    const [deviceState, unresolvedRecords] = await Promise.all([
      DeviceControlService.getStoredControlState(),
      DatabaseService.getTotalUnresolvedRecordCount(),
    ]);
    await ProvisioningResetService.reset({ deviceState, unresolvedRecords, confirmation });
    router.replace('/(auth)/login');
    return 'Scanner storage reset completed.';
  });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">Storage integrity and recovery</Text>
      <Text style={styles.description}>
        Checks never delete records. Maintenance removes only bounded, expired data that is already acknowledged or terminal.
      </Text>
      <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        style={styles.primary}
        onPress={() => void run(async () => integritySummary(await DatabaseService.verifyNativeIntegrity()))}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Run integrity checks</Text>}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        style={styles.secondary}
        onPress={() => void run(async () => {
          await StorageMaintenanceService.run();
          return 'Bounded storage maintenance completed.';
        })}
      >
        <Text style={styles.secondaryText}>Run bounded maintenance</Text>
      </Pressable>

      <Text style={styles.warning}>
        Full reset is available only after administrator deregistration and after every audit record is resolved.
      </Text>
      <TextInput
        accessibilityLabel={`Type ${PROVISIONING_RESET_CONFIRMATION} to confirm full reset`}
        autoCapitalize="characters"
        editable={!busy}
        maxLength={PROVISIONING_RESET_CONFIRMATION.length}
        onChangeText={setConfirmation}
        placeholder={PROVISIONING_RESET_CONFIRMATION}
        style={styles.input}
        value={confirmation}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || confirmation !== PROVISIONING_RESET_CONFIRMATION }}
        disabled={busy || confirmation !== PROVISIONING_RESET_CONFIRMATION}
        style={[styles.danger, confirmation !== PROVISIONING_RESET_CONFIRMATION && styles.disabled]}
        onPress={() => void reset()}
      >
        <Text style={styles.dangerText}>Reset deregistered scanner</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, backgroundColor: '#f0fdf4' },
  title: { color: '#065f46', fontSize: 24, fontWeight: '700' },
  description: { marginTop: 8, color: '#374151', lineHeight: 20 },
  status: { marginVertical: 18, padding: 12, borderRadius: 8, backgroundColor: '#fff', color: '#111827' },
  primary: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#059669' },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondary: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: '#065f46', fontWeight: '700' },
  warning: { marginTop: 24, color: '#7f1d1d', lineHeight: 20 },
  input: { marginTop: 12, minHeight: 48, borderWidth: 1, borderColor: '#9ca3af', borderRadius: 8, paddingHorizontal: 12, backgroundColor: '#fff' },
  danger: { marginTop: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#b91c1c' },
  dangerText: { color: '#fff', fontWeight: '700' },
  disabled: { opacity: 0.45 },
});
