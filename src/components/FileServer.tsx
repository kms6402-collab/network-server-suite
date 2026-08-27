import React, { useState } from 'react';
import { 
  FolderOpen, FileCode, Trash2, ArrowUpRight, ArrowDownLeft, 
  Settings, Server, Power, RefreshCw, Plus, Download, Upload, Clock, HardDrive
} from 'lucide-react';
import { TftpFtpConfig, FileRecord, TransferLog } from '../types';

interface FileServerProps {
  config: TftpFtpConfig;
  files: FileRecord[];
  transferLogs: TransferLog[];
  onToggleService: (service: 'TFTP' | 'FTP', enabled: boolean) => void;
  onUpdateConfig: (rootFolder: string, tftpPort: number, ftpPort: number) => void;
  onUploadSimulatedFile: (name: string, size: number, type: 'TFTP' | 'FTP') => void;
  onDownloadSimulatedFile: (name: string, type: 'TFTP' | 'FTP') => void;
  onDeleteFile: (name: string) => void;
  onCreateFile: (name: string, content: string) => void;
  onClearTransfers: () => void;
}

export default function FileServer({
  config,
  files,
  transferLogs,
  onToggleService,
  onUpdateConfig,
  onUploadSimulatedFile,
  onDownloadSimulatedFile,
  onDeleteFile,
  onCreateFile,
  onClearTransfers
}: FileServerProps) {
  
  // Local state
  const [rootFolder, setRootFolder] = useState(config.rootFolder);
  const [tftpPort, setTftpPort] = useState(config.tftpPort);
  const [ftpPort, setFtpPort] = useState(config.ftpPort);
  
  // File editor form
  const [newFileName, setNewFileName] = useState("");
  const [newFileContent, setNewFileContent] = useState("");
  const [showEditor, setShowEditor] = useState(false);

  // Simulated upload choice
  const [simUploadName, setSimUploadName] = useState("cisco_ios_15_4_vlan.bin");
  const [simUploadSize, setSimUploadSize] = useState("85"); // in MB
  const [simUploadProto, setSimUploadProto] = useState<'TFTP' | 'FTP'>("TFTP");

  const handleUpdateConfig = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateConfig(rootFolder, Number(tftpPort), Number(ftpPort));
  };

  const handleCreateFile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFileName) return;
    onCreateFile(newFileName, newFileContent);
    setNewFileName("");
    setNewFileContent("");
    setShowEditor(false);
  };

  const triggerUploadSimulation = () => {
    const sizeInBytes = Number(simUploadSize) * 1024 * 1024;
    onUploadSimulatedFile(simUploadName, sizeInBytes, simUploadProto);
  };

  const getFormatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="space-y-6 animate-fade-in" id="files-tab">
      {/* Port Configuration & Status header */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Service Controls Column */}
        <div className="p-5 glass-card rounded-2xl space-y-4">
          <h3 className="text-sm font-display font-bold text-white border-b border-slate-855 pb-2.5 flex items-center gap-2">
            <Settings className="w-4 h-4 text-indigo-400" />
            TFTP / FTP 서버 포트 설정
          </h3>
          <form onSubmit={handleUpdateConfig} className="space-y-4 text-xs" id="tftp-config-form">
            <div>
              <label className="block text-slate-300 font-bold mb-1.5">공유 폴더 경로</label>
              <input
                type="text"
                className="w-full bg-slate-950 border border-slate-850 rounded-xl p-2.5 text-white font-mono text-xs focus:outline-none focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/40 transition"
                value={rootFolder}
                onChange={(e) => setRootFolder(e.target.value)}
                placeholder="C:\path\to\shared_folder"
              />
              <span className="text-[10px] text-slate-500 mt-1.5 block">폴더의 절대 경로를 입력하세요. 없으면 자동 생성됩니다.</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-300 font-bold mb-1.5">TFTP 포트 (Default 69)</label>
                <input 
                  type="number" 
                  className="w-full bg-slate-950 border border-slate-850 rounded-xl p-2.5 text-white font-mono focus:outline-none focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/40 transition"
                  value={tftpPort}
                  onChange={(e) => setTftpPort(Number(e.target.value))}
                />
              </div>
              <div>
                <label className="block text-slate-300 font-bold mb-1.5">FTP 포트 (Default 21)</label>
                <input 
                  type="number" 
                  className="w-full bg-slate-950 border border-slate-850 rounded-xl p-2.5 text-white font-mono focus:outline-none focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/40 transition"
                  value={ftpPort}
                  onChange={(e) => setFtpPort(Number(e.target.value))}
                />
              </div>
            </div>

            <button
              id="save-tftp-config-btn"
              type="submit"
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-bold tracking-wide transition shadow-lg shadow-indigo-950/50 cursor-pointer"
            >
              설정 저장
            </button>
          </form>

          {/* Quick status displays */}
          <div className="space-y-3 pt-4 border-t border-slate-850 text-xs">
            <div className="flex justify-between items-center bg-slate-950/40 border border-slate-850 p-3 rounded-xl hover:bg-slate-950/60 transition">
              <div>
                <div className="font-bold text-white flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${config.tftpEnabled ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`}></span>
                  TFTP Server Daemon
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">펌웨어 전송용 프로토콜</div>
              </div>
              <button
                id="toggle-tftp-btn"
                onClick={() => onToggleService('TFTP', !config.tftpEnabled)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition ${config.tftpEnabled ? 'bg-rose-600/15 text-rose-400 border border-rose-900/50 hover:bg-rose-600/25' : 'bg-emerald-600/15 text-emerald-400 border border-emerald-900/50 hover:bg-emerald-600/25'}`}
              >
                <Power className="w-3.5 h-3.5" />
                {config.tftpEnabled ? 'Deactivate' : 'Activate'}
              </button>
            </div>

            <div className="flex justify-between items-center bg-slate-950/40 border border-slate-850 p-3 rounded-xl hover:bg-slate-950/60 transition">
              <div>
                <div className="font-bold text-white flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${config.ftpEnabled ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`}></span>
                  FTP Server Daemon
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">인증 기반 파일 전송</div>
              </div>
              <button
                id="toggle-ftp-btn"
                onClick={() => onToggleService('FTP', !config.ftpEnabled)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition ${config.ftpEnabled ? 'bg-rose-600/15 text-rose-400 border border-rose-900/50 hover:bg-rose-600/25' : 'bg-emerald-600/15 text-emerald-400 border border-emerald-900/50 hover:bg-emerald-600/25'}`}
              >
                <Power className="w-3.5 h-3.5" />
                {config.ftpEnabled ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </div>
        </div>

        {/* Local File Explorer */}
        <div className="lg:col-span-2 p-5 glass-card rounded-2xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-855 pb-3">
            <div className="flex items-center gap-2">
              <FolderOpen className="w-5 h-5 text-indigo-400" />
              <div>
                <h3 className="text-sm font-display font-bold text-white">
                  공유 폴더 파일 목록
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">FTP/TFTP로 접근 가능한 파일 목록</p>
              </div>
            </div>
            <button
              id="show-file-editor-btn"
              onClick={() => setShowEditor(!showEditor)}
              className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer transition shadow-lg shadow-indigo-950/20"
            >
              <Plus className="w-3.5 h-3.5" />
              신규 설정파일 생성
            </button>
          </div>

          {/* New file editor panel */}
          {showEditor && (
            <form onSubmit={handleCreateFile} className="p-4 bg-slate-950/80 border border-slate-850 rounded-xl space-y-3 text-xs" id="new-file-form">
              <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider block">설정 파일 작성 (.cfg, .txt)</span>
              <div className="grid grid-cols-3 gap-3 items-center">
                <label className="text-slate-300 font-bold">파일 이름</label>
                <input 
                  type="text" 
                  className="col-span-2 bg-slate-900 border border-slate-800 rounded-lg p-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                  placeholder="vlan_migration_config.cfg"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-slate-300 font-bold">파일 내용</label>
                <textarea 
                  className="w-full h-24 bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-white font-mono text-[11px] focus:outline-none focus:border-indigo-500"
                  placeholder="! Cisco commands go here..."
                  value={newFileContent}
                  onChange={(e) => setNewFileContent(e.target.value)}
                ></textarea>
              </div>
              <div className="flex justify-end gap-2 text-[11px]">
                <button 
                  id="cancel-create-file-btn"
                  type="button" 
                  onClick={() => setShowEditor(false)}
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg cursor-pointer transition"
                >
                  취소
                </button>
                <button 
                  id="submit-create-file-btn"
                  type="submit" 
                  className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold cursor-pointer transition"
                >
                  저장
                </button>
              </div>
            </form>
          )}

          {/* Files List Table */}
          <div className="overflow-hidden border border-slate-850 rounded-xl bg-slate-950/20">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/80 border-b border-slate-850 text-slate-300 font-bold">
                <tr>
                  <th className="p-3">파일명</th>
                  <th className="p-3">용량 Size</th>
                  <th className="p-3">수정 날짜</th>
                  <th className="p-3 text-right">삭제</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850/40">
                {files.map((file) => (
                  <tr key={file.name} className="hover:bg-slate-900/10 text-slate-300">
                    <td className="p-3 flex items-center gap-2">
                      <FileCode className="w-4 h-4 text-indigo-400 shrink-0" />
                      <span className="font-bold font-mono text-slate-200 truncate max-w-[150px]" title={file.name}>
                        {file.name}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-slate-400 text-[11px]">{getFormatSize(file.size)}</td>
                    <td className="p-3 text-slate-500 text-[11px]">{new Date(file.modifiedTime).toLocaleDateString()}</td>
                    <td className="p-3 text-right">
                      <button
                        id={`delete-file-${file.name}`}
                        onClick={() => onDeleteFile(file.name)}
                        className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-950/20 rounded-lg cursor-pointer transition"
                        title="삭제"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {files.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center text-slate-500 py-12">저장된 파일이 없습니다.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* History and transfer records */}
      <div className="p-5 glass-card rounded-2xl space-y-3">
        <div className="flex items-center justify-between border-b border-slate-855 pb-3">
          <div>
            <h3 className="text-sm font-display font-bold text-white">
              파일 전송 로그
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">장비가 파일을 주고받은 전체 내역</p>
          </div>
          <button
            id="clear-transfers-btn"
            onClick={onClearTransfers}
            className="text-slate-400 hover:text-rose-400 border border-slate-855 bg-slate-950 px-3 py-2 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
            내역 삭제
          </button>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-850 bg-slate-950/20">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900/80 border-b border-slate-850 text-slate-300 font-bold">
              <tr>
                <th className="p-3">프로토콜</th>
                <th className="p-3">타입</th>
                <th className="p-3">파일명</th>
                <th className="p-3">파일 크기</th>
                <th className="p-3">장비 IP</th>
                <th className="p-3">전송 속도</th>
                <th className="p-3">일시</th>
                <th className="p-3 text-right">전송 결과</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850/40">
              {transferLogs.slice().reverse().map((log) => (
                <tr key={log.id} className="hover:bg-slate-900/10 text-slate-300">
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                      log.service === 'FTP' ? 'bg-blue-500/15 text-blue-400 border-blue-900/30' : 'bg-purple-500/15 text-purple-400 border-purple-900/30'
                    }`}>
                      {log.service}
                    </span>
                  </td>
                  <td className="p-3">
                    <span className="flex items-center gap-1 text-[11px]">
                      {log.operation === 'UPLOAD' ? (
                        <>
                          <ArrowUpRight className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span className="text-amber-400 font-bold">업로드</span>
                        </>
                      ) : (
                        <>
                          <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          <span className="text-emerald-400 font-bold">다운로드</span>
                        </>
                      )}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-slate-200 truncate max-w-[180px]" title={log.fileName}>
                    {log.fileName}
                  </td>
                  <td className="p-3 text-slate-400 font-mono text-[11px]">{getFormatSize(log.fileSize)}</td>
                  <td className="p-3 font-mono text-slate-300">{log.clientIp}</td>
                  <td className="p-3 font-mono text-slate-400 text-[11px]">{log.speed}</td>
                  <td className="p-3 text-slate-500 text-[11px]">{new Date(log.timestamp).toLocaleString()}</td>
                  <td className="p-3 text-right">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                      log.status === 'COMPLETED' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-900/40' :
                      log.status === 'IN_PROGRESS' ? 'bg-amber-500/10 text-amber-400 border-amber-900/40 animate-pulse' : 'bg-rose-500/10 text-rose-400 border-rose-900/40'
                    }`}>
                      {log.status === 'COMPLETED' ? '성공' : log.status === 'IN_PROGRESS' ? '전송중' : '실패'}
                    </span>
                  </td>
                </tr>
              ))}
              {transferLogs.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-slate-500 py-12">전송 로그가 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
