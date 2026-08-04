import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { ScannerProvider } from '@/context/ScannerContext';
import { AppInitializationProvider } from '@/context/AppInitializationContext';
import { InitializationBoundary } from '@/components/InitializationBoundary';

export default function RootLayout() {
  return (
    <AppInitializationProvider>
      <InitializationBoundary>
        <ScannerProvider>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: '#059669' },
              headerTintColor: '#fff',
              headerTitleStyle: { fontWeight: 'bold' },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(main)" options={{ headerShown: false }} />
          </Stack>
          <StatusBar style="light" backgroundColor="#059669" />
        </ScannerProvider>
      </InitializationBoundary>
    </AppInitializationProvider>
  );
}
