import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import { initUserProfile } from '../repositories/userRepository';
import { resolveCurrentUserRole } from '../utils/roles';
import { reportClientEvent } from '../services/observabilityService';
import { isDemoMode } from '../config/appMode';
import { clearElevatedSession } from '../api/authApi';

export interface AuthUser {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  emailVerified?: boolean;
}

export type ServerConnectionStatus = 'checking' | 'connected' | 'error';
export type FirebaseConnectionStatus = ServerConnectionStatus;

interface AuthContextType {
  currentUser: AuthUser | null;
  loading: boolean;
  loginWithGoogle: (registrationData?: { sponsorId?: string; sponsorName?: string; desiredUsername?: string }) => Promise<void>;
  loginDirectly: (email: string, registrationData?: { sponsorId?: string; sponsorName?: string; desiredUsername?: string }) => Promise<void>;
  retryUserProfileSync: () => Promise<void>;
  logout: () => Promise<void>;
  serverConnectionStatus: ServerConnectionStatus;
  firebaseConnectionStatus: FirebaseConnectionStatus;
  isLoggingIn: boolean;
  isAdmin: boolean;
  isAuthModalOpen: boolean;
  setIsAuthModalOpen: (open: boolean) => void;
  authModalMode: 'login' | 'register';
  setAuthModalMode: (mode: 'login' | 'register') => void;
  pendingSponsorId: string;
  setPendingSponsorId: (id: string) => void;
  openLogin: () => void;
  openRegister: (sponsorId?: string) => void;
  authError: { code?: string; message: string } | null;
  clearAuthError: () => void;
}

