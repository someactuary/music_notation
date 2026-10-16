import { useState } from "react";
import { glyphChar } from "@/render/smufl";
import type { SmuflFontData } from "@/render/smufl/types";
import type { Articulation, ClefKind, NotatedDuration, Placement, Score } from "@/model";
import type { Cursor, PaletteAction, Selection } from "@/input/types";
import { beamToggleState } from "@/input/beams";
import { keySignatureAt } from "@/input/navigation";
import { KEY_SIG_OPTIONS, keySigLabel } from "./key-labels";

export interface PalettesProps {
  font: SmuflFontData;
  score: Score;
  cursor: Cursor;
  /** For the Beam toggle, whose state follows the selected notes. */
  selection: Selection;
  onApplyAction: (action: PaletteAction) => void;
}

/** A single glyph rendered in the Bravura font, for notation-like button labels. */
export function Smufl({ font, glyph }: { font: SmuflFontData; glyph: string }) {
  return (
    <span className="smufl" aria-hidden="true">
      {glyphChar(font, glyph)}
    </span>
  );
}

/** Clef-change buttons: the two clefs piano music switches between. */
const CLEF_CHANGES: { clef: ClefKind; label: string }[] = [
  { clef: "treble", label: "Treble" },
  { clef: "bass", label: "Bass" },
];

const DYNAMICS: { text: string; glyph: string }[] = [
  { text: "pp", glyph: "dynamicPP" },
  { text: "p", glyph: "dynamicPiano" },
  { text: "mp", glyph: "dynamicMP" },
  { text: "mf", glyph: "dynamicMF" },
  { text: "f", glyph: "dynamicForte" },
  { text: "ff", glyph: "dynamicFF" },
  { text: "sfz", glyph: "dynamicSforzato" },
];

const ARTICULATIONS: { articulation: Articulation; label: string; glyph: string }[] = [
  { articulation: "staccato", label: "Staccato", glyph: "articStaccatoAbove" },
  { articulation: "tenuto", label: "Tenuto", glyph: "articTenutoAbove" },
  { articulation: "accent", label: "Accent", glyph: "articAccentAbove" },
  { articulation: "marcato", label: "Marcato", glyph: "articMarcatoAbove" },
];

const FINGERINGS = ["1", "2", "3", "4", "5"];

const TUPLETS: { label: string; actual: number; normal: number }[] = [
  { label: "3", actual: 3, normal: 2 },
  { label: "5", actual: 5, normal: 4 },
  { label: "6", actual: 6, normal: 4 },
  { label: "7", actual: 7, normal: 4 },
  { label: "2", actual: 2, normal: 3 },
  { label: "9", actual: 9, normal: 8 },
];

const DURATIONS: { key: string; label: string; base: NotatedDuration["base"] }[] = [
  { key: "1", label: "Whole", base: 1 },
  { key: "2", label: "Half", base: 2 },
  { key: "4", label: "Quarter", base: 4 },
  { key: "8", label: "Eighth", base: 8 },
  { key: "6", label: "16th", base: 16 },
  { key: "3", label: "32nd", base: 32 },
];

const BEAT_UNITS: { label: string; duration: NotatedDuration }[] = [
  { label: "quarter", duration: { base: 4, dots: 0 } },
  { label: "half", duration: { base: 2, dots: 0 } },
  { label: "eighth", duration: { base: 8, dots: 0 } },
  { label: "dotted quarter", duration: { base: 4, dots: 1 } },
];

