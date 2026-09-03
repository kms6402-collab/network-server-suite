import React, { useState } from 'react';
import {
  Settings, Power, RefreshCw, Trash2, ShieldCheck,
  BookOpen, Info, Cpu, HardDrive, Network, RotateCcw,
  KeyRound, LogOut, Check, AlertCircle
} from 'lucide-react';
import { SystemStatus } from '../types';

interface SystemSettingsProps {
  status: SystemStatus;
  onToggleAutoStart: (enabled: boolean) => void;
  onFactoryReset: () => void;
  onRestartService: () => void;
  authUsername: string;
  onLogout: () => void;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
}

export default function SystemSettings({
  status,
  onToggleAutoStart,
  onFactoryReset,
  onRestartService,
  authUsername,
  onLogout,
  onChangePassword
}: SystemSettingsProps) {
  const [isRestarting, setIsRestarting] = useState(false);

  // Change-password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [pwFeedback, setPwFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  const handleChangePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwFeedback(null);
    if (newPassword !== confirmNewPassword) {
      setPwFeedback({ type: 'error', message: '새 비밀번호가 일치하지 않습니다.' });
      return;
    }
    setPwSaving(true);
    try {
      const result = await onChangePassword(currentPassword, newPassword);
      if (result.success) {
        setPwFeedback({ type: 'success', message: '비밀번호가 변경되었습니다.' });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmNewPassword('');
      } else {
        setPwFeedback({ type: 'error', message: result.error || '비밀번호 변경에 실패했습니다.' });
      }
    } finally {
      setPwSaving(false);
    }
  };

  const handleRestartClick = () => {
    if (!window.confirm("서비스를 재시작하시겠습니까? 잠시 접속이 끊깁니다.")) return;
    setIsRestarting(true);
    onRestartService();
    // The backend process is about to exit and relaunch, so there's nothing
    // meaningful to await here — just leave the button disabled for a beat
    // while the new process comes back up and polling resumes naturally.
    setTimeout(() => setIsRestarting(false), 8000);
  };


  return (
    <div className="space-y-6" id="settings-tab">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Startup service daemon configuration */}
        <div className="p-5 bg-slate-900/40 border border-slate-800 rounded-xl space-y-4">
          <h3 className="text-sm font-display font-semibold text-white border-b border-slate-850 pb-2 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            자동 시작 설정
          </h3>

          <div className="space-y-4 text-xs">
            <p className="text-slate-400 leading-relaxed">
              PC가 재부팅되면 <strong>DHCP, FTP, TFTP</strong> 서비스를 자동으로 다시 실행합니다.
            </p>

            <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
              <div>
                <div className="font-semibold text-white">자동 시작</div>
                <div className="text-[10px] text-slate-400 mt-1">
                  활성화하면 재부팅 시 서비스가 자동으로 시작됩니다.
                </div>
              </div>
              <button
                id="toggle-autostart-btn"
                onClick={() => onToggleAutoStart(!status.autoStart)}
                className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-1 transition ${
                  status.autoStart 
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/10' 
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-400'
                }`}
              >
                <Power className="w-3.5 h-3.5" />
                {status.autoStart ? '자동 실행 ON' : '수동 가동 OFF'}
              </button>
            </div>

            {/* Simulated Systemd startup configuration guide */}
            <div className="space-y-2 bg-slate-950 p-4 border border-slate-850 rounded-xl">
              <span className="font-mono text-[10px] font-bold text-indigo-400 block uppercase tracking-wider">
                systemd 등록 가이드
              </span>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                Linux에서는 `/etc/systemd/system/network-suite.service`로 등록해 관리할 수 있습니다.
              </p>
              <pre className="p-3 bg-slate-900 border border-slate-850 rounded text-[9px] font-mono overflow-x-auto text-slate-300 space-y-1">
                <div>[Unit]</div>
                <div>Description=Network Service Suite (DHCP & TFTP/FTP Daemons)</div>
                <div>After=network.target</div>
                <div className="text-slate-500"># Start auto-daemon on system reboot</div>
                <div>[Service]</div>
                <div>Type=simple</div>
                <div>ExecStart=/usr/bin/node /app/dist/server.cjs</div>
                <div>Restart=always</div>
                <div>RestartSec=10</div>
                <div>[Install]</div>
                <div>WantedBy=multi-user.target</div>
              </pre>
            </div>
          </div>
        </div>

        {/* Administrative tools & Configuration operations */}
        <div className="p-5 bg-slate-900/40 border border-slate-800 rounded-xl space-y-4">
          <h3 className="text-sm font-display font-semibold text-white border-b border-slate-850 pb-2 flex items-center gap-2">
            <Settings className="w-4 h-4 text-indigo-400" />
            시스템 초기화
          </h3>

          <div className="space-y-4 text-xs">
            <p className="text-slate-400 leading-relaxed">
              설정 오류나 충돌로 문제가 생기면 초기 상태로 되돌립니다.
            </p>

            <div className="p-4 bg-rose-950/15 border border-rose-900/30 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <span className="text-xs font-semibold text-rose-300 block">공장 초기화</span>
                <p className="text-[10px] text-slate-400">DHCP 임대, 장비 계정, 스크립트가 모두 초기화됩니다.</p>
              </div>
              <button
                id="factory-reset-btn"
                onClick={onFactoryReset}
                className="px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1 transition shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                초기화
              </button>
            </div>

            <div className="p-4 bg-amber-950/15 border border-amber-900/30 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <span className="text-xs font-semibold text-amber-300 block">서비스 재시작</span>
                <p className="text-[10px] text-slate-400">데이터는 유지한 채 서비스만 재시작합니다. 잠시 접속이 끊길 수 있습니다.</p>
              </div>
              <button
                id="restart-service-btn"
                onClick={handleRestartClick}
                disabled={isRestarting}
                className="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold flex items-center gap-1 transition shrink-0"
              >
                <RotateCcw className={`w-3.5 h-3.5 ${isRestarting ? 'animate-spin' : ''}`} />
                {isRestarting ? '재시작 중...' : '재시작'}
              </button>
            </div>

            <div className="space-y-3 p-4 bg-slate-950/40 border border-slate-850 rounded-xl">
              <span className="font-semibold text-white block">사용 포트</span>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-slate-900/50 p-2.5 rounded border border-slate-850">
                  <div className="text-[10px] text-slate-400">DHCP 서버</div>
                  <div className="font-mono text-emerald-400 font-bold mt-1 text-xs">UDP 67/68</div>
                </div>
                <div className="bg-slate-900/50 p-2.5 rounded border border-slate-850">
                  <div className="text-[10px] text-slate-400">TFTP 서버</div>
                  <div className="font-mono text-indigo-400 font-bold mt-1 text-xs">UDP 69</div>
                </div>
                <div className="bg-slate-900/50 p-2.5 rounded border border-slate-850">
                  <div className="text-[10px] text-slate-400">FTP 서버</div>
                  <div className="font-mono text-blue-400 font-bold mt-1 text-xs">TCP 21</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Web dashboard login account */}
      <div className="p-5 bg-slate-900/40 border border-slate-800 rounded-xl space-y-4">
        <h3 className="text-sm font-display font-semibold text-white border-b border-slate-850 pb-2 flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-sky-400" />
          관리자 계정
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl flex items-center justify-between">
            <div>
              <div className="font-semibold text-white">{authUsername || '(알 수 없음)'}</div>
              <div className="text-[10px] text-slate-400 mt-1">현재 로그인된 계정입니다.</div>
            </div>
            <button
              id="settings-logout-btn"
              onClick={onLogout}
              className="px-3 py-2 bg-slate-800 hover:bg-rose-950/40 hover:text-rose-300 text-slate-300 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              로그아웃
            </button>
          </div>

          <form onSubmit={handleChangePasswordSubmit} className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl space-y-2.5" id="change-password-form">
            <span className="font-semibold text-white block">비밀번호 변경</span>
            {pwFeedback && (
              <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] ${pwFeedback.type === 'success' ? 'text-emerald-400 bg-emerald-950/20 border border-emerald-900/40' : 'text-rose-400 bg-rose-950/20 border border-rose-900/40'}`}>
                {pwFeedback.type === 'success' ? <Check className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
                <span>{pwFeedback.message}</span>
              </div>
            )}
            <input
              type="password"
              className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white font-mono text-xs focus:outline-none focus:border-sky-500 transition"
              placeholder="현재 비밀번호"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="password"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white font-mono text-xs focus:outline-none focus:border-sky-500 transition"
                placeholder="새 비밀번호 (4자 이상)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={4}
                required
              />
              <input
                type="password"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white font-mono text-xs focus:outline-none focus:border-sky-500 transition"
                placeholder="새 비밀번호 확인"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                minLength={4}
                required
              />
            </div>
            <button
              id="change-password-submit"
              type="submit"
              disabled={pwSaving}
              className="w-full py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-lg font-bold transition text-xs cursor-pointer"
            >
              {pwSaving ? '변경 중...' : '비밀번호 변경'}
            </button>
          </form>
        </div>
      </div>

      {/* Manual User Manual Guide details */}
      <div className="p-5 bg-slate-900/40 border border-slate-800 rounded-xl space-y-4">
        <h3 className="text-sm font-display font-semibold text-white border-b border-slate-850 pb-2 flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-indigo-400" />
          사용 가이드
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-slate-400">
          <div className="space-y-1.5 leading-relaxed">
            <span className="font-semibold text-white flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
              1단계: DHCP 임대 개설
            </span>
            <p>
              DHCP 탭에서 IP 범위와 게이트웨이를 설정하고 활성화합니다.
              연결된 단말은 자동으로 목록에 등록됩니다.
            </p>
          </div>

          <div className="space-y-1.5 leading-relaxed">
            <span className="font-semibold text-white flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
              2단계: 파일 서버 및 백업 배치
            </span>
            <p>
              FTP/TFTP를 활성화하면 장비가 설정 파일이나 펌웨어를 주고받을 수 있습니다.
            </p>
          </div>

          <div className="space-y-1.5 leading-relaxed">
            <span className="font-semibold text-white flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
              3단계: SSH/Telnet 자동화 배포
            </span>
            <p>
              장비 계정과 스크립트를 등록한 뒤 일괄 실행하면 여러 장비에 동시에 설정을 적용합니다.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
