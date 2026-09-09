import { useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'origami-theme-preference';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredTheme(): ThemeMode {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'light' || saved === 'dark' || saved === 'system') {
    return saved;
  }
  return 'system';
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? getSystemTheme() : mode;
}

function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
  localStorage.setItem(THEME_STORAGE_KEY, mode);
}

/**
 * Single source of truth for the theme toggle, shared by every page via
 * TopNav. main.tsx still does its own synchronous pre-paint apply (to avoid
 * a flash of the wrong theme before React mounts) — this hook picks up that
 * same stored value and keeps it in sync afterward.
 */
export function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getStoredTheme());

  useEffect(() => {
    applyTheme(themeMode);

    if (themeMode !== 'system') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      document.documentElement.setAttribute('data-theme', resolveTheme('system'));
    };

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handleChange);
      return () => media.removeEventListener('change', handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, [themeMode]);

  return [themeMode, setThemeModeState];
}
