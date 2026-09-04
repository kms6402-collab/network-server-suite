export interface DhcpConfig {
  interfaceName: string;
  rangeStart: string;
  rangeEnd: string;
  subnetMask: string;
  gateway: string;
  dns: string;
  leaseTime: number; // in minutes
  // Optional: a specific IP the DHCP server should identify itself as
  // (DHCP option 54/siaddr) on the bound adapter. Empty/unset means "use
  // whatever real IP the adapter already has" (the default, automatic
  // behavior). When set, the backend adds it to the adapter as a secondary
  // IP if not already present — see ensureServerIpOnAdapter in server.ts.
  serverIp?: string;
  // Additional address ranges within the same adapter/subnet, on top of
  // rangeStart-rangeEnd above — e.g. a /23 or /22 pool split into separate
  // chunks (so a block in the middle can be excluded from leasing). Every
  // range always shares this DhcpConfig's interfaceName/subnetMask/serverIp
  // (there's only one bound adapter and one server identity), but each range
  // can override gateway/dns/leaseTime for clients landing in it.
  extraRanges?: DhcpRange[];
}

export interface DhcpRange {
  id: string;
  start: string;
  end: string;
  // Per-range overrides — omitted (or a value predating this field) falls
  // back to the top-level DhcpConfig field of the same name.
  gateway?: string;
  dns?: string;
  leaseTime?: number;
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

// A whitelisted FTP login. The FTP server rejects any USER/PASS not matching
// one of these exactly — if this list is empty, no one can log in (no
// anonymous/open-access fallback).
export interface FtpCredential {
  id: string;
  username: string;
  password: string;
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

// A saved "device list + script" combination that can be re-run as a single
// batch (see TerminalAutomation.tsx "저장된 배치 작업" panel). Purely a
// frontend convenience over the existing per-host POST /api/scripts/execute
// fan-out — no dedicated execution logic lives on the backend for this.
export interface BatchJob {
  id: string;
  name: string;
  hostIds: string[];
  scriptId: string;
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
