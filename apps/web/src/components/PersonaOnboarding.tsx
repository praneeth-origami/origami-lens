import { useState } from 'react';
import type { Persona } from '@origami/contracts';
import { setPersona } from '../api/client';
import { useAuth } from '../hooks/useAuth';

const PERSONA_OPTIONS: Array<{ value: Persona; label: string; description: string }> = [
  { value: 'DEVELOPER', label: 'Developer', description: 'I write and ship code.' },
  { value: 'FOUNDER', label: 'Founder', description: 'I run a company or product.' },
  { value: 'AGENCY', label: 'Agency', description: 'I build sites/apps for clients.' },
  { value: 'DESIGNER', label: 'Designer', description: 'I design interfaces and experiences.' },
  { value: 'QA_TEAM', label: 'QA team', description: 'I test and verify quality.' },
  { value: 'PRODUCT_MANAGER', label: 'Product manager', description: 'I plan and prioritize product work.' },
];

/**
 * Phase 3 — a one-time onboarding question shown after first login, before
 * the dashboard. Purely descriptive (see the Persona contract type's doc
 * comment): answering doesn't unlock or restrict anything yet, so skipping
 * or picking wrong is low-stakes — this is why there's no back-and-forth
 * confirmation step, just pick and go.
 */
export function PersonaOnboarding() {
  const { refresh } = useAuth();
  const [submitting, setSubmitting] = useState<Persona | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(persona: Persona) {
    setSubmitting(persona);
    setError(null);
    try {
      await setPersona(persona);
      await refresh();
    } catch {
      setError('Could not save your answer — please try again.');
      setSubmitting(null);
    }
  }

  return (
    <div className="persona-onboarding">
      <h1>Which best describes you?</h1>
      <p>This helps us tailor Origami Lens to how you work.</p>
      <div className="persona-options">
        {PERSONA_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="persona-option"
            disabled={submitting !== null}
            onClick={() => void choose(option.value)}
          >
            <span className="persona-option-label">{option.label}</span>
            <span className="persona-option-description">{option.description}</span>
          </button>
        ))}
      </div>
      {error ? <p className="persona-error">{error}</p> : null}
    </div>
  );
}
