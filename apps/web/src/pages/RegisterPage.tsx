import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, type Location } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout';
import { AuthDivider } from '../components/AuthDivider';
import { SocialLoginButtons } from '../components/SocialLoginButtons';
import { PasswordField } from '../components/PasswordField';
import { MailIcon, UserIcon } from '../components/icons';
import { useAuth } from '../hooks/useAuth';
import { ApiRequestError } from '../api/client';

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  /** Same router-state continuation LoginPage.tsx uses — set by InvitationPage.tsx so "sign up" from an invitation link returns here instead of the dashboard. Undefined for every ordinary signup, which keeps the original '/' redirect below. */
  const from = (location.state as { from?: Location } | null)?.from;

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await register({ displayName, email, password });
      navigate(from ? `${from.pathname}${from.search}` : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Failed to create your account. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="auth-card">
        <div>
          <h1>Create your account</h1>
          <p className="auth-card-subtitle">Start finding and fixing issues with Origami Lens</p>
        </div>

        <SocialLoginButtons />
        <AuthDivider label="or continue with email" />

        {error && <p className="auth-error" role="alert">{error}</p>}

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="register-name">Full name</label>
            <div className="auth-input-wrap">
              <span className="auth-input-icon"><UserIcon /></span>
              <input
                id="register-name"
                type="text"
                className="auth-input"
                placeholder="Jane Doe"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                required
              />
            </div>
          </div>

          <div className="auth-field">
            <label htmlFor="register-email">Email address</label>
            <div className="auth-input-wrap">
              <span className="auth-input-icon"><MailIcon /></span>
              <input
                id="register-email"
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

          <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="new-password" placeholder="At least 8 characters" />
          <PasswordField label="Confirm password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" placeholder="Re-enter your password" />

          <button type="submit" className="auth-submit-button" disabled={loading}>
            {loading ? 'Creating account…' : 'Create account →'}
          </button>
        </form>

        <p className="auth-card-footer">
          Already have an account? <Link to="/login" className="auth-link">Sign in</Link>
        </p>

        <p className="auth-card-terms">
          By creating an account, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </AuthLayout>
  );
}
