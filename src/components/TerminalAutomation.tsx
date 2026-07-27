import React, { useState, useEffect, useRef } from 'react';
import {
  Terminal, ShieldCheck, Plus, Trash2, Play, Pencil,
  Send, Server, AlertCircle, RefreshCw, Download, Plug, Unplug, Radio,
  Wifi, CheckSquare, Square, PencilLine, X, XCircle
} from 'lucide-react';
import { TerminalHost, CommandScript, ScriptExecution, DhcpLease } from '../types';

interface TerminalAutomationProps {
  hosts: TerminalHost[];
  scripts: CommandScript[];
  executions: ScriptExecution[];
  leases: DhcpLease[];
  onAddHost: (name: string, ip: string, port: number, protocol: 'SSH' | 'TELNET', username: string, password?: string) => void;
  onUpdateHost: (id: string, name: string, ip: string, port: number, protocol: 'SSH' | 'TELNET', username: string, password?: string) => void;
  onRemoveHost: (id: string) => void;
  onBulkImportHosts: (devices: { name: string; ip: string }[], protocol: 'SSH' | 'TELNET', port: number, username: string, password?: string) => Promise<{ imported: number; skipped: number } | void>;
  onBulkUpdateHosts: (ids: string[], updates: { protocol?: 'SSH' | 'TELNET'; port?: number; username?: string; password?: string }) => void;
  onBulkDeleteHosts: (ids: string[]) => void;
  onAddScript: (name: string, description: string, commands: string[]) => void;
  onUpdateScript: (id: string, name: string, description: string, commands: string[]) => void;
  onRemoveScript: (id: string) => void;
  onExecuteScript: (hostId: string, scriptId: string) => void;
  onManualConnect: (hostId: string) => void;
  onSendManualCommand: (execIds: string[], command: string) => void;
  onDisconnectSession: (execId: string) => void;
  onCloseSession: (execId: string) => void;
  onCloseAllSessions: () => void;
  onPollExecutions: () => void;
}

