import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { BRAVURA } from "@/render/smufl";
import { ensureFontLoaded } from "@/render/fonts";
import { engrave } from "@/engraving";
import type { Ref } from "@/engraving/layout-types";
import { newPianoScore } from "@/model/factory";
import type { NoteValue, TimeSignature } from "@/model/duration";
import { clefAt, type Score } from "@/model";
import { allEvents, findEvent } from "@/model/traverse";
import { parseScore, serializeScore } from "@/io/pscore";
import { importMusicXml, exportMusicXml, MusicXmlError } from "@/io/musicxml";
import { exportMidi } from "@/io/midi/export";
import type { OmrReviewItem } from "@/io/omr-cleanup";
import { frac } from "@/model/duration";
import { DEFAULT_ENTRY_STATE } from "@/input/types";
import type { KeyStroke, MidiNoteOn } from "@/input/types";
import { FIXTURES } from "../../test/fixtures";
import { ScoreView } from "./ScoreView";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { HelpPanel } from "./HelpPanel";
import { StavesPanel } from "./StavesPanel";
import { ImportPdfDialog } from "./ImportPdfDialog";
import type { ImportedFromOmr } from "./ImportPdfDialog";
import { ComparePanel } from "./ComparePanel";
import { Palettes } from "./Palettes";
import { ScoreInfoPanel } from "./ScoreInfoPanel";
import {
  CompareIcon,
  HelpIcon,
  InfoIcon,
  KeyboardIcon,
  NewIcon,
  OpenIcon,
  PauseIcon,
  PdfIcon,
  PlayIcon,
  PrintIcon,
  RedoIcon,
  SaveAsIcon,
  SaveIcon,
  SoundIcon,
  StopIcon,
  UndoIcon,
  XmlIcon,
} from "./icons";
import { Smufl } from "./Palettes";
import { newSatbScore } from "./presets";
import { KEY_SIG_OPTIONS, keySigLabel } from "./key-labels";
import { useEditorStore } from "./store";
import { handleKey } from "@/input/step-entry";
import { handleAction } from "@/input/actions";
import { handleMidiNote } from "@/input/midi-entry";
import { WEB_MIDI_UNSUPPORTED_MESSAGE } from "./midi";
import { useMidiPorts } from "./useMidiPorts";
import { useSound, type PlaybackTarget } from "./useSound";
import { SoundMenu } from "./SoundMenu";
import { ToolbarMenu } from "./ToolbarMenu";
import { usePlayback } from "./usePlayback";
import { readSetting, writeSetting } from "./storage";
import { hitTestPoint, locateEvent } from "./layout-utils";
import "./app.css";
import "./print.css";

const FILENAME_STORAGE_KEY = "pmn.filename";

const FIXTURE_NAMES = Object.keys(FIXTURES);

const TIME_SIG_OPTIONS: { label: string; value: TimeSignature }[] = [
  { label: "4/4", value: { numerator: 4, denominator: 4 } },
  { label: "3/4", value: { numerator: 3, denominator: 4 } },
  { label: "2/4", value: { numerator: 2, denominator: 4 } },
  { label: "6/8", value: { numerator: 6, denominator: 8 } },
];

const MEASURE_COUNT_OPTIONS = [8, 16, 32];

const DURATION_NAMES: Record<NoteValue, string> = {
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "16th",
  32: "32nd",
  64: "64th",
  128: "128th",
  256: "256th",
};

function clefLabel(clef: string): string {
  if (clef.startsWith("treble")) return "treble";
  if (clef.startsWith("bass")) return "bass";
  if (clef.startsWith("alto")) return "alto";
  if (clef.startsWith("tenor")) return "tenor";
  return clef;
}

/** Stacked treble/bass clef glyphs (Bravura, same as the notation palettes) for the
 * Staves button — more legible at a glance than a generic staff/bracket icon would be
 * in an app that already has real clef glyphs on hand. */
