import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAppInitialization } from '@/context/AppInitializationContext';

export function InitializationBoundary({ children }: { children: React.ReactNode }) {
  const { status, error, retry } = useAppInitialization();

  if (status === 'ready') return <>{children}</>;

  const terminal = status === 'terminal-error';
  return (
    <View style={styles.container} accessibilityRole="alert">
      {status === 'initializing' ? (
        <>
          <ActivityIndicator size="large" color="#059669" />
          <Text style={styles.title}>Opening secure scanner storage</Text>
          <Text style={styles.detail}>Scanning stays disabled until initialization completes.</Text>
        </>
      ) : (
        <>
          <Text style={styles.title} accessibilityRole="header">
            {terminal ? 'Scanner storage is unavailable' : 'Scanner startup did not complete'}
          </Text>
          <Text style={styles.detail}>{error ?? 'Secure initialization failed.'}</Text>
          {terminal ? (
            <Text style={styles.guidance}>
              Do not clear application data while audit records may be pending. Contact support.
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry secure scanner initialization"
              style={styles.button}
              onPress={() => void retry()}
            >
              <Text style={styles.buttonText}>Retry initialization</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#f0fdf4',
  },
  title: {
    marginTop: 16,
    color: '#065f46',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  detail: {
    marginTop: 8,
    color: '#374151',
    fontSize: 15,
    textAlign: 'center',
  },
  guidance: {
    marginTop: 16,
    color: '#991b1b',
    textAlign: 'center',
  },
  button: {
    marginTop: 20,
    borderRadius: 8,
    backgroundColor: '#059669',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '700',
  },
});
