import React, { useState } from 'react';
import { Server, Lock, User, LogIn, UserPlus, AlertCircle } from 'lucide-react';

interface LoginProps {
  // Whether an admin account already exists. When false, this renders a
  // one-time "create admin account" form instead of a login form — there is
  // no other way to reach the dashboard for the very first time.
  configured: boolean;
  onSetup: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  onLogin: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
}

export default function Login({ configured, onSetup, onLogin }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!configured && password !== confirmPassword) {
      setError('비밀번호가 일치하지 않습니다.');
      return;
    }
    setSubmitting(true);
    try {
      const result = configured ? await onLogin(username, password) : await onSetup(username, password);
      if (!result.success) {
        setError(result.error || (configured ? '로그인에 실패했습니다.' : '계정 생성에 실패했습니다.'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center text-slate-100 font-sans px-4">
      <div className="w-full max-w-sm p-6 glass-card rounded-2xl space-y-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-gradient-to-tr from-indigo-600 to-violet-500 rounded-xl shadow-lg shadow-indigo-950/40">
            <Server className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-base font-display font-bold text-white">Network Server Suite</h1>
            <p className="text-[11px] text-slate-400">
              {configured ? '계속하려면 로그인하세요.' : '처음 사용을 위해 관리자 계정을 만드세요.'}
            </p>
          </div>
        </div>

        {!configured && (
          <div className="flex items-start gap-1.5 text-amber-300 bg-amber-950/20 border border-amber-900/40 px-3 py-2 rounded-lg text-[10px] leading-relaxed">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              이 프로그램은 네트워크의 다른 PC에서도 접속할 수 있습니다. 여기서 만드는 계정으로만
              대시보드에 접속할 수 있으니 비밀번호를 안전하게 보관하세요.
            </span>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-1.5 text-rose-400 bg-rose-950/20 border border-rose-900/40 px-3 py-2 rounded-lg text-xs">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block text-slate-400 font-bold mb-1">아이디</label>
            <div className="relative">
              <User className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                autoFocus
                className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 pl-8 text-white font-mono focus:outline-none focus:border-indigo-500 transition"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-slate-400 font-bold mb-1">비밀번호</label>
            <div className="relative">
              <Lock className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 pl-8 text-white font-mono focus:outline-none focus:border-indigo-500 transition"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={4}
                required
              />
            </div>
          </div>
          {!configured && (
            <div>
              <label className="block text-slate-400 font-bold mb-1">비밀번호 확인</label>
              <div className="relative">
                <Lock className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  className="w-full bg-slate-950 border border-slate-850 rounded-lg p-2 pl-8 text-white font-mono focus:outline-none focus:border-indigo-500 transition"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={4}
                  required
                />
              </div>
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-lg font-bold transition flex items-center justify-center gap-1.5 cursor-pointer"
          >
            {configured ? <LogIn className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
            {configured ? '로그인' : '계정 생성'}
          </button>
        </form>
      </div>
    </div>
  );
}
