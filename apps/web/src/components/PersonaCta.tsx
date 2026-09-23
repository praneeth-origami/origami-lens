import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Persona } from '@origami/contracts';
import { useAuth } from '../hooks/useAuth';

interface PersonaCtaConfig {
  title: string;
  description: string;
  ctaLabel: string;
  to: string;
}

/**
 * Phase 4 — the first persona-specific behavior: what a user is nudged
 * toward depends on the Phase 3 answer, using only destinations that
 * already exist today (no "Invite your team" — Phase 2's organizations
 * have no real invite flow yet, so promising one here would be a dead end).
 */
const PERSONA_CTA: Record<Persona, PersonaCtaConfig> = {
  DEVELOPER: { title: 'Connect a repository', description: 'Get AI-reviewed fix proposals for issues found on your site, grounded in your actual code.', ctaLabel: 'Connect a repository', to: '/repositories' },
  QA_TEAM: { title: 'Run your first scan', description: 'Scan a page or an entire site to find functional, accessibility, and performance issues automatically.', ctaLabel: 'Go to Scans', to: '/scans' },
  DESIGNER: { title: 'Turn a screenshot into code', description: 'Upload a screenshot or Figma export and generate a working component from it.', ctaLabel: 'Go to Components', to: '/components' },
  FOUNDER: { title: 'Run your first scan', description: "Get a quick health score for your site — critical issues, performance, and accessibility, in minutes.", ctaLabel: 'Go to Scans', to: '/scans' },
  AGENCY: { title: 'Connect a repository', description: 'Connect a client repository to get AI-reviewed fix proposals grounded in the real codebase.', ctaLabel: 'Connect a repository', to: '/repositories' },
  PRODUCT_MANAGER: { title: 'Run your first scan', description: 'See a health score and prioritized issue list for your product, without needing to read code.', ctaLabel: 'Go to Scans', to: '/scans' },
};

function dismissKey(userId: string): string {
  return `origami-persona-cta-dismissed-${userId}`;
}

export function PersonaCta() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(() => {
    if (!user?.persona) return true;
    try {
      return localStorage.getItem(dismissKey(user.id)) === '1';
    } catch {
      return false;
    }
  });

  if (!user?.persona || dismissed) return null;

  const config = PERSONA_CTA[user.persona];

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(dismissKey(user!.id), '1');
    } catch {
      // localStorage unavailable (private window, blocked storage) — dismissal just won't persist across reloads, which is fine.
    }
  }

  return (
    <section className="persona-cta animate-in">
      <div className="persona-cta-copy">
        <h3>{config.title}</h3>
        <p>{config.description}</p>
      </div>
      <div className="persona-cta-actions">
        <Link className="primary-button" to={config.to} onClick={dismiss}>
          {config.ctaLabel}
        </Link>
        <button type="button" className="ghost-button" onClick={dismiss} aria-label="Dismiss">
          Dismiss
        </button>
      </div>
    </section>
  );
}
