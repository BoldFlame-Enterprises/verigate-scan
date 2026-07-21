import * as SecureStore from 'expo-secure-store';

const KEY = 'verigate_scan_offline_session_v2';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface OfflineSession {
  userId: number;
  email: string;
  eventId: number;
  mode: 'production' | 'demo';
  issuedAt: number;
  expiresAt: number;
}

class OfflineSessionServiceClass {
  async create(userId: number, email: string, eventId: number, mode: OfflineSession['mode']): Promise<void> {
    const issuedAt = Date.now();
    await SecureStore.setItemAsync(KEY, JSON.stringify({
      userId,
      email: email.toLowerCase(),
      eventId,
      mode,
      issuedAt,
      expiresAt: issuedAt + SESSION_TTL_MS,
    } satisfies OfflineSession));
  }

  async getValid(email?: string): Promise<OfflineSession | null> {
    const stored = await SecureStore.getItemAsync(KEY);
    if (!stored) return null;
    try {
      const session = JSON.parse(stored) as OfflineSession;
      if (session.expiresAt <= Date.now() || (email && session.email !== email.toLowerCase())) {
        await this.clear();
        return null;
      }
      return session;
    } catch {
      await this.clear();
      return null;
    }
  }

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY);
  }
}

export const OfflineSessionService = new OfflineSessionServiceClass();
