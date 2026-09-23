import { SparkleIcon } from './icons';

const SUGGESTED_QUESTIONS = [
  'Why is this happening?',
  'How does this affect users?',
  'Show me code examples',
  "What's the best way to fix this?",
];

interface Props {
  askInput: string;
  setAskInput: (value: string) => void;
  onAsk: (question?: string) => void;
  aiLoading: boolean;
  askResponse: string;
  onSuggestFix: () => void;
  fixResponse: string;
}

/**
 * "Ask AI" card — same askAi()/suggestFix() calls the page already made,
 * just given a dedicated card with suggested-question chips. A chip fills
 * the input and asks immediately using the exact question text (avoiding a
 * stale-state read of `askInput` right after setting it).
 */
export function IssueAskAi({ askInput, setAskInput, onAsk, aiLoading, askResponse, onSuggestFix, fixResponse }: Props) {
  return (
    <section className="ai-section issue-ask-ai">
      <div className="ai-section-heading">
        <div className="ai-section-icon"><SparkleIcon /></div>
        <div>
          <h3>Ask AI</h3>
          <p className="muted">Get instant answers about this issue, its impact, or how to fix it.</p>
        </div>
      </div>

      <div className="ask-row">
        <input
          value={askInput}
          onChange={(e) => setAskInput(e.target.value)}
          placeholder="Ask anything about this issue..."
          aria-label="Ask anything about this issue"
        />
        <button type="button" className="primary-button" onClick={() => onAsk()} disabled={aiLoading}>Ask AI</button>
      </div>

      <div className="ai-chip-row">
        {SUGGESTED_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            className="ai-chip"
            onClick={() => {
              setAskInput(q);
              onAsk(q);
            }}
            disabled={aiLoading}
          >
            {q}
          </button>
        ))}
      </div>

      {askResponse && <p className="ai-response">{askResponse}</p>}

      <div className="ai-actions">
        <button type="button" className="ghost-button" onClick={onSuggestFix} disabled={aiLoading}>
          Generate suggested fix (AI)
        </button>
      </div>
      {fixResponse && <pre className="ai-response">{fixResponse}</pre>}
    </section>
  );
}
