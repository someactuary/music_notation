/**
 * The "?" Help & FAQ panel. Content lives in help-faq.ts; this only renders it, one
 * collapsible entry per question, then a "Send feedback" box (sent by feedback.ts).
 */
import { useState, type FormEvent } from "react";
import { sendFeedback } from "./feedback";
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

type SendState = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

/** "Send feedback" at the bottom of the panel: emails Frank via Web3Forms (feedback.ts). */
function FeedbackForm({ send = sendFeedback }: { send?: typeof sendFeedback }) {
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [botcheck, setBotcheck] = useState(false);
  const [state, setState] = useState<SendState>({ kind: "idle" });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState({ kind: "sending" });
    try {
      await send({ message, name, email, botcheck });
      setState({ kind: "sent" });
      setMessage("");
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (state.kind === "sent") {
    return (
      <section className="help-feedback" aria-label="Send feedback">
        <h4>Send feedback</h4>
        <p>Thank you! Your message was sent.</p>
        <button type="button" onClick={() => setState({ kind: "idle" })}>
          Send another
        </button>
      </section>
    );
  }

  return (
    <section className="help-feedback" aria-label="Send feedback">
      <h4>Send feedback</h4>
      <p className="help-feedback-hint">A question, a bug, or an idea? It goes straight to the developer.</p>
      <form onSubmit={(e) => void submit(e)}>
        <textarea
          aria-label="Your message"
          placeholder="Your message"
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
        />
        <input aria-label="Your name (optional)" placeholder="Your name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          aria-label="Your email, if you'd like a reply (optional)"
          placeholder="Your email, if you'd like a reply (optional)"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {/* Spam trap: hidden from people, ticked by bots (Web3Forms discards those). */}
        <input
          type="checkbox"
          name="botcheck"
          className="help-feedback-trap"
          tabIndex={-1}
          aria-hidden="true"
          checked={botcheck}
          onChange={(e) => setBotcheck(e.target.checked)}
        />
        {state.kind === "error" && <p className="help-feedback-error">{state.message}</p>}
        <button type="submit" disabled={state.kind === "sending" || !message.trim()}>
          {state.kind === "sending" ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
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
      <FeedbackForm />
    </aside>
  );
}
