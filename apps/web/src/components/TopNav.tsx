import { NavLink } from 'react-router-dom';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { githubLoginUrl } from '../api/client';

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  if (mode === 'light') {
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77" />
      </svg>
    );
  }

  if (mode === 'dark') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M20 15.5A7.5 7.5 0 0 1 8.5 4a8 8 0 1 0 11.5 11.5Z" />
      </svg>
    );
  }

  return (
    <svg {...common} aria-hidden="true">
      <rect x="2.75" y="4.75" width="18.5" height="14.5" rx="2.5" />
      <path d="M9.5 18.5v-7.5h5.5v7.5" />
      <path d="M12 11.5h7.25" />
    </svg>
  );
}

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/scans', label: 'Scans', end: false },
  { to: '/components', label: 'Components', end: false },
  { to: '/repositories', label: 'Repositories', end: false },
];

const THEME_OPTIONS: ThemeMode[] = ['light', 'dark', 'system'];

export function TopNav() {
  const [themeMode, setThemeMode] = useTheme();
  const { user, loading, logout } = useAuth();

  return (
    <header className="top-nav">
      <div className="top-nav-inner">
        <div className="top-nav-brand">
          <div className="brand-mark" aria-hidden="true">O</div>
          <div className="brand-copy">
            <span className="brand-name">Origami Lens</span>
            <span className="brand-tagline">Find what's wrong with any webpage.</span>
          </div>
        </div>

        <nav className="top-nav-links" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `top-nav-link ${isActive ? 'active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="top-nav-actions">
          <div className="theme-switcher" role="group" aria-label="Theme selector">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={`theme-option ${themeMode === option ? 'active' : ''}`}
                onClick={() => setThemeMode(option)}
                aria-pressed={themeMode === option}
                title={option === 'system' ? 'System theme' : option === 'light' ? 'Light mode' : 'Dark mode'}
              >
                <ThemeIcon mode={option} />
              </button>
            ))}
          </div>

          <div className="auth-status">
            {loading ? null : user ? (
              <>
                {user.avatarUrl ? <img className="auth-avatar" src={user.avatarUrl} alt="" width={24} height={24} /> : null}
                <span className="auth-name">{user.displayName ?? user.primaryProviderLogin}</span>
                <button type="button" className="auth-signout" onClick={() => void logout()}>
                  Sign out
                </button>
              </>
            ) : (
              <a className="auth-signin" href={githubLoginUrl()}>
                Sign in with GitHub
              </a>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