function TempoForm({ onApplyAction, onDone }: { onApplyAction: (a: PaletteAction) => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [bpm, setBpm] = useState("");
  const [beatUnitLabel, setBeatUnitLabel] = useState(BEAT_UNITS[0]!.label);

  function submit() {
    const beatUnit = BEAT_UNITS.find((u) => u.label === beatUnitLabel)?.duration;
    const bpmNum = bpm.trim() === "" ? undefined : Number(bpm);
    onApplyAction({
      kind: "tempo",
      ...(text.trim() ? { text: text.trim() } : {}),
      ...(bpmNum !== undefined && Number.isFinite(bpmNum) ? { bpm: bpmNum } : {}),
      ...(beatUnit ? { beatUnit } : {}),
    });
    onDone();
  }

  return (
    <form
      className="palette-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input type="text" placeholder="Text (optional)" value={text} onChange={(e) => setText(e.target.value)} />
      <input
        type="number"
        placeholder="BPM"
        value={bpm}
        onChange={(e) => setBpm(e.target.value)}
        style={{ width: "4.5em" }}
      />
      <select value={beatUnitLabel} onChange={(e) => setBeatUnitLabel(e.target.value)}>
        {BEAT_UNITS.map((u) => (
          <option key={u.label} value={u.label}>
            {u.label}
          </option>
        ))}
      </select>
      <button type="submit">Add</button>
      <button type="button" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

const TEXT_STYLES: { value: "expression" | "technique" | "plain"; label: string }[] = [
  { value: "expression", label: "Expression" },
  { value: "technique", label: "Technique" },
  { value: "plain", label: "Plain" },
];

function TextForm({ onApplyAction, onDone }: { onApplyAction: (a: PaletteAction) => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [style, setStyle] = useState<"expression" | "technique" | "plain">("expression");
  const [placement, setPlacement] = useState<"" | Placement>("");

  function submit() {
    if (!text.trim()) return;
    onApplyAction({ kind: "text", text: text.trim(), style, ...(placement ? { placement } : {}) });
    onDone();
  }

  return (
    <form
      className="palette-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input type="text" placeholder="Text" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <select value={style} onChange={(e) => setStyle(e.target.value as "expression" | "technique" | "plain")}>
        {TEXT_STYLES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <select value={placement} onChange={(e) => setPlacement(e.target.value as "" | Placement)}>
        <option value="">(default)</option>
        <option value="above">above</option>
        <option value="below">below</option>
      </select>
      <button type="submit">Add</button>
      <button type="button" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

/**
 * A number input for a layout cap (measures/system, systems/page): blank = automatic.
 * Kept as a local draft so a multi-digit number can be typed before it commits (on
 * blur or Enter) rather than dispatching — and re-laying out the whole score — on
 * every keystroke; resyncs if the underlying value changes elsewhere (e.g. undo).
 */
function CappedCountField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  // Resync the draft when `value` changes for a reason other than this field's own
  // commit (undo/redo, loading a different score): compared and adjusted during
  // render, React's documented alternative to an effect for this ("Adjusting state
  // when a prop changes"), so it never fires the set-state-in-effect lint rule.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(value === undefined ? "" : String(value));
  }

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      onCommit(null);
      return;
    }
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0) onCommit(n);
    else setDraft(value === undefined ? "" : String(value)); // invalid: revert to the last committed value
  }

  return (
    <label>
      {label}{" "}
      <input
        type="number"
        min={1}
        step={1}
        placeholder="auto"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        style={{ width: "3.5em" }}
      />
    </label>
  );
}

/**
 * Second toolbar row: grouped notation palettes. Every button calls
 * `onApplyAction` with a `PaletteAction` (src/input/types.ts); this component
 * holds no score state of its own beyond the inline forms' draft fields — the
 * Key and Layout groups read `score`/`cursor` directly so they always show what's
 * true at the cursor's measure, including as the cursor moves.
 */
export function Palettes({ font, score, cursor, selection, onApplyAction }: PalettesProps) {
  const [openForm, setOpenForm] = useState<"tempo" | "text" | null>(null);
  const effectiveKey = keySignatureAt(score, cursor.measureIndex);
  const keyChangesHere = score.measures[cursor.measureIndex]?.keySig !== undefined;
  const measureLabel = cursor.measureIndex + 1;
  const atFirstMeasure = cursor.measureIndex === 0;

  return (
    <div className="palette-row" role="toolbar" aria-label="Notation palettes">
      <div className="palette-group" aria-label="Dynamics">
        <span className="palette-group-label">Dynamics</span>
        {DYNAMICS.map((d) => (
          <button
            key={d.text}
            type="button"
            title={d.text}
            onClick={() => onApplyAction({ kind: "dynamic", text: d.text })}
          >
            <Smufl font={font} glyph={d.glyph} />
          </button>
        ))}
      </div>

      <div className="palette-group" aria-label="Articulations">
        <span className="palette-group-label">Artic.</span>
        {ARTICULATIONS.map((a) => (
          <button
            key={a.articulation}
            type="button"
            title={a.label}
            onClick={() => onApplyAction({ kind: "articulation", articulation: a.articulation })}
          >
            <Smufl font={font} glyph={a.glyph} />
          </button>
        ))}
        <button
          type="button"
          title="Flip stem direction (X) — fixes an imported note's stem pointing the wrong way"
          onClick={() => onApplyAction({ kind: "flipStem" })}
        >
          Flip Stem
        </button>
        {(() => {
          const beam = beamToggleState(score, selection);
          return (
            <button
              type="button"
              aria-pressed={beam.pressed}
              disabled={!beam.enabled}
              title={beam.title}
              onClick={() => onApplyAction({ kind: "toggleBeam" })}
            >
              Beam
            </button>
          );
        })()}
      </div>

      <div className="palette-group" aria-label="Lines">
        <span className="palette-group-label">Lines</span>
        <button type="button" onClick={() => onApplyAction({ kind: "slur" })}>
          Slur
        </button>
        <button type="button" onClick={() => onApplyAction({ kind: "hairpin", shape: "cresc" })}>
          Cresc.
        </button>
        <button type="button" onClick={() => onApplyAction({ kind: "hairpin", shape: "dim" })}>
          Dim.
        </button>
        <button type="button" onClick={() => onApplyAction({ kind: "pedal" })}>
          Pedal
        </button>
        <button type="button" onClick={() => onApplyAction({ kind: "ottava", shift: 8 })}>
          8va
        </button>
        <button type="button" onClick={() => onApplyAction({ kind: "ottava", shift: -8 })}>
          8vb
        </button>
      </div>

      <div className="palette-group" aria-label="Marks">
        <span className="palette-group-label">Marks</span>
        <button type="button" onClick={() => onApplyAction({ kind: "fermata" })}>
          Fermata
        </button>
        <button type="button" aria-pressed={openForm === "tempo"} onClick={() => setOpenForm(openForm === "tempo" ? null : "tempo")}>
          Tempo…
        </button>
        <button type="button" aria-pressed={openForm === "text"} onClick={() => setOpenForm(openForm === "text" ? null : "text")}>
          Text…
        </button>
        {openForm === "tempo" && <TempoForm onApplyAction={onApplyAction} onDone={() => setOpenForm(null)} />}
        {openForm === "text" && <TextForm onApplyAction={onApplyAction} onDone={() => setOpenForm(null)} />}
      </div>

      <div className="palette-group" aria-label="Fingering">
        <span className="palette-group-label">Finger</span>
        {FINGERINGS.map((f) => (
          <button key={f} type="button" onClick={() => onApplyAction({ kind: "fingering", text: f })}>
            {f}
          </button>
        ))}
        <button type="button" onClick={() => onApplyAction({ kind: "fingering", text: "" })}>
          clear
        </button>
      </div>

      <div className="palette-group" aria-label="Tuplet">
        <span className="palette-group-label">Tuplet</span>
        {TUPLETS.map((t) => (
          <button
            key={t.label}
            type="button"
            title={`${t.actual}:${t.normal}`}
            onClick={() => onApplyAction({ kind: "tuplet", actual: t.actual, normal: t.normal })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="palette-group" aria-label="Duration">
        <span className="palette-group-label">Duration</span>
        {DURATIONS.map((d) => (
          <button
            key={d.key}
            type="button"
            title={d.label}
            onClick={() => onApplyAction({ kind: "setDuration", base: d.base, dots: 0 })}
          >
            {d.key}
          </button>
        ))}
        <button type="button" title="Toggle dot" onClick={() => onApplyAction({ kind: "toggleDot" })}>
          •
        </button>
      </div>

      <div className="palette-group" aria-label="Clef change">
        <span className="palette-group-label">Clef</span>
        {CLEF_CHANGES.map((c) => (
          <button
            key={c.clef}
            type="button"
            title={`${c.label} clef from the selected note on (or from the cursor). Select a clef change and press Delete to remove it`}
            onClick={() => onApplyAction({ kind: "clefChange", clef: c.clef })}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="palette-group" aria-label="Key signature">
        <span className="palette-group-label">Key (m{measureLabel})</span>
        <select
          value={effectiveKey.fifths}
          title="Key signature from this measure on"
          onChange={(e) =>
            onApplyAction({ kind: "setKeySignature", keySig: { fifths: Number(e.target.value), mode: effectiveKey.mode } })
          }
        >
          {KEY_SIG_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {keySigLabel(f)}
            </option>
          ))}
        </select>
        <select
          value={effectiveKey.mode}
          onChange={(e) =>
            onApplyAction({ kind: "setKeySignature", keySig: { fifths: effectiveKey.fifths, mode: e.target.value as "major" | "minor" } })
          }
        >
          <option value="major">major</option>
          <option value="minor">minor</option>
        </select>
        <button
          type="button"
          disabled={!keyChangesHere}
          title="Remove the key change at this measure (the previous key continues)"
          onClick={() => onApplyAction({ kind: "clearKeySignature" })}
        >
          Clear
        </button>
      </div>

      <div className="palette-group" aria-label="Layout">
        <span className="palette-group-label">Layout</span>
        <CappedCountField
          label="Measures/line"
          value={score.layout.measuresPerSystem}
          onCommit={(value) => onApplyAction({ kind: "setMeasuresPerSystem", value })}
        />
        <CappedCountField
          label="Systems/page"
          value={score.layout.systemsPerPage}
          onCommit={(value) => onApplyAction({ kind: "setSystemsPerPage", value })}
        />
        <button
          type="button"
          disabled={atFirstMeasure}
          aria-pressed={score.layout.systemBreaks.includes(cursor.measureIndex)}
          title={atFirstMeasure ? "The first measure can't start a new line" : `Start a new line at measure ${measureLabel}`}
          onClick={() => onApplyAction({ kind: "toggleSystemBreak" })}
        >
          ⏎ Line
        </button>
        <button
          type="button"
          disabled={atFirstMeasure}
          aria-pressed={score.layout.pageBreaks.includes(cursor.measureIndex)}
          title={atFirstMeasure ? "The first measure can't start a new page" : `Start a new page at measure ${measureLabel}`}
          onClick={() => onApplyAction({ kind: "togglePageBreak" })}
        >
          ⏎ Page
        </button>
        <button
          type="button"
          title="Remove every forced line/page break and let the layout flow automatically"
          onClick={() => onApplyAction({ kind: "clearForcedBreaks" })}
        >
          Reflow
        </button>
      </div>
    </div>
  );
}
