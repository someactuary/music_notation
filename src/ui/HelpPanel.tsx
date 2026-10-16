/**
 * The "?" Help & FAQ panel. Content lives in help-faq.ts; this only renders it, one
 * collapsible entry per question.
 */
import { FAQ, parseInline, type FaqEntry, type HelpBlock } from "./help-faq";

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((piece, i) =>
        piece.kind === "key" ? (
          <kbd key={i}>{piece.text}</kbd>
        ) : piece.kind === "bold" ? (
          <strong key={i}>{piece.text}</strong>
        ) : (
          <span key={i}>{piece.text}</span>
        ),
      )}
    </>
  );
}

function Block({ block }: { block: HelpBlock }) {
  if (typeof block === "string") {
    return (
      <p>
        <Inline text={block} />
      </p>
    );
  }
  return (
    <ul>
      {block.list.map((item, i) => (
        <li key={i}>
          <Inline text={item} />
        </li>
      ))}
    </ul>
  );
}

export function HelpPanel({ onClose, entries = FAQ }: { onClose: () => void; entries?: FaqEntry[] }) {
  return (
    <aside className="shortcuts-panel help-panel" aria-label="Help and FAQ">
      <div className="shortcuts-header">
        <strong>Help &amp; FAQ</strong>
        <button type="button" onClick={onClose} aria-label="Close help">
          ×
        </button>
      </div>
      {entries.map((entry) => (
        // With a single entry there's nothing to choose between, so show it open.
        <details key={entry.id} className="help-entry" open={entries.length === 1}>
          <summary>{entry.question}</summary>
          {entry.answer.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </details>
      ))}
      <p className="shortcuts-footnote">For every key, see Keyboard shortcuts (the keyboard button).</p>
    </aside>
  );
}
