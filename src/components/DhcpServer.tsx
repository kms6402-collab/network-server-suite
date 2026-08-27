import React, { useState, useEffect } from 'react';
import {
  Server, Network, Plus, Trash2, ShieldAlert,
  HelpCircle, RefreshCw, Layers, Check, Database,
  Search, Monitor, Laptop, Cpu, Printer, LayoutGrid, List, ArrowRight, Clock, Wifi, User, Settings,
  Radar, X, AlertCircle, Download
} from 'lucide-react';
import { DhcpConfig, DhcpLease, DhcpReservation, TerminalHost } from '../types';

interface DhcpServerProps {
  dhcpRunning: boolean;
  config: DhcpConfig;
  leases: DhcpLease[];
  reservations: DhcpReservation[];
  terminalHosts: TerminalHost[];
  onToggleDhcp: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  onUpdateConfig: (newConfig: DhcpConfig) => Promise<{ success: boolean; error?: string }>;
  onAddReservation: (mac: string, ip: string, hostname: string) => void;
  onRemoveReservation: (id: string) => void;
  onClearLeases: () => void;
  onRemoveLease: (id: string) => void;
  onRenewLease: (id: string) => void;
  onRefreshDiscovery: () => void;
}

export default function DhcpServer({
  dhcpRunning,
  config,
  leases,
  reservations,
  terminalHosts,
  onToggleDhcp,
  onUpdateConfig,
  onAddReservation,
  onRemoveReservation,
  onClearLeases,
  onRemoveLease,
  onRenewLease,
  onRefreshDiscovery
}: DhcpServerProps) {
  // Feedback banner for "설정 적용" (save config) and service toggle actions —
  // both were previously silent on both success and failure.
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 4500);
    return () => clearTimeout(timer);
  }, [feedback]);
  
  // Local state for configuration form
  const [interfaceName, setInterfaceName] = useState(config.interfaceName);
  const [rangeStart, setRangeStart] = useState(config.rangeStart);
  const [rangeEnd, setRangeEnd] = useState(config.rangeEnd);
  const [subnetMask, setSubnetMask] = useState(config.subnetMask);
  const [gateway, setGateway] = useState(config.gateway);
  const [dns, setDns] = useState(config.dns);
  const [leaseTime, setLeaseTime] = useState(config.leaseTime);

  // Advanced filters for Leases
  const [searchTerm, setSearchTerm] = useState("");
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');

  const getIpStatusMap = () => {
    try {
      const startParts = rangeStart.split(".");
      const endParts = rangeEnd.split(".");
      if (startParts.length !== 4 || endParts.length !== 4) return [];
      
      const startOctet = parseInt(startParts[3]);
      const endOctet = parseInt(endParts[3]);
      const baseIp = `${startParts[0]}.${startParts[1]}.${startParts[2]}.`;
      
      if (isNaN(startOctet) || isNaN(endOctet) || startOctet > endOctet) return [];
      
      // Limit to max 150 cells for display safety
      const limit = Math.min(endOctet - startOctet + 1, 150);
      const ipList = [];
      
      for (let i = 0; i < limit; i++) {
        const currentOctet = startOctet + i;
        const currentIp = `${baseIp}${currentOctet}`;
        
        // Find if leased or reserved
        const lease = leases.find(l => l.ip === currentIp);
        const reservation = reservations.find(r => r.ip === currentIp);
        
        let status: 'leased' | 'reserved' | 'self' | 'available' = 'available';
        let hostname = '미할당';
        let online: boolean | undefined = undefined;

        if (lease) {
          status = lease.id === 'host-pc-self' ? 'self' : 'leased';
          hostname = lease.hostname;
          online = lease.online;
        } else if (reservation) {
          status = 'reserved';
          hostname = `${reservation.hostname} (예약)`;
        }

        ipList.push({
          ip: currentIp,
          octet: currentOctet,
          status,
          hostname,
          online
        });
      }
      return ipList;
    } catch (e) {
      return [];
    }
  };

  // Available physical network interfaces state
  const [interfaces, setInterfaces] = useState<{name: string, ip: string, mac: string, netmask: string, internal: boolean}[]>([]);
  const [interfacesLoaded, setInterfacesLoaded] = useState(false);
  const [refreshingInterfaces, setRefreshingInterfaces] = useState(false);

  // Re-fetch the adapter list from the backend. Runs once on mount, and can
  // also be triggered on demand via the "새로고침" button next to the
  // binding adapter dropdown so newly plugged-in/enabled adapters show up
  // without reloading the whole page.
  const fetchInterfaces = async () => {
    setRefreshingInterfaces(true);
    try {
      const res = await fetch("/api/interfaces");
      if (res.ok) {
        const data = await res.json();
        setInterfaces(data.interfaces || []);
      }
    } catch (err) {
      console.error("Failed to load network interfaces", err);
    } finally {
      setInterfacesLoaded(true);
      setRefreshingInterfaces(false);
    }
  };

  useEffect(() => {
    fetchInterfaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Full ARP-cache snapshot for the "ARP 캐시 테이블" panel below — this polls
  // independently of App.tsx's 1.5s status polling (own useState/useEffect, same
  // self-contained pattern as fetchInterfaces above) so it works even without any
  // wiring changes to App.tsx.
  const [arpEntries, setArpEntries] = useState<{ ip: string; mac: string; matched: 'lease' | 'reservation' | 'unmanaged' }[]>([]);
  const [arpLoading, setArpLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchArpTable = async () => {
      setArpLoading(true);
      try {
        const res = await fetch("/api/dhcp/arp-table");
        if (res.ok && !cancelled) {
          const data = await res.json();
          setArpEntries(data.entries || []);
        }
      } catch (err) {
        console.error("Failed to load ARP table", err);
      } finally {
        if (!cancelled) setArpLoading(false);
      }
    };
    fetchArpTable();
    const interval = setInterval(fetchArpTable, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Re-sync local form state whenever the server-side config actually changes
  // value (e.g. after the backend self-heals the gateway/range to match this
  // host's real adapter). Only setInterfaceName was wired up before, so the
  // other fields (gateway in particular) kept showing whatever stale value the
  // form happened to have at first mount, even after the backend fixed itself.
  useEffect(() => {
    setInterfaceName(config.interfaceName);
  }, [config.interfaceName]);
  useEffect(() => {
    setRangeStart(config.rangeStart);
  }, [config.rangeStart]);
  useEffect(() => {
    setRangeEnd(config.rangeEnd);
  }, [config.rangeEnd]);
  useEffect(() => {
    setSubnetMask(config.subnetMask);
  }, [config.subnetMask]);
  useEffect(() => {
    setGateway(config.gateway);
  }, [config.gateway]);
  useEffect(() => {
    setDns(config.dns);
  }, [config.dns]);
  useEffect(() => {
    setLeaseTime(config.leaseTime);
  }, [config.leaseTime]);

  // If the configured adapter isn't among the real adapters on this PC (e.g. stale
  // config from a different machine), fall back to the first real adapter so the
  // dropdown always reflects an adapter that actually exists here.
  useEffect(() => {
    if (!interfacesLoaded || interfaces.length === 0) return;
    const stillValid = interfaces.some(i => i.name === interfaceName);
    if (!stillValid) {
      handleInterfaceChange(interfaces[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interfacesLoaded, interfaces]);

  // Handler to auto-calculate and align IP range when selecting an interface
  const handleInterfaceChange = (newInterfaceName: string) => {
    setInterfaceName(newInterfaceName);
    const selected = interfaces.find(i => i.name === newInterfaceName);
    if (selected) {
      const ipParts = selected.ip.split(".");
      if (ipParts.length === 4) {
        const subnetBase = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
        setRangeStart(`${subnetBase}.100`);
        setRangeEnd(`${subnetBase}.200`);
        // This app is itself the DHCP server, so the gateway it hands out must be
        // its own real interface IP, not a guessed "x.x.x.1".
        setGateway(selected.ip);
        setSubnetMask(selected.netmask || "255.255.255.0");
      }
    }
  };

  // Local state for static reservation form
  const [resMac, setResMac] = useState("");
  const [resIp, setResIp] = useState("");
  const [resHostname, setResHostname] = useState("");

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingConfig(true);
    try {
      const result = await onUpdateConfig({
        interfaceName,
        rangeStart,
        rangeEnd,
        subnetMask,
        gateway,
        dns,
        leaseTime: Number(leaseTime)
      });
      if (result?.success === false) {
        setFeedback({ type: 'error', message: result.error || 'DHCP 설정 적용에 실패했습니다.' });
      } else {
        setFeedback({ type: 'success', message: 'DHCP 설정이 성공적으로 적용되었습니다.' });
      }
    } catch (err) {
      setFeedback({ type: 'error', message: '설정을 적용하는 중 오류가 발생했습니다.' });
    } finally {
      setSavingConfig(false);
    }
  };

  // "임대 서비스 가동" now actually opens a real UDP DHCP socket, which can
  // collide with an existing DHCP server on this network (e.g. the router).
  // Gate turning it ON with a one-time-per-session confirmation instead of
  // nagging on every click; turning it OFF needs no confirmation.
  const handleToggleClick = async () => {
    if (!dhcpRunning) {
      const alreadyAcknowledged = sessionStorage.getItem('dhcp-conflict-risk-ack') === '1';
      if (!alreadyAcknowledged) {
        const confirmed = window.confirm(
          '이 네트워크에 이미 다른 DHCP 서버(공유기 등)가 있으면 충돌할 수 있습니다. 계속하시겠습니까?'
        );
        if (!confirmed) return;
        sessionStorage.setItem('dhcp-conflict-risk-ack', '1');
      }
    }

    const result = await onToggleDhcp(!dhcpRunning);
    if (result?.success === false) {
      setFeedback({ type: 'error', message: result.error || 'DHCP 서비스 전환에 실패했습니다.' });
    } else if (!dhcpRunning) {
      setFeedback({ type: 'success', message: 'DHCP 서버가 가동되었습니다.' });
    }
  };

  const handleAddReservation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!resMac || !resIp || !resHostname) return;
    onAddReservation(resMac, resIp, resHostname);
    setResMac("");
    setResIp("");
    setResHostname("");
  };

  // Online/offline status indicator derived from the backend's periodic ping
  // sweep (`lease.online` / `lease.lastCheckedAt`). `online === undefined` means
  // the sweep hasn't checked this lease's IP yet (e.g. it was just discovered).
  const getOnlineIndicator = (lease: DhcpLease) => {
    if (lease.online === undefined) {
      return { dotClass: 'bg-slate-500', label: '확인 중', pulse: false };
    }
    if (lease.online) {
      return { dotClass: 'bg-emerald-400', label: '온라인', pulse: true };
    }
    return { dotClass: 'bg-rose-500', label: '오프라인', pulse: false };
  };

  // Helper function to dynamically identify device type and choose design styles
  const getDeviceDetails = (hostname: string) => {
    const name = hostname.toLowerCase();
    if (name.includes('db') || name.includes('sql') || name.includes('database') || name.includes('oracle')) {
      return {
        icon: <Database className="w-5 h-5 text-indigo-400" />,
        bg: 'from-indigo-600/10 to-blue-600/10 border-indigo-500/20 bg-indigo-950/20',
        label: 'DB 서버',
        badgeColor: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
      };
    }
    if (name.includes('switch') || name.includes('router') || name.includes('edge') || name.includes('hub') || name.includes('backbone')) {
      return {
        icon: <Network className="w-5 h-5 text-emerald-400" />,
        bg: 'from-emerald-600/10 to-teal-600/10 border-emerald-500/20 bg-emerald-950/20',
        label: '코어 스위치',
        badgeColor: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      };
    }
    if (name.includes('printer') || name.includes('print')) {
      return {
        icon: <Printer className="w-5 h-5 text-amber-400" />,
        bg: 'from-amber-600/10 to-orange-600/10 border-amber-500/20 bg-amber-950/20',
        label: '네트워크 프린터',
        badgeColor: 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      };
    }
    if (name.includes('laptop') || name.includes('notebook') || name.includes('macbook')) {
      return {
        icon: <Laptop className="w-5 h-5 text-sky-400" />,
        bg: 'from-sky-600/10 to-blue-600/10 border-sky-500/20 bg-sky-950/20',
        label: '무선 단말',
        badgeColor: 'bg-sky-500/15 text-sky-300 border-sky-500/30'
      };
    }
    if (name.includes('workstation') || name.includes('eng') || name.includes('desktop') || name.includes('pc')) {
      return {
        icon: <Monitor className="w-5 h-5 text-violet-400" />,
        bg: 'from-violet-600/10 to-fuchsia-600/10 border-violet-500/20 bg-violet-950/20',
        label: '워크스테이션',
        badgeColor: 'bg-violet-500/15 text-violet-300 border-violet-500/30'
      };
    }
    return {
      icon: <Cpu className="w-5 h-5 text-slate-400" />,
      bg: 'from-slate-600/10 to-zinc-600/10 border-slate-700/50 bg-slate-900/20',
      label: '일반 단말',
      badgeColor: 'bg-slate-500/15 text-slate-300 border-slate-500/30'
    };
  };

  // CDP/LLDP neighbor lookup for a lease in the active-lease list. If the
  // lease's IP matches an already-registered TerminalHost (자동화 접속 대상 장비),
  // we can query immediately using that host's saved credentials. Otherwise we
  // need a one-off set of connection details from the user — that's what the
  // 'form' mode below collects (never persisted, used for this single request
  // only).
  const [neighborModal, setNeighborModal] = useState<{ lease: DhcpLease; mode: 'form' | 'loading' | 'result' } | null>(null);
  const [neighborResult, setNeighborResult] = useState<{ success: boolean; output?: string; error?: string } | null>(null);
  const [credProtocol, setCredProtocol] = useState<'SSH' | 'TELNET'>('SSH');
  const [credPort, setCredPort] = useState(22);
  const [credUsername, setCredUsername] = useState('');
  const [credPassword, setCredPassword] = useState('');

  const runNeighborQuery = async (payload: Record<string, unknown>) => {
    setNeighborModal(prev => (prev ? { ...prev, mode: 'loading' } : prev));
    setNeighborResult(null);
    try {
      const res = await fetch('/api/terminal/neighbors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      setNeighborResult(data);
    } catch (err: any) {
      setNeighborResult({ success: false, error: err?.message || '요청 중 알 수 없는 오류가 발생했습니다.' });
    } finally {
      setNeighborModal(prev => (prev ? { ...prev, mode: 'result' } : prev));
    }
  };

  const handleOpenNeighborQuery = (lease: DhcpLease) => {
    const matchedHost = terminalHosts.find(h => h.ip === lease.ip);
    if (matchedHost) {
      setNeighborModal({ lease, mode: 'loading' });
      setNeighborResult(null);
      runNeighborQuery({ hostId: matchedHost.id });
    } else {
      setCredProtocol('SSH');
      setCredPort(22);
      setCredUsername('');
      setCredPassword('');
      setNeighborResult(null);
      setNeighborModal({ lease, mode: 'form' });
    }
  };

  const handleSubmitAdhocNeighborQuery = (e: React.FormEvent) => {
    e.preventDefault();
    if (!neighborModal || !credUsername) return;
    runNeighborQuery({
      ip: neighborModal.lease.ip,
      port: credPort,
      protocol: credProtocol,
      username: credUsername,
      password: credPassword || undefined
    });
  };

  const closeNeighborModal = () => {
    setNeighborModal(null);
    setNeighborResult(null);
  };

  // Filtered leases based on search term
  const filteredLeases = leases.filter(lease => {
    const term = searchTerm.toLowerCase();
    return (
      lease.hostname.toLowerCase().includes(term) ||
      lease.ip.toLowerCase().includes(term) ||
      lease.mac.toLowerCase().includes(term)
    );
  });

  // Standard CSV field escaping: wrap every value in double quotes, and
  // double-up any double quotes already inside the value.
  const csvField = (value: string) => `"${value.replace(/"/g, '""')}"`;

  // Export the currently-visible (search-filtered) lease list as a CSV file.
  // Client-side only, same Blob + URL.createObjectURL download pattern used
  // by TerminalAutomation's log export, but built fresh here for CSV rows.
  const handleExportLeases = () => {
    const onlineLabelFor = (lease: DhcpLease) => {
      if (lease.online === undefined) return '확인중';
      return lease.online ? '온라인' : '오프라인';
    };

    const header = ['호스트명', 'IP주소', 'MAC주소', '인터페이스', '임대시작', '만료시간', '상태', '온라인여부'];
    const rows = filteredLeases.map(lease => [
      lease.hostname,
      lease.ip,
      lease.mac,
      lease.interfaceName,
      new Date(lease.leasedAt).toLocaleString(),
      new Date(lease.expiresAt).toLocaleString(),
      lease.status === 'reserved' ? '고정예약' : '대여중',
      onlineLabelFor(lease)
    ]);

    const csvContent = [header, ...rows]
      .map(row => row.map(cell => csvField(String(cell))).join(','))
      .join('\r\n');

    // UTF-8 BOM so Excel doesn't mangle Korean text.
    const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `dhcp-leases-${timestamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 animate-fade-in" id="dhcp-tab">
      {/* Feedback banner for save-config / service-toggle actions */}
      {feedback && (
        <div
          id="dhcp-feedback-banner"
          className={`p-3.5 rounded-xl border flex items-center gap-2.5 text-xs font-semibold animate-fade-in ${
            feedback.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}
        >
          {feedback.type === 'success' ? <Check className="w-4 h-4 shrink-0" /> : <ShieldAlert className="w-4 h-4 shrink-0" />}
          <span>{feedback.message}</span>
        </div>
      )}

      {/* Interface & Service Toggle (Simple and clear) */}
      <div className="p-5 glass-card rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className={`p-3.5 rounded-xl border transition-all duration-300 ${dhcpRunning ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
            <Network className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h2 className="text-lg font-display font-bold text-white flex items-center gap-2">
              DHCP 자동 IP 임대 서버
              <span className={`text-xs px-2.5 py-0.5 rounded-full font-sans font-semibold tracking-wide ${dhcpRunning ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-900' : 'bg-rose-500/10 text-rose-400 border border-rose-900'}`}>
                {dhcpRunning ? '● 서버 가동중' : '○ 서버 일시 중지'}
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              <strong className="text-indigo-400 font-mono">{config.interfaceName}</strong> 어댑터에서 IP를 자동 임대합니다.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            id="toggle-dhcp-btn"
            onClick={handleToggleClick}
            className={`px-5 py-3 rounded-xl text-xs font-bold tracking-wider uppercase transition-all duration-200 flex items-center gap-2 shadow-lg cursor-pointer ${
              dhcpRunning
                ? 'bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white shadow-rose-950/20'
                : 'bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white shadow-indigo-950/20'
            }`}
          >
            <Server className="w-4 h-4" />
            {dhcpRunning ? '임대 서비스 정지' : '임대 서비스 가동'}
          </button>
        </div>
      </div>

      {/* REAL NETWORK DEVICE DISCOVERY */}
      <div className="p-5 glass-card rounded-2xl space-y-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-display font-bold text-indigo-300 uppercase tracking-wider flex items-center gap-1.5">
              <Wifi className="w-4 h-4 text-emerald-400" />
              네트워크 단말 탐지
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              가동 중일 때 4초마다 단말을 탐지하고, 6초마다 온라인 상태를 갱신합니다.
            </p>
          </div>
          <button
            id="refresh-discovery-btn"
            onClick={onRefreshDiscovery}
            disabled={!dhcpRunning}
            className="px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 border border-slate-850 bg-slate-950 text-slate-300 hover:text-white hover:border-indigo-500/40 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
            title={dhcpRunning ? "네트워크 다시 스캔" : "서비스를 먼저 가동하세요"}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            지금 새로고침
          </button>
        </div>
      </div>

      {/* DHCP IP 주소 풀 설정 (Horizontal Top-Bar Layout) */}
      <form onSubmit={handleSaveConfig} className="p-4 glass-card rounded-2xl space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-850 pb-1.5 gap-1.5">
          <div>
            <h3 className="text-xs font-display font-bold text-white flex items-center gap-1.5">
              <Settings className="w-3.5 h-3.5 text-indigo-400" />
              DHCP 서버 설정
            </h3>
            <p className="text-[10px] text-slate-400 mt-0.5">IP 대역과 서브넷을 설정합니다.</p>
          </div>
          <span className="text-[9px] text-indigo-400 bg-indigo-950/40 border border-indigo-900/40 px-2 py-0.5 rounded font-mono font-bold">
            Gateway/Server: {gateway || '미지정'}
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-8 gap-3 items-end text-xs">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-slate-400 font-bold text-[10px] truncate">바인딩 어댑터</label>
              <button
                type="button"
                id="refresh-interfaces-btn"
                onClick={fetchInterfaces}
                disabled={refreshingInterfaces}
                className="text-slate-400 hover:text-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition shrink-0"
                title="어댑터 목록 새로고침"
              >
                <RefreshCw className={`w-3 h-3 ${refreshingInterfaces ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <select
              className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 text-white font-sans text-[11px] focus:outline-none focus:border-indigo-500/80 transition cursor-pointer"
              value={interfaceName}
              onChange={(e) => handleInterfaceChange(e.target.value)}
            >
              {interfaces.map((i) => (
                <option key={i.name} value={i.name}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-slate-400 font-bold mb-1 text-[10px] truncate">IP 시작 대역</label>
            <input 
              type="text" 
              className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 text-white font-mono text-[11px] focus:outline-none focus:border-indigo-500/80 transition"
              value={rangeStart}
              onChange={(e) => setRangeStart(e.target.value)}
              placeholder="192.168.1.100"
              required
            />
          </div>

          <div>
            <label className="block text-slate-400 font-bold mb-1 text-[10px] truncate">IP 종료 대역</label>
            <input 
              type="text" 
              className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 text-white font-mono text-[11px] focus:outline-none focus:border-indigo-500/80 transition"
              value={rangeEnd}
              onChange={(e) => setRangeEnd(e.target.value)}
              placeholder="192.168.1.200"
              required
            />
          </div>

          <div>
            <label className="block text-slate-400 font-bold mb-1 text-[10px] truncate">서브넷 마스크</label>
            <input 
              type="text" 
              className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 text-white font-mono text-[11px] focus:outline-none focus:border-indigo-500/80 transition"
              value={subnetMask}
              onChange={(e) => setSubnetMask(e.target.value)}
              placeholder="255.255.255.0"
              required
            />
          </div>

          <div>
            <label className="block text-slate-400 font-bold mb-1 text-[10px] truncate">기본 게이트웨이</label>
            <input 
              type="text" 
              className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 text-white font-mono text-[11px] focus:outline-none focus:border-indigo-500/80 transition"
              value={gateway}
              onChange={(e) => setGateway(e.target.value)}
              placeholder="192.168.1.1"
              required
            />
          </div>

          <div>
            <label className="block text-slate-400 font-bold mb-1 text-[10px] truncate">기본 DNS 서버</label>
            <input 
              type="text" 
              className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 text-white font-mono text-[11px] focus:outline-none focus:border-indigo-500/80 transition"
              value={dns}
              onChange={(e) => setDns(e.target.value)}
              placeholder="8.8.8.8"
              required
            />
          </div>

          <div>
            <label className="block text-slate-400 font-bold mb-1 text-[10px] truncate">임대 시간 (분)</label>
            <input 
              type="number" 
              className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 text-white font-mono text-[11px] focus:outline-none focus:border-indigo-500/80 transition"
              value={leaseTime}
              onChange={(e) => setLeaseTime(Number(e.target.value))}
              placeholder="120"
              min="1"
              required
            />
          </div>

          <div>
            <button
              id="save-dhcp-config-btn"
              type="submit"
              disabled={savingConfig}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg p-2 font-bold transition text-[11px] h-[36px] flex items-center justify-center gap-1 cursor-pointer shadow-md shadow-indigo-950/40 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${savingConfig ? 'animate-spin' : ''}`} />
              설정 적용
            </button>
          </div>
        </div>
      </form>

      {/* Main Stack: Full-Width Stacked Cards with No Hidden Sidebars */}
      <div className="space-y-4">
        
        {/* IP Address Status Map */}
        <div className="p-4 glass-card rounded-xl space-y-3">
          <div>
            <h3 className="text-xs font-display font-bold text-white flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              IP 사용 현황
            </h3>
            <p className="text-[10px] text-slate-400 mt-0.5">
              IP 임대 풀(<strong className="text-emerald-400 font-mono">{rangeStart} ~ {rangeEnd}</strong>) 점유/여유 현황입니다.
            </p>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-3 text-[9px] text-slate-400 bg-slate-950/40 p-2 rounded-lg border border-slate-850/40">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded bg-emerald-500/20 border border-emerald-500/40"></span>
              <span>동적 할당</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded bg-indigo-500/20 border border-indigo-500/40"></span>
              <span>고정 예약</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded bg-sky-500/20 border border-sky-500/40"></span>
              <span>내 PC</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded bg-slate-800/40 border border-slate-700/40"></span>
              <span>여유</span>
            </div>
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              <span>온라인</span>
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
              <span>오프라인</span>
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
              <span>확인 중</span>
            </div>
          </div>

          {/* Grid Map */}
          {(() => {
            const ipStatusMap = getIpStatusMap();
            return ipStatusMap.length > 0 ? (
              <div className="grid grid-cols-6 sm:grid-cols-10 md:grid-cols-15 lg:grid-cols-20 gap-1 p-2.5 bg-slate-950/60 border border-slate-850/60 rounded-xl max-h-[140px] overflow-y-auto">
                {ipStatusMap.map((cell) => {
                  let bgClass = "bg-slate-800/10 border-slate-700/30 hover:bg-slate-800/40 text-slate-500";
                  let titleStatus = "여유";

                  if (cell.status === 'leased') {
                    bgClass = "bg-emerald-500/20 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/30 shadow-[0_0_6px_rgba(16,185,129,0.1)]";
                    titleStatus = "대여중";
                  } else if (cell.status === 'reserved') {
                    bgClass = "bg-indigo-500/20 border-indigo-500/40 text-indigo-400 hover:bg-indigo-500/30 shadow-[0_0_6px_rgba(99,102,241,0.1)]";
                    titleStatus = "예약중";
                  } else if (cell.status === 'self') {
                    bgClass = "bg-sky-500/20 border-sky-500/40 text-sky-400 hover:bg-sky-500/30 shadow-[0_0_6px_rgba(14,165,233,0.1)] font-bold";
                    titleStatus = "내 PC";
                  }

                  const hasLeaseLikeStatus = cell.status !== 'available';
                  const onlineDotClass = cell.online === undefined
                    ? "bg-slate-500"
                    : cell.online ? "bg-emerald-400 animate-pulse" : "bg-rose-500";
                  const onlineLabel = cell.online === undefined ? "확인 중" : cell.online ? "온라인" : "오프라인";

                  return (
                    <div
                      key={cell.ip}
                      className={`relative p-0.5 rounded border text-center font-mono text-[9px] select-none transition duration-150 ${bgClass}`}
                      title={`IP: ${cell.ip}\n상태: ${titleStatus}\n장비명: ${cell.hostname}${hasLeaseLikeStatus ? `\n온라인 상태: ${onlineLabel}` : ''}`}
                    >
                      {hasLeaseLikeStatus && (
                        <span className={`absolute top-[1px] right-[1px] w-1 h-1 rounded-full ${onlineDotClass}`}></span>
                      )}
                      <div className="font-bold">.{cell.octet}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center text-slate-500 py-4 text-xs bg-slate-950/40 border border-slate-850 rounded-xl">
                IP 대역 형식이 올바르지 않습니다.
              </div>
            );
          })()}
        </div>

        {/* Active leases list */}
        <div className="p-4 glass-card rounded-xl space-y-3">
          
          {/* Filter toolbar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-1.5 border-b border-slate-850/60">
            <div>
              <h3 className="text-xs font-display font-bold text-white flex items-center gap-1.5">
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                할당 단말 현황 ({filteredLeases.length})
              </h3>
              <p className="text-[10px] text-slate-400 mt-0.5">IP를 할당받은 단말 목록입니다.</p>
            </div>
            
            <div className="flex items-center gap-2">
              {/* Search box */}
              <div className="relative">
                <Search className="w-3 h-3 text-slate-500 absolute left-2 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="단말 검색 (이름, IP, MAC)"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="bg-slate-950 border border-slate-850 text-[10px] rounded-lg pl-7 pr-3 py-1.5 text-white w-[160px] focus:outline-none focus:border-indigo-500 transition"
                />
              </div>

              {/* View toggles */}
              <div className="bg-slate-950 p-1 rounded-lg border border-slate-850 flex items-center gap-0.5">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-1 rounded cursor-pointer ${viewMode === 'grid' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}
                  title="카드 그리드 뷰"
                >
                  <LayoutGrid className="w-3 h-3" />
                </button>
                <button
                  onClick={() => setViewMode('table')}
                  className={`p-1 rounded cursor-pointer ${viewMode === 'table' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}
                  title="컴팩트 테이블 뷰"
                >
                  <List className="w-3 h-3" />
                </button>
              </div>

              {/* Export current (filtered) leases as CSV */}
              <button
                id="export-leases-btn"
                onClick={handleExportLeases}
                className="text-slate-400 hover:text-emerald-400 border border-slate-850 bg-slate-950 p-1.5 rounded-lg text-xs cursor-pointer transition"
                title="CSV로 내보내기"
              >
                <Download className="w-3 h-3" />
              </button>

              {/* Flush leases */}
              <button
                id="clear-leases-btn"
                onClick={onClearLeases}
                className="text-slate-400 hover:text-rose-400 border border-slate-850 bg-slate-950 p-1.5 rounded-lg text-xs cursor-pointer transition"
                title="임대 목록 비우기"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* MAIN LEASES RENDERING */}
          {viewMode === 'grid' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {filteredLeases.map((lease) => {
                const dev = getDeviceDetails(lease.hostname);
                const onlineInd = getOnlineIndicator(lease);
                return (
                  <div
                    key={lease.id}
                    className={`p-3 rounded-xl border bg-gradient-to-br transition-all duration-300 relative overflow-hidden group ${dev.bg} hover:scale-[1.01]`}
                  >
                    <div className="absolute top-0 right-0 p-6 opacity-5 group-hover:scale-125 transition-transform duration-300">
                      {dev.icon}
                    </div>

                    <div className="flex items-start justify-between gap-2 relative z-10">
                      <div className="flex items-center gap-1.5">
                        <div className="p-1.5 bg-slate-950/80 border border-slate-850 rounded-lg">
                          {dev.icon}
                        </div>
                        <div>
                          <div className="text-[11px] font-bold text-white flex items-center gap-1.5">
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${onlineInd.dotClass} ${onlineInd.pulse ? 'animate-pulse' : ''}`}
                              title={onlineInd.label}
                            ></span>
                            {lease.hostname}
                            {lease.id === 'host-pc-self' && (
                              <span className="text-[8px] bg-slate-100 text-slate-900 px-1 py-0.2 rounded uppercase font-bold tracking-widest font-sans">
                                ME
                              </span>
                            )}
                          </div>
                          <div className="text-[9px] text-slate-400 font-medium truncate max-w-[120px]">{dev.label} · {onlineInd.label}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <span className={`px-1.5 py-0.2 rounded text-[8px] font-bold border ${
                          lease.status === 'reserved'
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                            : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                        }`}>
                          {lease.status === 'reserved' ? 'STATIC' : 'DYNAMIC'}
                        </span>
                        {lease.id !== 'host-pc-self' && (
                          <button
                            id={`neighbors-lease-${lease.id}`}
                            onClick={() => handleOpenNeighborQuery(lease)}
                            className="text-slate-400 hover:text-sky-400 p-0.5 rounded transition cursor-pointer"
                            title="CDP/LLDP 이웃 정보 조회"
                          >
                            <Radar className="w-3 h-3" />
                          </button>
                        )}
                        {lease.id !== 'host-pc-self' && (
                          <button
                            id={`renew-lease-${lease.id}`}
                            onClick={() => onRenewLease(lease.id)}
                            className="text-slate-400 hover:text-indigo-400 p-0.5 rounded transition cursor-pointer"
                            title="임대 갱신"
                          >
                            <RefreshCw className="w-3 h-3" />
                          </button>
                        )}
                        {lease.id !== 'host-pc-self' && (
                          <button
                            id={`remove-lease-${lease.id}`}
                            onClick={() => onRemoveLease(lease.id)}
                            className="text-slate-400 hover:text-rose-400 p-0.5 rounded transition cursor-pointer"
                            title="임대 반환"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 p-2 bg-slate-950/80 border border-slate-850 rounded-lg flex items-center justify-between relative z-10">
                      <span className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider">임대 IP</span>
                      <span className="font-mono text-[11px] font-bold text-emerald-400 select-all">
                        {lease.ip}
                      </span>
                    </div>

                    <div className="mt-2.5 space-y-1 text-[9px] text-slate-400 border-t border-slate-850/60 pt-2 relative z-10">
                      <div className="flex justify-between">
                        <span className="text-slate-500">MAC 주소</span>
                        <span className="font-mono text-white select-all">{lease.mac}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">대여 시간</span>
                        <span className="text-slate-300">{new Date(lease.leasedAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredLeases.length === 0 && (
                <div className="col-span-full text-center text-slate-500 py-10 font-medium text-xs">검색 결과가 없습니다.</div>
              )}
            </div>
          ) : (
            /* Compact list representation (One line per item) */
            <div className="overflow-x-auto rounded-xl border border-slate-850 bg-slate-950/20">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/80 border-b border-slate-850 text-slate-300 font-bold text-[10px]">
                  <tr>
                    <th className="p-2.5 pl-3">단말 호스트명</th>
                    <th className="p-2.5">임대 IP</th>
                    <th className="p-2.5">MAC 주소</th>
                    <th className="p-2.5">인터페이스</th>
                    <th className="p-2.5">대여 일자</th>
                    <th className="p-2.5">상태</th>
                    <th className="p-2.5">온라인</th>
                    <th className="p-2.5 text-right pr-3">관리</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-850/40 text-slate-300 text-[11px]">
                  {filteredLeases.map((lease) => {
                    const dev = getDeviceDetails(lease.hostname);
                    const onlineInd = getOnlineIndicator(lease);
                    return (
                      <tr key={lease.id} className="hover:bg-slate-900/10 transition">
                        <td className="p-2 pl-3 flex items-center gap-2">
                          <div className="p-1 bg-slate-950 border border-slate-850 rounded">
                            {dev.icon}
                          </div>
                          <div>
                            <div className="font-bold text-white text-[11px]">{lease.hostname}</div>
                            <div className="text-[10px] text-slate-500">{dev.label}</div>
                          </div>
                        </td>
                        <td className="p-2">
                          <span className="font-mono text-emerald-400 font-bold bg-emerald-950/30 border border-emerald-900/30 px-2 py-0.5 rounded text-[11px]">
                            {lease.ip}
                          </span>
                        </td>
                        <td className="p-2 font-mono text-slate-400 text-[11px]">{lease.mac}</td>
                        <td className="p-2 font-mono text-slate-400 text-[11px]">{lease.interfaceName}</td>
                        <td className="p-2 text-slate-400 text-[10px]">
                          <div>S: {new Date(lease.leasedAt).toLocaleTimeString()}</div>
                          <div className="text-slate-500">E: {new Date(lease.expiresAt).toLocaleTimeString()}</div>
                        </td>
                        <td className="p-2">
                          <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold border ${
                            lease.status === 'reserved'
                              ? 'bg-blue-500/10 text-blue-400 border-blue-900/40'
                              : 'bg-emerald-500/10 text-emerald-400 border-emerald-900/40'
                          }`}>
                            {lease.status === 'reserved' ? '고정 예약' : '대여중'}
                          </span>
                        </td>
                        <td className="p-2">
                          <span className="flex items-center gap-1.5" title={lease.lastCheckedAt ? `마지막 확인: ${new Date(lease.lastCheckedAt).toLocaleTimeString()}` : '아직 확인되지 않음'}>
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${onlineInd.dotClass} ${onlineInd.pulse ? 'animate-pulse' : ''}`}></span>
                            <span className="text-[10px] text-slate-400">{onlineInd.label}</span>
                          </span>
                        </td>
                        <td className="p-2 text-right pr-3">
                          {lease.id !== 'host-pc-self' && (
                            <button
                              id={`neighbors-lease-table-${lease.id}`}
                              onClick={() => handleOpenNeighborQuery(lease)}
                              className="text-slate-400 hover:text-sky-400 p-1 rounded transition cursor-pointer"
                              title="CDP/LLDP 이웃 정보 조회"
                            >
                              <Radar className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {lease.id !== 'host-pc-self' && (
                            <button
                              id={`renew-lease-table-${lease.id}`}
                              onClick={() => onRenewLease(lease.id)}
                              className="text-slate-400 hover:text-indigo-400 p-1 rounded transition cursor-pointer"
                              title="임대 갱신"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {lease.id !== 'host-pc-self' && (
                            <button
                              id={`remove-lease-table-${lease.id}`}
                              onClick={() => onRemoveLease(lease.id)}
                              className="text-slate-400 hover:text-rose-400 p-1 rounded transition cursor-pointer"
                              title="임대 반환"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredLeases.length === 0 && (
                    <tr>
                      <td colSpan={8} className="text-center text-slate-500 py-6 text-xs">활성 임대가 없습니다.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ARP Cache Table — surfaces the whole LAN, including statically-configured
            devices this DHCP server never issued a lease to */}
        <div className="p-4 glass-card rounded-xl space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-display font-bold text-white flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-indigo-400" />
                ARP 캐시 테이블
              </h3>
              <p className="text-[10px] text-slate-400 mt-0.5">
                정적 IP 단말을 포함한 전체 네트워크 단말입니다. 5초마다 갱신됩니다.
              </p>
            </div>
            {arpLoading && (
              <RefreshCw className="w-3.5 h-3.5 text-slate-500 animate-spin shrink-0" />
            )}
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-850 bg-slate-950/20 max-h-[260px] overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/80 border-b border-slate-850 text-slate-300 font-bold text-[10px] sticky top-0">
                <tr>
                  <th className="p-2.5 pl-3">IP 주소</th>
                  <th className="p-2.5">MAC 주소</th>
                  <th className="p-2.5">상태</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850/40 text-slate-300 text-[11px]">
                {arpEntries.map((entry) => {
                  const badge = entry.matched === 'lease'
                    ? { text: 'DHCP 임대중', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-900/40' }
                    : entry.matched === 'reservation'
                      ? { text: '고정 예약', cls: 'bg-blue-500/10 text-blue-400 border-blue-900/40' }
                      : { text: '미관리 정적 IP', cls: 'bg-amber-500/10 text-amber-400 border-amber-900/40' };
                  return (
                    <tr key={entry.ip + entry.mac} className="hover:bg-slate-900/10 transition">
                      <td className="p-2 pl-3 font-mono text-white text-[11px]">{entry.ip}</td>
                      <td className="p-2 font-mono text-slate-400 text-[11px]">{entry.mac}</td>
                      <td className="p-2">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold border ${badge.cls}`}>
                          {badge.text}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {arpEntries.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-center text-slate-500 py-6 text-xs">
                      {arpLoading ? '조회 중...' : '탐지된 단말이 없습니다.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Static Reservations */}
        <div className="p-4 glass-card rounded-xl space-y-4">
          <div>
            <h3 className="text-xs font-display font-bold text-white flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-indigo-400" />
              고정 IP 예약
            </h3>
            <p className="text-[10px] text-slate-400 mt-0.5">MAC 주소별로 항상 동일한 고정 IP를 부여합니다.</p>
          </div>

          <div className="space-y-3">
            {/* Horizontal inline input fields for addition */}
            <form onSubmit={handleAddReservation} className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-slate-950/40 border border-slate-850/60 p-3 rounded-xl text-xs" id="add-reservation-form">
              <div>
                <label className="block text-slate-400 font-bold mb-1 text-[10px]">호스트명</label>
                <input 
                  type="text" 
                  className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                  placeholder="Primary-SQL-DB"
                  value={resHostname}
                  onChange={(e) => setResHostname(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-slate-400 font-bold mb-1 text-[10px]">MAC 주소</label>
                <input 
                  type="text" 
                  className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                  placeholder="AA:BB:CC:DD:EE:FF"
                  value={resMac}
                  onChange={(e) => setResMac(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-slate-400 font-bold mb-1 text-[10px]">고정 IP</label>
                <input 
                  type="text" 
                  className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                  placeholder="192.168.1.50"
                  value={resIp}
                  onChange={(e) => setResIp(e.target.value)}
                  required
                />
              </div>
              <div className="flex items-end">
                <button
                  id="add-reservation-submit"
                  type="submit"
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold transition shadow h-[34px] flex items-center justify-center gap-1 cursor-pointer text-xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  예약 추가
                </button>
              </div>
            </form>

            {/* List of reservations (Full-width, one item per line) */}
            <div className="border border-slate-850/60 rounded-xl bg-slate-950/40 overflow-y-auto max-h-[220px]">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/60 text-slate-300 border-b border-slate-850/60 font-bold text-[10px]">
                  <tr>
                    <th className="p-2.5 pl-3">호스트명</th>
                    <th className="p-2.5">고정 IP</th>
                    <th className="p-2.5">MAC 주소</th>
                    <th className="p-2.5 text-right pr-3">관리</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-850/30 text-slate-300 text-[11px]">
                  {reservations.map((res) => (
                    <tr key={res.id} className="hover:bg-slate-900/10 transition">
                      <td className="p-2.5 pl-3 font-bold text-white">{res.hostname}</td>
                      <td className="p-2.5">
                        <span className="font-mono text-indigo-400 font-bold bg-indigo-950/30 border border-indigo-900/30 px-2 py-0.5 rounded text-[11px]">
                          {res.ip}
                        </span>
                      </td>
                      <td className="p-2.5 font-mono text-slate-400 text-[11px]">{res.mac}</td>
                      <td className="p-2.5 text-right pr-3">
                        <button
                          id={`delete-reservation-${res.id}`}
                          onClick={() => onRemoveReservation(res.id)}
                          className="text-slate-400 hover:text-rose-400 p-1 rounded transition cursor-pointer"
                          title="예약 삭제"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {reservations.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center text-slate-500 py-6">등록된 예약이 없습니다.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* CDP/LLDP neighbor lookup modal — triggered from the active-lease list
          above. If the lease's IP matched a registered TerminalHost, the
          query has already started (mode 'loading') using that host's saved
          credentials. Otherwise the user is first asked for one-off
          connection details (mode 'form') that are never persisted, only
          used for this single request. */}
      {neighborModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={closeNeighborModal}
        >
          <div
            className="bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-850 px-5 py-3 shrink-0">
              <div>
                <h3 className="text-sm font-display font-bold text-white flex items-center gap-1.5">
                  <Radar className="w-4 h-4 text-sky-400" />
                  CDP/LLDP 이웃 정보 — {neighborModal.lease.hostname || neighborModal.lease.ip}
                </h3>
                {neighborModal.mode === 'result' && (
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    PC/서버 등은 미지원 메시지가 나올 수 있습니다(정상).
                  </p>
                )}
                {neighborModal.mode === 'form' && (
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    등록되지 않은 장비입니다. 계정 정보는 이번 조회에만 사용되고 저장되지 않습니다.
                  </p>
                )}
              </div>
              <button
                id="close-lease-neighbor-modal-btn"
                onClick={closeNeighborModal}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 cursor-pointer transition shrink-0"
                title="닫기"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {neighborModal.mode === 'form' && (
                <form onSubmit={handleSubmitAdhocNeighborQuery} className="space-y-3 text-xs" id="adhoc-neighbor-cred-form">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-slate-300 font-bold mb-1">프로토콜</label>
                      <select
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none"
                        value={credProtocol}
                        onChange={(e) => {
                          const p = e.target.value as 'SSH' | 'TELNET';
                          setCredProtocol(p);
                          setCredPort(p === 'SSH' ? 22 : 23);
                        }}
                      >
                        <option value="SSH">SSH</option>
                        <option value="TELNET">TELNET</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-slate-300 font-bold mb-1">접속 포트</label>
                      <input
                        type="number"
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white font-mono focus:outline-none"
                        value={credPort}
                        onChange={(e) => setCredPort(Number(e.target.value))}
                        required
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-slate-300 font-bold mb-1">사용자 계정 (User)</label>
                      <input
                        type="text"
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none"
                        placeholder="admin"
                        value={credUsername}
                        onChange={(e) => setCredUsername(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-slate-300 font-bold mb-1">비밀번호 (Secret)</label>
                      <input
                        type="password"
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none"
                        placeholder="••••••••"
                        value={credPassword}
                        onChange={(e) => setCredPassword(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={closeNeighborModal}
                      className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg cursor-pointer transition"
                    >
                      취소
                    </button>
                    <button
                      type="submit"
                      disabled={!credUsername}
                      className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-30 disabled:pointer-events-none text-white rounded-lg font-bold cursor-pointer transition"
                    >
                      조회 실행
                    </button>
                  </div>
                </form>
              )}
              {neighborModal.mode === 'loading' && (
                <div className="flex flex-col items-center justify-center gap-3 text-slate-400 text-xs py-12">
                  <RefreshCw className="w-6 h-6 animate-spin text-sky-400" />
                  <p>CDP/LLDP 정보 수집 중... (약 5초 소요)</p>
                </div>
              )}
              {neighborModal.mode === 'result' && neighborResult && neighborResult.success && (
                <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-emerald-300/90 leading-relaxed">
                  {neighborResult.output || '(응답 없음 — 미지원이거나 이웃 장비가 없습니다.)'}
                </pre>
              )}
              {neighborModal.mode === 'result' && neighborResult && !neighborResult.success && (
                <div className="flex items-start gap-2 text-rose-400 text-xs bg-rose-950/20 border border-rose-900/40 rounded-xl p-3">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{neighborResult.error || '알 수 없는 오류가 발생했습니다.'}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
