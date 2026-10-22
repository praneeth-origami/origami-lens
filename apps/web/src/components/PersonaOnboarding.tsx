import { useState } from 'react';
import type { Persona } from '@origami/contracts';
import { setPersona } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { CodeBracketIcon, RocketIcon, UsersIcon, PaletteIcon, CheckCircleIcon, ChartIcon, CheckIcon, ArrowRightIcon } from './icons';

const PERSONA_OPTIONS: Array<{ value: Persona; label: string; description: string; icon: typeof CodeBracketIcon }> = [
  { value: 'DEVELOPER', label: 'Developer', description: 'I write and ship code. Find and fix issues, improve quality, and move faster.', icon: CodeBracketIcon },
  { value: 'FOUNDER', label: 'Founder', description: 'I run a company or product. Get a high-level view and focus on what matters.', icon: RocketIcon },
  { value: 'AGENCY', label: 'Agency', description: 'I build sites/apps for clients. Manage multiple projects and deliver better results.', icon: UsersIcon },
  { value: 'DESIGNER', label: 'Designer', description: 'I design interfaces and experiences. Turn ideas into pixel-perfect products.', icon: PaletteIcon },
  { value: 'QA_TEAM', label: 'QA team', description: 'I test and verify quality. Find issues early and keep releases reliable.', icon: CheckCircleIcon },
  { value: 'PRODUCT_MANAGER', label: 'Product manager', description: 'I plan and prioritize product work. Understand insights and track progress.', icon: ChartIcon },
];

const STEPS = ['Your role', 'Connect tools', 'Get started'];

/**
 * Phase 3 — a one-time onboarding question shown after first login, before
 * the dashboard. Purely descriptive (see the Persona contract type's doc
 * comment): answering doesn't unlock or restrict anything yet. Select-then-
 * Continue is a presentation/interaction change only — the actual
 * submission (setPersona -> refresh) is byte-for-byte the same call the
 * previous immediate-on-click version made; only WHEN it fires changed.
 */
export function PersonaOnboarding() {
  const { refresh } = useAuth();
  const [selected, setSelected] = useState<Persona | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    if (!selected || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await setPersona(selected);
      await refresh();
    } catch {
      setError('Could not save your answer — please try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="persona-onboarding">
      <div className="persona-onboarding-glow" aria-hidden="true" />

      <ol className="persona-steps" aria-label="Onboarding progress">
        {STEPS.map((step, i) => (
          <li key={step} className={`persona-step ${i === 0 ? 'active' : ''}`}>
            <span className="persona-step-index" aria-hidden="true">{i + 1}</span>
            <span className="persona-step-label">{step}</span>
            {i < STEPS.length - 1 && <span className="persona-step-connector" aria-hidden="true" />}
          </li>
        ))}
      </ol>

      <div className="persona-heading">
        <h1>Which best <span className="persona-heading-accent">describes you?</span></h1>
        <p>This helps us tailor Origami Lens to how you work and shows you the most relevant features, templates, and integrations.</p>
      </div>

      <div className="persona-options" role="radiogroup" aria-label="Which best describes you?">
        {PERSONA_OPTIONS.map((option) => {
          const Icon = option.icon;
          const isSelected = selected === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={`persona-option ${isSelected ? 'selected' : ''}`}
              disabled={submitting}
              onClick={() => setSelected(option.value)}
            >
              <span className="persona-option-top">
                <span className="persona-option-icon" aria-hidden="true"><Icon /></span>
                {isSelected && <span className="persona-option-check" aria-hidden="true"><CheckIcon /></span>}
              </span>
              <span className="persona-option-label">{option.label}</span>
              <span className="persona-option-description">{option.description}</span>
              <span className="persona-option-arrow" aria-hidden="true"><ArrowRightIcon /></span>
            </button>
          );
        })}
      </div>

      {error && <p className="persona-error" role="alert">{error}</p>}

      <div className="persona-continue-row">
        <button type="button" className="persona-continue" disabled={!selected || submitting} onClick={() => void handleContinue()}>
          {submitting ? 'Saving…' : 'Continue'} <ArrowRightIcon />
        </button>
      </div>
    </div>
  );
}
