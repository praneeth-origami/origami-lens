import type { ReactNode } from 'react';
import { ChartIcon, OrigamiLensIcon, PullRequestIcon, SearchIcon, SparkleIcon } from './icons';

const FEATURES = [
  { icon: <SearchIcon />, title: 'Detect issues', desc: 'Performance, accessibility, SEO, best practices & more' },
  { icon: <SparkleIcon />, title: 'Get AI fixes', desc: 'Understand, fix, and verify with AI' },
  { icon: <PullRequestIcon />, title: 'Create pull requests', desc: 'Go from issue to PR, faster' },
  { icon: <ChartIcon />, title: 'Build better products', desc: 'Delight your users and ship with confidence' },
];

/** A single curved, hand-drawn-style connector with an arrowhead — used for the three workflow labels around the graphic. `flip` mirrors it horizontally for the labels that point the other way. */
function HandDrawnArrow({ className, flip = false }: { className: string; flip?: boolean }) {
  return (
    <svg
      className={className}
      width="46"
      height="34"
      viewBox="0 0 46 34"
      fill="none"
      aria-hidden="true"
      style={flip ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M3 4c8 2 16 8 20 14s6 12 18 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M34 27l7 5-8 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The center animated workflow graphic — Scan -> Find issues -> Apply fixes.
 * A simplified, clean approximation of the reference's browser/code panel
 * illustration (no literal hand-drawn illustration file, just real DOM/CSS/
 * SVG, so it stays crisp and respects prefers-reduced-motion — see
 * dashboard.css). This is its own column, not tucked inside the hero text.
 */
function AuthHeroGraphic() {
  return (
    <div className="auth-hero-graphic" aria-hidden="true">
      <span className="auth-graphic-label auth-graphic-label-scan">Scan</span>
      <HandDrawnArrow className="auth-graphic-arrow auth-graphic-arrow-scan" />

      <span className="auth-graphic-label auth-graphic-label-issues">Find issues</span>
      <HandDrawnArrow className="auth-graphic-arrow auth-graphic-arrow-issues" flip />

      <span className="auth-graphic-label auth-graphic-label-fixes">Apply fixes</span>
      <HandDrawnArrow className="auth-graphic-arrow auth-graphic-arrow-fixes" />

      {/* Rear "depth" cards — purely structural, no readable content, just
          skeleton bars — sitting behind the main inspection card so the
          illustration reads as a layered stack, not one flat panel. */}
      <div className="auth-graphic-back auth-graphic-back-1">
        <span className="auth-graphic-skeleton-bar" style={{ width: '55%' }} />
        <span className="auth-graphic-skeleton-bar" style={{ width: '75%' }} />
        <span className="auth-graphic-skeleton-bar" style={{ width: '40%' }} />
      </div>
      <div className="auth-graphic-back auth-graphic-back-2">
        <span className="auth-graphic-skeleton-bar" style={{ width: '65%' }} />
        <span className="auth-graphic-skeleton-bar" style={{ width: '45%' }} />
      </div>

      <div className="auth-graphic-browser">
        <div className="auth-graphic-browser-bar">
          <span className="auth-graphic-scan-dot" /> origamilens.com
        </div>
        <div className="auth-graphic-issues">
          <div className="auth-graphic-issue-row" style={{ animationDelay: '0.2s' }}>
            <span className="auth-graphic-issue-label">✕ Console error detected</span>
            <span className="auth-graphic-pill critical">Critical</span>
          </div>
          <div className="auth-graphic-issue-row" style={{ animationDelay: '0.5s' }}>
            <span className="auth-graphic-issue-label">⚠ Missing alt text</span>
            <span className="auth-graphic-pill high">High</span>
          </div>
          <div className="auth-graphic-issue-row" style={{ animationDelay: '0.8s' }}>
            <span className="auth-graphic-issue-label">◔ Slow resource</span>
            <span className="auth-graphic-pill medium">Medium</span>
          </div>
          <div className="auth-graphic-issue-row" style={{ animationDelay: '1.1s' }}>
            <span className="auth-graphic-issue-label">✓ Good practices</span>
            <span className="auth-graphic-pill passed">Passed</span>
          </div>
        </div>
      </div>
      <div className="auth-graphic-code">
        <div className="auth-graphic-code-line">// Fix: Add accessible label</div>
        <div className="auth-graphic-code-remove">- &lt;button&gt;&lt;/button&gt;</div>
        <div className="auth-graphic-code-add">+ &lt;button aria-label="Open menu"&gt;</div>
        <div className="auth-graphic-code-line">&nbsp;&nbsp;&lt;MenuIcon /&gt;</div>
        <div className="auth-graphic-code-add">+ &lt;/button&gt;</div>
      </div>
    </div>
  );
}

/**
 * The full-bleed shell shared by /login, /register, /forgot-password, and
 * /reset-password — a fixed dark marketing surface with a top bar, a hero
 * column, a center animated workflow graphic, and a white auth card (passed
 * as `children`), matching the reference design. Not theme-toggled by
 * design (see dashboard.css) — same choice most dev-tool sign-in pages make
 * for a fixed branding surface.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-topbar">
        <div className="auth-topbar-brand">
          <OrigamiLensIcon size={34} />
          <div className="auth-topbar-brand-copy">
            <span className="auth-topbar-brand-name">Origami Lens</span>
            <span className="auth-topbar-brand-tagline">Find what's wrong with any webpage.</span>
          </div>
        </div>
        <div className="auth-topbar-cta">
          <span>New here?</span>
          <a className="auth-topbar-link" href="#auth-hero-features">
            Learn more →
          </a>
        </div>
      </div>

      <div className="auth-content">
        <div className="auth-hero">
          <span className="auth-hero-badge">BUILT FOR DEVELOPERS</span>
          <h1 className="auth-hero-title">
            Ship better web<br />experiences<br />
            <span className="auth-hero-title-accent">with AI.</span>
          </h1>
          <p className="auth-hero-subtitle">
            Scan your website, find issues, understand the root cause, get AI-powered fixes, and create pull
            requests — all in one place.
          </p>

          <ul className="auth-hero-features" id="auth-hero-features">
            {FEATURES.map((f) => (
              <li className="auth-hero-feature" key={f.title}>
                <span className="auth-hero-feature-icon">{f.icon}</span>
                <div>
                  <p className="auth-hero-feature-title">{f.title}</p>
                  <p className="auth-hero-feature-desc">{f.desc}</p>
                </div>
              </li>
            ))}
          </ul>

          <p className="auth-hero-tagline">Better websites,<br />Happier users. 🚀</p>
        </div>

        <AuthHeroGraphic />

        <div className="auth-card-wrap">{children}</div>
      </div>
    </div>
  );
}
