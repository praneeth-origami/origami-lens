import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout';
import { MailIcon } from '../components/icons';
import { useAuth } from '../hooks/useAuth';
import { ApiRequestError } from '../api/client';

type Status = 'verifying' | 'success' | 'error' | 'no-token';

export function VerifyEmailPage() {
  const { verifyEmail, resendVerificationEmail } = useAuth();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'no-token');
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (!token) return;
    verifyEmail({ token })
      .then(() => setStatus('success'))
      .catch((err) => {
        setError(err instanceof ApiRequestError ? err.message : 'This verification link is invalid or has expired.');
        setStatus('error');
      });
  }, [token, verifyEmail]);

  const handleResend = async (e: FormEvent) => {
    e.preventDefault();
    if (resending) return;
    setResending(true);
    try {
      await resendVerificationEmail({ email });
      // Always the same success state regardless of whether the email exists
      // or is already verified — see the backend's resendVerificationEmail
      // doc comment for why.
      setResent(true);
    } finally {
      setResending(false);
    }
  };

  return (
    <AuthLayout>
      <div className="auth-card">
        <div>
          <h1>Verify your email</h1>
          <p className="auth-card-subtitle">Confirm your email address to finish setting up your account</p>
        </div>

        {status === 'verifying' && <p className="auth-card-subtitle">Verifying your email…</p>}

        {status === 'success' && (
          <p className="auth-success">Your email is verified. You're all set.</p>
        )}

        {status === 'error' && (
          <>
            <p className="auth-error" role="alert">{error}</p>
            {!resent ? (
              <form className="auth-form" onSubmit={handleResend}>
                <div className="auth-field">
                  <label htmlFor="verify-resend-email">Email address</label>
                  <div className="auth-input-wrap">
                    <span className="auth-input-icon"><MailIcon /></span>
                    <input
                      id="verify-resend-email"
                      type="email"
                      className="auth-input"
                      placeholder="you@company.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      required
                    />
                  </div>
                </div>
                <button type="submit" className="auth-submit-button" disabled={resending}>
                  {resending ? 'Sending…' : 'Send a new verification link'}
                </button>
              </form>
            ) : (
              <p className="auth-success">If that account needs verifying, a new link is on its way. Check your inbox.</p>
            )}
          </>
        )}

        {status === 'no-token' && (
          <p className="auth-error" role="alert">
            This verification link is missing its token — please use the link from your email.
          </p>
        )}

        <p className="auth-card-footer">
          <Link to="/login" className="auth-link">← Back to sign in</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
