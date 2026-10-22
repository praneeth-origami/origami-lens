import { useState } from 'react';
import { askAboutPageScan, askAboutScan, ApiRequestError } from '../api/client';
import { SparkleIcon } from './icons';

const SUGGESTED_QUESTIONS = [
  'Why is this page slow?',
  "What's broken?",
  'What should I improve?',
  'Check accessibility',
  'Check mobile issues',
  'Explain this page',
  'What would you change?',
];

interface Props {
  scanId: string;
  /** Omit for a CURRENT_PAGE scan (the scan row itself is the one page) — provide for one page of a WEBSITE scan. */
  pageScanId?: string;
}

/**
 * "Ask About This Page" — grounded in a scan's own persisted, privacy-
 * scrubbed evidence (migration 036), never a generic chatbot. Same input +
 * suggested-question-chip + response-panel shape as IssueAskAi.tsx, but
 * self-contained (owns its own state) rather than lifted to the parent
 * page, since it only ever needs a scanId/pageScanId to operate.
 */
export function PageAskAi({ scanId, pageScanId }: Props) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');

  const ask = async (q?: string) => {
    const finalQuestion = q ?? question;
    if (!finalQuestion.trim() || loading) return;
    setLoading(true);
    setError('');
    setAnswer('');
    try {
      const res = pageScanId
        ? await askAboutPageScan(scanId, pageScanId, finalQuestion)
        : await askAboutScan(scanId, finalQuestion);
      setAnswer(res.answer);
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.code === 'SCAN_NOT_READY'
          ? "This scan hasn't finished yet — try again once it completes."
          : err instanceof ApiRequestError && err.code === 'EVIDENCE_UNAVAILABLE'
            ? 'Not enough evidence was captured for this scan to answer confidently.'
            : 'Ask About This Page is unavailable right now.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="ai-section page-ask-ai">
      <div className="ai-section-heading">
        <div className="ai-section-icon"><SparkleIcon /></div>
        <div>
          <h3>Ask About This Page</h3>
          <p className="muted">Get grounded answers from this scan's real evidence — performance, accessibility, and detected issues.</p>
        </div>
      </div>

      <div className="ask-row">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Why is this page slow?"
          aria-label="Ask about this page"
          onKeyDown={(e) => { if (e.key === 'Enter') ask(); }}
        />
        <button type="button" className="primary-button" onClick={() => ask()} disabled={loading}>Ask Origami AI</button>
      </div>

      <div className="ai-chip-row">
        {SUGGESTED_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            className="ai-chip"
            onClick={() => { setQuestion(q); ask(q); }}
            disabled={loading}
          >
            {q}
          </button>
        ))}
      </div>

      {loading && <p className="muted">Thinking…</p>}
      {error && <p className="ai-response ai-response-error">{error}</p>}
      {answer && <p className="ai-response">{answer}</p>}
    </section>
  );
}
