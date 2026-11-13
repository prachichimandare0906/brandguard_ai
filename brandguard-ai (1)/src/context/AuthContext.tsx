import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { User, OrgMembership, UserRole } from '../types';
import { api, ApiError, AuthResponse, setActiveOrgHeader, setUnauthorizedHandler } from '../services/api';

interface AuthContextValue {
  user: User | null;
  activeOrg: OrgMembership | null;
  memberships: OrgMembership[];
  role: UserRole | null;
  loading: boolean;
  sessionMessage: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (payload: {
    name: string;
    email: string;
    password: string;
    orgName: string;
    seedStarterBrand?: boolean;
  }) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  createOrg: (name: string, seedStarterBrand?: boolean) => Promise<void>;
  refreshSession: () => Promise<void>;
  clearSessionMessage: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [activeOrg, setActiveOrg] = useState<OrgMembership | null>(null);
  const [memberships, setMemberships] = useState<OrgMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);

  const isAuthenticatedRef = useRef(false);
  const authActionInFlightRef = useRef(false);

  const applyAuthState = useCallback((res: { user: User; activeOrg: OrgMembership; memberships: OrgMembership[] }) => {
    isAuthenticatedRef.current = true;
    setUser(res.user);
    setActiveOrg(res.activeOrg);
    setMemberships(res.memberships);
    setActiveOrgHeader(res.activeOrg.orgId);
    setSessionMessage(null);
  }, []);

  const clearAuthState = useCallback((message?: string) => {
    isAuthenticatedRef.current = false;
    setUser(null);
    setActiveOrg(null);
    setMemberships([]);
    setActiveOrgHeader(null);
    if (message) setSessionMessage(message);
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const res = await api.getSession();
      if (res.authenticated && res.user && res.activeOrg) {
        applyAuthState({
          user: res.user,
          activeOrg: res.activeOrg,
          memberships: res.memberships,
        });
      } else {
        const wasLoggedIn = isAuthenticatedRef.current;
        clearAuthState(
          wasLoggedIn ? 'Your session expired or was signed out. Please sign in again.' : undefined
        );
      }
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 401) {
        const wasLoggedIn = isAuthenticatedRef.current;
        clearAuthState(
          wasLoggedIn ? 'Your session expired or was signed out. Please sign in again.' : undefined
        );
      } else if (!isAuthenticatedRef.current) {
        // Temporary network or 503 outage at startup — do not falsely label as expired session
        clearAuthState(
          err?.message || 'Unable to verify server session right now. Please check connectivity and try again.'
        );
      }
    } finally {
      setLoading(false);
    }
  }, [applyAuthState, clearAuthState]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (isAuthenticatedRef.current && !authActionInFlightRef.current) {
        clearAuthState('Your session expired or was signed out. Please sign in again.');
      }
    });
    refreshSession();
    return () => setUnauthorizedHandler(null);
  }, [clearAuthState, refreshSession]);

  const verifyCookieSessionAfterAuth = async (fallbackRes: AuthResponse): Promise<AuthResponse> => {
    try {
      return await api.me();
    } catch (verifyErr: any) {
      if (verifyErr instanceof ApiError && verifyErr.status === 401) {
        throw new Error(
          'Credentials verified, but the browser did not store or send the session cookie. Ensure cookies are enabled or open BrandGuard AI in a standalone tab.'
        );
      }
      if (verifyErr instanceof ApiError && verifyErr.isNetworkError) {
        throw verifyErr;
      }
      return fallbackRes;
    }
  };

  const login = async (email: string, password: string) => {
    if (authActionInFlightRef.current) return;
    authActionInFlightRef.current = true;
    try {
      const loginRes = await api.login({ email, password });
      const verified = await verifyCookieSessionAfterAuth(loginRes);
      applyAuthState(verified);
    } finally {
      authActionInFlightRef.current = false;
    }
  };

  const register = async (payload: {
    name: string;
    email: string;
    password: string;
    orgName: string;
    seedStarterBrand?: boolean;
  }) => {
    if (authActionInFlightRef.current) return;
    authActionInFlightRef.current = true;
    try {
      const regRes = await api.register(payload);
      const verified = await verifyCookieSessionAfterAuth(regRes);
      applyAuthState(verified);
    } finally {
      authActionInFlightRef.current = false;
    }
  };

  const logout = async () => {
    authActionInFlightRef.current = true;
    try {
      await api.logout();
    } catch {
      // Clear local auth state even if network logout fails
    } finally {
      clearAuthState();
      authActionInFlightRef.current = false;
    }
  };

  const switchOrg = async (orgId: string) => {
    await api.switchOrg(orgId);
    setActiveOrgHeader(orgId);
    await refreshSession();
  };

  const createOrg = async (name: string, seedStarterBrand = true) => {
    const res = await api.createOrg({ name, seedStarterBrand });
    setActiveOrgHeader(res.activeOrg.orgId);
    await refreshSession();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        activeOrg,
        memberships,
        role: activeOrg?.role || user?.role || null,
        loading,
        sessionMessage,
        login,
        register,
        logout,
        switchOrg,
        createOrg,
        refreshSession,
        clearSessionMessage: () => setSessionMessage(null),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
