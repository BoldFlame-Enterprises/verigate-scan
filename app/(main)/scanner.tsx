import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  Dimensions,
  Modal,
  TextInput,
  Switch,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useScanner } from '../../src/context/ScannerContext';
import { DatabaseService } from '../../src/services/DatabaseService';
import { SyncService } from '../../src/services/SyncService';
import { NotificationService } from '../../src/services/NotificationService';
import { AudioFeedbackService } from '../../src/services/AudioFeedbackService';

const { width } = Dimensions.get('window');

type Modal_ = 'none' | 'manual' | 'override' | 'incident' | 'area';

export default function ScannerScreen() {
  const { scannerUser, lastScanResult, setLastScanResult, selectedArea, setSelectedArea } = useScanner();
  const [isScanning, setIsScanning] = useState(true);
  const [scanCount, setScanCount] = useState(0);
  const [permission, requestPermission] = useCameraPermissions();
  const [activeModal, setActiveModal] = useState<Modal_>('none');
  const [availableAreas, setAvailableAreas] = useState<string[]>([]);
  const [eventId, setEventId] = useState<number | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const isSecurityRole = scannerUser?.role === 'security' || scannerUser?.role === 'admin';

  useEffect(() => {
    AudioFeedbackService.init().catch((err) => console.warn('Audio feedback init failed:', err));
    NotificationService.init().catch((err) => console.warn('Notification init failed:', err));
    return () => {
      AudioFeedbackService.teardown();
    };
  }, []);

  useEffect(() => {
    (async () => {
      const id = await SyncService.getCurrentEventId();
      setEventId(id);
      setLastSyncAt(await SyncService.getLastSyncAt());

      const areas = id ? await DatabaseService.getSyncedAreas(id) : [];
      const areaNames = areas.length > 0 ? areas.map((a) => a.name) : scannerUser?.allowed_areas ?? [];
      setAvailableAreas(areaNames.filter((name) => !scannerUser || scannerUser.allowed_areas.includes(name)));

      if (!selectedArea && areaNames.length > 0) {
        setActiveModal('area');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSyncNow = useCallback(async () => {
    setIsSyncing(true);
    const result = await SyncService.syncNow();
    setIsSyncing(false);

    if (result.success) {
      setLastSyncAt(Date.now());
      setEventId(result.eventId ?? null);
      await NotificationService.scheduleStaleWarning();
      Alert.alert('Synced', `${result.eventName}: ${result.userCount} users, ${result.areaCount} areas, ${result.uploadedScans} scans uploaded.`);
    } else {
      Alert.alert('Sync failed', result.error ?? 'Unknown error (working offline)');
    }
  }, []);

  const handleQRCodeScanned = useCallback(async ({ data }: { data: string }) => {
    if (!isScanning || !scannerUser) return;

    const scanArea = selectedArea ?? scannerUser.allowed_areas[0];
    if (!scanArea) {
      Alert.alert('Error', 'No scanning area selected.');
      return;
    }

    setIsScanning(false);

    try {
      const verification = await DatabaseService.verifyQRCode(data, scanArea);

      if (verification.user) {
        await DatabaseService.logScan({
          user_id: verification.user.id,
          user_name: verification.user.name,
          area: scanArea,
          access_granted: verification.success,
          failure_reason: verification.success ? undefined : verification.reason,
          scanned_at: new Date().toISOString(),
          scanner_user: scannerUser.name
        });
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
  }, [isScanning, scannerUser, selectedArea, setLastScanResult]);

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
            await DatabaseService.clearScannerCredentials();
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
          onBarcodeScanned={isScanning ? handleQRCodeScanned : undefined}
          barcodeScannerSettings={{
            barcodeTypes: ['qr'],
          }}
        />

        <View style={styles.overlay}>
          <View style={styles.scanArea} />
          <Text style={styles.scanInstructions}>
            Point camera at QR code
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
            <Text style={styles.syncStatusText}>
              Last sync: {lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : 'never'}
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
            <Text style={styles.actionButtonText}>Logout / Switch User</Text>
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
        areas={availableAreas}
        onSelect={(area) => {
          setSelectedArea(area);
          setActiveModal('none');
        }}
        onClose={() => setActiveModal('none')}
      />

      <ManualEntryModal
        visible={activeModal === 'manual'}
        area={selectedArea ?? scannerUser?.allowed_areas[0] ?? ''}
        scannerName={scannerUser?.name ?? 'Unknown'}
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
        onClose={() => setActiveModal('none')}
      />

      <IncidentModal
        visible={activeModal === 'incident'}
        area={selectedArea ?? undefined}
        eventId={eventId}
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
  onClose,
  onResult,
}: {
  visible: boolean;
  area: string;
  scannerName: string;
  onClose: () => void;
  onResult: (result: { success: boolean; message: string; userName?: string; timestamp: Date }) => void;
}) {
  const [email, setEmail] = useState('');

  const handleSubmit = async () => {
    if (!email.trim()) {
      Alert.alert('Error', 'Enter the attendee email printed on their badge/ID.');
      return;
    }

    const user = await DatabaseService.getUserByEmail(email.toLowerCase().trim());
    if (!user) {
      onResult({ success: false, message: 'No matching attendee found for manual entry', timestamp: new Date() });
      setEmail('');
      return;
    }

    const granted = user.allowed_areas.includes(area);
    await DatabaseService.logScan({
      user_id: user.id,
      user_name: user.name,
      area,
      access_granted: granted,
      failure_reason: granted ? undefined : `No access to ${area} (manual entry)`,
      scanned_at: new Date().toISOString(),
      scanner_user: `${scannerName} (manual)`,
    });

    onResult({
      success: granted,
      message: granted ? `Manual entry: access GRANTED for ${user.name}` : `Manual entry: access DENIED for ${user.name}`,
      userName: user.name,
      timestamp: new Date(),
    });
    setEmail('');
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
          <TouchableOpacity style={modalStyles.submitButton} onPress={handleSubmit}>
            <Text style={modalStyles.submitText}>Verify</Text>
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
  onClose,
}: {
  visible: boolean;
  area: string;
  eventId: number | null;
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
  onClose,
}: {
  visible: boolean;
  area?: string;
  eventId: number | null;
  onClose: () => void;
}) {
  const [category, setCategory] = useState('suspicious_activity');
  const [description, setDescription] = useState('');

  const handleSubmit = async () => {
    if (description.trim().length < 5) {
      Alert.alert('Description required', 'Please describe the incident in a bit more detail.');
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
