import React, { useState } from 'react';
import { ShieldCheck, Lock, Building2, UserPlus, LogIn, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export const SignInScreen: React.FC = () => {
  const { login, register, sessionMessage, clearSessionMessage } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');

  // Login fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Register fields
  const [fullName, setFullName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [seedStarterBrand, setSeedStarterBrand] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    clearSessionMessage();
    setSubmitting(true);

    try {
      if (mode === 'login') {
        await login(email.trim(), password);
      } else {
        await register({
          name: fullName.trim(),
          email: email.trim(),
          password,
          orgName: orgName.trim(),
          seedStarterBrand,
        });
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed. Please verify your details.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col justify-center items-center p-6">
      <div className="w-full max-w-md space-y-6">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-teal-500/15 border border-teal-500/30 text-teal-400 font-bold text-xl">
            BG
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">BrandGuard AI</h1>
          <p className="text-xs text-slate-400">
            Enterprise Brand Governance · Multi-Tenant Compliance Workspace
          </p>
        </div>

        {/* Auth Card */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-xl p-6 space-y-5">
          {/* Mode Tabs */}
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg text-xs font-semibold">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError(null);
              }}
              className={`py-2 rounded-md flex items-center justify-center gap-1.5 transition-colors ${
                mode === 'login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Sign In</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setError(null);
              }}
              className={`py-2 rounded-md flex items-center justify-center gap-1.5 transition-colors ${
                mode === 'register' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Create Workspace</span>
            </button>
          </div>

          {sessionMessage && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span>{sessionMessage}</span>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 space-y-1.5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
              {typeof window !== 'undefined' &&
                window.self !== window.top &&
                error.toLowerCase().includes('cookie') && (
                  <div className="pl-6">
                    <a
                      href={window.location.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center font-semibold text-teal-700 hover:text-teal-800 underline"
                    >
                      Open BrandGuard AI in a standalone tab
                    </a>
                  </div>
                )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3.5">
            {mode === 'register' && (
              <>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Full Name</label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    placeholder="e.g. Elena Vance"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Organisation / Brand Name
                  </label>
                  <div className="relative">
                    <Building2 className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                    <input
                      type="text"
                      required
                      minLength={2}
                      placeholder="e.g. Acme Cloud Corp"
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      className="w-full text-xs pl-9 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                  </div>
                </div>
              </>
            )}

            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">Work Email</label>
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                Password {mode === 'register' && <span className="text-slate-400 font-normal">(min. 8 characters)</span>}
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full text-xs pl-9 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
            </div>

            {mode === 'register' && (
              <label className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={seedStarterBrand}
                  onChange={(e) => setSeedStarterBrand(e.target.checked)}
                  className="mt-0.5 accent-teal-600"
                />
                <span>
                  <strong className="text-slate-900">Initialize with starter brand guidelines & sample content</strong>
                  <span className="block text-[11px] text-slate-500 mt-0.5">
                    Creates isolated sample rules, verified facts, terminology, and a draft campaign inside your new organisation.
                  </span>
                </span>
              </label>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <ShieldCheck className="w-4 h-4 text-teal-400" />
              <span>
                {submitting
                  ? mode === 'login'
                    ? 'Verifying Credentials...'
                    : 'Creating Isolated Workspace...'
                  : mode === 'login'
                  ? 'Sign In to BrandGuard AI'
                  : 'Create Admin Account & Workspace'}
              </span>
            </button>
          </form>

          <div className="pt-3 border-t border-slate-100 text-[11px] text-slate-500 space-y-1">
            <div className="flex items-center gap-1.5 text-slate-700 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 shrink-0" />
              <span>HttpOnly database sessions & scrypt password security</span>
            </div>
            <p className="text-slate-400 leading-relaxed">
              Every workspace enforces strict organisation isolation and Creator, Brand Manager, and Administrator permissions.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
