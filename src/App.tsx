import React, { useState, useEffect } from 'react';
import { 
  Activity, Server, Network, FolderOpen, Terminal, Settings, RefreshCw, AlertCircle
} from 'lucide-react';
import {
  SystemStatus, DhcpConfig, DhcpLease, DhcpReservation,
  TftpFtpConfig, FtpCredential, FileRecord, TransferLog, TerminalHost, CommandScript, ScriptExecution, BatchJob
} from './types';

// Import sub-components
import Dashboard from './components/Dashboard';
import DhcpServer from './components/DhcpServer';
import FileServer from './components/FileServer';
import TerminalAutomation from './components/TerminalAutomation';
import SystemSettings from './components/SystemSettings';

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'dhcp' | 'files' | 'terminal' | 'settings'>('dashboard');
  const [isLoading, setIsLoading] = useState(true);
  const [isPolling, setIsPolling] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // States loaded from backend API
  const [status, setStatus] = useState<SystemStatus>({
    dhcpRunning: false,
    tftpRunning: false,
    ftpRunning: false,
    autoStart: true,
    cpuUsage: 1.2,
    memoryUsage: 33.4,
    uptime: 0
  });

  const [dhcpConfig, setDhcpConfig] = useState<DhcpConfig>({
    interfaceName: "Ethernet 1 (eth0)",
    rangeStart: "192.168.1.100",
    rangeEnd: "192.168.1.200",
    subnetMask: "255.255.255.0",
    gateway: "192.168.1.1",
    dns: "8.8.8.8",
    leaseTime: 120
  });

  const [leases, setLeases] = useState<DhcpLease[]>([]);
  const [reservations, setReservations] = useState<DhcpReservation[]>([]);
  const [tftpFtpConfig, setTftpFtpConfig] = useState<TftpFtpConfig>({
    tftpEnabled: false,
    ftpEnabled: false,
    rootFolder: "",
    tftpPort: 69,
    ftpPort: 21
  });

  const [ftpCredentials, setFtpCredentials] = useState<FtpCredential[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [transferLogs, setTransferLogs] = useState<TransferLog[]>([]);
  const [terminalHosts, setTerminalHosts] = useState<TerminalHost[]>([]);
  const [commandScripts, setCommandScripts] = useState<CommandScript[]>([]);
  const [dhcpConsoleLogs, setDhcpConsoleLogs] = useState<{ timestamp: string; level: 'INFO' | 'SUCCESS' | 'WARN'; message: string }[]>([]);
  const [scriptExecutions, setScriptExecutions] = useState<ScriptExecution[]>([]);
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);

  // Function to load all backend state together
  const fetchAllState = async () => {
    try {
      const response = await fetch('/api/status');
      if (!response.ok) throw new Error("서버 연결 불안정");
      const data = await response.json();
      
      setStatus(data.systemStatus);
      setDhcpConfig(data.dhcpConfig);
      setLeases(data.leases);
      setReservations(data.reservations);
      setTftpFtpConfig(data.tftpFtpConfig);
      setFtpCredentials(data.ftpCredentials);
      setTransferLogs(data.transferLogs);
      setTerminalHosts(data.terminalHosts);
      setCommandScripts(data.commandScripts);
      setBatchJobs(data.batchJobs);
      setDhcpConsoleLogs(data.dhcpConsoleLogs);
      
      // Also fetch scripts executions
      const execResponse = await fetch('/api/scripts/executions');
      if (execResponse.ok) {
        const execData = await execResponse.json();
        setScriptExecutions(execData.scriptExecutions);
      }

      // Also list served files
      const filesResponse = await fetch('/api/files');
      if (filesResponse.ok) {
        const filesData = await filesResponse.json();
        setFiles(filesData.files);
      }

      setErrorMsg(null);
    } catch (error: any) {
      console.error(error);
      setErrorMsg("서버에 연결할 수 없습니다.");
    } finally {
      setIsLoading(false);
    }
  };

  // Initial load and periodic polling
  useEffect(() => {
    fetchAllState();
    
    // Set up continuous polling for dynamic updates
    const interval = setInterval(() => {
      if (isPolling) fetchAllState();
    }, 1500);

    return () => clearInterval(interval);
  }, [isPolling]);

  // Handle service toggling (DHCP, FTP, TFTP)
  const handleToggleService = async (service: 'DHCP' | 'TFTP' | 'FTP', enabled: boolean): Promise<{ success: boolean; error?: string }> => {
    try {
      if (service === 'DHCP') {
        const res = await fetch('/api/dhcp/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        const data = await res.json().catch(() => ({}));
        // The backend can respond 200 OK with success:false (e.g. the real
        // DHCP socket failed to bind — EACCES/EADDRINUSE) — dhcpRunning is
        // reverted server-side in that case, so always resync local state.
        if (data.systemStatus) setStatus(data.systemStatus);
        if (data.dhcpConfig) setDhcpConfig(data.dhcpConfig);
        if (data.leases) setLeases(data.leases);
        if (data.dhcpConsoleLogs) setDhcpConsoleLogs(data.dhcpConsoleLogs);
        if (res.ok && data.success !== false) {
          return { success: true };
        }
        return { success: false, error: data.error || 'DHCP 서비스 전환에 실패했습니다.' };
      } else {
        const res = await fetch('/api/tftpftp/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service, enabled })
        });
        if (res.ok) {
          const data = await res.json();
          setStatus(data.systemStatus);
          setTftpFtpConfig(data.tftpFtpConfig);
          return { success: true };
        }
        return { success: false, error: 'TFTP/FTP 서비스 전환에 실패했습니다.' };
      }
    } catch (e) {
      console.error(e);
      return { success: false, error: '네트워크 오류로 요청이 실패했습니다.' };
    }
  };

  // DHCP config updating
  const handleUpdateDhcpConfig = async (newConfig: DhcpConfig): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/dhcp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success !== false) {
        setDhcpConfig(data.dhcpConfig);
        setDhcpConsoleLogs(data.dhcpConsoleLogs);
        return { success: true };
      }
      return { success: false, error: data.error || 'DHCP 설정 적용에 실패했습니다.' };
    } catch (e) {
      console.error(e);
      return { success: false, error: '네트워크 오류로 설정을 적용하지 못했습니다.' };
    }
  };

  // DHCP static reservation
  const handleAddReservation = async (mac: string, ip: string, hostname: string) => {
    try {
      const res = await fetch('/api/dhcp/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mac, ip, hostname })
      });
      if (res.ok) {
        const data = await res.json();
        setReservations(data.reservations);
        setLeases(data.leases);
        setDhcpConsoleLogs(data.dhcpConsoleLogs);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleRemoveReservation = async (id: string) => {
    try {
      const res = await fetch(`/api/dhcp/reservations/${id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        const data = await res.json();
        setReservations(data.reservations);
        setLeases(data.leases);
        setDhcpConsoleLogs(data.dhcpConsoleLogs);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleClearLeases = async () => {
    try {
      const res = await fetch('/api/dhcp/leases/clear', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setLeases(data.leases);
        setDhcpConsoleLogs(data.dhcpConsoleLogs);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Return (revoke) a single lease — removes it from the backend's lease
  // table so the real DHCP server engine frees that IP for reassignment.
  const handleRemoveLease = async (id: string) => {
    try {
      const res = await fetch(`/api/dhcp/leases/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        setLeases(data.leases);
        setDhcpConsoleLogs(data.dhcpConsoleLogs);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Manually "renew" a single lease — asks the backend to push out its
  // expiry, retry reverse DNS, and re-ping the IP in one admin action.
  const handleRenewLease = async (id: string) => {
    try {
      const res = await fetch(`/api/dhcp/leases/${id}/renew`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setLeases(data.leases);
        setDhcpConsoleLogs(data.dhcpConsoleLogs);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleRefreshDiscovery = async () => {
    try {
      const res = await fetch('/api/dhcp/discover', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setLeases(data.leases);
        setDhcpConsoleLogs(data.dhcpConsoleLogs);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // File management
  const handleUpdateFileConfig = async (rootFolder: string, tftpPort: number, ftpPort: number) => {
    try {
      const res = await fetch('/api/tftpftp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootFolder, tftpPort, ftpPort })
      });
      const data = await res.json();
      if (res.ok) {
        setTftpFtpConfig(data.tftpFtpConfig);
        setErrorMsg(null);
      } else {
        setErrorMsg(data.error || "설정을 저장하지 못했습니다.");
      }
    } catch (e) {
      console.error(e);
      setErrorMsg("설정을 저장하는 중 오류가 발생했습니다.");
    }
  };

  // Opens a native folder-picker on the server machine (PowerShell
  // FolderBrowserDialog) and returns the chosen absolute path, or null if the
  // dialog failed or was cancelled. Only fills in the field — the caller
  // still has to submit the config form to actually apply/validate it.
  const handleBrowseFolder = async (): Promise<string | null> => {
    try {
      const res = await fetch('/api/tftpftp/browse-folder', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success && !data.cancelled) return data.path;
      return null;
    } catch (e) {
      console.error(e);
      return null;
    }
  };

  const handleAddFtpCredential = async (username: string, password: string) => {
    try {
      const res = await fetch('/api/tftpftp/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok) {
        setFtpCredentials(data.ftpCredentials);
        setErrorMsg(null);
      } else {
        setErrorMsg(data.error || "계정을 추가하지 못했습니다.");
      }
    } catch (e) {
      console.error(e);
      setErrorMsg("계정을 추가하는 중 오류가 발생했습니다.");
    }
  };

  const handleDeleteFtpCredential = async (id: string) => {
    try {
      const res = await fetch(`/api/tftpftp/credentials/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        setFtpCredentials(data.ftpCredentials);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteFile = async (name: string) => {
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(name)}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setErrorMsg(null);
        fetchAllState();
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error || "파일을 삭제하지 못했습니다.");
      }
    } catch (e) {
      console.error(e);
      setErrorMsg("파일을 삭제하는 중 오류가 발생했습니다.");
    }
  };

  const handleCreateFile = async (name: string, content: string) => {
    try {
      const res = await fetch('/api/files/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content })
      });
      if (res.ok) {
        fetchAllState();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleClearTransfers = async () => {
    try {
      const res = await fetch('/api/tftpftp/transfers/clear', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setTransferLogs(data.transferLogs);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleClearConsoleLogs = async () => {
    try {
      const res = await fetch('/api/system/console-log/clear', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setDhcpConsoleLogs(data.dhcpConsoleLogs);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Terminals & Automations
  const handleAddHost = async (name: string, ip: string, port: number, protocol: 'SSH' | 'TELNET', username: string, password?: string) => {
    try {
      const res = await fetch('/api/hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ip, port, protocol, username, password })
      });
      if (res.ok) {
        const data = await res.json();
        setTerminalHosts(data.terminalHosts);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleUpdateHost = async (id: string, name: string, ip: string, port: number, protocol: 'SSH' | 'TELNET', username: string, password?: string) => {
    try {
      const res = await fetch(`/api/hosts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ip, port, protocol, username, password })
      });
      if (res.ok) {
        const data = await res.json();
        setTerminalHosts(data.terminalHosts);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleRemoveHost = async (id: string) => {
    try {
      const res = await fetch(`/api/hosts/${id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        const data = await res.json();
        setTerminalHosts(data.terminalHosts);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleBulkImportHosts = async (devices: { name: string; ip: string }[], protocol: 'SSH' | 'TELNET', port: number, username: string, password?: string) => {
    try {
      const res = await fetch('/api/hosts/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devices, protocol, port, username, password })
      });
      if (res.ok) {
        const data = await res.json();
        setTerminalHosts(data.terminalHosts);
        return { imported: data.imported as number, skipped: data.skipped as number };
      }
    } catch (e) {
      console.error(e);
    }
    return { imported: 0, skipped: 0 };
  };

  const handleBulkUpdateHosts = async (ids: string[], updates: { protocol?: 'SSH' | 'TELNET'; port?: number; username?: string; password?: string }) => {
    try {
      const res = await fetch('/api/hosts/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, ...updates })
      });
      if (res.ok) {
        const data = await res.json();
        setTerminalHosts(data.terminalHosts);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleBulkDeleteHosts = async (ids: string[]) => {
    try {
      const res = await fetch('/api/hosts/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      if (res.ok) {
        const data = await res.json();
        setTerminalHosts(data.terminalHosts);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddScript = async (name: string, description: string, commands: string[]) => {
    try {
      const res = await fetch('/api/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, commands })
      });
      if (res.ok) {
        const data = await res.json();
        setCommandScripts(data.commandScripts);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleUpdateScript = async (id: string, name: string, description: string, commands: string[]) => {
    try {
      const res = await fetch(`/api/scripts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, commands })
      });
      if (res.ok) {
        const data = await res.json();
        setCommandScripts(data.commandScripts);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleRemoveScript = async (id: string) => {
    try {
      const res = await fetch(`/api/scripts/${id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        const data = await res.json();
        setCommandScripts(data.commandScripts);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Returns the new execution's id (or null on failure) so callers like the
  // sequential batch runner in TerminalAutomation can wait for this specific
  // execution to finish before starting the next host.
  const handleExecuteScript = async (hostId: string, scriptId: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/scripts/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId, scriptId })
      });
      fetchAllState();
      if (!res.ok) return null;
      const data = await res.json();
      return data.executionId ?? null;
    } catch (e) {
      console.error(e);
      return null;
    }
  };

  // Manual-connect: open a live SSH/Telnet session without running a batch
  // script, so the user can type commands interactively.
  const handleManualConnect = async (hostId: string) => {
    try {
      await fetch('/api/terminal/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId })
      });
      fetchAllState();
    } catch (e) {
      console.error(e);
    }
  };

  // Send a manual CLI command into one (single session) or many (broadcast
  // "send to all sessions") already-open live sessions at once.
  const handleSendManualCommand = async (execIds: string[], command: string) => {
    try {
      await fetch('/api/terminal/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ execIds, command })
      });
      fetchAllState();
    } catch (e) {
      console.error(e);
    }
  };

  const handleDisconnectSession = async (execId: string) => {
    try {
      await fetch('/api/terminal/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ execId })
      });
      fetchAllState();
    } catch (e) {
      console.error(e);
    }
  };

  // Fully close a session tab (disconnect + remove its execution record),
  // as opposed to handleDisconnectSession above which only severs the live
  // connection but keeps the tab/record around.
  const handleCloseSession = async (execId: string) => {
    try {
      const res = await fetch(`/api/scripts/executions/${execId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        const data = await res.json();
        setScriptExecutions(data.scriptExecutions);
      } else {
        fetchAllState();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleCloseAllSessions = async () => {
    try {
      const res = await fetch('/api/scripts/executions/close-all', {
        method: 'POST'
      });
      if (res.ok) {
        const data = await res.json();
        setScriptExecutions(data.scriptExecutions);
      } else {
        fetchAllState();
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Saved batch jobs ("device list + script" combo re-run) — pure CRUD
  // against the new /api/batch-jobs endpoints; actual execution is handled
  // entirely inside TerminalAutomation by replaying onExecuteScript per host.
  const handleSaveBatchJob = async (name: string, hostIds: string[], scriptId: string) => {
    try {
      const res = await fetch('/api/batch-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, hostIds, scriptId })
      });
      if (res.ok) {
        const data = await res.json();
        setBatchJobs(data.batchJobs);
      }
    } catch (e) { console.error(e); }
  };

  const handleDeleteBatchJob = async (id: string) => {
    try {
      const res = await fetch(`/api/batch-jobs/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        setBatchJobs(data.batchJobs);
      }
    } catch (e) { console.error(e); }
  };

  // Settings & Recovery
  const handleToggleAutoStart = async (enabled: boolean) => {
    try {
      const res = await fetch('/api/system/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoStart: enabled })
      });
      if (res.ok) {
        const data = await res.json();
        setStatus(data.systemStatus);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleFactoryReset = async () => {
    if (!confirm("모든 설정과 기록을 초기화하시겠습니까?")) return;
    try {
      const res = await fetch('/api/system/reset', { method: 'POST' });
      if (res.ok) {
        fetchAllState();
        alert("초기화 완료");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleRestartService = async () => {
    try {
      await fetch('/api/system/restart', { method: 'POST' });
    } catch (e) {
      console.error(e);
    }
  };

  const handleRebootSimulation = async () => {
    setIsLoading(true);
    try {
      await fetch('/api/system/reset', { method: 'POST' }); // Reset as a quick reboot state dump
      // Simulating reboot downtime
      setTimeout(() => {
        fetchAllState();
        alert("재시작 완료 - 서비스가 자동으로 복구되었습니다.");
      }, 1500);
    } catch (e) {
      console.error(e);
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-white">
      {/* Dynamic Header */}
      <header className="sticky top-0 z-50 border-b border-slate-900/60 bg-slate-950/60 backdrop-blur-xl px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-gradient-to-tr from-indigo-600 to-violet-500 rounded-xl shadow-lg shadow-indigo-950/40 hover:scale-105 transition-transform duration-300">
            <Server className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-display font-bold tracking-tight text-white flex items-center gap-2">
              Network Server Suite
              <span className="text-[10px] font-sans font-semibold bg-indigo-500/10 text-indigo-300 px-2.5 py-0.5 border border-indigo-500/20 rounded-full tracking-wide">
                v2.5.1 Enterprise
              </span>
            </h1>
            <p className="text-xs text-slate-400 mt-1">DHCP·TFTP·FTP 관리 및 SSH/Telnet 자동화 콘솔</p>
          </div>
        </div>

        {/* Global connection status bar */}
        <div className="flex items-center gap-3.5 text-xs">
          {errorMsg && (
            <div className="flex items-center gap-1.5 text-rose-400 bg-rose-950/20 border border-rose-900/40 px-3 py-1.5 rounded-lg animate-pulse">
              <AlertCircle className="w-4 h-4" />
              <span>{errorMsg}</span>
            </div>
          )}
          
          <div className="bg-slate-950/80 border border-slate-850/60 p-1 rounded-xl flex gap-1 font-medium text-[11px] shadow-inner">
            <button
              id="tab-btn-dashboard"
              onClick={() => setActiveTab('dashboard')}
              className={`px-3.5 py-2 rounded-lg flex items-center gap-2 transition-all duration-200 cursor-pointer ${activeTab === 'dashboard' ? 'bg-indigo-600 shadow-lg shadow-indigo-950/50 text-white font-semibold' : 'text-slate-400 hover:text-white hover:bg-slate-900/50'}`}
            >
              <Activity className="w-3.5 h-3.5" />
              대시보드
            </button>
            <button
              id="tab-btn-dhcp"
              onClick={() => setActiveTab('dhcp')}
              className={`px-3.5 py-2 rounded-lg flex items-center gap-2 transition-all duration-200 cursor-pointer ${activeTab === 'dhcp' ? 'bg-indigo-600 shadow-lg shadow-indigo-950/50 text-white font-semibold' : 'text-slate-400 hover:text-white hover:bg-slate-900/50'}`}
            >
              <Network className="w-3.5 h-3.5" />
              DHCP 관리
            </button>
            <button
              id="tab-btn-files"
              onClick={() => setActiveTab('files')}
              className={`px-3.5 py-2 rounded-lg flex items-center gap-2 transition-all duration-200 cursor-pointer ${activeTab === 'files' ? 'bg-indigo-600 shadow-lg shadow-indigo-950/50 text-white font-semibold' : 'text-slate-400 hover:text-white hover:bg-slate-900/50'}`}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              TFTP/FTP 공유
            </button>
            <button
              id="tab-btn-terminal"
              onClick={() => setActiveTab('terminal')}
              className={`px-3.5 py-2 rounded-lg flex items-center gap-2 transition-all duration-200 cursor-pointer ${activeTab === 'terminal' ? 'bg-indigo-600 shadow-lg shadow-indigo-950/50 text-white font-semibold' : 'text-slate-400 hover:text-white hover:bg-slate-900/50'}`}
            >
              <Terminal className="w-3.5 h-3.5" />
              CLI 자동화
            </button>
            <button
              id="tab-btn-settings"
              onClick={() => setActiveTab('settings')}
              className={`px-3.5 py-2 rounded-lg flex items-center gap-2 transition-all duration-200 cursor-pointer ${activeTab === 'settings' ? 'bg-indigo-600 shadow-lg shadow-indigo-950/50 text-white font-semibold' : 'text-slate-400 hover:text-white hover:bg-slate-900/50'}`}
            >
              <Settings className="w-3.5 h-3.5" />
              설정
            </button>
          </div>
        </div>
      </header>

      {/* Main Panel */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6">
        {isLoading ? (
          <div className="py-24 text-center space-y-4">
            <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin mx-auto" />
            <p className="text-slate-400 text-sm">네트워크 백엔드 데몬 정보 수신 중...</p>
          </div>
        ) : (
          <div className="transition-all duration-300">
            {activeTab === 'dashboard' && (
              <Dashboard 
                status={status}
                onToggleService={handleToggleService}
                dhcpLeasesCount={leases.filter(l => l.status === 'active' || l.status === 'reserved').length}
                filesCount={files.length}
                hostsCount={terminalHosts.length}
                consoleLogs={dhcpConsoleLogs}
                transferLogs={transferLogs}
                onTriggerReboot={handleRebootSimulation}
                isPolling={isPolling}
                leases={leases}
                onNavigateToTab={(tab) => setActiveTab(tab)}
                onClearConsoleLogs={handleClearConsoleLogs}
                onClearTransfers={handleClearTransfers}
              />
            )}

            {activeTab === 'dhcp' && (
              <DhcpServer
                dhcpRunning={status.dhcpRunning}
                config={dhcpConfig}
                leases={leases}
                reservations={reservations}
                terminalHosts={terminalHosts}
                onToggleDhcp={(enabled) => handleToggleService('DHCP', enabled)}
                onUpdateConfig={handleUpdateDhcpConfig}
                onAddReservation={handleAddReservation}
                onRemoveReservation={handleRemoveReservation}
                onClearLeases={handleClearLeases}
                onRemoveLease={handleRemoveLease}
                onRenewLease={handleRenewLease}
                onRefreshDiscovery={handleRefreshDiscovery}
              />
            )}

            {activeTab === 'files' && (
              <FileServer 
                config={tftpFtpConfig}
                files={files}
                transferLogs={transferLogs}
                credentials={ftpCredentials}
                onToggleService={handleToggleService}
                onUpdateConfig={handleUpdateFileConfig}
                onBrowseFolder={handleBrowseFolder}
                onAddCredential={handleAddFtpCredential}
                onDeleteCredential={handleDeleteFtpCredential}
                onDeleteFile={handleDeleteFile}
                onCreateFile={handleCreateFile}
                onClearTransfers={handleClearTransfers}
              />
            )}

            {activeTab === 'terminal' && (
              <TerminalAutomation
                hosts={terminalHosts}
                scripts={commandScripts}
                executions={scriptExecutions}
                leases={leases}
                batchJobs={batchJobs}
                onSaveBatchJob={handleSaveBatchJob}
                onDeleteBatchJob={handleDeleteBatchJob}
                onAddHost={handleAddHost}
                onUpdateHost={handleUpdateHost}
                onRemoveHost={handleRemoveHost}
                onBulkImportHosts={handleBulkImportHosts}
                onBulkUpdateHosts={handleBulkUpdateHosts}
                onBulkDeleteHosts={handleBulkDeleteHosts}
                onAddScript={handleAddScript}
                onUpdateScript={handleUpdateScript}
                onRemoveScript={handleRemoveScript}
                onExecuteScript={handleExecuteScript}
                onManualConnect={handleManualConnect}
                onSendManualCommand={handleSendManualCommand}
                onDisconnectSession={handleDisconnectSession}
                onCloseSession={handleCloseSession}
                onCloseAllSessions={handleCloseAllSessions}
                onPollExecutions={fetchAllState}
              />
            )}

            {activeTab === 'settings' && (
              <SystemSettings
                status={status}
                onToggleAutoStart={handleToggleAutoStart}
                onFactoryReset={handleFactoryReset}
                onRestartService={handleRestartService}
              />
            )}
          </div>
        )}
      </main>

      {/* Footer credits and system statistics bar */}
      <footer className="mt-auto border-t border-slate-900 bg-slate-950/40 py-4 px-6 text-center text-slate-500 text-xs flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
        <div className="font-mono text-[10px]">
          SERVER PROCESS BOUND: http://0.0.0.0:3000 | PLATFORM INGRESS: ONLINE
        </div>
        <div>
          © 2026 Network Server Suite • Crafted with high-performance CJS auto-recovery engine
        </div>
      </footer>
    </div>
  );
}
