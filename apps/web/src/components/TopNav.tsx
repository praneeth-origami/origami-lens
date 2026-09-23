import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import type { AuthUser } from '@origami/contracts';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import {
  OrigamiLensIcon,
  HomeIcon,
  ActivityIcon,
  CubeIcon,
  GitBranchIcon,
  UsersIcon,
  TagIcon,
  ShieldIcon,
  ChevronDownIcon,
} from './icons';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

function MenuIcon({ open }: { open: boolean }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (open) {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M5 5l14 14M19 5L5 19" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

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

interface NavItem {
  to: string;
  label: string;
  end: boolean;
  icon: ComponentType;
}

const BASE_NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', end: true, icon: HomeIcon },
  { to: '/scans', label: 'Scans', end: true, icon: ActivityIcon },
  { to: '/components', label: 'Components', end: false, icon: CubeIcon },
  { to: '/repositories', label: 'Repositories', end: false, icon: GitBranchIcon },
  { to: '/workspace/members', label: 'Workspace', end: false, icon: UsersIcon },
  { to: '/pricing', label: 'Pricing', end: false, icon: TagIcon },
];

const THEME_OPTIONS: ThemeMode[] = ['light', 'dark', 'system'];

/**
 * DashboardPage itself immediately redirects `/` to `/scans/:activeScanId`
 * once it knows the active scan (see DashboardPage.tsx) — so "is Dashboard
 * active" can never be answered by matching the literal `/` path alone,
 * unlike every other nav item. `/scans/:scanId` (bare, no further segments)
 * is still DashboardPage, not the Scans list (ScansListPage, exact `/scans`
 * only) — so it belongs to Dashboard's active state, not Scans's.
 */
function isDashboardRoute(pathname: string): boolean {
  return pathname === '/' || /^\/scans\/[^/]+$/.test(pathname);
}

function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.to === '/') return isDashboardRoute(pathname);
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/**
 * Replaces the old flat avatar+name+"Sign out" row with a real dropdown.
 * Self-contained (own open/close state, click-outside, Escape-to-close,
 * focus-return-to-trigger) — no new dependency, same logout() call as
 * before. The secondary line under the name is real account data
 * (email, or the provider login for OAuth accounts with no email on
 * file) — AuthUser has no job-title-like field, so nothing here is invented.
 */
function ProfileMenu({ user, isElevated, onSignOut }: { user: AuthUser; isElevated: boolean; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const name = user.displayName ?? user.primaryProviderLogin;
  const secondary = user.email ?? user.primaryProviderLogin;
  const initial = name.charAt(0).toUpperCase();
  const closeMenu = () => setOpen(false);

  return (
    <div className="profile-menu-container" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="profile-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {user.avatarUrl ? (
          <img className="profile-avatar" src={user.avatarUrl} alt="" width={28} height={28} />
        ) : (
          <span className="profile-avatar profile-avatar-initial" aria-hidden="true">{initial}</span>
        )}
        <span className="profile-copy">
          <span className="profile-name">{name}</span>
          <span className="profile-secondary">{secondary}</span>
        </span>
        <span className="profile-chevron" aria-hidden="true"><ChevronDownIcon /></span>
      </button>

      {open && (
        <div className="profile-menu" role="menu" aria-label="Profile menu">
          {isElevated && (
            <Link to="/admin" role="menuitem" className="profile-menu-item" onClick={closeMenu}>
              <ShieldIcon /> Admin
            </Link>
          )}
          <Link to="/billing/settings" role="menuitem" className="profile-menu-item" onClick={closeMenu}>
            <TagIcon /> Billing
          </Link>
          <button
            type="button"
            role="menuitem"
            className="profile-menu-item profile-menu-item-danger"
            onClick={() => {
              closeMenu();
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function TopNav() {
  const [themeMode, setThemeMode] = useTheme();
  const { user, loading, logout } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  const isElevated = !!user && user.platformRole !== 'USER';
  const navItems: NavItem[] = isElevated ? [...BASE_NAV_ITEMS, { to: '/admin', label: 'Admin', end: false, icon: ShieldIcon }] : BASE_NAV_ITEMS;

  return (
    <header className="top-nav">
      <div className="top-nav-glow" aria-hidden="true" />
      <div className="top-nav-inner">
        <div className="top-nav-brand">
          <span className="brand-mark-frame">
            <OrigamiLensIcon size={26} className="brand-mark" />
          </span>
          <div className="brand-copy">
            <span className="brand-name">Origami Lens</span>
            <span className="brand-tagline">Find what's wrong with any webpage.</span>
          </div>
        </div>

        <nav id="primary-navigation" className={`top-nav-links ${menuOpen ? 'open' : ''}`} aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={closeMenu}
                className={() => `top-nav-link ${isNavItemActive(item, location.pathname) ? 'active' : ''}`}
              >
                <span className="top-nav-link-icon" aria-hidden="true"><Icon /></span>
                <span className="top-nav-link-label">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="top-nav-actions">
          {!loading && user && <WorkspaceSwitcher />}

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

          {/* Only ever rendered signed-in — App.tsx keeps TopNav unmounted entirely for the signed-out sign-in page (RequireAuth), so there is no logged-out branch to render here. */}
          {!loading && user && <ProfileMenu user={user} isElevated={isElevated} onSignOut={() => void logout()} />}
        </div>

        <button
          type="button"
          className="nav-menu-toggle"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="primary-navigation"
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
        >
          <MenuIcon open={menuOpen} />
        </button>
      </div>
    </header>
  );
}
