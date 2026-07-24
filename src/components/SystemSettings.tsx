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
    if (!window.confirm("서비스를 재시작하시겠습니까? 잠시 접속이 끊길 수 있습니다.")) return;
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
            PC / 서버 재부팅 시 자동 가동 데몬 설정 (Service Autostart)
          </h3>
          
          <div className="space-y-4 text-xs">
            <p className="text-slate-400 leading-relaxed">
              서버 OS가 재시작되거나 정전 등의 이슈로 PC가 재부팅되었을 때, 별도의 수동 로그인 및 프로그램 실행 조작 없이 
              <strong> DHCP, FTP, TFTP 가상 백엔드 네트워크 데몬</strong>이 시스템 백그라운드 서비스 수준에서 
              자동으로 초기화 및 복구 가동되도록 지정하는 설정입니다.
            </p>

            <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
              <div>
                <div className="font-semibold text-white">자동 서비스 실행 활성화 (Autostart Status)</div>
                <div className="text-[10px] text-slate-400 mt-1">
                  활성화 시, 본 컨테이너/OS 인프라가 올라올 때 마지막 가동 포트를 자동 바인딩합니다.
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
                실제 Linux OS 배포용 systemd 데몬 등록 가이드
              </span>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                해당 데몬은 Linux `/etc/systemd/system/network-suite.service` 로 영구 가입되어 관리할 수 있습니다.
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
            시스템 초기화 및 백엔드 복구 데이터베이스
          </h3>

          <div className="space-y-4 text-xs">
            <p className="text-slate-400 leading-relaxed">
              설정 오작동 및 포트 충돌, 또는 잘못된 스위치 주소 예약 바인딩으로 인해 백엔드가 반응하지 않는 경우, 
              저장 파일 데이터베이스를 지우고 최초 상태로 되돌립니다.
            </p>

            <div className="p-4 bg-rose-950/15 border border-rose-900/30 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <span className="text-xs font-semibold text-rose-300 block">공장 초기화 (Factory Reset Database)</span>
                <p className="text-[10px] text-slate-400">모든 DHCP 임대 상태, 스위치 터미널 계정, 쉘 자동화 스크립트가 리셋됩니다.</p>
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
                <p className="text-[10px] text-slate-400">데이터는 유지한 채, 백엔드 프로세스만 종료 후 재기동합니다. 수초간 접속이 끊길 수 있습니다.</p>
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
              <span className="font-semibold text-white block">시스템 가동 및 바인딩 자원 리소스</span>
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
          네트워크 서버 스위트 운용 방법 지침 (User Manual)
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-slate-400">
          <div className="space-y-1.5 leading-relaxed">
            <span className="font-semibold text-white flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
              1단계: DHCP 임대 개설
            </span>
            <p>
              DHCP 서버 탭으로 이동하여 임대할 IP 대역폭(Start - End Range)과 게이트웨이 주소를 입력 후 활성화합니다. 
              단말이 접수되면 자동으로 대여 목록에 등록되어 MAC 및 호스트 이름을 확인할 수 있습니다.
            </p>
          </div>

          <div className="space-y-1.5 leading-relaxed">
            <span className="font-semibold text-white flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
              2단계: 파일 서버 및 백업 배치
            </span>
            <p>
              FTP/TFTP 기능을 활성화하면, 임대 장치(L2/L3 스위치 등)가 원격 환경설정 파일이나 OS 바이너리를 업로드하거나 
              안전하게 복사 배포받아 갈 수 있도록 가상 저장소가 자동 마운트됩니다.
            </p>
          </div>

          <div className="space-y-1.5 leading-relaxed">
            <span className="font-semibold text-white flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
              3단계: SSH/Telnet 자동화 배포
            </span>
            <p>
              장치 프로필에 타겟 스위치의 계정을 등록하고, 일괄 실행할 스크립트 매크로를 작성합니다. 
              일괄 배치 자동화(Batch Run)를 실행하면, 여러 장치에 동시 연결하여 설정 변경을 순식간에 적용합니다.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
