import React, { createContext, ReactNode, useContext, useState } from 'react';
import { ScannerUser } from '@/services/DatabaseService';
import { BackendUser } from '@/services/ApiClient';

export interface EligibleEvent {
  id: number;
  name: string;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  role_in_event: string;
}

export interface PendingAccountLogin {
  user: BackendUser;
  events: EligibleEvent[];
  rememberMe: boolean;
}

interface ScannerContextType {
  scannerUser: ScannerUser | null;
  setScannerUser: (user: ScannerUser | null) => void;
  isScanning: boolean;
  setIsScanning: (scanning: boolean) => void;
  scanCount: number;
  setScanCount: (count: number) => void;
  lastScanResult: ScanResult | null;
  setLastScanResult: (result: ScanResult | null) => void;
  selectedArea: string | null;
  setSelectedArea: (area: string | null) => void;
  pendingAccountLogin: PendingAccountLogin | null;
  setPendingAccountLogin: (login: PendingAccountLogin | null) => void;
}

export interface ScanResult {
  success: boolean;
  message: string;
  userName?: string;
  timestamp: Date;
}

const ScannerContext = createContext<ScannerContextType | undefined>(undefined);

interface ScannerProviderProps {
  children: ReactNode;
}

export const ScannerProvider: React.FC<ScannerProviderProps> = ({ children }) => {
  const [scannerUser, setScannerUser] = useState<ScannerUser | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(true);
  const [scanCount, setScanCount] = useState<number>(0);
  const [lastScanResult, setLastScanResult] = useState<ScanResult | null>(null);
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [pendingAccountLogin, setPendingAccountLogin] = useState<PendingAccountLogin | null>(null);

  return (
    <ScannerContext.Provider
      value={{
        scannerUser,
        setScannerUser,
        isScanning,
        setIsScanning,
        scanCount,
        setScanCount,
        lastScanResult,
        setLastScanResult,
        selectedArea,
        setSelectedArea,
        pendingAccountLogin,
        setPendingAccountLogin,
      }}
    >
      {children}
    </ScannerContext.Provider>
  );
};

export const useScanner = (): ScannerContextType => {
  const context = useContext(ScannerContext);
  if (context === undefined) {
    throw new Error('useScanner must be used within a ScannerProvider');
  }
  return context;
};
