import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout';
import { MailIcon } from '../components/icons';
import { useAuth } from '../hooks/useAuth';
import { ApiRequestError } from '../api/client';

export function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await requestPasswordReset({ email });
      // Always the same success state regardless of whether the email exists
      // — see the backend's requestPasswordReset doc comment for why.
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="auth-card">
        <div>
          <h1>Forgot your password?</h1>
          <p className="auth-card-subtitle">Enter your email and we'll send you a reset link</p>
        </div>

        {error && <p className="auth-error" role="alert">{error}</p>}

        {sent ? (
          <p className="auth-success">
            If an account exists for that email, a password reset link is on its way. Check your inbox.
          </p>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="auth-field">
              <label htmlFor="forgot-email">Email address</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon"><MailIcon /></span>
                <input
                  id="forgot-email"
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

            <button type="submit" className="auth-submit-button" disabled={loading}>
              {loading ? 'Sending reset link…' : 'Send reset link'}
            </button>
          </form>
        )}

        <p className="auth-card-footer">
          <Link to="/login" className="auth-link">← Back to sign in</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
