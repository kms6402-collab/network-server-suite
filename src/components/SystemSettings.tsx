import React, { useState } from 'react';
import {
  Settings, Power, RefreshCw, Trash2, ShieldCheck,
  BookOpen, Info, Cpu, HardDrive, Network, RotateCcw
} from 'lucide-react';
import { SystemStatus } from '../types';

interface SystemSettingsProps {
  status: SystemStatus;
  onToggleAutoStart: (enabled: boolean) => void;
  onFactoryReset: () => void;
  onRestartService: () => void;
}

export default function SystemSettings({
  status,
  onToggleAutoStart,
  onFactoryReset,
  onRestartService
}: SystemSettingsProps) {
  const [isRestarting, setIsRestarting] = useState(false);

  const handleRestartClick = () => {
    if (!window.confirm("서비스를 재시작할까요? 잠시 접속이 끊깁니다.")) return;
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
            재부팅 시 자동 시작 설정
          </h3>

          <div className="space-y-4 text-xs">
            <p className="text-slate-400 leading-relaxed">
              재부팅 후 별도 조작 없이 <strong>DHCP, FTP, TFTP 서비스</strong>가
              자동으로 다시 시작되도록 하는 설정입니다.
            </p>

            <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
              <div>
                <div className="font-semibold text-white">자동 시작 상태</div>
                <div className="text-[10px] text-slate-400 mt-1">
                  활성화하면 시스템 시작 시 서비스가 자동으로 켜집니다.
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
                systemd 등록 가이드 (Linux)
              </span>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                `/etc/systemd/system/network-suite.service`에 등록해 관리할 수 있습니다.
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
              설정 오류나 포트 충돌로 응답이 없을 때, 저장된 데이터를 지우고 초기 상태로 되돌립니다.
            </p>

            <div className="p-4 bg-rose-950/15 border border-rose-900/30 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <span className="text-xs font-semibold text-rose-300 block">공장 초기화</span>
                <p className="text-[10px] text-slate-400">DHCP 임대, 터미널 계정, 스크립트가 모두 초기화됩니다.</p>
              </div>
              <button
                id="factory-reset-btn"
                onClick={onFactoryReset}
                className="px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1 transition shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                서버 초기화 (RESET)
              </button>
            </div>

            <div className="p-4 bg-amber-950/15 border border-amber-900/30 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <span className="text-xs font-semibold text-amber-300 block">서비스 재시작 (Restart Service)</span>
                <p className="text-[10px] text-slate-400">데이터는 유지한 채 프로세스만 재시작합니다. 잠시 접속이 끊깁니다.</p>
              </div>
              <button
                id="restart-service-btn"
                onClick={handleRestartClick}
                disabled={isRestarting}
                className="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold flex items-center gap-1 transition shrink-0"
              >
                <RotateCcw className={`w-3.5 h-3.5 ${isRestarting ? 'animate-spin' : ''}`} />
                {isRestarting ? '재시작 중...' : '서비스 재시작 (RESTART)'}
              </button>
            </div>

            <div className="space-y-3 p-4 bg-slate-950/40 border border-slate-850 rounded-xl">
              <span className="font-semibold text-white block">사용 포트 정보</span>
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

      {/* Manual User Manual Guide details */}
      <div className="p-5 bg-slate-900/40 border border-slate-800 rounded-xl space-y-4">
        <h3 className="text-sm font-display font-semibold text-white border-b border-slate-850 pb-2 flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-indigo-400" />
          이용 가이드 (User Manual)
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-slate-400">
          <div className="space-y-1.5 leading-relaxed">
            <span className="font-semibold text-white flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
              1단계: DHCP 임대 개설
            </span>
            <p>
              DHCP 탭에서 IP 범위와 게이트웨이를 입력 후 활성화하세요.
              연결된 단말이 자동으로 목록에 등록됩니다.
            </p>
          </div>

          <div className="space-y-1.5 leading-relaxed">
            <span className="font-semibold text-white flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
              2단계: 파일 서버 설정
            </span>
            <p>
              FTP/TFTP를 켜면 장비가 설정 파일이나 펌웨어를 주고받을 수 있습니다.
            </p>
          </div>

          <div className="space-y-1.5 leading-relaxed">
            <span className="font-semibold text-white flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
              3단계: SSH/Telnet 자동화
            </span>
            <p>
              장비 계정과 실행할 스크립트를 등록하세요.
              일괄 실행하면 여러 장비에 순서대로 설정을 적용합니다.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
