import React, { createContext, ReactNode, useContext, useState } from 'react';
import { ScannerUser } from '@/services/DatabaseService';

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
        setSelectedArea
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