import { Redirect } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useScanner } from '@/context/ScannerContext';
import { DatabaseService } from '@/services/DatabaseService';
import { OfflineSessionService } from '@/services/OfflineSessionService';
import { ApiClient } from '@/services/ApiClient';
import { SyncService } from '@/services/SyncService';
import { DEMO_MODE } from '@/config';

export default function IndexScreen() {
  const [isLoading, setIsLoading] = useState(true);
  const [shouldAutoLogin, setShouldAutoLogin] = useState(false);
  const { scannerUser, setScannerUser } = useScanner();

  useEffect(() => {
    const checkAuthState = async () => {
      try {
        const storedEmail = await DatabaseService.getStoredScannerEmail();
        await ApiClient.loadTokens();
        const metadata = storedEmail ? await OfflineSessionService.getMetadata(storedEmail) : null;
        const scanner = metadata
          ? await DatabaseService.getScannerUserByEmail(metadata.email)
          : null;
        if (metadata && scanner && (metadata.mode === 'production' || DEMO_MODE)) {
          const eventId = metadata.mode === 'production'
            ? await SyncService.getCurrentEventId()
            : metadata.eventId;
          if (eventId == null) return;
          const session = await OfflineSessionService.getValid({
            userId: scanner.id,
            email: metadata.email,
            eventId,
            deviceId: await SyncService.getDeviceId(),
            tokenBinding: ApiClient.getTokenBinding(),
          });
          if (!session) return;
          setScannerUser(scanner);
          setShouldAutoLogin(true);
        }
      } catch (error) {
        console.error('Error checking auth state:', error);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuthState();
  }, [setScannerUser]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f0fdf4' }}>
        <ActivityIndicator size="large" color="#059669" />
      </View>
    );
  }

  // Redirect based on authentication state
  if (scannerUser || shouldAutoLogin) {
    return <Redirect href="/(main)/scanner" />;
  }

  return <Redirect href="/(auth)/login" />;
}
