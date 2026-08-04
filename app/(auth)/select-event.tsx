import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { EligibleEvent, useScanner } from '@/context/ScannerContext';
import { ApiClient } from '@/services/ApiClient';
import { DatabaseService } from '@/services/DatabaseService';
import { DeviceControlService } from '@/services/DeviceControlService';
import { OfflineSessionService } from '@/services/OfflineSessionService';
import { SyncService } from '@/services/SyncService';

export type EventAvailability =
  | 'eligible'
  | 'inactive'
  | 'upcoming'
  | 'ended'
  | 'role-ineligible'
  | 'invalid-time';

export function classifyEligibleEvent(
  event: EligibleEvent,
  now = Date.now()
): EventAvailability {
  if (!event.is_active) return 'inactive';
  if (event.role_in_event !== 'scanner' && event.role_in_event !== 'admin') {
    return 'role-ineligible';
  }
  const startsAt = event.starts_at == null ? null : Date.parse(event.starts_at);
  const endsAt = event.ends_at == null ? null : Date.parse(event.ends_at);
  if ((startsAt != null && !Number.isFinite(startsAt)) || (endsAt != null && !Number.isFinite(endsAt))) {
    return 'invalid-time';
  }
  if (startsAt != null && now < startsAt) return 'upcoming';
  if (endsAt != null && now > endsAt) return 'ended';
  return 'eligible';
}

export function eligibleEvents(events: EligibleEvent[], now = Date.now()): EligibleEvent[] {
  return events.filter((event) => classifyEligibleEvent(event, now) === 'eligible');
}

const availabilityLabel: Record<EventAvailability, string> = {
  eligible: 'Available now',
  inactive: 'Inactive',
  upcoming: 'Not started',
  ended: 'Ended',
  'role-ineligible': 'Scanner role required',
  'invalid-time': 'Invalid event schedule',
};

export default function SelectEventScreen() {
  const {
    pendingAccountLogin,
    setPendingAccountLogin,
    setScannerUser,
  } = useScanner();
  const [selectingId, setSelectingId] = useState<number | null>(null);
  const available = useMemo(
    () => eligibleEvents(pendingAccountLogin?.events ?? []),
    [pendingAccountLogin]
  );

  const cancel = async () => {
    if (selectingId != null) return;
    setPendingAccountLogin(null);
    await ApiClient.clearTokens();
    router.replace('/(auth)/login');
  };

  const select = async (event: EligibleEvent) => {
    if (!pendingAccountLogin || selectingId != null || classifyEligibleEvent(event) !== 'eligible') return;
    setSelectingId(event.id);
    try {
      await SyncService.selectEvent(event);
      const installationId = await SyncService.getDeviceId();
      await ApiClient.registerDeviceSession(
        event.id,
        installationId,
        Platform.OS === 'ios' ? 'ios' : 'android'
      );
      await DeviceControlService.clearRevocationMarker();
      const result = await SyncService.syncNow();
      if (!result.success || !result.eventId) {
        throw new Error(result.error ?? 'Initial event sync failed');
      }
      const areas = await DatabaseService.getSyncedAreas(result.eventId);
      await DatabaseService.upsertSyncedScannerUser(
        pendingAccountLogin.user,
        areas.map((area) => area.name)
      );
      const scanner = await DatabaseService.getScannerUserByEmail(pendingAccountLogin.user.email);
      if (!scanner) throw new Error('Scanner account was not available after event sync');
      await DatabaseService.storeScannerCredentials(scanner.email, pendingAccountLogin.rememberMe);
      await OfflineSessionService.create(scanner.id, scanner.email, result.eventId, 'production', {
        deviceId: installationId,
        tokenBinding: ApiClient.getTokenBinding(),
      });
      setPendingAccountLogin(null);
      setScannerUser(scanner);
      router.replace('/(main)/scanner');
    } catch (error) {
      await Promise.allSettled([ApiClient.clearTokens(), SyncService.clearEventSelection()]);
      setPendingAccountLogin(null);
      Alert.alert(
        'Event selection failed',
        error instanceof Error ? error.message : 'Could not establish scanner authority.'
      );
      router.replace('/(auth)/login');
    } finally {
      setSelectingId(null);
    }
  };

  if (!pendingAccountLogin) {
    return (
      <View style={styles.center} accessibilityRole="alert">
        <Text style={styles.title}>Account login expired</Text>
        <Pressable style={styles.primaryButton} onPress={() => void cancel()} accessibilityRole="button">
          <Text style={styles.primaryButtonText}>Return to login</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">Choose scanner event</Text>
      <Text style={styles.subtitle}>
        Device authority is issued only after you confirm an available event.
      </Text>
      {pendingAccountLogin.events.map((event) => {
        const availability = classifyEligibleEvent(event);
        const selectable = availability === 'eligible' && selectingId == null;
        return (
          <Pressable
            key={event.id}
            accessibilityRole="button"
            accessibilityState={{ disabled: !selectable, busy: selectingId === event.id }}
            accessibilityLabel={`${event.name}, ${availabilityLabel[availability]}, role ${event.role_in_event}`}
            disabled={!selectable}
            onPress={() => void select(event)}
            style={[styles.eventCard, !selectable && styles.disabledCard]}
          >
            <View style={styles.eventCopy}>
              <Text style={styles.eventName}>{event.name}</Text>
              <Text style={styles.eventMeta}>{availabilityLabel[availability]} · {event.role_in_event}</Text>
            </View>
            {selectingId === event.id ? <ActivityIndicator color="#059669" /> : null}
          </Pressable>
        );
      })}
      {available.length === 0 ? (
        <Text style={styles.warning} accessibilityRole="alert">
          No currently available event has scanner authority for this account.
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: selectingId != null }}
        disabled={selectingId != null}
        style={styles.secondaryButton}
        onPress={() => void cancel()}
      >
        <Text style={styles.secondaryButtonText}>Cancel and clear account session</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, backgroundColor: '#f0fdf4' },
  center: { flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f0fdf4' },
  title: { color: '#065f46', fontSize: 24, fontWeight: '700', textAlign: 'center' },
  subtitle: { marginTop: 8, marginBottom: 20, color: '#4b5563', textAlign: 'center' },
  eventCard: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, padding: 16, borderRadius: 10, borderWidth: 1, borderColor: '#059669', backgroundColor: '#fff' },
  disabledCard: { borderColor: '#d1d5db', backgroundColor: '#f3f4f6', opacity: 0.75 },
  eventCopy: { flex: 1 },
  eventName: { color: '#111827', fontSize: 17, fontWeight: '700' },
  eventMeta: { marginTop: 4, color: '#4b5563', fontSize: 13, textTransform: 'capitalize' },
  warning: { marginTop: 8, color: '#991b1b', textAlign: 'center' },
  primaryButton: { marginTop: 20, borderRadius: 8, backgroundColor: '#059669', paddingHorizontal: 18, paddingVertical: 12 },
  primaryButtonText: { color: '#fff', fontWeight: '700' },
  secondaryButton: { marginTop: 16, padding: 14, alignItems: 'center' },
  secondaryButtonText: { color: '#065f46', fontWeight: '600', textAlign: 'center' },
});
