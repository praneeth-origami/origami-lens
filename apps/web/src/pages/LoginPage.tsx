import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, type Location } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout';
import { AuthDivider } from '../components/AuthDivider';
import { SocialLoginButtons } from '../components/SocialLoginButtons';
import { PasswordField } from '../components/PasswordField';
import { MailIcon } from '../components/icons';
import { useAuth } from '../hooks/useAuth';
import { ApiRequestError } from '../api/client';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: Location } | null)?.from;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await login({ email, password });
      navigate(from ? `${from.pathname}${from.search}` : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Failed to sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="auth-card">
        <div>
          <h1>Welcome back</h1>
          <p className="auth-card-subtitle">Sign in to your Origami Lens account</p>
        </div>

        <SocialLoginButtons />
        <AuthDivider />

        {error && <p className="auth-error" role="alert">{error}</p>}

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="login-email">Email address</label>
            <div className="auth-input-wrap">
              <span className="auth-input-icon"><MailIcon /></span>
              <input
                id="login-email"
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

          <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" />

          <div className="auth-row-between">
            <label className="auth-checkbox-label">
              <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
              Remember me
            </label>
            <Link to="/forgot-password" className="auth-link">Forgot password?</Link>
          </div>

          <button type="submit" className="auth-submit-button" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in →'}
          </button>
        </form>

        <p className="auth-card-footer">
          Don't have an account? <Link to="/register" className="auth-link">Create account</Link>
        </p>

        <p className="auth-card-terms">
          By signing in, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </AuthLayout>
  );
}