async function checkGainAccountProvisioned(): Promise<{
  registered: boolean;
  memberStatus?: 'active' | 'suspended' | 'closed';
}> {
  const response = await fetch('/api/account/state', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (response.status === 404 || response.status === 401) return { registered: false };

  let body: any = null;
  try {
    body = await response.json();
  } catch { }

  if (response.ok) {
    const memberStatus = body?.wallet?.member_status || body?.wallet?.status;
    return {
      registered: true,
      memberStatus: memberStatus === 'suspended' || memberStatus === 'closed' ? memberStatus : 'active',
    };
  }

  const code = typeof body?.code === 'string' ? body.code : '';
  const message = typeof body?.message === 'string' && body.message.trim()
    ? body.message
    : `Status akun GAIN gagal diperiksa (${response.status}).`;

  throw Object.assign(new Error(message), {
    code: code || 'ACCOUNT_STATE_CHECK_FAILED',
    memberStatus: body?.wallet?.member_status || body?.wallet?.status,
  });
}

function enforceActiveMemberState(result: { registered: boolean; memberStatus?: 'active' | 'suspended' | 'closed' }) {
  if (!result.registered) return;
  if (result.memberStatus === 'suspended') {
    throw Object.assign(new Error('Akun GAIN sedang ditangguhkan oleh administrator.'), { code: 'MEMBER_SUSPENDED' });
  }
  if (result.memberStatus === 'closed') {
    throw Object.assign(new Error('Akun GAIN sudah ditutup.'), { code: 'MEMBER_CLOSED' });
  }
}

const AuthContext = createContext<AuthContextType>({
  currentUser: null,
  loading: true,
  loginWithGoogle: async () => { },
  loginDirectly: async () => { },
  retryUserProfileSync: async () => { },
  logout: async () => { },
  serverConnectionStatus: 'checking',
  firebaseConnectionStatus: 'checking',
  isLoggingIn: false,
  isAdmin: false,
  isAuthModalOpen: false,
  setIsAuthModalOpen: () => { },
  authModalMode: 'login',
  setAuthModalMode: () => { },
  pendingSponsorId: '',
  setPendingSponsorId: () => { },
  openLogin: () => { },
  openRegister: () => { },
  authError: null,
  clearAuthError: () => { },
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [firebaseConnectionStatus, setFirebaseConnectionStatus] = useState<FirebaseConnectionStatus>('checking');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register'>('login');
  const [pendingSponsorId, setPendingSponsorId] = useState('');
  const [authError, setAuthError] = useState<{ code?: string; message: string } | null>(null);

  const [isAdmin, setIsAdmin] = useState(false);
  const registrationDataRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const refParam = (params.get('ref') || params.get('sponsor') || params.get('ref_id'))?.trim().toUpperCase();
    if (refParam && /^GN-\d{5}$/.test(refParam)) {
      setPendingSponsorId(refParam);
      if (!currentUser && (window.location.pathname.includes('/register') || params.has('ref') || params.has('sponsor'))) {
        setIsAuthModalOpen(true);
        setAuthModalMode('register');
      }
    }
  }, [currentUser]);

  useEffect(() => {
    let cancelled = false;
    const updateAdminStatus = async () => {
      if (!currentUser) { setIsAdmin(false); return; }
      try {
        const role = await resolveCurrentUserRole();
        if (!cancelled) setIsAdmin(role === 'admin' || role === 'super_admin');
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
    };
    updateAdminStatus();
    return () => { cancelled = true; };
  }, [currentUser]);

  useEffect(() => {
    let connectionCheckActive = true;
    const checkBackendReadiness = async () => {
      try {
        const response = await fetch('/readyz', { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!connectionCheckActive) return;
        setFirebaseConnectionStatus(response.ok ? 'connected' : 'error');
      } catch {
        if (connectionCheckActive) setFirebaseConnectionStatus('error');
      }
    };
    const handleBrowserOffline = () => setFirebaseConnectionStatus('error');
    void checkBackendReadiness();
    window.addEventListener('online', checkBackendReadiness);
    window.addEventListener('offline', handleBrowserOffline);

    // Phase 3 session check
    const checkSession = async () => {
      try {
        const res = await fetch('/api/auth/session-status', { method: 'GET' });
        if (res.ok) {
          const accountState = await checkGainAccountProvisioned();
          enforceActiveMemberState(accountState);
          if (accountState.registered) {
            let savedUser = null;
            try { savedUser = JSON.parse(localStorage.getItem('gain_saved_user') || 'null'); } catch { }
            if (savedUser) setCurrentUser(savedUser);
          } else {
            setCurrentUser(null);
          }
        } else {
          setCurrentUser(null);
          localStorage.removeItem('gain_saved_user');
        }
      } catch (e) {
        console.warn('Session check failed', e);
      }
      setLoading(false);
    };

    void checkSession();

    return () => {
      connectionCheckActive = false;
      window.removeEventListener('online', checkBackendReadiness);
      window.removeEventListener('offline', handleBrowserOffline);
    };
  }, []);

  const googleLoginHandler = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      setIsLoggingIn(true);
      setAuthError(null);
      
      const isRegistration = Boolean(registrationDataRef.current);
      
      try {
        // Send access token to backend
        const res = await fetch('/api/auth/google/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: tokenResponse.access_token,
            registrationData: registrationDataRef.current
          })
        });
        
        if (!res.ok) throw new Error('Login to server failed');
        const data = await res.json();
        const userObj = data.user;
        
        if (isRegistration) {
          await initUserProfile(userObj, registrationDataRef.current);
          setCurrentUser(userObj);
          if (typeof window !== 'undefined') localStorage.setItem('gain_saved_user', JSON.stringify(userObj));
          setAuthError(null);
          setIsAuthModalOpen(false);
          reportClientEvent('auth.google.authenticated', { provider: 'google' });
          return;
        }

        const accountState = await checkGainAccountProvisioned();
        enforceActiveMemberState(accountState);

        if (!accountState.registered) {
          setCurrentUser(null);
          if (typeof window !== 'undefined') {
            localStorage.removeItem(`gain_wallet_${userObj.uid}`);
            localStorage.removeItem('gain_saved_user');
          }
          setAuthModalMode('register');
          setIsAuthModalOpen(true);
          setAuthError({
            code: 'ACCOUNT_NOT_REGISTERED',
            message: 'Akun Google Anda belum terdaftar sebagai Member GAIN. Silakan pilih "Daftar Akun Baru" terlebih dahulu.',
          });
          return;
        }

        setCurrentUser(userObj);
        setIsAuthModalOpen(false);
        if (typeof window !== 'undefined') localStorage.setItem('gain_saved_user', JSON.stringify(userObj));
        reportClientEvent('auth.google.authenticated', { provider: 'google' });
        
      } catch (err: any) {
        const code = typeof err?.code === 'string' ? err.code : 'auth/error';
        console.error('[AUTH_LOGIN_FAILED]', { code });
        reportClientEvent('auth.login.failed', { provider: 'google', errorCode: code });
        setAuthError({ code, message: err?.message || 'Login Google gagal' });
      } finally {
        registrationDataRef.current = null;
        setIsLoggingIn(false);
      }
    },
    onError: (error) => {
      console.error('[Google Auth] Sign-in notice:', error);
      setIsLoggingIn(false);
    },
    onNonOAuthError: (error) => {
      console.error('[Google Auth] Non-OAuth error (popup closed or blocked):', error);
      setIsLoggingIn(false);
    }
  });

  const loginWithGoogle = async (registrationData?: { sponsorId?: string; sponsorName?: string; desiredUsername?: string }) => {
    setIsLoggingIn(true);
    setAuthError(null);
    registrationDataRef.current = registrationData;
    googleLoginHandler();
  };

  const loginDirectly = async (email: string, registrationData?: { sponsorId?: string; sponsorName?: string; desiredUsername?: string }) => {
    if (!isDemoMode) {
      setAuthError({ code: 'auth/demo-login-disabled', message: 'Login email hanya tersedia dalam mode demo.' });
      return;
    }
    setIsLoggingIn(true);
    setAuthError(null);
    try {
      const dummyUser = {
        uid: `gain-usr-${email.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}`,
        displayName: registrationData?.desiredUsername || email.split('@')[0],
      } as any;
      setCurrentUser(dummyUser);
      if (typeof window !== 'undefined') localStorage.setItem('gain_saved_user', JSON.stringify(dummyUser));
      await initUserProfile(dummyUser, registrationData);
    } catch (err: any) {
      reportClientEvent('auth.login.failed', { provider: 'direct-demo', errorCode: 'auth/direct-login-error' });
      setAuthError({ code: 'auth/direct-login-error', message: err?.message || 'Login langsung gagal' });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const retryUserProfileSync = async () => {
    if (!currentUser) throw new Error('Sesi belum siap. Silakan muat ulang halaman lalu coba lagi.');
    setAuthError(null);
    try {
      const accountState = await checkGainAccountProvisioned();
      enforceActiveMemberState(accountState);
      if (!accountState.registered) {
        setCurrentUser(null);
        setAuthModalMode('register');
        setIsAuthModalOpen(true);
        throw Object.assign(new Error('Akun Google belum terdaftar sebagai Member GAIN.'), { code: 'ACCOUNT_NOT_REGISTERED' });
      }
    } catch (err: any) {
      const message = err?.message || 'Status akun GAIN belum dapat diverifikasi.';
      setAuthError({ code: err?.code || 'ACCOUNT_STATE_CHECK_FAILED', message });
      throw err;
    }
  };

  const logout = async () => {
    try {
      await clearElevatedSession();
      await fetch('/api/auth/session-logout', { method: 'POST' });
      reportClientEvent('auth.logout.success');
      if (typeof window !== 'undefined') {
        localStorage.removeItem('gain_saved_user');
        localStorage.removeItem('gain_active_api_creds');
        localStorage.removeItem('gain_active_api_creds_map');
        sessionStorage.removeItem('gain_active_api_creds');
      }
      setCurrentUser(null);
    } catch (err: any) {
      const code = typeof err?.code === 'string' ? err.code : 'auth/logout-error';
      console.error('[AUTH_LOGOUT_FAILED]', { code });
      reportClientEvent('auth.logout.failed', { errorCode: code });
      setAuthError({ code, message: err?.message || 'Logout gagal. Sesi tetap aktif.' });
    }
  };

  const openLogin = () => { setAuthModalMode('login'); setIsAuthModalOpen(true); };
  const openRegister = (sponsorId?: string) => { if (sponsorId) setPendingSponsorId(sponsorId); setAuthModalMode('register'); setIsAuthModalOpen(true); };
  const clearAuthError = () => { setAuthError(null); };

  return (
    <AuthContext.Provider
      value={{
        currentUser, loading, loginWithGoogle, loginDirectly, retryUserProfileSync, logout,
        serverConnectionStatus: firebaseConnectionStatus,
        firebaseConnectionStatus, isLoggingIn, isAdmin, isAuthModalOpen, setIsAuthModalOpen,
        authModalMode, setAuthModalMode, pendingSponsorId, setPendingSponsorId, openLogin,
        openRegister, authError, clearAuthError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
