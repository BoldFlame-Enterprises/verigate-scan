import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import {
  DatabaseService,
  QueueDiagnostic,
  QueueHealth,
} from '@/services/DatabaseService';
import { DeregistrationAuditService } from '@/services/DeregistrationAuditService';
import { ApiClient } from '@/services/ApiClient';
import { SyncScheduler } from '@/services/SyncScheduler';
import { SyncService } from '@/services/SyncService';

const emptyHealth: QueueHealth = {
  pending: 0,
  retrying: 0,
  terminal: 0,
  quarantined: 0,
  acknowledged: 0,
  unresolved: 0,
};

export function queueHealthSummary(health: QueueHealth): string {
  return `${health.unresolved} unresolved: ${health.pending} pending, ${health.retrying} retrying, ${health.terminal} terminal, ${health.quarantined} quarantined`;
}

export default function QueueStatusScreen() {
  const [eventId, setEventId] = useState<number | null>(null);
  const [health, setHealth] = useState<QueueHealth>(emptyHealth);
  const [diagnostics, setDiagnostics] = useState<QueueDiagnostic[]>([]);
  const [status, setStatus] = useState('Loading local audit queues…');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const selectedEventId = await SyncService.getCurrentEventId();
      setEventId(selectedEventId);
      if (selectedEventId == null) {
        setHealth(emptyHealth);
        setDiagnostics([]);
        setStatus('No selected event is available on this installation.');
        return;
      }
      const [nextHealth, nextDiagnostics] = await Promise.all([
        DatabaseService.getQueueHealth(selectedEventId),
        DatabaseService.getQueueDiagnostics(selectedEventId),
      ]);
      setHealth(nextHealth);
      setDiagnostics(nextDiagnostics);
      setStatus(queueHealthSummary(nextHealth));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Queue status is unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (ApiClient.hasDeviceSession()) {
        const result = await SyncScheduler.syncNow();
        setStatus(result.success ? 'Connected queue retry completed.' : result.error ?? 'Connected retry did not complete.');
      } else {
        const result = await DeregistrationAuditService.resume();
        setStatus(`Deregistration audit: ${result.status}; ${result.unresolved} unresolved.`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Queue retry failed.');
    } finally {
      await load();
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">Local audit queue health</Text>
      <Text style={styles.subtitle}>Event {eventId ?? 'not selected'}</Text>
      <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>

      <View style={styles.grid}>
        {(['pending', 'retrying', 'terminal', 'quarantined', 'acknowledged'] as const).map((key) => (
          <View key={key} style={styles.metric}>
            <Text style={styles.metricValue}>{health[key]}</Text>
            <Text style={styles.metricLabel}>{key}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Unresolved redacted records</Text>
      {diagnostics.length === 0 ? <Text style={styles.empty}>No unresolved local records.</Text> : null}
      {diagnostics.map((record) => (
        <View key={`${record.kind}:${record.recordId}`} style={styles.record}>
          <Text style={styles.recordTitle}>{record.kind} · {record.state}</Text>
          <Text style={styles.recordMeta}>ID: {record.recordId}</Text>
          <Text style={styles.recordMeta}>Recorded: {record.occurredAt}</Text>
          {record.errorCode ? <Text style={styles.recordError}>Error: {record.errorCode}</Text> : null}
        </View>
      ))}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: loading }}
        disabled={loading}
        style={styles.primary}
        onPress={() => void retry()}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Retry eligible uploads</Text>}
      </Pressable>
      <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => router.back()}>
        <Text style={styles.secondaryText}>Back</Text>
      </Pressable>
      <Text style={styles.privacy}>
        Diagnostics omit QR payloads, tokens, secrets, attendee email, and other unnecessary personal data.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, backgroundColor: '#f0fdf4' },
  title: { color: '#065f46', fontSize: 24, fontWeight: '700', textAlign: 'center' },
  subtitle: { marginTop: 4, color: '#4b5563', textAlign: 'center' },
  status: { marginVertical: 16, color: '#111827', textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: { minWidth: '30%', flexGrow: 1, padding: 12, borderRadius: 8, backgroundColor: '#fff', alignItems: 'center' },
  metricValue: { color: '#065f46', fontSize: 22, fontWeight: '700' },
  metricLabel: { color: '#4b5563', textTransform: 'capitalize' },
  sectionTitle: { marginTop: 24, marginBottom: 8, color: '#111827', fontSize: 18, fontWeight: '700' },
  empty: { color: '#4b5563' },
  record: { marginBottom: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff' },
  recordTitle: { color: '#111827', fontWeight: '700', textTransform: 'capitalize' },
  recordMeta: { marginTop: 2, color: '#4b5563', fontSize: 12 },
  recordError: { marginTop: 2, color: '#991b1b', fontSize: 12 },
  primary: { marginTop: 20, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#059669' },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondary: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: '#065f46', fontWeight: '700' },
  privacy: { marginTop: 12, color: '#6b7280', fontSize: 12, textAlign: 'center' },
});
