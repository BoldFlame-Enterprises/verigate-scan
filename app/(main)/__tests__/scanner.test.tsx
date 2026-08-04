/* eslint-disable import/first */
jest.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'stable-operation-id') }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock('@/context/ScannerContext', () => ({ useScanner: jest.fn() }));
jest.mock('@/services/DatabaseService', () => ({ DatabaseService: {} }));
jest.mock('@/services/SyncService', () => ({ SyncService: {} }));
jest.mock('@/services/SyncScheduler', () => ({ SyncScheduler: {} }));
jest.mock('@/services/NotificationService', () => ({ NotificationService: {} }));
jest.mock('@/services/AudioFeedbackService', () => ({ AudioFeedbackService: {} }));
jest.mock('@/services/ApiClient', () => ({ ApiClient: {} }));
jest.mock('@/services/OfflineSessionService', () => ({ OfflineSessionService: {} }));
jest.mock('@/services/DeviceControlService', () => ({ DeviceControlService: {} }));
jest.mock('@/config', () => ({ DEMO_MODE: false }));

import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import {
  CameraPermissionPanel,
  IncidentModal,
  ManualEntryModal,
  OverrideModal,
} from '../scanner';
import { OPERATIONAL_FIELD_LIMITS } from '@/components/OperationalForm';
import { RecordingAuthorityInput } from '@/services/RecordingAuthorityService';

const authority: RecordingAuthorityInput = {
  databaseReady: true,
  appState: 'active',
  blockingModal: true,
  operationInFlight: false,
  deviceSession: true,
  revoked: false,
  event: { id: 2, name: 'Event', is_active: true, starts_at: null, ends_at: null },
  selectedArea: { id: 3, name: 'Arena' },
  lastSyncAt: Date.now(),
  auditHealthy: true,
};

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(element); });
  return renderer;
}

describe('critical scanner components', () => {
  it('offers settings after permanent camera denial and retains audit recovery access', () => {
    const request = jest.fn();
    const settings = jest.fn();
    const queue = jest.fn();
    const renderer = render(
      <CameraPermissionPanel
        canAskAgain={false}
        onRequest={request}
        onSettings={settings}
        onQueue={queue}
      />
    );

    const settingsButton = renderer.root.findByProps({
      accessibilityLabel: 'Open device settings for camera permission',
    });
    act(() => settingsButton.props.onPress());
    expect(settings).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ accessibilityLabel: 'Open audit queue recovery' })).toBeTruthy();
  });

  it('renders bounded, named manual and override fields with disabled-state authority', () => {
    const manual = render(
      <ManualEntryModal
        visible
        area="Arena"
        scannerName="Scanner"
        eventId={2}
        authorityInput={authority}
        lastSyncAt={Date.now()}
        onClose={jest.fn()}
        onResult={jest.fn()}
      />
    );
    expect(manual.root.findByProps({ accessibilityLabel: 'Attendee email for manual entry' }).props.maxLength)
      .toBe(OPERATIONAL_FIELD_LIMITS.email);
    expect(manual.root.findByProps({ accessibilityLabel: 'Reason QR verification cannot be used' }).props.maxLength)
      .toBe(OPERATIONAL_FIELD_LIMITS.reason);
    expect(manual.root.findAllByProps({ accessibilityLiveRegion: 'polite' }).length).toBeGreaterThanOrEqual(1);

    const override = render(
      <OverrideModal visible area="Arena" eventId={2} authorityInput={authority} onClose={jest.fn()} />
    );
    expect(override.root.findByProps({ accessibilityLabel: 'Optional attendee email for override' }).props.maxLength)
      .toBe(OPERATIONAL_FIELD_LIMITS.email);
    expect(override.root.findByProps({ accessibilityLabel: 'Mandatory emergency override reason' }).props.maxLength)
      .toBe(OPERATIONAL_FIELD_LIMITS.reason);
  });

  it('renders a bounded incident description and accessible category selection for narrow modal layouts', () => {
    const incident = render(
      <IncidentModal visible area="Arena" eventId={2} authorityInput={authority} onClose={jest.fn()} />
    );
    expect(incident.root.findByProps({ accessibilityLabel: 'Incident description' }).props.maxLength)
      .toBe(OPERATIONAL_FIELD_LIMITS.description);
    expect(incident.root.findByProps({ accessibilityLabel: 'suspicious_activity incident category' })).toBeTruthy();
    expect(incident.root.findByProps({ accessibilityLabel: 'technical_issue incident category' })).toBeTruthy();
    expect(incident.root.findByProps({ accessibilityLabel: 'other incident category' })).toBeTruthy();
    expect(incident.root.findAllByProps({ accessibilityLiveRegion: 'polite' }).length).toBeGreaterThanOrEqual(1);
  });
});