export default function TerminalAutomation({
  hosts,
  scripts,
  executions,
  leases,
  onAddHost,
  onUpdateHost,
  onRemoveHost,
  onBulkImportHosts,
  onBulkUpdateHosts,
  onBulkDeleteHosts,
  onAddScript,
  onUpdateScript,
  onRemoveScript,
  onExecuteScript,
  onManualConnect,
  onSendManualCommand,
  onDisconnectSession,
  onCloseSession,
  onCloseAllSessions,
  onPollExecutions
}: TerminalAutomationProps) {

  // Host Form State
  const [hostName, setHostName] = useState("");
  const [hostIp, setHostIp] = useState("");
  const [hostPort, setHostPort] = useState(22);
  const [hostProtocol, setHostProtocol] = useState<'SSH' | 'TELNET'>("SSH");
  const [hostUser, setHostUser] = useState("");
  const [hostPass, setHostPass] = useState("");
  const [showHostForm, setShowHostForm] = useState(false);
  // Non-null while editing an existing device profile instead of creating a new one.
  const [editingHostId, setEditingHostId] = useState<string | null>(null);

  // Multi-select state for bulk update/delete on the device list.
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set());

  // DHCP import panel state
  const [showDhcpImportPanel, setShowDhcpImportPanel] = useState(false);
  const [selectedLeaseIds, setSelectedLeaseIds] = useState<Set<string>>(new Set());
  const [importProtocol, setImportProtocol] = useState<'SSH' | 'TELNET'>("SSH");
  const [importPort, setImportPort] = useState(22);
  const [importUser, setImportUser] = useState("");
  const [importPass, setImportPass] = useState("");
  const [importResultMsg, setImportResultMsg] = useState<string | null>(null);

  // Bulk update panel state ("변경 안 함" defaults = empty string / not selected)
  const [showBulkUpdateForm, setShowBulkUpdateForm] = useState(false);
  const [bulkProtocol, setBulkProtocol] = useState<'' | 'SSH' | 'TELNET'>("");
  const [bulkPort, setBulkPort] = useState("");
  const [bulkUser, setBulkUser] = useState("");
  const [bulkPass, setBulkPass] = useState("");

  const importableLeases = leases.filter(l => l.id !== 'host-pc-self');

  // Script Form State
  const [scriptName, setScriptName] = useState("");
  const [scriptDesc, setScriptDesc] = useState("");
  const [scriptCommands, setScriptCommands] = useState("");
  const [showScriptForm, setShowScriptForm] = useState(false);
  // Non-null while editing an existing script instead of creating a new one.
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);

  // Execution selection state
  const [selectedHostId, setSelectedHostId] = useState(hosts[0]?.id || "");
  const [selectedScriptId, setSelectedScriptId] = useState(scripts[0]?.id || "");
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // When the device-list multi-select (selectedHostIds, shared with bulk
  // update/delete) has entries, this toggle lets the batch runner target all
  // of them at once instead of the single-host dropdown below.
  const [runOnAllSelectedHosts, setRunOnAllSelectedHosts] = useState(false);

  // Manual terminal input
  const [manualCommand, setManualCommand] = useState("");
  // "Send to all sessions" broadcast toggle (SecureCRT-style).
  const [broadcastToAll, setBroadcastToAll] = useState(false);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const prevTabIdRef = useRef<string | null>(null);
  // Tracks whether the user was near the bottom of the log viewer *before*
  // the latest log update landed, so the auto-scroll decision below is based
  // on pre-update scroll position rather than the already-grown scrollHeight
  // (see handleLogScroll for how this gets kept up to date).
  const isNearBottomRef = useRef(true);

  const activeExec = executions.find(e => e.id === activeTabId);
  const openSessionCount = executions.filter(e => e.sessionOpen).length;

  // Update defaults when hosts/scripts load
  useEffect(() => {
    if (!selectedHostId && hosts.length > 0) setSelectedHostId(hosts[0].id);
    if (!selectedScriptId && scripts.length > 0) setSelectedScriptId(scripts[0].id);
  }, [hosts, scripts]);

  // Track the most recent execution tab. Also recovers when the currently
  // active tab disappears from the list (e.g. the user closed it via
  // onCloseSession) — falls back to another open tab, or to null if none
  // remain, so a removed session's id never lingers as the "active" one.
  useEffect(() => {
    if (executions.length === 0) {
      if (activeTabId !== null) setActiveTabId(null);
      return;
    }

    const running = executions.find(e => e.status === 'running');
    const activeStillExists = activeTabId !== null && executions.some(e => e.id === activeTabId);

    if (running) {
      setActiveTabId(running.id);
    } else if (!activeStillExists) {
      setActiveTabId(executions[executions.length - 1].id);
    }
  }, [executions]);

  // Track the user's scroll position continuously (before content changes),
  // since by the time the log-update effect below runs, the log lines have
  // already been appended to the DOM and scrollHeight has already grown —
  // recomputing "distance from bottom" at that point no longer reflects
  // where the user actually was right before the update. This handler keeps
  // isNearBottomRef in sync with the real, pre-update scroll position.
  const NEAR_BOTTOM_THRESHOLD = 80;
  const handleLogScroll = () => {
    const container = logContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
  };

  // Smart auto-scroll: always jump to bottom when switching to a different
  // session tab (the user wants to see where that session currently stands),
  // but while staying on the same tab only auto-scroll when new log lines
  // arrive if the user was already near the bottom *before* this update —
  // so scrolling up to read history isn't fought every ~1.5s polling cycle,
  // and bursts of multiple log lines arriving at once don't erroneously
  // suppress auto-scroll just because scrollHeight already grew.
  useEffect(() => {
    const container = logContainerRef.current;
    if (!container) return;

    const tabChanged = prevTabIdRef.current !== activeTabId;
    prevTabIdRef.current = activeTabId;

    if (tabChanged || isNearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      isNearBottomRef.current = true;
    }
  }, [activeExec?.logs, activeTabId]);

  const resetHostForm = () => {
    setHostName("");
    setHostIp("");
    setHostPort(hostProtocol === 'SSH' ? 22 : 23);
    setHostUser("");
    setHostPass("");
    setShowHostForm(false);
    setEditingHostId(null);
  };

  const handleShowAddHostForm = () => {
    if (showHostForm) {
      resetHostForm();
      return;
    }
    setEditingHostId(null);
    setHostName("");
    setHostIp("");
    setHostUser("");
    setHostPass("");
    setHostPort(hostProtocol === 'SSH' ? 22 : 23);
    setShowHostForm(true);
  };

  const handleEditHostClick = (host: TerminalHost) => {
    setEditingHostId(host.id);
    setHostName(host.name);
    setHostIp(host.ip);
    setHostPort(host.port);
    setHostProtocol(host.protocol);
    setHostUser(host.username);
    setHostPass(""); // never re-display the stored secret; blank = keep unchanged
    setShowHostForm(true);
  };

  const handleAddHostSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hostName || !hostIp || !hostUser) return;
    if (editingHostId) {
      onUpdateHost(editingHostId, hostName, hostIp, hostPort, hostProtocol, hostUser, hostPass || undefined);
    } else {
      onAddHost(hostName, hostIp, hostPort, hostProtocol, hostUser, hostPass);
    }
    resetHostForm();
  };

  const toggleHostSelected = (id: string) => {
    setSelectedHostIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAllHosts = () => {
    setSelectedHostIds(prev => {
      if (prev.size === hosts.length) return new Set();
      return new Set(hosts.map(h => h.id));
    });
  };

  const resetDhcpImportPanel = () => {
    setShowDhcpImportPanel(false);
    setSelectedLeaseIds(new Set());
    setImportProtocol("SSH");
    setImportPort(22);
    setImportUser("");
    setImportPass("");
  };

  const toggleLeaseSelected = (id: string) => {
    setSelectedLeaseIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAllLeases = () => {
    setSelectedLeaseIds(prev => {
      if (prev.size === importableLeases.length) return new Set();
      return new Set(importableLeases.map(l => l.id));
    });
  };

  const handleDhcpImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedLeaseIds.size === 0 || !importUser) return;
    const devices = importableLeases
      .filter(l => selectedLeaseIds.has(l.id))
      .map(l => ({ name: l.hostname || l.ip, ip: l.ip }));
    const result = await onBulkImportHosts(devices, importProtocol, importPort, importUser, importPass || undefined);
    if (result) {
      setImportResultMsg(`${result.imported}개 가져오기 완료, ${result.skipped}개 스킵(이미 등록됨/중복)`);
    }
    resetDhcpImportPanel();
  };

  const resetBulkUpdateForm = () => {
    setShowBulkUpdateForm(false);
    setBulkProtocol("");
    setBulkPort("");
    setBulkUser("");
    setBulkPass("");
  };

  const handleBulkUpdateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedHostIds.size === 0) return;
    const updates: { protocol?: 'SSH' | 'TELNET'; port?: number; username?: string; password?: string } = {};
    if (bulkProtocol) updates.protocol = bulkProtocol;
    if (bulkPort) updates.port = Number(bulkPort);
    if (bulkUser) updates.username = bulkUser;
    if (bulkPass) updates.password = bulkPass;
    if (Object.keys(updates).length === 0) return;
    onBulkUpdateHosts(Array.from(selectedHostIds), updates);
    resetBulkUpdateForm();
    setSelectedHostIds(new Set());
  };

  const handleBulkDeleteClick = () => {
    if (selectedHostIds.size === 0) return;
    if (!window.confirm(`선택한 ${selectedHostIds.size}개 장비를 일괄 삭제하시겠습니까?`)) return;
    onBulkDeleteHosts(Array.from(selectedHostIds));
    setSelectedHostIds(new Set());
  };

  const resetScriptForm = () => {
    setScriptName("");
    setScriptDesc("");
    setScriptCommands("");
    setShowScriptForm(false);
    setEditingScriptId(null);
  };

  const handleShowAddScriptForm = () => {
    if (showScriptForm) {
      resetScriptForm();
      return;
    }
    setEditingScriptId(null);
    setScriptName("");
    setScriptDesc("");
    setScriptCommands("");
    setShowScriptForm(true);
  };

  const handleEditScriptClick = (script: CommandScript) => {
    setEditingScriptId(script.id);
    setScriptName(script.name);
    setScriptDesc(script.description);
    setScriptCommands(script.commands.join("\n"));
    setShowScriptForm(true);
  };

  const handleAddScriptSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!scriptName || !scriptCommands) return;
    // Intentionally no filter() here: a blank line is a valid, deliberate
    // "just send Enter" step in a script, so it must survive into the
    // commands array as an empty string rather than being dropped. Only the
    // trailing '\r' (from Windows-style line endings) is stripped, and
    // non-empty lines are trimmed as before.
    const cmds = scriptCommands.split("\n").map(c => c.replace(/\r$/, "").trim());
    if (editingScriptId) {
      onUpdateScript(editingScriptId, scriptName, scriptDesc, cmds);
    } else {
      onAddScript(scriptName, scriptDesc, cmds);
    }
    resetScriptForm();
  };

  // batchModeActive mirrors the button/checkbox visibility rule: only takes
  // over from the single-host dropdown when the device list actually has a
  // non-empty multi-selection AND the toggle is switched on.
  const batchModeActive = runOnAllSelectedHosts && selectedHostIds.size > 0;

  const handleRunScript = () => {
    if (!selectedScriptId) return;
    if (batchModeActive) {
      // Backend already supports independent per-host sessions/tabs, so this
      // is a pure frontend fan-out: dispatch one execute call per selected
      // host, staggered slightly so the requests don't all land in the same
      // tick.
      const targetHostIds: string[] = Array.from(selectedHostIds);
      targetHostIds.forEach((hostId, idx) => {
        setTimeout(() => onExecuteScript(hostId, selectedScriptId), idx * 200);
      });
      return;
    }
    if (!selectedHostId) return;
    onExecuteScript(selectedHostId, selectedScriptId);
  };

  const handleSendManualCommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCommand || !activeTabId) return;

    const execIds = broadcastToAll
      ? executions.filter(ex => ex.sessionOpen).map(ex => ex.id)
      : [activeTabId];

    if (execIds.length === 0) return;

    onSendManualCommand(execIds, manualCommand);
    setManualCommand("");
  };

  const handleExportLog = () => {
    if (!activeExec) return;
    const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
    const hostLabel = safe(getHostNameFromId(activeExec.hostId));
    const scriptLabel = safe(getScriptNameFromId(activeExec.scriptId));
    const ts = new Date(activeExec.timestamp || Date.now()).toISOString().replace(/[:.]/g, "-");
    const filename = `${hostLabel}_${scriptLabel}_${ts}.log`;

    const blob = new Blob([activeExec.logs.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getHostNameFromId = (id: string) => {
    return hosts.find(h => h.id === id)?.name || "Unknown Host";
  };

  const getScriptNameFromId = (id: string) => {
    if (id === "manual") return "수동 연결";
    return scripts.find(s => s.id === id)?.name || "Unknown Script";
  };

  return (
    <div className="space-y-6 animate-fade-in" id="terminal-tab">

      {/* Device Profiles & Interactive Script Launcher */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Device Accounts Manager */}
        <div className="p-5 glass-card rounded-2xl space-y-3 flex flex-col min-h-[400px] lg:h-auto">
          <div className="flex items-center justify-between border-b border-slate-855 pb-2.5">
            <h3 className="text-sm font-display font-bold text-white flex items-center gap-1.5">
              <Server className="w-4 h-4 text-emerald-400" />
              자동화 접속 대상 장비 (Devices)
            </h3>
            <div className="flex items-center gap-2.5">
              <button
                id="show-dhcp-import-btn"
                onClick={() => {
                  if (showDhcpImportPanel) {
                    resetDhcpImportPanel();
                  } else {
                    setShowHostForm(false);
                    setShowBulkUpdateForm(false);
                    setShowDhcpImportPanel(true);
                  }
                }}
                className="text-emerald-400 hover:text-emerald-300 text-xs font-bold flex items-center gap-0.5 cursor-pointer transition"
              >
                <Wifi className="w-3.5 h-3.5" />
                DHCP 클라이언트에서 가져오기
              </button>
              <button
                id="show-host-form-btn"
                onClick={() => {
                  resetDhcpImportPanel();
                  resetBulkUpdateForm();
                  handleShowAddHostForm();
                }}
                className="text-indigo-400 hover:text-indigo-300 text-xs font-bold flex items-center gap-0.5 cursor-pointer transition"
              >
                <Plus className="w-3.5 h-3.5" />
                장비 등록
              </button>
            </div>
          </div>

          {importResultMsg && !showDhcpImportPanel && (
            <div className="text-[10px] text-emerald-400 bg-emerald-950/30 border border-emerald-900/50 rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2">
              <span>{importResultMsg}</span>
              <button type="button" onClick={() => setImportResultMsg(null)} className="text-slate-400 hover:text-white cursor-pointer">×</button>
            </div>
          )}

          {showDhcpImportPanel ? (
            <form onSubmit={handleDhcpImportSubmit} className="space-y-2.5 bg-slate-950 p-4 border border-slate-850 rounded-xl text-xs overflow-y-auto max-h-[340px]" id="dhcp-import-form">
              <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider block">
                DHCP 임대 클라이언트 선택 후 일괄 등록
              </span>

              <div className="flex items-center justify-between text-[10px] text-slate-400 font-bold">
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="accent-indigo-500 cursor-pointer"
                    checked={importableLeases.length > 0 && selectedLeaseIds.size === importableLeases.length}
                    onChange={toggleSelectAllLeases}
                  />
                  전체 선택/해제
                </label>
                <span>{selectedLeaseIds.size} / {importableLeases.length}개 선택됨</span>
              </div>

              <div className="max-h-[130px] overflow-y-auto space-y-1.5 border border-slate-850 rounded-lg p-2 bg-slate-900/40">
                {importableLeases.map(lease => (
                  <label key={lease.id} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-900 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="accent-indigo-500 cursor-pointer shrink-0"
                      checked={selectedLeaseIds.has(lease.id)}
                      onChange={() => toggleLeaseSelected(lease.id)}
                    />
                    <span className="font-bold text-white truncate">{lease.hostname || '(unknown)'}</span>
                    <span className="font-mono text-slate-400 shrink-0">{lease.ip}</span>
                    <span className="font-mono text-slate-500 shrink-0">{lease.mac}</span>
                  </label>
                ))}
                {importableLeases.length === 0 && (
                  <div className="text-slate-500 text-center py-4 text-[10px]">가져올 수 있는 DHCP 임대 클라이언트가 없습니다.</div>
                )}
              </div>

              <span className="text-[10px] text-slate-400">선택한 장비들에 공통으로 적용할 접속 계정 정보:</span>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-slate-300 font-bold mb-1">프로토콜</label>
                  <select
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none"
                    value={importProtocol}
                    onChange={(e) => {
                      const p = e.target.value as 'SSH' | 'TELNET';
                      setImportProtocol(p);
                      setImportPort(p === 'SSH' ? 22 : 23);
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
                    value={importPort}
                    onChange={(e) => setImportPort(Number(e.target.value))}
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
                    value={importUser}
                    onChange={(e) => setImportUser(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-bold mb-1">비밀번호 (Secret)</label>
                  <input
                    type="password"
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none"
                    placeholder="••••••••"
                    value={importPass}
                    onChange={(e) => setImportPass(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 text-[10px] pt-1">
                <button
                  id="cancel-dhcp-import-btn"
                  type="button"
                  onClick={resetDhcpImportPanel}
                  className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg cursor-pointer transition"
                >
                  취소
                </button>
                <button
                  id="submit-dhcp-import-btn"
                  type="submit"
                  disabled={selectedLeaseIds.size === 0 || !importUser}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 disabled:pointer-events-none text-white rounded-lg font-bold cursor-pointer transition"
                >
                  {selectedLeaseIds.size}개 가져오기
                </button>
              </div>
            </form>
          ) : showBulkUpdateForm ? (
            <form onSubmit={handleBulkUpdateSubmit} className="space-y-2.5 bg-slate-950 p-4 border border-slate-850 rounded-xl text-xs overflow-y-auto max-h-[340px]" id="bulk-update-host-form">
              <span className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider block">
                선택 장비 {selectedHostIds.size}개 계정 정보 일괄 수정
              </span>
              <p className="text-[10px] text-slate-500">비워두면 해당 항목은 변경하지 않습니다.</p>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-slate-300 font-bold mb-1">프로토콜</label>
                  <select
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none"
                    value={bulkProtocol}
                    onChange={(e) => setBulkProtocol(e.target.value as '' | 'SSH' | 'TELNET')}
                  >
                    <option value="">변경 안 함</option>
                    <option value="SSH">SSH</option>
                    <option value="TELNET">TELNET</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-slate-300 font-bold mb-1">접속 포트</label>
                  <input
                    type="number"
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white font-mono focus:outline-none"
                    placeholder="변경 안 함"
                    value={bulkPort}
                    onChange={(e) => setBulkPort(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-300 font-bold mb-1">사용자 계정 (User)</label>
                  <input
                    type="text"
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none"
                    placeholder="변경 안 함"
                    value={bulkUser}
                    onChange={(e) => setBulkUser(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-bold mb-1">비밀번호 (Secret)</label>
                  <input
                    type="password"
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none"
                    placeholder="변경 안 함"
                    value={bulkPass}
                    onChange={(e) => setBulkPass(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 text-[10px] pt-1">
                <button
                  id="cancel-bulk-update-host-btn"
                  type="button"
                  onClick={resetBulkUpdateForm}
                  className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg cursor-pointer transition"
                >
                  취소
                </button>
                <button
                  id="submit-bulk-update-host-btn"
                  type="submit"
                  disabled={!bulkProtocol && !bulkPort && !bulkUser && !bulkPass}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:pointer-events-none text-white rounded-lg font-bold cursor-pointer transition"
                >
                  {selectedHostIds.size}개 일괄 수정
                </button>
              </div>
            </form>
          ) : showHostForm ? (
            <form onSubmit={handleAddHostSubmit} className="space-y-2.5 bg-slate-950 p-4 border border-slate-850 rounded-xl text-xs overflow-y-auto max-h-[300px]" id="add-host-form">
              <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider block">
                {editingHostId ? "장비 정보 수정" : "신규 SSH/Telnet 장비 추가"}
              </span>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-300 font-bold mb-1">장비명 (Hostname)</label>
                  <input
                    type="text"
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none focus:border-indigo-500"
                    placeholder="Switch-Core-A"
                    value={hostName}
                    onChange={(e) => setHostName(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-bold mb-1">IP 주소</label>
                  <input
                    type="text"
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white font-mono focus:outline-none focus:border-indigo-500"
                    placeholder="192.168.1.1"
                    value={hostIp}
                    onChange={(e) => setHostIp(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-slate-300 font-bold mb-1">프로토콜</label>
                  <select
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none"
                    value={hostProtocol}
                    onChange={(e) => {
                      const p = e.target.value as 'SSH' | 'TELNET';
                      setHostProtocol(p);
                      setHostPort(p === 'SSH' ? 22 : 23);
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
                    value={hostPort}
                    onChange={(e) => setHostPort(Number(e.target.value))}
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
                    value={hostUser}
                    onChange={(e) => setHostUser(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-bold mb-1">비밀번호 (Secret)</label>
                  <input
                    type="password"
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none"
                    placeholder={editingHostId ? "비워두면 기존 비밀번호 유지" : "••••••••"}
                    value={hostPass}
                    onChange={(e) => setHostPass(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 text-[10px] pt-1">
                <button
                  id="cancel-add-host-btn"
                  type="button"
                  onClick={resetHostForm}
                  className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg cursor-pointer transition"
                >
                  취소
                </button>
                <button
                  id="submit-add-host-btn"
                  type="submit"
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold cursor-pointer transition"
                >
                  {editingHostId ? "수정 완료" : "추가하기"}
                </button>
              </div>
            </form>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 space-y-2">
              {hosts.length > 0 && (
                <div className="flex items-center justify-between gap-2 text-[10px] shrink-0">
                  <label className="flex items-center gap-1.5 text-slate-400 font-bold cursor-pointer select-none">
                    <input
                      type="checkbox"
                      id="select-all-hosts-checkbox"
                      className="accent-indigo-500 cursor-pointer"
                      checked={hosts.length > 0 && selectedHostIds.size === hosts.length}
                      onChange={toggleSelectAllHosts}
                    />
                    전체 선택 {selectedHostIds.size > 0 ? `(${selectedHostIds.size}개)` : ''}
                  </label>
                  <div className="flex items-center gap-1.5">
                    <button
                      id="bulk-update-hosts-btn"
                      type="button"
                      disabled={selectedHostIds.size === 0}
                      onClick={() => {
                        setShowHostForm(false);
                        resetDhcpImportPanel();
                        setShowBulkUpdateForm(true);
                      }}
                      className="px-2 py-1 bg-slate-800 hover:bg-indigo-950/40 hover:text-indigo-300 disabled:opacity-30 disabled:pointer-events-none text-slate-300 rounded-lg font-bold flex items-center gap-1 cursor-pointer transition"
                    >
                      <PencilLine className="w-3 h-3" />
                      선택 항목 일괄 수정
                    </button>
                    <button
                      id="bulk-delete-hosts-btn"
                      type="button"
                      disabled={selectedHostIds.size === 0}
                      onClick={handleBulkDeleteClick}
                      className="px-2 py-1 bg-slate-800 hover:bg-rose-950/40 hover:text-rose-300 disabled:opacity-30 disabled:pointer-events-none text-slate-300 rounded-lg font-bold flex items-center gap-1 cursor-pointer transition"
                    >
                      <Trash2 className="w-3 h-3" />
                      선택 항목 일괄 삭제
                    </button>
                  </div>
                </div>
              )}
              <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
              {hosts.map((host) => (
                <div key={host.id} className={`p-3 bg-slate-950/40 border rounded-xl flex items-center justify-between hover:border-slate-700/80 hover:bg-slate-950/60 transition ${selectedHostIds.has(host.id) ? 'border-indigo-700/70 bg-indigo-950/10' : 'border-slate-850'}`}>
                  <div className="flex items-center gap-2.5 min-w-0">
                    <input
                      type="checkbox"
                      id={`select-host-${host.id}`}
                      className="accent-indigo-500 cursor-pointer shrink-0"
                      checked={selectedHostIds.has(host.id)}
                      onChange={() => toggleHostSelected(host.id)}
                    />
                    <div className="space-y-1 min-w-0">
                      <div className="font-bold text-white text-xs truncate">{host.name}</div>
                      <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
                        <span className={`px-1 rounded text-[9px] font-bold ${host.protocol === 'SSH' ? 'bg-indigo-950 text-indigo-400 border border-indigo-900/50' : 'bg-orange-950 text-orange-400 border border-orange-900/50'}`}>
                          {host.protocol}
                        </span>
                        <span>{host.ip}:{host.port}</span>
                        <span>•</span>
                        <span>U: {host.username}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      id={`manual-connect-${host.id}`}
                      onClick={() => onManualConnect(host.id)}
                      className="p-1.5 text-slate-400 hover:text-emerald-400 rounded-lg hover:bg-emerald-950/20 cursor-pointer transition"
                      title="수동 접속 (Manual Connect)"
                    >
                      <Plug className="w-3.5 h-3.5" />
                    </button>
                    <button
                      id={`edit-host-${host.id}`}
                      onClick={() => handleEditHostClick(host)}
                      className="p-1.5 text-slate-400 hover:text-indigo-400 rounded-lg hover:bg-indigo-950/20 cursor-pointer transition"
                      title="장비 프로필 수정"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      id={`delete-host-${host.id}`}
                      onClick={() => onRemoveHost(host.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-rose-950/20 cursor-pointer transition"
                      title="장비 프로필 제거"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {hosts.length === 0 && (
                <div className="text-slate-500 text-center py-16 text-xs font-medium">등록된 SSH/Telnet 장비가 존재하지 않습니다.</div>
              )}
              </div>
            </div>
          )}
        </div>

        {/* Configuration Script Automation Engine */}
        <div className="p-5 glass-card rounded-2xl space-y-4 flex flex-col h-[400px]">
          <div className="flex items-center justify-between border-b border-slate-855 pb-2.5">
            <h3 className="text-sm font-display font-bold text-white flex items-center gap-1.5">
              <Terminal className="w-4 h-4 text-emerald-400" />
              배포 설정 자동화 스크립트 (Scripts)
            </h3>
            <button
              id="show-script-form-btn"
              onClick={handleShowAddScriptForm}
              className="text-indigo-400 hover:text-indigo-300 text-xs font-bold flex items-center gap-0.5 cursor-pointer transition"
            >
              <Plus className="w-3.5 h-3.5" />
              스크립트 작성
            </button>
          </div>

          {showScriptForm ? (
            <form onSubmit={handleAddScriptSubmit} className="space-y-2.5 bg-slate-950 p-4 border border-slate-850 rounded-xl text-xs overflow-y-auto max-h-[300px]" id="add-script-form">
              <div className="flex justify-between items-center">
                <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider block">
                  {editingScriptId ? "자동화 스크립트 수정" : "신규 자동화 스크립트 작성"}
                </span>
              </div>
              <div>
                <label className="block text-slate-300 font-bold mb-1">스크립트 그룹명</label>
                <input
                  type="text"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white font-bold focus:outline-none focus:border-indigo-500"
                  placeholder="Cisco Interface Bulk Configuration"
                  value={scriptName}
                  onChange={(e) => setScriptName(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-slate-300 font-bold mb-1">설명</label>
                <input
                  type="text"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white focus:outline-none focus:border-indigo-500"
                  placeholder="VLAN, IP, Descriptions 일괄 배포 템플릿"
                  value={scriptDesc}
                  onChange={(e) => setScriptDesc(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-slate-300 font-bold mb-1">실행 CLI 명령목록 (줄바꿈 구분)</label>
                <textarea
                  className="w-full h-20 bg-slate-900 border border-slate-800 rounded-lg p-2 text-white font-mono text-[10px] focus:outline-none focus:border-indigo-500"
                  placeholder="enable&#10;configure terminal&#10;interface GigabitEthernet1/1&#10;no shutdown"
                  value={scriptCommands}
                  onChange={(e) => setScriptCommands(e.target.value)}
                  required
                ></textarea>
              </div>

              <div className="flex justify-end gap-2 text-[10px] pt-1">
                <button
                  id="cancel-add-script-btn"
                  type="button"
                  onClick={resetScriptForm}
                  className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg cursor-pointer transition"
                >
                  취소
                </button>
                <button
                  id="submit-add-script-btn"
                  type="submit"
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold cursor-pointer transition"
                >
                  {editingScriptId ? "수정 완료" : "스크립트 생성"}
                </button>
              </div>
            </form>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
              {scripts.map((script) => (
                <div key={script.id} className="p-3 bg-slate-950/40 border border-slate-850 rounded-xl flex items-center justify-between hover:border-slate-700/80 hover:bg-slate-950/60 transition">
                  <div className="space-y-1">
                    <div className="font-bold text-white text-xs">{script.name}</div>
                    <div className="text-[10px] text-slate-400 truncate max-w-[180px]">{script.description || '세부 설명이 존재하지 않습니다.'}</div>
                    <div className="text-[9px] font-mono text-emerald-400 font-bold">{script.commands.length} Command lines</div>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button
                      id={`edit-script-${script.id}`}
                      onClick={() => handleEditScriptClick(script)}
                      className="p-1.5 text-slate-400 hover:text-indigo-400 rounded-lg hover:bg-indigo-950/20 cursor-pointer transition"
                      title="설정 스크립트 수정"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      id={`delete-script-${script.id}`}
                      onClick={() => onRemoveScript(script.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-rose-950/20 cursor-pointer transition"
                      title="설정 스크립트 제거"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {scripts.length === 0 && (
                <div className="text-slate-500 text-center py-16 text-xs font-medium">등록된 환경설정 자동화 스크립트 템플릿이 없습니다.</div>
              )}
            </div>
          )}
        </div>

        {/* Trigger and execution dispatch panel */}
        <div className="p-5 glass-card rounded-2xl space-y-4 flex flex-col justify-between h-[400px]">
          <div className="space-y-3">
            <h3 className="text-sm font-display font-bold text-white border-b border-slate-855 pb-2.5 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-indigo-400 animate-pulse" />
              원격 CRT 자동화 일괄 배치 실행기
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              저장된 SSH/Telnet 프로필과 자동화 명령 스크립트를 선택한 뒤 <strong>배치 실행</strong> 버튼을 누르면, 백엔드 세션 스레드가 생성되어 원격 타겟 장비에 순차적으로 자동화 배포 명령을 밀어넣고 로그를 기록합니다.
            </p>

            <div className="space-y-2.5 pt-2">
              {selectedHostIds.size > 0 && (
                <label className="flex items-center gap-1.5 text-[10px] text-indigo-300 font-bold cursor-pointer select-none bg-indigo-950/20 border border-indigo-900/40 rounded-lg px-2.5 py-1.5">
                  <input
                    type="checkbox"
                    id="run-on-all-selected-hosts-toggle"
                    checked={runOnAllSelectedHosts}
                    onChange={(e) => setRunOnAllSelectedHosts(e.target.checked)}
                    className="accent-indigo-500 cursor-pointer"
                  />
                  <CheckSquare className="w-3 h-3" />
                  선택된 {selectedHostIds.size}개 장비 전체에 일괄 실행
                </label>
              )}

              <div className={batchModeActive ? "opacity-40 pointer-events-none transition" : "transition"}>
                <label className="block text-[11px] text-slate-300 font-bold mb-1.5">대상 네트워크 스위치/라우터 선택</label>
                <select
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-white text-xs focus:outline-none focus:border-indigo-500 transition"
                  value={selectedHostId}
                  onChange={(e) => setSelectedHostId(e.target.value)}
                  disabled={batchModeActive}
                >
                  <option value="" disabled>장치를 선택하세요</option>
                  {hosts.map(h => (
                    <option key={h.id} value={h.id}>{h.name} ({h.ip})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-300 font-bold mb-1.5">자동 배포 스크립트 선택</label>
                <select
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-white text-xs focus:outline-none focus:border-indigo-500 transition"
                  value={selectedScriptId}
                  onChange={(e) => setSelectedScriptId(e.target.value)}
                >
                  <option value="" disabled>스크립트 템플릿 선택</option>
                  {scripts.map(s => (
                    <option key={s.id} value={s.id}>{s.name} ({s.commands.length} lines)</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <button
            id="run-automation-btn"
            onClick={handleRunScript}
            disabled={!selectedScriptId || (!batchModeActive && !selectedHostId)}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 disabled:pointer-events-none active:bg-emerald-700 text-white rounded-xl font-bold tracking-wider text-xs flex items-center justify-center gap-2 cursor-pointer transition duration-150 shadow-lg shadow-emerald-950/20"
          >
            <Play className="w-4 h-4 text-emerald-100" />
            {batchModeActive
              ? `선택된 ${selectedHostIds.size}개 장비에 일괄 배치 실행 (RUN BATCH)`
              : '배치 자동화 CLI 배포 실행 (RUN BATCH)'}
          </button>
        </div>
      </div>

      {/* Interactive Concurrent Terminal Sessions */}
      <div className="p-5 glass-card rounded-2xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-855 pb-3">
          <div>
            <h3 className="text-sm font-display font-bold text-white">
              실시간 원격 CLI 세션 뷰어 (SecureCRT Interactive Terminal Emulator)
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">동시에 구동 중인 여러 장비의 CLI 원격 세션 상태와 진행 상세 로그</p>
          </div>

          {/* Active session tabs selection */}
          <div className="flex items-center gap-1.5">
            <div className="flex gap-1.5 overflow-x-auto max-w-full pb-1">
              {executions.map((exec, idx) => (
                <button
                  id={`tab-${exec.id}`}
                  key={exec.id}
                  onClick={() => setActiveTabId(exec.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold shrink-0 flex items-center gap-1.5 border cursor-pointer transition ${
                    activeTabId === exec.id
                      ? 'bg-slate-950 text-emerald-400 border-slate-700/80'
                      : 'bg-slate-900/50 text-slate-400 border-slate-850 hover:border-slate-700'
                  }`}
                >
                  <Terminal className="w-3.5 h-3.5" />
                  Session-{idx + 1}
                  <span className={`w-1.5 h-1.5 rounded-full ${exec.status === 'running' ? 'bg-amber-400 animate-ping' : exec.status === 'completed' ? 'bg-emerald-400' : 'bg-rose-500'}`}></span>
                  <span
                    role="button"
                    id={`close-tab-${exec.id}`}
                    onClick={(e) => { e.stopPropagation(); onCloseSession(exec.id); }}
                    className="ml-0.5 p-0.5 rounded hover:bg-rose-950/60 hover:text-rose-400 text-slate-500 cursor-pointer transition"
                    title="세션 닫기 (탭 제거)"
                  >
                    <X className="w-3 h-3" />
                  </span>
                </button>
              ))}
              {executions.length === 0 && (
                <span className="text-[11px] text-slate-500 py-1.5 font-medium">활성 자동화 세션 없음</span>
              )}
            </div>
            {executions.length > 1 && (
              <button
                id="close-all-sessions-btn"
                onClick={onCloseAllSessions}
                className="shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-bold flex items-center gap-1 border border-slate-850 text-slate-400 hover:text-rose-400 hover:border-rose-900/60 hover:bg-rose-950/20 cursor-pointer transition"
                title="모든 세션 닫기"
              >
                <XCircle className="w-3.5 h-3.5" />
                모두 닫기
              </button>
            )}
          </div>
        </div>

        {/* Console Box */}
        {activeExec ? (
          <div className="space-y-3">
            {/* Session Metadata Header */}
            <div className="flex flex-col sm:flex-row justify-between text-xs bg-slate-950/60 border border-slate-850 p-3 rounded-xl text-slate-400 font-mono gap-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <div>대상 장비: <strong className="text-white font-bold">{getHostNameFromId(activeExec.hostId)}</strong></div>
                <div>스크립트: <strong className="text-indigo-300 font-bold">{getScriptNameFromId(activeExec.scriptId)}</strong></div>
                <div className="flex items-center gap-1.5">
                  진행 상태:
                  <strong className={`font-bold flex items-center gap-1 ${
                    activeExec.status === 'completed' ? 'text-emerald-400' :
                    activeExec.status === 'failed' ? 'text-rose-400' :
                    'text-amber-400'
                  }`}>
                    {activeExec.status === 'failed' && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-950/60 border border-rose-900/60">
                        <AlertCircle className="w-3 h-3" />
                        접속/실행 실패
                      </span>
                    )}
                    {activeExec.status !== 'failed' && activeExec.status.toUpperCase()}
                  </strong>
                </div>
                <div className="flex items-center gap-1.5">
                  세션:
                  <strong className={`font-bold ${activeExec.sessionOpen ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {activeExec.sessionOpen ? '연결됨' : '종료됨'}
                  </strong>
                </div>
              </div>
              <div className="flex items-center gap-2 justify-between sm:justify-end">
                <div className="w-24 bg-slate-800 h-2 rounded-full overflow-hidden shrink-0">
                  <div className={`h-full transition-all duration-300 ${activeExec.status === 'failed' ? 'bg-rose-500' : 'bg-emerald-400'}`} style={{ width: `${activeExec.progress}%` }}></div>
                </div>
                <div className="font-bold text-white">{activeExec.progress}%</div>
                <button
                  id="export-log-btn"
                  onClick={handleExportLog}
                  className="p-1.5 text-slate-400 hover:text-indigo-400 rounded-lg hover:bg-indigo-950/20 cursor-pointer transition"
                  title="로그 내보내기 (.log)"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
                <button
                  id="disconnect-session-btn"
                  onClick={() => onDisconnectSession(activeExec.id)}
                  disabled={!activeExec.sessionOpen}
                  className="p-1.5 text-slate-400 hover:text-rose-400 disabled:opacity-30 disabled:pointer-events-none rounded-lg hover:bg-rose-950/20 cursor-pointer transition"
                  title="연결 종료"
                >
                  <Unplug className="w-3.5 h-3.5" />
                </button>
                <button
                  id="close-session-btn"
                  onClick={() => onCloseSession(activeExec.id)}
                  className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-rose-950/20 cursor-pointer transition"
                  title="세션 닫기 (탭 제거)"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Live CRT terminal block (streams real SSH/Telnet session output) */}
            <div
              ref={logContainerRef}
              onScroll={handleLogScroll}
              className="bg-slate-950/90 border border-slate-850 rounded-xl p-5 h-[320px] overflow-y-auto font-mono text-[11px] leading-relaxed text-emerald-300/90 space-y-1 terminal-glow"
            >
              {activeExec.logs.map((line, lIdx) => (
                <div key={lIdx} className="whitespace-pre-wrap">{line}</div>
              ))}

              {activeExec.status === 'running' && (
                <div className="flex items-center gap-2 text-amber-300 text-xs py-2 animate-pulse">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>원격 장비가 CLI 응답 패킷을 연산 중입니다... ({activeExec.currentCommand})</span>
                </div>
              )}
            </div>

            {/* Active session interactive command CLI input (SecureCRT command bar) */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-[10px] text-slate-400 font-bold cursor-pointer select-none w-fit">
                <input
                  type="checkbox"
                  id="broadcast-toggle"
                  checked={broadcastToAll}
                  onChange={(e) => setBroadcastToAll(e.target.checked)}
                  className="accent-indigo-500 cursor-pointer"
                />
                <Radio className="w-3 h-3 text-indigo-400" />
                모든 활성 세션에 동시 전송 (Broadcast to all sessions{openSessionCount > 0 ? ` · ${openSessionCount}개 연결됨` : ''})
              </label>
              <form onSubmit={handleSendManualCommand} className="flex gap-2" id="manual-cli-form">
                <div className="flex-1 bg-slate-950 border border-slate-850 rounded-xl flex items-center px-3 gap-2">
                  <span className="font-mono text-xs text-slate-500 font-bold select-none">Manual_CLI#</span>
                  <input
                    type="text"
                    className="w-full bg-transparent border-0 text-white font-mono text-xs focus:outline-none py-2.5 disabled:opacity-40"
                    placeholder={
                      activeExec.sessionOpen
                        ? "대화식 수동 명령을 장비에 직접 송출합니다... (e.g., show run-config, ping 8.8.8.8)"
                        : "세션이 종료되어 수동 명령을 보낼 수 없습니다. 장비 목록에서 다시 접속하세요."
                    }
                    value={manualCommand}
                    onChange={(e) => setManualCommand(e.target.value)}
                    disabled={!activeExec.sessionOpen}
                  />
                </div>
                <button
                  id="send-manual-cli-btn"
                  type="submit"
                  disabled={!activeExec.sessionOpen || !manualCommand}
                  className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:pointer-events-none text-slate-300 border border-slate-750 font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition"
                >
                  <Send className="w-3.5 h-3.5" />
                  명령 송출
                </button>
              </form>
              {!activeExec.sessionOpen && (
                <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                  <AlertCircle className="w-3 h-3" />
                  이 세션의 연결이 종료되어 더 이상 명령을 보낼 수 없습니다.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-slate-950/40 border border-slate-850/80 rounded-2xl py-16 text-center text-slate-500 text-xs font-mono flex flex-col items-center justify-center gap-3">
            <Terminal className="w-8 h-8 text-slate-600 animate-pulse" />
            <div className="leading-relaxed">
              활성 또는 과거 터미널 세션이 선택되지 않았습니다.<br/>
              상단 실행기에서 배치 스크립트를 작동시키거나, 장비 목록의 "수동 접속" 버튼으로 세션을 개설하십시오.
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
