export interface DhcpConfig {
  interfaceName: string;
  rangeStart: string;
  rangeEnd: string;
  subnetMask: string;
  gateway: string;
  dns: string;
  leaseTime: number; // in minutes
}

export interface DhcpLease {
  id: string;
  ip: string;
  mac: string;
  hostname: string;
  interfaceName: string;
  leasedAt: string;
  expiresAt: string;
  status: 'active' | 'expired' | 'reserved';
  // Populated by a periodic background ping sweep — undefined until the first
  // sweep has checked this lease's IP at least once.
  online?: boolean;
  lastCheckedAt?: string;
}

export interface DhcpReservation {
  id: string;
  mac: string;
  ip: string;
  hostname: string;
}

export interface TftpFtpConfig {
  tftpEnabled: boolean;
  ftpEnabled: boolean;
  rootFolder: string;
  tftpPort: number;
  ftpPort: number;
}

export interface FileRecord {
  name: string;
  size: number;
  isDirectory: boolean;
  modifiedTime: string;
}

export interface TransferLog {
  id: string;
  service: 'TFTP' | 'FTP';
  clientIp: string;
  operation: 'UPLOAD' | 'DOWNLOAD';
  fileName: string;
  fileSize: number; // bytes
  progress: number; // 0 to 100
  speed: string; // e.g. "1.2 MB/s"
  status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';
  timestamp: string;
}

export interface TerminalHost {
  id: string;
  name: string;
  ip: string;
  port: number;
  protocol: 'SSH' | 'TELNET';
  username: string;
  password?: string;
}

export interface CommandScript {
  id: string;
  name: string;
  description: string;
  commands: string[];
}

export interface ScriptExecution {
  id: string;
  hostId: string;
  scriptId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  currentCommand: string;
  progress: number;
  logs: string[];
  timestamp: string;
  // Whether a live SSH/Telnet connection for this execution is still open on the
  // backend (registered in the `liveSessions` registry) and can accept manual
  // CLI commands via POST /api/terminal/send.
  sessionOpen: boolean;
}

export interface SystemStatus {
  dhcpRunning: boolean;
  tftpRunning: boolean;
  ftpRunning: boolean;
  autoStart: boolean;
  cpuUsage: number;
  memoryUsage: number;
  uptime: number; // seconds
}
