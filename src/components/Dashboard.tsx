import React, { useEffect, useRef } from 'react';
import {
  Activity, Server, Clock, HardDrive, Cpu,
  CheckCircle, AlertTriangle, RefreshCw, Power,
  Database, Network, Monitor, Laptop, Printer,
  Terminal, Layers, Trash2
} from 'lucide-react';
import { SystemStatus, TransferLog, DhcpLease } from '../types';

interface DashboardProps {
  status: SystemStatus;
  onToggleService: (service: 'DHCP' | 'TFTP' | 'FTP', enabled: boolean) => void;
  dhcpLeasesCount: number;
  filesCount: number;
  hostsCount: number;
  consoleLogs: { timestamp: string; level: 'INFO' | 'SUCCESS' | 'WARN'; message: string }[];
  transferLogs: TransferLog[];
  onTriggerReboot: () => void;
  isPolling: boolean;
  leases?: DhcpLease[];
  onNavigateToTab?: (tab: 'dashboard' | 'dhcp' | 'files' | 'terminal' | 'settings') => void;
  onClearConsoleLogs: () => void;
  onClearTransfers: () => void;
}

export default function Dashboard({
  status,
  onToggleService,
  dhcpLeasesCount,
  filesCount,
  hostsCount,
  consoleLogs,
  transferLogs,
  onTriggerReboot,
  isPolling,
  leases = [],
  onNavigateToTab,
  onClearConsoleLogs,
  onClearTransfers
}: DashboardProps) {

  // Auto-scroll for the console log panel: mirrors the verified pattern in
  // TerminalAutomation.tsx (see CLAUDE.md). We track whether the user was
  // near the bottom *before* the latest log update landed via onScroll, so
  // the auto-scroll decision below is based on pre-update scroll position
  // rather than the already-grown scrollHeight (recomputing distance after
  // the DOM updates breaks auto-scroll when several log lines arrive at
  // once).
  const consoleLogContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const NEAR_BOTTOM_THRESHOLD = 80;

  const handleConsoleLogScroll = () => {
    const container = consoleLogContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
  };

  useEffect(() => {
    const container = consoleLogContainerRef.current;
    if (!container) return;

    if (isNearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [consoleLogs]);

  const formatUptime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getActiveTransfersCount = () => {
    return transferLogs.filter(t => t.status === 'IN_PROGRESS').length;
  };

  return (
    <div className="space-y-6" id="dashboard-tab animate-fade-in">
      {/* Header Info (Extremely Compact & Elegant) */}
      <div className="flex items-center justify-between gap-4 p-3.5 px-4 glass-card rounded-xl">
        <div className="flex items-center gap-2.5 min-w-0">
          <Activity className="w-4 h-4 text-emerald-400 animate-pulse shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-display font-bold text-white tracking-tight truncate">
              실시간 모니터링
            </h2>
            <p className="text-[10px] text-slate-400 truncate hidden sm:block">
              정상 가동 중
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isPolling && (
            <span className="flex items-center gap-1.5 text-[10px] font-bold badge-neon-emerald px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-active shrink-0"></span>
              API Connected
            </span>
          )}
        </div>
      </div>

      {/* Grid of Resource Stats (Slim and One-row Aligned) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* CPU */}
        <div className="p-3.5 glass-card rounded-xl flex items-center justify-between gap-4" id="stat-cpu">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-slate-950/80 border border-slate-850/60 rounded-lg text-emerald-400 shrink-0">
              <Cpu className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="block text-[11px] text-slate-400 font-bold tracking-wide">CPU 사용률</span>
              <span className="text-lg font-mono font-bold text-white leading-none">{status.cpuUsage}%</span>
            </div>
          </div>
          <div className="w-20 bg-slate-900/80 h-1.5 rounded-full overflow-hidden border border-slate-800/40 shrink-0">
            <div 
              className={`h-full transition-all duration-500 rounded-full ${status.cpuUsage > 70 ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.4)]' : status.cpuUsage > 40 ? 'bg-amber-400' : 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.4)]'}`}
              style={{ width: `${Math.min(status.cpuUsage, 100)}%` }}
            ></div>
          </div>
        </div>

        {/* MEMORY */}
        <div className="p-3.5 glass-card rounded-xl flex items-center justify-between gap-4" id="stat-mem">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-slate-950/80 border border-slate-850/60 rounded-lg text-indigo-400 shrink-0">
              <HardDrive className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="block text-[11px] text-slate-400 font-bold tracking-wide">메모리 (Memory)</span>
              <span className="text-lg font-mono font-bold text-white leading-none">{status.memoryUsage}%</span>
            </div>
          </div>
          <div className="w-20 bg-slate-900/80 h-1.5 rounded-full overflow-hidden border border-slate-800/40 shrink-0">
            <div 
              className="h-full bg-indigo-500 rounded-full shadow-[0_0_8px_rgba(99,102,241,0.4)] transition-all duration-500"
              style={{ width: `${Math.min(status.memoryUsage, 100)}%` }}
            ></div>
          </div>
        </div>

        {/* UPTIME */}
        <div className="p-3.5 glass-card rounded-xl flex items-center justify-between gap-4" id="stat-uptime">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-slate-950/80 border border-slate-850/60 rounded-lg text-emerald-400 shrink-0">
              <Clock className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="block text-[11px] text-slate-400 font-bold tracking-wide">시스템 가동 시간</span>
              <span className="text-base font-mono font-bold text-emerald-400 leading-none">{formatUptime(status.uptime)}</span>
            </div>
          </div>
          <span className="text-[9px] text-slate-500 font-medium shrink-0">자동 가동 중</span>
        </div>

        {/* TOTAL SERVICES */}
        <div className="p-3.5 glass-card rounded-xl flex items-center justify-between gap-4" id="stat-services">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-slate-950/80 border border-slate-850/60 rounded-lg text-indigo-400 shrink-0">
              <Server className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="block text-[11px] text-slate-400 font-bold tracking-wide">가동 서비스 상태</span>
              <div className="flex items-center gap-1.5 mt-0.5">
                <div className="flex items-center gap-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${status.dhcpRunning ? 'bg-emerald-400' : 'bg-slate-600'}`}></span>
                  <span className="text-[9px] text-slate-300 font-mono">DHCP</span>
                </div>
                <div className="flex items-center gap-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${status.tftpRunning ? 'bg-emerald-400' : 'bg-slate-600'}`}></span>
                  <span className="text-[9px] text-slate-300 font-mono">TFTP</span>
                </div>
                <div className="flex items-center gap-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${status.ftpRunning ? 'bg-emerald-400' : 'bg-slate-600'}`}></span>
                  <span className="text-[9px] text-slate-300 font-mono">FTP</span>
                </div>
              </div>
            </div>
          </div>
          <span className="text-[9px] text-slate-500 font-medium shrink-0">67,69,21 대기</span>
        </div>
      </div>

      {/* Services Rapid Switch Board (Compact Control Panel with minimal space) */}
      <div className="p-3.5 glass-card rounded-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-850 pb-2 mb-2.5">
          <h3 className="text-xs font-display font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Power className="w-3.5 h-3.5 text-indigo-400" />
            서비스 제어
          </h3>
          <span className="text-[10px] text-slate-500">클릭 한 번으로 즉시 켜기/끄기</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {/* DHCP Controller */}
          <div className={`p-2 px-3 rounded-lg border transition-all duration-300 flex items-center justify-between ${status.dhcpRunning ? 'bg-emerald-950/10 border-emerald-500/20' : 'bg-slate-950/20 border-slate-900/60'}`}>
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${status.dhcpRunning ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></span>
              <span className="font-bold text-white text-xs">DHCP Server</span>
              <span className="text-[10px] text-slate-400 font-mono">UDP 67</span>
            </div>
            <button 
              id="toggle-dhcp-dashboard-btn"
              onClick={() => onToggleService('DHCP', !status.dhcpRunning)}
              className={`px-2.5 py-1 rounded-md transition duration-200 flex items-center gap-1 text-[10px] font-bold cursor-pointer ${status.dhcpRunning ? 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 border border-rose-500/20' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
            >
              <Power className="w-3 h-3" />
              {status.dhcpRunning ? '중지' : '가동'}
            </button>
          </div>

          {/* TFTP Controller */}
          <div className={`p-2 px-3 rounded-lg border transition-all duration-300 flex items-center justify-between ${status.tftpRunning ? 'bg-indigo-950/10 border-indigo-500/20' : 'bg-slate-950/20 border-slate-900/60'}`}>
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${status.tftpRunning ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></span>
              <span className="font-bold text-white text-xs">TFTP Server</span>
              <span className="text-[10px] text-slate-400 font-mono">UDP 69</span>
            </div>
            <button 
              id="toggle-tftp-dashboard-btn"
              onClick={() => onToggleService('TFTP', !status.tftpRunning)}
              className={`px-2.5 py-1 rounded-md transition duration-200 flex items-center gap-1 text-[10px] font-bold cursor-pointer ${status.tftpRunning ? 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 border border-rose-500/20' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
            >
              <Power className="w-3 h-3" />
              {status.tftpRunning ? '중지' : '가동'}
            </button>
          </div>

          {/* FTP Controller */}
          <div className={`p-2 px-3 rounded-lg border transition-all duration-300 flex items-center justify-between ${status.ftpRunning ? 'bg-indigo-950/10 border-indigo-500/20' : 'bg-slate-950/20 border-slate-900/60'}`}>
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${status.ftpRunning ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></span>
              <span className="font-bold text-white text-xs">FTP Server</span>
              <span className="text-[10px] text-slate-400 font-mono">TCP 21</span>
            </div>
            <button 
              id="toggle-ftp-dashboard-btn"
              onClick={() => onToggleService('FTP', !status.ftpRunning)}
              className={`px-2.5 py-1 rounded-md transition duration-200 flex items-center gap-1 text-[10px] font-bold cursor-pointer ${status.ftpRunning ? 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 border border-rose-500/20' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
            >
              <Power className="w-3 h-3" />
              {status.ftpRunning ? '중지' : '가동'}
            </button>
          </div>
        </div>
      </div>

      {/* DHCP Leased Terminal Overview (Clean and readable table-list format) */}
      <div className="p-4 glass-card rounded-xl space-y-3">
        <div className="flex items-center justify-between border-b border-slate-850 pb-2">
          <div>
            <h3 className="text-xs font-display font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <Network className="w-3.5 h-3.5 text-indigo-400" />
              최근 DHCP 임대 현황
            </h3>
            <p className="text-[10px] text-slate-400">IP를 할당받은 단말 목록</p>
          </div>
          {onNavigateToTab && (
            <button
              onClick={() => onNavigateToTab('dhcp')}
              className="text-[10px] text-indigo-400 hover:text-indigo-300 font-bold flex items-center gap-1 cursor-pointer transition duration-200"
            >
              상세 관리 바로가기 <span className="text-sm">→</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-850/60 bg-slate-950/20">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900/60 border-b border-slate-850 text-slate-300 font-bold text-[10px]">
              <tr>
                <th className="p-2.5 pl-3">호스트명</th>
                <th className="p-2.5">종류</th>
                <th className="p-2.5">IP 주소</th>
                <th className="p-2.5">MAC</th>
                <th className="p-2.5 text-right pr-3">만료 시간</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850/30">
              {leases.slice(0, 5).map((lease) => {
                const name = lease.hostname.toLowerCase();
                let label = '일반 단말';
                let labelColor = 'text-slate-400 bg-slate-950 border border-slate-800';
                
                if (name.includes('db') || name.includes('sql') || name.includes('database') || name.includes('oracle')) {
                  label = 'DB 서버';
                  labelColor = 'text-indigo-400 bg-indigo-950/40 border border-indigo-900/30';
                } else if (name.includes('switch') || name.includes('router') || name.includes('edge') || name.includes('hub') || name.includes('backbone')) {
                  label = '네트워크 장비';
                  labelColor = 'text-emerald-400 bg-emerald-950/40 border border-emerald-900/30';
                } else if (name.includes('printer') || name.includes('print')) {
                  label = '스마트 프린터';
                  labelColor = 'text-amber-400 bg-amber-950/40 border border-amber-900/30';
                } else if (name.includes('laptop') || name.includes('notebook') || name.includes('macbook')) {
                  label = '사원 노트북';
                  labelColor = 'text-sky-400 bg-sky-950/40 border border-sky-900/30';
                } else if (name.includes('workstation') || name.includes('eng') || name.includes('desktop') || name.includes('pc')) {
                  label = '워크스테이션';
                  labelColor = 'text-violet-400 bg-violet-950/40 border border-violet-900/30';
                }

                return (
                  <tr key={lease.id} className="hover:bg-slate-900/20 text-slate-300 transition">
                    <td className="p-2.5 pl-3 font-mono font-bold text-white text-[11px]">{lease.hostname}</td>
                    <td className="p-2.5">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${labelColor}`}>
                        {label}
                      </span>
                    </td>
                    <td className="p-2.5 font-mono text-emerald-400 font-bold text-[11px]">{lease.ip}</td>
                    <td className="p-2.5 font-mono text-slate-400 text-[11px]">{lease.mac}</td>
                    <td className="p-2.5 text-right pr-3 text-[10px] text-slate-500">
                      {lease.expiresAt ? new Date(lease.expiresAt).toLocaleTimeString() : '무제한'}
                    </td>
                  </tr>
                );
              })}
              {leases.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-500 py-8 text-xs font-medium">
                    할당된 단말 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Console log & Transfers panels stacked vertically */}
      <div className="space-y-4">
        {/* DHCP & Server live activity logs (Full-width, compact height) */}
        <div className="p-4 glass-card rounded-xl flex flex-col h-[220px]">
          <div className="flex items-center justify-between mb-2 border-b border-slate-850 pb-1.5">
            <h3 className="text-xs font-display font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5 text-indigo-400" />
              실시간 로그
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-slate-500 font-mono hidden sm:inline">Real-time terminal standard out</span>
              <button
                id="clear-console-logs-btn"
                onClick={onClearConsoleLogs}
                title="로그 지우기"
                className="text-slate-400 hover:text-rose-400 border border-slate-850 bg-slate-950 p-1.5 rounded-lg text-xs cursor-pointer transition"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div
            ref={consoleLogContainerRef}
            onScroll={handleConsoleLogScroll}
            className="flex-1 bg-slate-950/60 border border-slate-850/40 rounded-lg p-3 font-mono text-[11px] overflow-y-auto space-y-1.5 terminal-glow text-slate-300"
          >
            {consoleLogs.map((log, index) => (
              <div key={index} className="flex items-start gap-2 leading-normal border-b border-slate-900/20 pb-1">
                <span className="text-slate-500 select-none shrink-0">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                <span className={`px-1 py-0.2 rounded text-[8px] font-bold shrink-0 ${
                  log.level === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                  log.level === 'WARN' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-slate-800 text-slate-400'
                }`}>
                  {log.level}
                </span>
                <span className="break-all">{log.message}</span>
              </div>
            ))}
            {consoleLogs.length === 0 && (
              <div className="text-slate-500 text-center py-6">로그 없음</div>
            )}
          </div>
        </div>

        {/* Current Active or Historical Transfers (Stacked below logs, full-width, compact height) */}
        <div className="p-4 glass-card rounded-xl flex flex-col h-[220px]">
          <div className="flex items-center justify-between mb-2 border-b border-slate-850 pb-1.5">
            <h3 className="text-xs font-display font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              최근 전송 이력
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400">
                진행 중: <strong className="text-indigo-400">{getActiveTransfersCount()}</strong>
              </span>
              <button
                id="clear-transfers-btn"
                onClick={onClearTransfers}
                title="로그 지우기"
                className="text-slate-400 hover:text-rose-400 border border-slate-850 bg-slate-950 p-1.5 rounded-lg text-xs cursor-pointer transition"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto rounded-lg border border-slate-850/60 bg-slate-950/40">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/80 border-b border-slate-850 text-slate-400 font-bold text-[10px] sticky top-0">
                <tr>
                  <th className="p-2 pl-3">서비스</th>
                  <th className="p-2">파일명</th>
                  <th className="p-2">크기</th>
                  <th className="p-2">클라이언트 IP</th>
                  <th className="p-2 text-right pr-3">상태</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850/30">
                {transferLogs.slice().reverse().map((log) => (
                  <tr key={log.id} className="hover:bg-slate-900/10 text-slate-300 text-[11px]">
                    <td className="p-2 pl-3">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                        log.service === 'FTP' ? 'bg-blue-500/10 text-blue-400 border border-blue-550/20' : 'bg-purple-500/10 text-purple-400 border border-purple-550/20'
                      }`}>
                        {log.service}
                      </span>
                    </td>
                    <td className="p-2 font-bold text-slate-200">
                      <div className="truncate max-w-[280px]" title={log.fileName}>
                        {log.fileName}
                      </div>
                    </td>
                    <td className="p-2 font-mono text-slate-400 text-[10px]">{(log.fileSize / 1024).toFixed(1)} KB</td>
                    <td className="p-2 font-mono text-slate-400">{log.clientIp}</td>
                    <td className="p-2 text-right pr-3">
                      {log.status === 'IN_PROGRESS' ? (
                        <div className="inline-flex items-center gap-2">
                          <span className="text-amber-400 font-bold text-[10px]">전송 중 ({log.progress}%)</span>
                          <span className="text-slate-500 font-mono text-[9px]">{log.speed}</span>
                          <div className="w-12 bg-slate-900 h-1 rounded-full overflow-hidden border border-slate-800">
                            <div className="bg-amber-400 h-full" style={{ width: `${log.progress}%` }}></div>
                          </div>
                        </div>
                      ) : log.status === 'COMPLETED' ? (
                        <div className="inline-flex items-center gap-1 text-emerald-400 font-bold text-[10px]">
                          <CheckCircle className="w-3 h-3" />
                          <span>완료</span>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1 text-rose-400 font-bold text-[10px]">
                          <AlertTriangle className="w-3 h-3" />
                          <span>실패</span>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {transferLogs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-slate-500 py-6 text-xs">
                      전송 이력 없음
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
