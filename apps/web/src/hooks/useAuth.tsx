import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type {
  AuthUser,
  ForgotPasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResendVerificationEmailRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
} from '@origami/contracts';
import {
  fetchCurrentUser,
  loginWithEmail as loginWithEmailRequest,
  logout as logoutRequest,
  registerWithEmail as registerWithEmailRequest,
  requestPasswordReset as requestPasswordResetRequest,
  resendVerificationEmail as resendVerificationEmailRequest,
  resetPassword as resetPasswordRequest,
  verifyEmail as verifyEmailRequest,
} from '../api/client';

export interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  /** Email/password login (Phase 16/H) — GitHub/Google remain full-page redirects (githubLoginUrl()/googleLoginUrl()), not driven by this hook. */
  login: (input: LoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  requestPasswordReset: (input: ForgotPasswordRequest) => Promise<void>;
  resetPassword: (input: ResetPasswordRequest) => Promise<void>;
  /** Additive only — confirms/resends an email-verification link. Nothing in the app gates on verification status; see AuthUser.emailVerifiedAt's doc comment. */
  verifyEmail: (input: VerifyEmailRequest) => Promise<void>;
  resendVerificationEmail: (input: ResendVerificationEmailRequest) => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

/**
 * Phase 16/A — reads the current signed-in Origami Lens user, if any, via
 * the session cookie (never localStorage — see the Phase 16 design
 * report's threat model on why the session lives only in an httpOnly
 * cookie). GitHub/Google sign-in are full-page navigations to
 * githubLoginUrl()/googleLoginUrl(), not driven by this hook; email/password
 * (Phase 16/H) IS driven by this hook, since it's a plain JSON POST with no
 * redirect involved.
 *
 * A single provider (mounted once in App.tsx) owns the fetch so every
 * consumer — TopNav, RequireAuth — shares one /auth/me call instead of
 * each firing its own.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { user: current } = await fetchCurrentUser();
    setUser(current);
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const logout = useCallback(async () => {
    await logoutRequest();
    setUser(null);
  }, []);

  const login = useCallback(async (input: LoginRequest) => {
    const { user: loggedIn } = await loginWithEmailRequest(input);
    setUser(loggedIn);
  }, []);

  const register = useCallback(async (input: RegisterRequest) => {
    const { user: created } = await registerWithEmailRequest(input);
    setUser(created);
  }, []);

  const requestPasswordReset = useCallback(async (input: ForgotPasswordRequest) => {
    await requestPasswordResetRequest(input);
  }, []);

  const resetPassword = useCallback(async (input: ResetPasswordRequest) => {
    await resetPasswordRequest(input);
  }, []);

  const verifyEmail = useCallback(async (input: VerifyEmailRequest) => {
    await verifyEmailRequest(input);
  }, []);

  const resendVerificationEmail = useCallback(async (input: ResendVerificationEmailRequest) => {
    await resendVerificationEmailRequest(input);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, refresh, logout, login, register, requestPasswordReset, resetPassword, verifyEmail, resendVerificationEmail }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
