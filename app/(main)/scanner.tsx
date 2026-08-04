import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  Dimensions,
  AppState,
  Modal,
  TextInput,
  Switch,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import { useScanner } from '../../src/context/ScannerContext';
import { DatabaseService, EventAuthority } from '../../src/services/DatabaseService';
import { SyncResult, SyncService } from '../../src/services/SyncService';
import { SyncScheduler } from '../../src/services/SyncScheduler';
import { NotificationService } from '../../src/services/NotificationService';
import { AudioFeedbackService } from '../../src/services/AudioFeedbackService';
import { ApiClient } from '../../src/services/ApiClient';
import { OfflineSessionService } from '../../src/services/OfflineSessionService';
import { DeviceControlService } from '../../src/services/DeviceControlService';
import {
  durableDecisionAfterLocalFailure,
  evaluateManualAssignment,
  evaluateRecordingAuthority,
  EventRecordingAuthority,
  RecordingAuthorityInput,
  recordingFreshness,
} from '../../src/services/RecordingAuthorityService';
import { DEMO_MODE } from '../../src/config';

const { width } = Dimensions.get('window');

type Modal_ = 'none' | 'manual' | 'override' | 'incident' | 'area';

export default function ScannerScreen() {
  const {
    scannerUser,
    setScannerUser,
    lastScanResult,
    setLastScanResult,
    selectedArea,
    selectedAreaEventId,
    setSelectedAreaForEvent,
    clearSelectedArea,
  } = useScanner();
  const [isScanning, setIsScanning] = useState(true);
  const [scanCount, setScanCount] = useState(0);
  const [permission, requestPermission] = useCameraPermissions();
  const [activeModal, setActiveModal] = useState<Modal_>('none');
  const [availableAreas, setAvailableAreas] = useState<{ id: number; name: string }[]>([]);
  const [eventId, setEventId] = useState<number | null>(null);
  const [eventName, setEventName] = useState<string | null>(null);
  const [eventAuthority, setEventAuthority] = useState<EventAuthority | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const [authorityNow, setAuthorityNow] = useState(Date.now());
  const [localAuditDegraded, setLocalAuditDegraded] = useState(false);
  const mountedRef = useRef(true);
  const syncedStateRefreshRef = useRef<(result?: SyncResult, promptForArea?: boolean) => Promise<void>>(async () => undefined);
  const authenticatedScannerId = scannerUser?.id;

  const isSecurityRole = scannerUser?.role === 'security' || scannerUser?.role === 'admin';

  useEffect(() => {
    AudioFeedbackService.init().catch((err) => console.warn('Audio feedback init failed:', err));
    NotificationService.init().catch((err) => console.warn('Notification init failed:', err));
    return () => {
      AudioFeedbackService.teardown();
    };
  }, []);

  const refreshSyncedState = useCallback(async (result?: SyncResult, promptForArea = false) => {
    const session = await OfflineSessionService.getMetadata(scannerUser?.email);
    const id = result?.eventId ?? (await SyncService.getCurrentEventId()) ?? session?.eventId ?? null;
    const name = result?.eventName ?? await SyncService.getCurrentEventName();
    const syncedAt = await SyncService.getLastSyncAt();
    const areas = id != null ? await DatabaseService.getSyncedAreas(id) : [];
    const areaNames = areas.length > 0 ? areas.map((area) => area.name) : scannerUser?.allowed_areas ?? [];
    const hasBackendWideAreaAccess = ApiClient.isAuthenticated()
      && (scannerUser?.role === 'scanner' || scannerUser?.role === 'admin');
    const visibleAreas = hasBackendWideAreaAccess
      ? areaNames
      : areaNames.filter((areaName) => !scannerUser || scannerUser.allowed_areas.includes(areaName));

    if (!mountedRef.current) return;
    setEventId(id);
    setEventName(name);
    setLastSyncAt(syncedAt ?? (result?.success ? Date.now() : null));
    const visibleRecords = areas.length > 0
      ? areas.filter((area) => visibleAreas.includes(area.name))
      : DEMO_MODE
        ? visibleAreas.map((area, index) => ({ id: index + 1, name: area }))
        : [];
    const storedAuthority = id != null ? await DatabaseService.getEventAuthority(id) : null;
    const resolvedAuthority = storedAuthority ?? (
      DEMO_MODE && id != null
        ? {
            id,
            name: name ?? `Event ${id}`,
            is_active: true,
            starts_at: null,
            ends_at: null,
            snapshot_at: new Date().toISOString(),
          }
        : null
    );
    setEventAuthority(resolvedAuthority);
    setAvailableAreas(visibleRecords);
    const areaIsCurrent = id != null && selectedAreaEventId === id &&
      !!selectedArea && visibleRecords.some((area) => area.name === selectedArea);
    if (!areaIsCurrent && selectedArea) clearSelectedArea();
    if (promptForArea && !areaIsCurrent && visibleRecords.length > 0) setActiveModal('area');
    if (result?.success) {
      setLocalAuditDegraded(false);
      await NotificationService.scheduleStaleWarning();
    }
  }, [clearSelectedArea, scannerUser, selectedArea, selectedAreaEventId]);

  useEffect(() => {
    const timer = setInterval(() => setAuthorityNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  syncedStateRefreshRef.current = refreshSyncedState;

  useEffect(() => {
    mountedRef.current = true;
    void syncedStateRefreshRef.current(undefined, true);
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const handleRevocation = async () => {
      setIsScanning(false);
      clearSelectedArea();
      setScannerUser(null);
      router.replace('/(auth)/login');
    };
    const unsubscribe = DeviceControlService.subscribe(() => handleRevocation());
    const appState = AppState.addEventListener('change', (state) => {
      setAppState(state);
      if (state === 'active') void DeviceControlService.checkConnectedState();
    });
    void DeviceControlService.checkConnectedState();
    return () => {
      unsubscribe();
      appState.remove();
    };
  }, [clearSelectedArea, setScannerUser]);

  const selectedAreaRecord = eventId != null && selectedAreaEventId === eventId
    ? availableAreas.find((area) => area.name === selectedArea) ?? null
    : null;
  const baseAuthorityInput = useMemo<RecordingAuthorityInput>(() => ({
    databaseReady: true,
    appState,
    blockingModal: false,
    operationInFlight: false,
    deviceSession: ApiClient.hasDeviceSession(),
    revoked: scannerUser == null,
    event: eventAuthority as EventRecordingAuthority | null,
    selectedArea: selectedAreaRecord,
    lastSyncAt,
    now: authorityNow,
    demoMode: DEMO_MODE,
    auditHealthy: !localAuditDegraded,
  }), [appState, authorityNow, eventAuthority, lastSyncAt, localAuditDegraded, scannerUser, selectedAreaRecord]);
  const recordingAuthority = evaluateRecordingAuthority({
    ...baseAuthorityInput,
    blockingModal: activeModal !== 'none',
    operationInFlight: !isScanning,
  });

  useEffect(() => {
    if (!authenticatedScannerId || !ApiClient.isAuthenticated()) return;
    SyncScheduler.start({
      onSuccess: (result) => syncedStateRefreshRef.current(result),
      onDeviceControl: (reason) => DeviceControlService.revoke(reason),
    });
    return () => SyncScheduler.stop();
  }, [authenticatedScannerId]);

  const handleSyncNow = useCallback(async () => {
    setIsSyncing(true);
    try {
      const result = await SyncScheduler.syncNow();
      if (!mountedRef.current) return;
      if (result.deviceControlReason) {
        await DeviceControlService.revoke(result.deviceControlReason);
        return;
      }
      if (result.success) {
        Alert.alert('Synced', `${result.eventName}: ${result.userCount} users, ${result.areaCount} areas, ${result.uploadedScans} scans uploaded.`);
      } else {
        Alert.alert('Sync failed', result.error ?? 'Unknown error (working offline)');
      }
    } finally {
      if (mountedRef.current) setIsSyncing(false);
    }
  }, []);

  const handleQRCodeScanned = useCallback(async ({ data }: { data: string }) => {
    if (!isScanning || !scannerUser) return;
    if (!recordingAuthority.allowed || eventId == null || !selectedAreaRecord) {
      Alert.alert(
        'Scanning unavailable',
        recordingAuthority.allowed
          ? 'Select a current event area before scanning.'
          : recordingAuthority.message
      );
      return;
    }

    const scanArea = selectedAreaRecord.name;

    setIsScanning(false);
    let durableServerDecision: { success: boolean; message: string; userName?: string } | null = null;

    try {
      const deviceScanId = Crypto.randomUUID();
      const scannedAt = new Date().toISOString();
      const [areas, scannerInstallationId, trust] = await Promise.all([
        DatabaseService.getSyncedAreas(eventId),
        SyncService.getDeviceId(),
        DatabaseService.getQrTrustMaterial(eventId),
      ]);
      const areaId = areas.find((area) => area.name === scanArea)?.id;
      if (!areaId) throw new Error('Selected area is not in the synchronized event snapshot');

      const local = await DatabaseService.verifyQRCode(data, scanArea, eventId);
      let verification = local;
      let decisionSource: 'offline-current' | 'offline-stale' | 'server' =
        local.trust_freshness === 'stale' || local.trust_freshness === 'expired'
          ? 'offline-stale'
          : 'offline-current';
      let fallbackAcknowledged = false;

      if (local.conclusive === false) {
        if (ApiClient.isAuthenticated()) {
          try {
            const server = await ApiClient.request<{
              access_granted: boolean;
              reason?: string;
              credential_id?: string;
              nonce_hash?: string;
              decision_code?: string;
              user?: { id: number; name: string };
              persistence?: {
                client_record_id: string;
                status: 'accepted' | 'duplicate' | 'rejected' | 'retryable_error';
              };
            }>('/scan/verify', {
              method: 'POST',
              body: {
                qr_code: data,
                area_id: areaId,
                event_id: eventId,
                device_scan_id: deviceScanId,
                device_info: { app: 'scan' },
                local_evidence: {
                  trust_generation: trust?.generation ?? null,
                  trust_freshness: local.trust_freshness ?? null,
                  user_snapshot_at: lastSyncAt
                    ? new Date(lastSyncAt).toISOString()
                    : null,
                },
              },
            });
            verification = {
              success: server.access_granted,
              reason: server.reason,
              code: server.decision_code,
              conclusive: true,
              credential_id: server.credential_id,
              nonce_hash: server.nonce_hash,
              trust_freshness: local.trust_freshness,
              user: server.user
                ? {
                  id: server.user.id,
                  name: server.user.name,
                  email: '',
                  phone: '',
                  event_id: eventId,
                  assignments: [],
                  access_level: '',
                  allowed_areas: [],
                  is_active: true,
                }
                : undefined,
            };
            decisionSource = 'server';
            fallbackAcknowledged =
              server.persistence?.client_record_id === deviceScanId &&
              (server.persistence.status === 'accepted' ||
                server.persistence.status === 'duplicate');
            if (fallbackAcknowledged) {
              durableServerDecision = {
                success: verification.success,
                message: verification.success
                  ? `Access GRANTED for ${verification.user?.name ?? 'attendee'}`
                  : `Access DENIED: ${verification.reason ?? 'Denied by current server authority'}`,
                userName: verification.user?.name,
              };
            }
          } catch {
            verification = {
              ...local,
              success: false,
              reason: 'Current server authority is unavailable; access denied',
              code: 'fallback_unavailable',
              conclusive: true,
            };
          }
        } else {
          verification = {
            ...local,
            success: false,
            reason: 'Synchronization is required before this decision can be made',
            code: 'fallback_unavailable',
            conclusive: true,
          };
        }
      }

      await DatabaseService.logScan({
        event_id: eventId,
        user_id: verification.user?.id ?? null,
        user_name: verification.user?.name ?? null,
        area: scanArea,
        area_id: areaId,
        access_granted: verification.success,
        failure_reason: verification.success ? undefined : verification.reason,
        scanned_at: scannedAt,
        scanner_user: scannerUser.name,
        device_scan_id: deviceScanId,
        credential_id: verification.credential_id,
        nonce_hash: verification.nonce_hash,
        decision_code: verification.code,
        decision_source: decisionSource,
        trust_generation: trust?.generation ?? null,
        user_snapshot_at: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
        scanner_installation_id: scannerInstallationId,
      });
      setLocalAuditDegraded(false);
      if (fallbackAcknowledged) {
        await DatabaseService.markScanLogSyncedByDeviceId(deviceScanId);
      }

      if (verification.success) {
        AudioFeedbackService.playGranted();
      } else {
        AudioFeedbackService.playDenied();
      }

      setLastScanResult({
        success: verification.success,
        message: verification.success
          ? `Access GRANTED for ${verification.user?.name}`
          : `Access DENIED: ${verification.reason}`,
        userName: verification.user?.name,
        timestamp: new Date()
      });

      setScanCount(prev => prev + 1);

      setTimeout(() => {
        setLastScanResult(null);
        setIsScanning(true);
      }, 2000);

    } catch (error) {
      console.error('QR verification failed:', error);
      if (durableServerDecision) {
        const preserved = durableDecisionAfterLocalFailure(durableServerDecision, error);
        setLocalAuditDegraded(true);
        setIsScanning(true);
        setLastScanResult({
          success: preserved.success,
          message: preserved.message,
          userName: preserved.userName,
          timestamp: new Date(),
        });
        if (preserved.success) AudioFeedbackService.playGranted();
        else AudioFeedbackService.playDenied();
        return;
      }
      AudioFeedbackService.playDenied();
      setLastScanResult({
        success: false,
        message: 'QR verification failed',
        timestamp: new Date()
      });

      setTimeout(() => {
        setLastScanResult(null);
        setIsScanning(true);
      }, 2000);
    }
  }, [eventId, isScanning, lastSyncAt, recordingAuthority, scannerUser, selectedAreaRecord, setLastScanResult]);

  const handleLogout = () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            SyncScheduler.stop();
            await NotificationService.cancelStaleWarning();
            await DatabaseService.clearScannerCredentials();
            await OfflineSessionService.clear();
            await ApiClient.logout();
            clearSelectedArea();
            setScannerUser(null);
            router.replace('/(auth)/login');
          },
        },
      ]
    );
  };

  const viewScanLogs = async () => {
    try {
      const logs = await DatabaseService.getScanLogs(10);
      const logText = logs.map(log =>
        `${log.user_name} - ${log.area} - ${log.access_granted ? 'GRANTED' : 'DENIED'} - ${new Date(log.scanned_at).toLocaleTimeString()}`
      ).join('\n');

      Alert.alert('Recent Scans', logText || 'No scans yet');
    } catch (error) {
      console.error('Error getting scan logs:', error);
      Alert.alert('Error', 'Failed to load scan logs');
    }
  };

  if (!permission) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionTitle}>Loading Camera Permission...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionTitle}>Camera Permission Required</Text>
        <Text style={styles.permissionText}>
          VeriGate Scan needs camera access to scan QR codes for access control.
        </Text>
        <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.cameraContainer}>
        <CameraView
          style={styles.camera}
          facing="back"
          onBarcodeScanned={isScanning && recordingAuthority.allowed ? handleQRCodeScanned : undefined}
          barcodeScannerSettings={{
            barcodeTypes: ['qr'],
          }}
        />

        <View style={styles.overlay}>
          <View style={styles.scanArea} />
          <Text style={styles.scanInstructions}>
            {recordingAuthority.allowed ? 'Point camera at QR code' : recordingAuthority.message}
          </Text>
        </View>

        {lastScanResult && (
          <View style={[
            styles.resultOverlay,
            { backgroundColor: lastScanResult.success ? '#059669' : '#dc2626' }
          ]}>
            <Text style={styles.resultText}>
              {lastScanResult.success ? '✅ ACCESS GRANTED' : '❌ ACCESS DENIED'}
            </Text>
            {lastScanResult.userName && (
              <Text style={styles.resultUserText}>
                {lastScanResult.userName}
              </Text>
            )}
            <Text style={styles.resultMessage}>
              {lastScanResult.message}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.controlsPanel}>
        <ScrollView style={styles.controlsContent}>
          <View style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Text style={styles.scannerName}>{scannerUser?.name || 'Unknown Scanner'}</Text>
              <View style={[styles.roleBadge, isSecurityRole && styles.roleBadgeSecurity]}>
                <Text style={styles.roleBadgeText}>{scannerUser?.role ?? 'unknown'}</Text>
              </View>
            </View>
            <Text style={styles.scanCount}>Scans this session: {scanCount}</Text>
            <Text style={styles.syncStatusText}>Event: {eventName ?? 'not selected'}</Text>
            <Text style={styles.syncStatusText}>
              Last sync: {lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : 'never'}
            </Text>
            <Text style={styles.syncStatusText} accessibilityLiveRegion="polite">
              Authority: {recordingFreshness(lastSyncAt, authorityNow).replace('-', ' ')}
            </Text>
          </View>

          <TouchableOpacity style={styles.areaCard} onPress={() => setActiveModal('area')}>
            <Text style={styles.areaLabel}>Scanning Area (tap to change):</Text>
            <Text style={styles.areaValue}>{selectedArea || scannerUser?.allowed_areas[0] || 'N/A'}</Text>
          </TouchableOpacity>

          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={[styles.actionButton, styles.scanButton]}
              onPress={() => setIsScanning(!isScanning)}
            >
              <Text style={styles.actionButtonText}>
                {isScanning ? 'Pause Scanning' : 'Resume Scanning'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionButton, styles.logsButton]}
              onPress={viewScanLogs}
            >
              <Text style={styles.actionButtonText}>View Logs</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={[styles.actionButton, styles.manualButton]}
              onPress={() => setActiveModal('manual')}
            >
              <Text style={styles.actionButtonText}>Manual Entry</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionButton, styles.incidentButton]}
              onPress={() => setActiveModal('incident')}
            >
              <Text style={styles.actionButtonText}>Report Incident</Text>
            </TouchableOpacity>
          </View>

          {isSecurityRole && (
            <TouchableOpacity
              style={[styles.actionButton, styles.overrideButton, styles.fullWidthButton]}
              onPress={() => setActiveModal('override')}
            >
              <Text style={styles.actionButtonText}>Emergency Override</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.actionButton, styles.syncButton, styles.fullWidthButton]}
            onPress={handleSyncNow}
            disabled={isSyncing}
          >
            <Text style={styles.actionButtonText}>{isSyncing ? 'Syncing...' : 'Sync with event'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, styles.logoutButton]}
            onPress={handleLogout}
          >
            <Text style={styles.actionButtonText}>Logout</Text>
          </TouchableOpacity>

          <View style={styles.instructionsCard}>
            <Text style={styles.instructionsTitle}>Instructions:</Text>
            <Text style={styles.instructionText}>• Hold device steady and point camera at QR code</Text>
            <Text style={styles.instructionText}>• Green result = Access granted</Text>
            <Text style={styles.instructionText}>• Red result = Access denied</Text>
            <Text style={styles.instructionText}>• All scans are automatically logged</Text>
          </View>
        </ScrollView>
      </View>

      <AreaPickerModal
        visible={activeModal === 'area'}
        areas={availableAreas.map((area) => area.name)}
        onSelect={(area) => {
          if (eventId != null) setSelectedAreaForEvent(eventId, area);
          setActiveModal('none');
        }}
        onClose={() => setActiveModal('none')}
      />

      <ManualEntryModal
        visible={activeModal === 'manual'}
        area={selectedArea ?? scannerUser?.allowed_areas[0] ?? ''}
        scannerName={scannerUser?.name ?? 'Unknown'}
        eventId={eventId}
        authorityInput={baseAuthorityInput}
        lastSyncAt={lastSyncAt}
        onClose={() => setActiveModal('none')}
        onResult={(result) => {
          setActiveModal('none');
          setLastScanResult(result);
          if (result.success) AudioFeedbackService.playGranted();
          else AudioFeedbackService.playDenied();
          setTimeout(() => setLastScanResult(null), 2500);
        }}
      />

      <OverrideModal
        visible={activeModal === 'override'}
        area={selectedArea ?? scannerUser?.allowed_areas[0] ?? ''}
        eventId={eventId}
        authorityInput={baseAuthorityInput}
        onClose={() => setActiveModal('none')}
      />

      <IncidentModal
        visible={activeModal === 'incident'}
        area={selectedArea ?? undefined}
        eventId={eventId}
        authorityInput={baseAuthorityInput}
        onClose={() => setActiveModal('none')}
      />
    </View>
  );
}

