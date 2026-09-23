import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout';
import { PasswordField } from '../components/PasswordField';
import { useAuth } from '../hooks/useAuth';
import { ApiRequestError } from '../api/client';

export function ResetPasswordPage() {
  const { resetPassword } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await resetPassword({ token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Failed to reset your password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="auth-card">
        <div>
          <h1>Reset your password</h1>
          <p className="auth-card-subtitle">Choose a new password for your account</p>
        </div>

        {!token && (
          <p className="auth-error" role="alert">
            This reset link is missing its token — please use the link from your email, or request a new one.
          </p>
        )}

        {error && <p className="auth-error" role="alert">{error}</p>}

        {done ? (
          <>
            <p className="auth-success">Your password has been reset. You can now sign in with your new password.</p>
            <button type="button" className="auth-submit-button" onClick={() => navigate('/login', { replace: true })}>
              Go to sign in
            </button>
          </>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" placeholder="At least 8 characters" />
            <PasswordField label="Confirm new password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" placeholder="Re-enter your new password" />

            <button type="submit" className="auth-submit-button" disabled={loading || !token}>
              {loading ? 'Resetting…' : 'Reset password'}
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
