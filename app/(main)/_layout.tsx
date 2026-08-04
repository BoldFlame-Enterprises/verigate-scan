import React from 'react';
import { Stack } from 'expo-router';

export default function MainLayout() {
  return (
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
      <Stack.Screen 
        name="scanner" 
        options={{ 
          title: 'QR Code Scanner',
          headerLeft: () => null, // Prevent going back
        }} 
      />
      <Stack.Screen
        name="queue-status"
        options={{ title: 'Audit Queue Health' }}
      />
      <Stack.Screen
        name="storage-recovery"
        options={{ title: 'Storage Recovery' }}
      />
    </Stack>
  );
}
