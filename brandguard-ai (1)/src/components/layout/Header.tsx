import React from 'react';
import { User, OrgMembership } from '../../types';
import { RefreshCw, Cpu, Sparkles, LogOut, ShieldCheck } from 'lucide-react';

interface HeaderProps {
  currentTabName: string;
  currentUser: User | null;
  activeOrg: OrgMembership | null;
  onLogout: () => void;
  onRequestResetDemo: () => void;
  isResetting?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  currentTabName,
  currentUser,
  activeOrg,
  onLogout,
  onRequestResetDemo,
  isResetting = false,
}) => {
  const isAdmin = currentUser?.role === 'admin';

  return (
    <header className="h-16 px-6 bg-white border-b border-slate-200 flex items-center justify-between gap-6 shrink-0 sticky top-0 z-20">
      {/* Zone 1: Breadcrumb Trail */}
      <div className="flex items-center gap-2 text-sm min-w-0">
        <span className="text-slate-400 font-medium truncate">{activeOrg?.name || 'BrandGuard'}</span>
        <span className="text-slate-300">/</span>
        <span className="font-semibold text-slate-800 truncate">{currentTabName}</span>
      </div>

      {/* Zone 2 & 3: Engine Disclosure, Admin Starter Reset, Authenticated User & Logout */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-100 text-xs text-slate-600 border border-slate-200">
          <Cpu className="w-3.5 h-3.5 text-teal-600" />
          <span>Engine:</span>
          <span className="font-semibold text-slate-800 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-teal-600 inline" />
            Gemini + Rule Fallback
          </span>
        </div>

        {isAdmin && (
          <button
            onClick={onRequestResetDemo}
            disabled={isResetting}
            title="Reset current organisation to starter brand template"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isResetting ? 'animate-spin' : ''}`} />
            <span className="hidden lg:inline">Reset Starter</span>
          </button>
        )}

        {/* Authenticated User Identity */}
        <div className="flex items-center gap-3 pl-3 border-l border-slate-200">
          <div className="text-right hidden sm:block">
            <div className="text-xs font-bold text-slate-900 leading-tight">
              {currentUser?.name || 'Authenticated User'}
            </div>
            <div className="text-[11px] text-teal-700 font-medium flex items-center justify-end gap-1 capitalize">
              <ShieldCheck className="w-3 h-3" />
              <span>{currentUser?.role?.replace('_', ' ')}</span>
            </div>
          </div>

          <button
            onClick={onLogout}
            title="Sign out and revoke session"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-md transition-colors"
          >
            <LogOut className="w-3.5 h-3.5 text-slate-600" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </header>
  );
};
