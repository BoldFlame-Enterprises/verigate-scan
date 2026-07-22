import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { ScannerProvider } from '@/context/ScannerContext';
import { DatabaseService } from '@/services/DatabaseService';

export default function RootLayout() {
  useEffect(() => {
    const initializeApp = async () => {
      try {
        await DatabaseService.initDatabase();
        console.log('✅ VeriGate Scan database initialized');
      } catch (error) {
        console.error('❌ Failed to initialize database:', error);
      }
    };

    initializeApp();
  }, []);

  return (
    <ScannerProvider>
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: '#059669',
          },
          headerTintColor: '#fff',
          headerTitleStyle: {
            fontWeight: 'bold',
          },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(main)" options={{ headerShown: false }} />
      </Stack>
      <StatusBar style="light" backgroundColor="#059669" />
    </ScannerProvider>
  );
}