function AreaPickerModal({
  visible,
  areas,
  onSelect,
  onClose,
}: {
  visible: boolean;
  areas: string[];
  onSelect: (area: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={modalStyles.backdrop}>
        <View style={modalStyles.sheet}>
          <Text style={modalStyles.title}>Select scanning area</Text>
          {areas.length === 0 && <Text style={modalStyles.helperText}>No areas available - sync with the event first.</Text>}
          {areas.map((area) => (
            <TouchableOpacity key={area} style={modalStyles.optionRow} onPress={() => onSelect(area)}>
              <Text style={modalStyles.optionText}>{area}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={modalStyles.cancelButton} onPress={onClose}>
            <Text style={modalStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function ManualEntryModal({
  visible,
  area,
  scannerName,
  eventId,
  authorityInput,
  lastSyncAt,
  onClose,
  onResult,
}: {
  visible: boolean;
  area: string;
  scannerName: string;
  eventId: number | null;
  authorityInput: RecordingAuthorityInput;
  lastSyncAt: number | null;
  onClose: () => void;
  onResult: (result: { success: boolean; message: string; userName?: string; timestamp: Date }) => void;
}) {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [identityEvidenceConfirmed, setIdentityEvidenceConfirmed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (isSubmitting) return;
    if (!email.trim()) {
      Alert.alert('Error', 'Enter the attendee email printed on their badge/ID.');
      return;
    }

    if (reason.trim().length < 3) {
      Alert.alert('Reason required', 'Record why cryptographic QR verification cannot be used.');
      return;
    }
    if (!identityEvidenceConfirmed) {
      Alert.alert('Identity evidence required', 'Confirm that the attendee identity was checked using approved evidence.');
      return;
    }
    const authority = evaluateRecordingAuthority({
      ...authorityInput,
      blockingModal: false,
      operationInFlight: false,
    });
    if (!authority.allowed || eventId == null || !authorityInput.selectedArea) {
      onResult({
        success: false,
        message: authority.allowed ? 'No current event area is available' : authority.message,
        timestamp: new Date(),
      });
      return;
    }
    setIsSubmitting(true);
    try {
      const recordedAt = new Date();
      const user = await DatabaseService.getUserByEmail(email.toLowerCase().trim(), eventId);
      const decision = user
        ? evaluateManualAssignment(user, eventId, authorityInput.selectedArea.id, recordedAt.getTime())
        : {
            granted: false as const,
            code: 'manual_subject_missing',
            reason: 'No matching active attendee exists in the current event snapshot.',
          };
      const deviceScanId = Crypto.randomUUID();
      await DatabaseService.logScan({
        event_id: eventId,
        user_id: user?.id ?? null,
        user_name: user?.name ?? null,
        area,
        area_id: authorityInput.selectedArea.id,
        access_granted: decision.granted,
        failure_reason: decision.granted ? undefined : decision.reason,
        scanned_at: recordedAt.toISOString(),
        scanner_user: `${scannerName} (manual)`,
        device_scan_id: deviceScanId,
        decision_code: decision.code,
        decision_source: 'manual',
        manual_reason: reason.trim(),
        identity_evidence_confirmed: true,
        user_snapshot_at: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
        scanner_installation_id: await SyncService.getDeviceId(),
      });

      onResult({
        success: decision.granted,
        message: decision.granted
          ? `Manual entry: access GRANTED for ${user?.name}`
          : `Manual entry: access DENIED: ${decision.reason}`,
        userName: user?.name,
        timestamp: recordedAt,
      });
      setEmail('');
      setReason('');
      setIdentityEvidenceConfirmed(false);
    } catch (error) {
      onResult({
        success: false,
        message: error instanceof Error ? error.message : 'Manual decision could not be recorded',
        timestamp: new Date(),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={modalStyles.backdrop}>
        <View style={modalStyles.sheet}>
          <Text style={modalStyles.title}>Manual entry (damaged QR fallback)</Text>
          <Text style={modalStyles.helperText}>Area: {area || 'none selected'}</Text>
          <TextInput
            style={modalStyles.input}
            placeholder="Attendee email"
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <TextInput
            style={modalStyles.input}
            placeholder="Reason QR verification cannot be used"
            placeholderTextColor="#6b7280"
            value={reason}
            onChangeText={setReason}
          />
          <View style={modalStyles.switchRow}>
            <Text style={modalStyles.optionText}>Approved identity evidence checked</Text>
            <Switch value={identityEvidenceConfirmed} onValueChange={setIdentityEvidenceConfirmed} />
          </View>
          <TouchableOpacity style={modalStyles.submitButton} onPress={handleSubmit} disabled={isSubmitting}>
            <Text style={modalStyles.submitText}>{isSubmitting ? 'Recording...' : 'Verify and record'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={modalStyles.cancelButton} onPress={onClose}>
            <Text style={modalStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function OverrideModal({
  visible,
  area,
  eventId,
  authorityInput,
  onClose,
}: {
  visible: boolean;
  area: string;
  eventId: number | null;
  authorityInput: RecordingAuthorityInput;
  onClose: () => void;
}) {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [accessGranted, setAccessGranted] = useState(true);

  const handleSubmit = async () => {
    if (reason.trim().length < 3) {
      Alert.alert('Reason required', 'A mandatory reason (at least a few words) must be logged for every emergency override.');
      return;
    }
    const authority = evaluateRecordingAuthority({
      ...authorityInput,
      blockingModal: false,
      operationInFlight: false,
    });
    if (!authority.allowed) {
      Alert.alert('Override unavailable', authority.message);
      return;
    }
    if (!eventId) {
      Alert.alert('No event', 'Sync with an event before recording overrides.');
      return;
    }

    const areas = await DatabaseService.getSyncedAreas(eventId);
    const resolvedAreaId = areas.find((a) => a.name === area)?.id;

    await DatabaseService.queueOverride(eventId, area, accessGranted, reason.trim(), email.trim() || undefined, resolvedAreaId);

    Alert.alert('Override recorded', 'This will be uploaded and reviewed by an admin on the next sync.');
    setEmail('');
    setReason('');
    setAccessGranted(true);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={modalStyles.backdrop}>
        <View style={modalStyles.sheet}>
          <Text style={modalStyles.title}>Emergency / manual override</Text>
          <Text style={modalStyles.helperText}>Area: {area || 'none selected'}</Text>
          <TextInput
            style={modalStyles.input}
            placeholder="Attendee email (optional)"
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <View style={modalStyles.switchRow}>
            <Text style={modalStyles.optionText}>Grant access</Text>
            <Switch value={accessGranted} onValueChange={setAccessGranted} />
          </View>
          <TextInput
            style={[modalStyles.input, modalStyles.multiline]}
            placeholder="Reason (mandatory)"
            placeholderTextColor="#6b7280"
            value={reason}
            onChangeText={setReason}
            multiline
          />
          <TouchableOpacity style={modalStyles.submitButton} onPress={handleSubmit}>
            <Text style={modalStyles.submitText}>Record override</Text>
          </TouchableOpacity>
          <TouchableOpacity style={modalStyles.cancelButton} onPress={onClose}>
            <Text style={modalStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function IncidentModal({
  visible,
  area,
  eventId,
  authorityInput,
  onClose,
}: {
  visible: boolean;
  area?: string;
  eventId: number | null;
  authorityInput: RecordingAuthorityInput;
  onClose: () => void;
}) {
  const [category, setCategory] = useState('suspicious_activity');
  const [description, setDescription] = useState('');

  const handleSubmit = async () => {
    if (description.trim().length < 5) {
      Alert.alert('Description required', 'Please describe the incident in a bit more detail.');
      return;
    }
    const authority = evaluateRecordingAuthority({
      ...authorityInput,
      blockingModal: false,
      operationInFlight: false,
    });
    if (!authority.allowed) {
      Alert.alert('Incident recording unavailable', authority.message);
      return;
    }
    if (!eventId) {
      Alert.alert('No event', 'Sync with an event before reporting incidents.');
      return;
    }

    const areas = await DatabaseService.getSyncedAreas(eventId);
    const resolvedAreaId = area ? areas.find((a) => a.name === area)?.id : undefined;

    await DatabaseService.queueIncident(eventId, category, description.trim(), area, resolvedAreaId);
    Alert.alert('Incident reported', 'This will be uploaded and visible to admins on the next sync.');
    setDescription('');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={modalStyles.backdrop}>
        <View style={modalStyles.sheet}>
          <Text style={modalStyles.title}>Report an incident</Text>
          <View style={modalStyles.categoryRow}>
            {['suspicious_activity', 'technical_issue', 'other'].map((c) => (
              <TouchableOpacity
                key={c}
                style={[modalStyles.categoryChip, category === c && modalStyles.categoryChipActive]}
                onPress={() => setCategory(c)}
              >
                <Text style={modalStyles.categoryChipText}>{c.replace('_', ' ')}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            style={[modalStyles.input, modalStyles.multiline]}
            placeholder="What happened?"
            placeholderTextColor="#6b7280"
            value={description}
            onChangeText={setDescription}
            multiline
          />
          <TouchableOpacity style={modalStyles.submitButton} onPress={handleSubmit}>
            <Text style={modalStyles.submitText}>Submit report</Text>
          </TouchableOpacity>
          <TouchableOpacity style={modalStyles.cancelButton} onPress={onClose}>
            <Text style={modalStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#111827', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, maxHeight: '80%' },
  title: { color: '#f9fafb', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  helperText: { color: '#9ca3af', fontSize: 13, marginBottom: 12 },
  optionRow: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1f2937' },
  optionText: { color: '#f9fafb', fontSize: 16 },
  input: {
    borderWidth: 1,
    borderColor: '#374151',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#f9fafb',
    backgroundColor: '#1f2937',
    marginBottom: 12,
  },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  submitButton: { backgroundColor: '#059669', borderRadius: 8, padding: 14, alignItems: 'center', marginBottom: 8 },
  submitText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  cancelButton: { padding: 12, alignItems: 'center' },
  cancelText: { color: '#9ca3af', fontSize: 14 },
  categoryRow: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  categoryChip: { borderWidth: 1, borderColor: '#374151', borderRadius: 20, paddingVertical: 6, paddingHorizontal: 12 },
  categoryChipActive: { backgroundColor: '#059669', borderColor: '#059669' },
  categoryChipText: { color: '#f9fafb', fontSize: 12, textTransform: 'capitalize' },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  cameraContainer: {
    flex: 0.55,
    position: 'relative',
  },
  camera: {
    flex: 1,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanArea: {
    width: width * 0.7,
    height: width * 0.7,
    borderWidth: 2,
    borderColor: '#ffffff',
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  scanInstructions: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 20,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 10,
    borderRadius: 8,
  },
  resultOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.95,
  },
  resultText: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  resultUserText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  resultMessage: {
    color: '#ffffff',
    fontSize: 16,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  controlsPanel: {
    flex: 0.45,
    backgroundColor: '#0b0f19',
  },
  controlsContent: {
    padding: 16,
  },
  infoCard: {
    backgroundColor: '#111827',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  scannerName: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#f9fafb',
  },
  roleBadge: {
    backgroundColor: '#374151',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  roleBadgeSecurity: {
    backgroundColor: '#b45309',
  },
  roleBadgeText: {
    color: '#f9fafb',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  scanCount: {
    fontSize: 14,
    color: '#34d399',
    fontWeight: '600',
  },
  syncStatusText: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 4,
  },
  areaCard: {
    backgroundColor: '#111827',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  areaLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#9ca3af',
    marginBottom: 6,
  },
  areaValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#34d399',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  actionButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  fullWidthButton: {
    marginBottom: 12,
  },
  scanButton: {
    backgroundColor: '#059669',
  },
  logsButton: {
    backgroundColor: '#0ea5e9',
  },
  manualButton: {
    backgroundColor: '#6366f1',
  },
  incidentButton: {
    backgroundColor: '#d97706',
  },
  overrideButton: {
    backgroundColor: '#b91c1c',
  },
  syncButton: {
    backgroundColor: '#0284c7',
  },
  logoutButton: {
    backgroundColor: '#dc2626',
    marginBottom: 16,
  },
  actionButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  instructionsCard: {
    backgroundColor: '#111827',
    padding: 16,
    borderRadius: 12,
  },
  instructionsTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#93c5fd',
    marginBottom: 8,
  },
  instructionText: {
    fontSize: 14,
    color: '#93c5fd',
    marginBottom: 4,
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#0b0f19',
  },
  permissionTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#f9fafb',
    marginBottom: 16,
    textAlign: 'center',
  },
  permissionText: {
    fontSize: 16,
    color: '#9ca3af',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 24,
  },
  permissionButton: {
    backgroundColor: '#059669',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  permissionButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
