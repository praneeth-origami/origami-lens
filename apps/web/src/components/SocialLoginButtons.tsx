import { githubLoginUrl, googleLoginUrl } from '../api/client';
import { GitHubIcon, GoogleIcon } from './icons';

/** GitHub/Google remain full-page redirects (see useAuth.tsx's doc comment) — shared between LoginPage and RegisterPage so both offer the exact same two OAuth options alongside email/password. */
export function SocialLoginButtons() {
  return (
    <div className="auth-signin-options">
      <a className="auth-provider-button auth-provider-button-github" href={githubLoginUrl()}>
        <GitHubIcon /> Continue with GitHub
      </a>
      <a className="auth-provider-button auth-provider-button-google" href={googleLoginUrl()}>
        <GoogleIcon /> Continue with Google
      </a>
    </div>
  );
}