function ClefIcon() {
  return (
    <span className="clef-icon" aria-hidden="true">
      <Smufl font={BRAVURA} glyph="gClef" />
      <Smufl font={BRAVURA} glyph="fClef" />
    </span>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target.isContentEditable;
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Lowercased file extension without the dot, or "" if there isn't one. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/** `name` with its extension (if any) replaced by `ext`. */
function withExtension(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  return `${base}.${ext}`;
}

/** Triggers a browser download of `content` as `filename`. */
function downloadFile(filename: string, content: BlobPart, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface NewScoreFormProps {
  onCreate: (opts: { measureCount: number; timeSig: TimeSignature; keySigFifths: number }) => void;
  onCreateSatb: (opts: { measureCount: number; timeSig: TimeSignature; keySigFifths: number }) => void;
  onOpenSample: (name: string) => void;
  onCancel: () => void;
}

function NewScoreForm({ onCreate, onCreateSatb, onOpenSample, onCancel }: NewScoreFormProps) {
  const [measureCount, setMeasureCount] = useState(8);
  const [timeSigLabel, setTimeSigLabel] = useState(TIME_SIG_OPTIONS[0]!.label);
  const [keySigFifths, setKeySigFifths] = useState(0);

  function currentOpts() {
    const timeSig = TIME_SIG_OPTIONS.find((o) => o.label === timeSigLabel)?.value ?? TIME_SIG_OPTIONS[0]!.value;
    return { measureCount, timeSig, keySigFifths };
  }

  function handleSubmit() {
    onCreate(currentOpts());
  }

  return (
    <form
      className="new-score-form"
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      <label>
        Measures:{" "}
        <select value={measureCount} onChange={(e) => setMeasureCount(Number(e.target.value))}>
          {MEASURE_COUNT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label>
        Time:{" "}
        <select value={timeSigLabel} onChange={(e) => setTimeSigLabel(e.target.value)}>
          {TIME_SIG_OPTIONS.map((o) => (
            <option key={o.label} value={o.label}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Key:{" "}
        <select value={keySigFifths} onChange={(e) => setKeySigFifths(Number(e.target.value))}>
          {KEY_SIG_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {keySigLabel(f)}
            </option>
          ))}
        </select>
      </label>
      <button type="submit">Create</button>
      <button type="button" onClick={() => onCreateSatb(currentOpts())} title="4 staves: Soprano/Alto/Tenor/Bass">
        New SATB
      </button>
      <label className="new-score-sample">
        Or open a sample:{" "}
        <select value="" onChange={(e) => e.target.value && onOpenSample(e.target.value)}>
          <option value="">(choose)</option>
          {FIXTURE_NAMES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

export function App() {
  const [fontReady, setFontReady] = useState(false);
  const [newFormOpen, setNewFormOpen] = useState(false);
  const [ioMessage, setIoMessage] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Help and Shortcuts open in the same spot, so opening one closes the other.
  const [faqOpen, setFaqOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [stavesOpen, setStavesOpen] = useState(false);
  // The name last opened/saved as, remembered across reloads (localStorage) so "Save"
  // reuses it instead of re-deriving one from the title every time; "Save As" always
  // prompts for a new one. Null means this document has never been saved.
  const [fileName, setFileNameState] = useState<string | null>(() => readSetting(FILENAME_STORAGE_KEY));
  const setFileName = useCallback((name: string | null) => {
    setFileNameState(name);
    writeSetting(FILENAME_STORAGE_KEY, name);
  }, []);
  const [importOpen, setImportOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  // The imported PDF's bytes and the OMR review list, kept for the "Compare with
  // PDF" panel — in memory only, never persisted (docs/ARCHITECTURE.md "M4 contracts").
  const [pdfSession, setPdfSession] = useState<{ bytes: ArrayBuffer; filename: string } | null>(null);
  const [omrReview, setOmrReview] = useState<OmrReviewItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const initialScore = useMemo(() => newPianoScore(), []);
  const editor = useEditorStore(initialScore, handleKey, handleAction, handleMidiNote);

  const ports = useMidiPorts();
  const { midi } = ports;

  useEffect(() => {
    let cancelled = false;
    ensureFontLoaded()
      .then(() => {
        if (!cancelled) setFontReady(true);
      })
      .catch(() => {
        if (!cancelled) setFontReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sound = useSound(midi);
  /** Play needs a sound to play through: the built-in engine started, or MIDI access and an output. Says why if not. */
  const ensureOutput = useCallback(async (): Promise<boolean> => {
    if (sound.target === "builtin") {
      if (await sound.ensureReady()) {
        setIoMessage(null);
        return true;
      }
      setIoMessage("The built-in sounds couldn't start — try another sound, or play through a MIDI device.");
      return false;
    }
    if (!ports.supported) {
      setIoMessage(WEB_MIDI_UNSUPPORTED_MESSAGE);
      return false;
    }
    if (!ports.granted && !(await ports.connect())) return false;
    if (midi.outputs().length === 0) {
      setIoMessage("No MIDI output found — plug in your piano (or a MIDI synth) and try again.");
      return false;
    }
    if (!midi.hasOutput()) ports.selectOutput(midi.outputs()[0]!.id);
    setIoMessage(null);
    return true;
  }, [sound, ports, midi]);
  const playback = usePlayback({ score: editor.score, cursor: editor.cursor, sink: sound.sink, ensureOutput });
  const { stop: stopPlayback } = playback;
  /** Switching where playback goes ends what is playing, so nothing is left ringing on the other side. */
  const changeTarget = useCallback(
    (target: PlaybackTarget) => {
      stopPlayback();
      sound.setTarget(target);
    },
    [stopPlayback, sound],
  );

  const { applyMidi } = editor;
  useEffect(() => {
    return midi.onNoteOn((ev) => {
      applyMidi(ev);
    });
  }, [midi, applyMidi]);

  // Dev-only test hook (see docs on window.__pmnMidiTest): lets a Playwright/console
  // script push a synthetic MidiNoteOn straight into the store, without a real MIDI
  // device — Web MIDI reports zero devices in headless/CI browsers. Lives here (not
  // main.tsx) because that's where the store is; never present in a production build.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __pmnMidiTest?: (ev: MidiNoteOn) => void };
    w.__pmnMidiTest = (ev: MidiNoteOn) => applyMidi(ev);
    return () => {
      delete w.__pmnMidiTest;
    };
  }, [applyMidi]);

  // Dev-only: exposes the built-in sound engine so an end-to-end script can check that
  // notes are actually being started (see window.__pmnEngine.notesStarted).
  const { engine: soundEngine } = sound;
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __pmnEngine?: typeof soundEngine };
    w.__pmnEngine = soundEngine;
    return () => {
      delete w.__pmnEngine;
    };
  }, [soundEngine]);

  // Dev-only test hook to preview lyric-mode UI: the real L-key handler
  // (src/input/step-entry.ts) hasn't landed yet, so there's no in-app way to enter
  // lyric mode. Tags the first note event in the score with a lyric and points
  // entry.lyric at it, via the same store.setEntry used for App's own state.
  const { loadScore, setEntry } = editor;
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __pmnDevSetLyric?: (verse: number, text: string) => void };
    w.__pmnDevSetLyric = (verse: number, text: string) => {
      const cloned = structuredClone(editor.score) as Score;
      const firstNote = Array.from(allEvents(cloned)).find((e) => e.positioned.event.kind === "note");
      if (!firstNote) return;
      const event = firstNote.positioned.event;
      if (event.kind !== "note") return;
      event.lyrics = [{ verse, text, syllabic: "single" }];
      loadScore(cloned);
      setEntry({ ...DEFAULT_ENTRY_STATE, active: true, lyric: { eventId: event.id, verse } });
    };
    return () => {
      delete w.__pmnDevSetLyric;
    };
  }, [editor.score, loadScore, setEntry]);

  const layout = useMemo(() => engrave(editor.score, { font: BRAVURA }), [editor.score]);

  // @page size must match the score's page size in mm; it depends on layout
  // data, so it's injected as a <style> instead of living in print.css.
  const pageSizeCss = useMemo(() => {
    const page = layout.pages[0];
    if (!page) return "";
    const widthMm = page.widthSp * layout.staffSpaceMm;
    const heightMm = page.heightSp * layout.staffSpaceMm;
    return `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }`;
  }, [layout]);

  // The browser tab is the customary place a document's filename shows up alongside
  // the app name (Word, Google Docs, etc.).
  useEffect(() => {
    document.title = fileName ? `${fileName} — Sheet Music Assistant` : "Sheet Music Assistant";
  }, [fileName]);

  const { applyKey } = editor;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      const stroke: KeyStroke = {
        key: e.key,
        shift: e.shiftKey,
        mod: isMac() ? e.metaKey : e.ctrlKey,
        alt: e.altKey,
      };
      if (e.key === "Escape") playback.stop();
      const handled = applyKey(stroke);
      if (handled) {
        e.preventDefault();
        return;
      }
      if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // A focused toolbar button would otherwise also be "clicked" by this Space's key-up.
        if (e.target instanceof HTMLButtonElement) e.target.blur();
        e.preventDefault();
        playback.toggle();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyKey, playback]);

  const handleOpenSample = useCallback(
    (name: string) => {
      const make = FIXTURES[name];
      if (!make) return;
      setIoMessage(null);
      setFileName(null);
      editor.loadScore(make());
      setNewFormOpen(false);
    },
    [editor, setFileName],
  );

  function handleNewScore(opts: { measureCount: number; timeSig: TimeSignature; keySigFifths: number }) {
    setIoMessage(null);
    setFileName(null);
    editor.newScore({
      measureCount: opts.measureCount,
      timeSig: opts.timeSig,
      keySig: { fifths: opts.keySigFifths, mode: "major" },
    });
    setNewFormOpen(false);
  }

  function handleNewSatb(opts: { measureCount: number; timeSig: TimeSignature; keySigFifths: number }) {
    setIoMessage(null);
    setFileName(null);
    editor.loadScore(
      newSatbScore({
        measureCount: opts.measureCount,
        timeSig: opts.timeSig,
        keySig: { fifths: opts.keySigFifths, mode: "major" },
      }),
    );
    setNewFormOpen(false);
  }

  async function handleFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!file) return;
    const ext = extensionOf(file.name);
    try {
      let score: Score;
      if (ext === "mxl") {
        score = importMusicXml(await file.arrayBuffer());
      } else if (ext === "musicxml" || ext === "xml") {
        score = importMusicXml(await file.text());
      } else {
        // .pscore, or anything unrecognized: try our own JSON format.
        score = parseScore(await file.text());
      }
      setIoMessage(null);
        setFileName(file.name);
      editor.loadScore(score);
    } catch (err) {
      if (err instanceof MusicXmlError) setIoMessage(err.message);
      else setIoMessage(err instanceof Error ? err.message : String(err));
    }
  }

  /** The name a "Save" (or "Save As" default) should use: the remembered filename with its
   * extension swapped to `.pscore` (Save always writes the native format even if the
   * document was opened from MusicXML), or one derived from the title if nothing's
   * been saved/opened yet. */
  function pscoreFilename(): string {
    return fileName ? withExtension(fileName, "pscore") : `${editor.score.meta.title || "score"}.pscore`;
  }

  function handleSave() {
    const name = pscoreFilename();
    downloadFile(name, serializeScore(editor.score), "application/json");
    setFileName(name);
  }

  function handleSaveAs() {
    const suggested = pscoreFilename();
    const input = window.prompt("Save as:", suggested);
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed) return;
    const name = extensionOf(trimmed) === "pscore" ? trimmed : withExtension(trimmed, "pscore");
    downloadFile(name, serializeScore(editor.score), "application/json");
    setFileName(name);
  }

  /** The remembered document name with `ext` swapped in, else one derived from the title. */
  function exportFilename(ext: string): string {
    return fileName ? withExtension(fileName, ext) : `${editor.score.meta.title || "score"}.${ext}`;
  }

  function handleExportMidi(interpretation: "expressive" | "literal") {
    try {
      downloadFile(exportFilename("mid"), exportMidi(editor.score, { interpretation }), "audio/midi");
      setIoMessage(null);
    } catch (err) {
      setIoMessage(err instanceof Error ? err.message : String(err));
    }
  }

  function handleExportMusicXml() {
    try {
      const text = exportMusicXml(editor.score);
      downloadFile(exportFilename("musicxml"), text, "application/vnd.recordare.musicxml+xml");
      setIoMessage(null);
    } catch (err) {
      if (err instanceof MusicXmlError) setIoMessage(err.message);
      else setIoMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const handleClickElement = useCallback(
    (id: string, _role: Ref["role"], modifiers: { shift: boolean; mod: boolean }) => {
      if (modifiers.shift || modifiers.mod) {
        const ids = editor.selection.ids;
        const next = ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
        editor.setSelection({ ids: next });
      } else {
        editor.setSelection({ ids: [id] });
      }
      const loc = locateEvent(editor.score, id);
      if (!loc) return;
      editor.setCursor({
        partIndex: loc.partIndex,
        measureIndex: loc.measureIndex,
        staffIndex: loc.staffIndex,
        voiceIndex: loc.voiceIndex,
        offset: loc.offset,
      });
    },
    [editor],
  );

  const handleSelectMany = useCallback(
    (ids: string[], additive: boolean) => {
      if (!additive) {
        editor.setSelection({ ids });
        return;
      }
      const merged = new Set(editor.selection.ids);
      for (const id of ids) merged.add(id);
      editor.setSelection({ ids: Array.from(merged) });
    },
    [editor],
  );

  const handleClickEmpty = useCallback(
    (pageIndex: number, xSp: number, ySp: number) => {
      const hit = hitTestPoint(layout, pageIndex, xSp, ySp);
      if (!hit) return;
      editor.setSelection({ ids: [] });
      editor.setCursor({
        ...editor.cursor,
        measureIndex: hit.measureIndex,
        staffIndex: hit.staffIndex,
        offset: hit.offset,
      });
    },
    [editor, layout],
  );

  const handleDragPitch = useCallback(
    (noteId: string, diatonicDelta: number) => {
      editor.applyAction({ kind: "dragPitch", noteId, diatonicDelta });
    },
    [editor],
  );

  // A drag's (dx, dy) is the gesture's own delta; the marking may already carry a
  // nudge from an earlier drag, so the new absolute offset is that plus this delta
  // (setNudge takes an absolute value — see src/commands/layout.ts).
  const handleDragMarking = useCallback(
    (id: string, dx: number, dy: number) => {
      const existing = editor.score.layout.nudges[id];
      editor.applyAction({
        kind: "setNudge",
        id,
        dx: (existing?.dx ?? 0) + dx,
        dy: (existing?.dy ?? 0) + dy,
      });
    },
    [editor],
  );

  const handleOmrImported = useCallback(
    (result: ImportedFromOmr) => {
      editor.loadScore(result.score);
      setOmrReview(result.review);
      setPdfSession(result.pdfBytes ? { bytes: result.pdfBytes, filename: result.pdfFilename } : null);
      setImportOpen(false);
      setIoMessage(null);
        setFileName(null);
    },
    [editor, setFileName],
  );

  const handleReviewClick = useCallback(
    (item: OmrReviewItem) => {
      editor.setSelection({ ids: [] });
      editor.setCursor({
        partIndex: 0,
        measureIndex: item.measureIndex,
        staffIndex: item.staffIndex,
        voiceIndex: 0,
        offset: frac(0),
      });
    },
    [editor],
  );

  const cursor = editor.cursor;
  const currentStaffDef = editor.score.parts[cursor.partIndex]?.staves[cursor.staffIndex];
  // The clef at the cursor itself, so a clef change earlier in the piece shows here.
  const clef = currentStaffDef
    ? clefLabel(clefAt(editor.score, cursor.partIndex, cursor.staffIndex, cursor.measureIndex, cursor.offset))
    : "?";
  const durationName = DURATION_NAMES[editor.entry.base] ?? String(editor.entry.base);
  const dots = ".".repeat(editor.entry.dots);
  const statusMessage = ioMessage ?? editor.message;

  // Lyric mode (docs/ARCHITECTURE.md "M3 contracts > Lyrics"): reads the syllable text
  // straight from the score so it always matches what's engraved. Not note entry, so
  // the entry cursor line is hidden below (`entryActive`).
  const lyric = editor.entry.lyric;
  const lyricInfo = useMemo(() => {
    if (!lyric) return null;
    const event = findEvent(editor.score, lyric.eventId);
    const text = event && event.kind === "note" ? (event.lyrics?.find((l) => l.verse === lyric.verse)?.text ?? "") : "";
    return { verse: lyric.verse, text };
  }, [editor.score, lyric]);

  return (
    <div className="app" data-font-ready={fontReady}>
      <style>{pageSizeCss}</style>
      <header className="toolbar">
        <span className="toolbar-doc">
          <span className="toolbar-title">Sheet Music Assistant</span>
          {fileName && <span className="toolbar-filename">{fileName}</span>}
        </span>

        <div className="toolbar-group">
          <button type="button" className="icon-button" title="New" onClick={() => setNewFormOpen((v) => !v)}>
            <NewIcon />
          </button>
          <button type="button" className="icon-button" title="Open" onClick={() => fileInputRef.current?.click()}>
            <OpenIcon />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pscore,.musicxml,.xml,.mxl,application/json"
            style={{ display: "none" }}
            onChange={(e) => void handleFileChosen(e)}
          />
          <button type="button" className="icon-button" title="Save" onClick={handleSave}>
            <SaveIcon />
          </button>
          <button type="button" className="icon-button" title="Save As" onClick={handleSaveAs}>
            <SaveAsIcon />
          </button>
        </div>

        <div className="toolbar-divider" aria-hidden="true" />

        <div className="toolbar-group">
          <button
            type="button"
            className="icon-button"
            title="Undo"
            onClick={editor.undo}
            disabled={!editor.canUndo}
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Redo"
            onClick={editor.redo}
            disabled={!editor.canRedo}
          >
            <RedoIcon />
          </button>
        </div>

        <div className="toolbar-divider" aria-hidden="true" />

        <div className="toolbar-group">
          <button type="button" className="icon-button" title="Print" onClick={() => window.print()}>
            <PrintIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Staves"
            aria-pressed={stavesOpen}
            onClick={() => setStavesOpen((v) => !v)}
          >
            <ClefIcon />
          </button>
          <button type="button" className="icon-button" title="Import PDF or photo" onClick={() => setImportOpen(true)}>
            <PdfIcon />
          </button>
        </div>

        <div className="toolbar-divider" aria-hidden="true" />

        <div className="toolbar-group">
          <button
            type="button"
            className="icon-button"
            title={playback.status === "playing" ? "Pause (Space)" : "Play from the cursor (Space)"}
            aria-pressed={playback.status === "playing"}
            onClick={playback.toggle}
          >
            {playback.status === "playing" ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            className="icon-button"
            title="Stop (Esc)"
            disabled={playback.status === "stopped"}
            onClick={playback.stop}
          >
            <StopIcon />
          </button>
          <select
            className="speed-select"
            aria-label="Playback speed"
            title="Playback speed"
            value={playback.speed}
            onChange={(e) => playback.setSpeed(Number(e.target.value))}
          >
            {[0.5, 0.75, 0.9, 1, 1.1, 1.25].map((v) => (
              <option key={v} value={v}>
                {Math.round(v * 100)}%
              </option>
            ))}
          </select>
        </div>

        {(sound.status.state === "loading" || sound.status.state === "error") && sound.target === "builtin" && (
          <span className={`toolbar-hint${sound.status.state === "error" ? " toolbar-hint-error" : ""}`}>
            {sound.status.state === "loading" ? (sound.status.message ?? "Loading…") : "Sound unavailable"}
          </span>
        )}

        <div className="toolbar-end">
          <div className="toolbar-group">
            <ToolbarMenu
              title="Sound & MIDI"
              icon={<SoundIcon />}
              lit={sound.target === "midi" ? ports.outputId !== null : ports.inputId !== null}
            >
              {() => (
                <SoundMenu
                  sound={sound}
                  ports={ports}
                  playing={playback.status === "playing"}
                  onChangeTarget={changeTarget}
                  onExportMidi={handleExportMidi}
                />
              )}
            </ToolbarMenu>
            <button type="button" className="icon-button" title="Export MusicXML" onClick={handleExportMusicXml}>
              <XmlIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setCompareOpen((v) => !v)}
              aria-pressed={compareOpen}
              disabled={!pdfSession}
              title={pdfSession ? "Compare with the original PDF" : "Compare with PDF (import a PDF this session to enable)"}
            >
              <CompareIcon />
            </button>
          </div>

          <div className="toolbar-divider" aria-hidden="true" />

          <div className="toolbar-group">
            <button
              type="button"
              className="icon-button"
              title="Help & FAQ"
              onClick={() => {
                setFaqOpen((v) => !v);
                setShortcutsOpen(false);
              }}
              aria-pressed={faqOpen}
            >
              <HelpIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Keyboard shortcuts"
              onClick={() => {
                setShortcutsOpen((v) => !v);
                setFaqOpen(false);
              }}
              aria-pressed={shortcutsOpen}
            >
              <KeyboardIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Score info (title, composer…)"
              onClick={() => setInfoOpen((v) => !v)}
              aria-pressed={infoOpen}
            >
              <InfoIcon />
            </button>
          </div>
        </div>
      </header>
      {newFormOpen && (
        <NewScoreForm
          onCreate={handleNewScore}
          onCreateSatb={handleNewSatb}
          onOpenSample={handleOpenSample}
          onCancel={() => setNewFormOpen(false)}
        />
      )}
      <Palettes
        font={BRAVURA}
        score={editor.score}
        cursor={cursor}
        selection={editor.selection}
        onApplyAction={editor.applyAction}
      />
      {shortcutsOpen && <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />}
      {faqOpen && <HelpPanel onClose={() => setFaqOpen(false)} />}
      {infoOpen && (
        <ScoreInfoPanel meta={editor.score.meta} onApplyAction={editor.applyAction} onClose={() => setInfoOpen(false)} />
      )}
      {stavesOpen && editor.score.parts[cursor.partIndex] && (
        <StavesPanel
          part={editor.score.parts[cursor.partIndex]!}
          onApplyAction={editor.applyAction}
          onClose={() => setStavesOpen(false)}
        />
      )}
      <div className={`workspace${compareOpen && pdfSession ? " workspace-with-compare" : ""}`}>
        <main>
          <ScoreView
            layout={layout}
            font={BRAVURA}
            idAttributes
            cursor={editor.cursor}
            selection={editor.selection}
            entryActive={editor.entry.active && !lyricInfo}
            onClickElement={handleClickElement}
            onClickEmpty={handleClickEmpty}
            onSelectMany={handleSelectMany}
            onDragPitch={handleDragPitch}
            onDragMarking={handleDragMarking}
            playhead={playback.playhead}
            onInsertMeasure={(index) => editor.applyAction({ kind: "insertMeasure", index })}
            onDeleteMeasure={(measureIndex) => editor.applyAction({ kind: "deleteMeasure", measureIndex })}
          />
        </main>
        {compareOpen && pdfSession && (
          <ComparePanel
            pdfBytes={pdfSession.bytes}
            pageBreaks={editor.score.layout.pageBreaks}
            cursorMeasureIndex={cursor.measureIndex}
            review={omrReview}
            onReviewClick={handleReviewClick}
            onClose={() => setCompareOpen(false)}
          />
        )}
      </div>
      {importOpen && <ImportPdfDialog onClose={() => setImportOpen(false)} onImported={handleOmrImported} />}
      <footer className="status-bar">
        {lyricInfo ? (
          <span className="lyric-status">
            Lyrics &middot; verse {lyricInfo.verse + 1} &middot; {lyricInfo.text}
          </span>
        ) : (
          <span>
            Measure {cursor.measureIndex + 1} &middot; Staff {clef} &middot; Voice {cursor.voiceIndex + 1}{" "}
            <button
              type="button"
              className="voice-toggle"
              title="Toggle voice 1 / 2"
              onClick={() => editor.applyAction({ kind: "setVoice", voiceIndex: cursor.voiceIndex === 1 ? 0 : 1 })}
            >
              Voice 1/2
            </button>
            &middot; Duration {durationName}
            {dots} &middot;{" "}
            <span className={editor.entry.active ? "entry-on" : "entry-off"}>
              {editor.entry.active ? "Note entry ON" : "Note entry OFF"}
            </span>
          </span>
        )}
        {statusMessage ? (
          <span className="status-bar-message">{statusMessage}</span>
        ) : (
          !editor.entry.active &&
          !lyricInfo && <span className="status-bar-hint">Press N to start entering notes, or click Shortcuts.</span>
        )}
      </footer>
    </div>
  );
}
