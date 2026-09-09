import { useMemo, useState } from 'react';
import type { GeneratedFile } from '@origami/contracts';
import { buildZip, downloadBlob } from '../utils/zip';

interface Props {
  componentName: string;
  files: GeneratedFile[];
}

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default', 'from', 'if', 'else',
  'for', 'while', 'class', 'extends', 'new', 'this', 'null', 'true', 'false', 'async', 'await',
  'div', 'span', 'button', 'section', 'header', 'footer', 'nav', 'className', 'style',
]);

/**
 * Lightweight, dependency-free tokenizer. Basic syntax highlighting only —
 * not a full parser — but real (not decorative) and keeps the code viewer
 * from needing a new npm dependency for this feature.
 */
function tokenize(code: string): Array<{ text: string; cls?: string }> {
  const pattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|<\/?[A-Za-z][\w-]*|\b[A-Za-z_][\w]*\b|[{}()[\];:.,=<>/])/g;
  const tokens: Array<{ text: string; cls?: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    if (match.index > lastIndex) tokens.push({ text: code.slice(lastIndex, match.index) });
    const text = match[0];
    let cls: string | undefined;
    if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('<!--')) cls = 'tok-comment';
    else if (/^["'`]/.test(text)) cls = 'tok-string';
    else if (/^<\/?[A-Za-z]/.test(text)) cls = 'tok-tag';
    else if (KEYWORDS.has(text)) cls = 'tok-keyword';
    else if (/^[{}()[\];:.,=<>/]$/.test(text)) cls = 'tok-punct';
    tokens.push({ text, cls });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < code.length) tokens.push({ text: code.slice(lastIndex) });
  return tokens;
}

export function CodeViewer({ componentName, files }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const active = files[activeIndex] ?? files[0];

  const tokens = useMemo(() => (active ? tokenize(active.content) : []), [active]);

  if (!active) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(active.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const handleDownload = () => {
    if (files.length === 1) {
      const blob = new Blob([files[0].content], { type: 'text/plain' });
      downloadBlob(blob, files[0].path);
      return;
    }
    const zip = buildZip(files.map((f) => ({ path: `${componentName}/${f.path}`, content: f.content })));
    downloadBlob(zip, `${componentName}.zip`);
  };

  return (
    <div className="code-viewer">
      {files.length > 1 && (
        <div className="code-viewer-tabs">
          {files.map((file, i) => (
            <button
              key={file.path}
              type="button"
              className={`code-tab ${i === activeIndex ? 'active' : ''}`}
              onClick={() => setActiveIndex(i)}
            >
              {file.path}
            </button>
          ))}
        </div>
      )}

      <div className="code-viewer-toolbar">
        <span className="code-file-name">{active.path}</span>
        <div className="code-viewer-actions">
          <button type="button" className="ghost-button" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy Code'}
          </button>
          <button type="button" className="primary-button" onClick={handleDownload}>
            Download Component
          </button>
        </div>
      </div>

      <pre className="code-block">
        <code>
          {tokens.map((t, i) => (
            <span key={i} className={t.cls}>{t.text}</span>
          ))}
        </code>
      </pre>
    </div>
  );
}
