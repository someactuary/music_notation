/**
 * Editor-state contracts shared by src/input (pure key handling) and src/ui (React).
 * Everything here is plain data; the UI owns the store, src/input owns the rules.
 */
import type { Fraction, NoteValue } from "@/model/duration";
import type { Alter, KeySignature } from "@/model/pitch";
import type {
  Articulation,
  ClefKind,
  Id,
  NoteEvent,
  Placement,
  RestEvent,
  Score,
  ScoreMeta,
  StaffGroupSymbol,
} from "@/model";
import type { NotatedDuration } from "@/model/duration";
import type { Command } from "@/commands/types";

/** Where the next entered note goes. `offset` is measure-relative, in whole notes. */
export interface Cursor {
  partIndex: number;
  measureIndex: number;
  staffIndex: number;
  voiceIndex: number;
  offset: Fraction;
}

/** What the user has selected. Element ids are note ids or event ids (rests). */
export interface Selection {
  ids: Id[];
}

/** Pending note-entry settings, MuseScore-style: choose duration, then type pitches. */
export interface EntryState {
  base: NoteValue;
  dots: 0 | 1 | 2 | 3;
  /** Accidental to apply to the next entered note; cleared after use. */
  alter: Alter | null;
  /** Octave of the last entered/selected pitch; new letters pick the nearest octave to this. */
  referenceOctave: number;
  /** Diatonic reference step (0-6, C=0) of the last entered pitch for nearest-octave logic. */
  referenceStepIndex: number;
  /** When true, typed letters are added to the chord at the cursor instead of advancing. */
  chordMode: boolean;
  /** True while note-entry mode is active (N toggles). Off = navigation/selection only. */
  active: boolean;
  /**
   * Lyric-entry mode: typed characters edit the lyric (verse `verse`) of the event at
   * `eventId`; Space / "-" / "_" move on to the next note. null = not in lyric mode.
   */
  lyric: { eventId: Id; verse: number } | null;
}

/** Internal clipboard: events per staff, with offsets relative to the copied span's start. */
export interface ClipboardItem {
  offset: Fraction;
  /** A deep copy; ids are regenerated on paste. */
  event: NoteEvent | RestEvent;
}
export interface ClipboardStaff {
  /** Staff index relative to the topmost copied staff (0 = same staff as the paste cursor). */
  staffOffset: number;
  items: ClipboardItem[];
}
export interface ClipboardContent {
  staves: ClipboardStaff[];
  /** Total span from the first onset to the end of the last event (max over staves). */
  length: Fraction;
}

export interface EditorState {
  score: Score;
  cursor: Cursor;
  selection: Selection;
  entry: EntryState;
  clipboard: ClipboardContent | null;
}

/** Normalized keyboard event, independent of the DOM. */
export interface KeyStroke {
  /** KeyboardEvent.key: "a", "A", "ArrowUp", "Backspace", "Delete", "Enter", "Escape", "Tab", " ", "+", "-", ".", "0"-"9" ... */
  key: string;
  shift: boolean;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod: boolean;
  alt: boolean;
}

/** Result of handling a keystroke. `null` = key not handled (let the browser have it). */
export interface KeyResult {
  /** Commands to run through History, in order. May be empty for pure navigation. */
  commands: Command[];
  /** New cursor after the commands have been applied. Omit to keep. */
  cursor?: Cursor;
  selection?: Selection;
  entry?: EntryState;
  /** "undo" / "redo" are handled by the store, not by commands. */
  history?: "undo" | "redo";
  /** Replace the internal clipboard (copy/cut). */
  clipboard?: ClipboardContent | null;
  /** Optional user-facing note for the status bar, e.g. "Note does not fit in measure". */
  message?: string;
}

/**
 * Pure keystroke handler. Reads state, never mutates it. The store applies `commands`,
 * then the cursor/selection/entry updates. Implemented in src/input/step-entry.ts.
 */
export type KeyHandler = (state: EditorState, key: KeyStroke) => KeyResult | null;

export const DEFAULT_ENTRY_STATE: EntryState = {
  base: 4,
  dots: 0,
  alter: null,
  referenceOctave: 4,
  referenceStepIndex: 0,
  chordMode: false,
  active: false,
  lyric: null,
};

/**
 * Actions triggered from the UI (palettes, inspector, mouse drags) rather than raw keys.
 * Handled by the same pure machinery as keystrokes: `ActionHandler` returns a KeyResult the
 * store applies. Most act on the current selection (or the event before the cursor).
 */
export type PaletteAction =
  // Notation on the selection
  | { kind: "dynamic"; text: string }
  | { kind: "articulation"; articulation: Articulation }
  | { kind: "slur" }
  | { kind: "hairpin"; shape: "cresc" | "dim" }
  | { kind: "pedal" }
  | { kind: "ottava"; shift: 8 | -8 }
  | { kind: "fermata" }
  | { kind: "tempo"; text?: string; bpm?: number; beatUnit?: NotatedDuration }
  | { kind: "text"; text: string; style: "expression" | "technique" | "plain"; placement?: Placement }
  | { kind: "fingering"; text: string }
  | { kind: "tuplet"; actual: number; normal: number }
  | { kind: "flipStem" }
  | { kind: "setDuration"; base: NotatedDuration["base"]; dots: NotatedDuration["dots"] }
  | { kind: "toggleDot" }
  | { kind: "removeAttachment"; id: Id }
  | { kind: "removeSpanner"; id: Id }
  // Mouse editing
  | { kind: "dragPitch"; noteId: Id; diatonicDelta: number }
  // Staves (SATB etc.)
  | { kind: "addStaff"; atIndex: number; clef: ClefKind; name?: string }
  | { kind: "removeStaff"; staffIndex: number }
  | { kind: "setClef"; staffIndex: number; clef: ClefKind }
  // A clef change from the first selected note (or the cursor, when nothing is selected) on.
  | { kind: "clefChange"; clef: ClefKind }
  // Measures (the +/− buttons on a hovered measure): insert an empty measure at `index`
  // (so `measureIndex + 1` = after it), or delete one measure.
  | { kind: "insertMeasure"; index: number }
  | { kind: "deleteMeasure"; measureIndex: number }
  | { kind: "setStaffName"; staffIndex: number; name: string; abbreviation?: string }
  | { kind: "setBracket"; bracket: StaffGroupSymbol }
  // Score info: title/subtitle/composer/lyricist/copyright (src/ui/ScoreInfoPanel.tsx).
  | { kind: "setMeta"; patch: Partial<ScoreMeta> }
  // Voices
  | { kind: "setVoice"; voiceIndex: number }
  // Key signature: applies at the cursor's measure, per docs/ARCHITECTURE.md's
  // "Manual layout control" (setKeySignature reads state.cursor.measureIndex, so the
  // action itself carries no measure index).
  | { kind: "setKeySignature"; keySig: KeySignature }
  | { kind: "clearKeySignature" }
  // Manual layout control: forced breaks (at the cursor's measure) and global caps.
  | { kind: "toggleSystemBreak" }
  | { kind: "togglePageBreak" }
  | { kind: "setMeasuresPerSystem"; value: number | null }
  | { kind: "setSystemsPerPage"; value: number | null }
  | { kind: "clearForcedBreaks" }
  // Moving a selectable marking (drag in ScoreView, or a future nudge shortcut):
  // `dx`/`dy` are the new ABSOLUTE offset (see src/commands/layout.ts's setNudge).
  | { kind: "setNudge"; id: Id; dx: number; dy: number }
  | { kind: "clearNudge"; id: Id };

export type ActionHandler = (state: EditorState, action: PaletteAction) => KeyResult | null;

/** A MIDI note-on from a connected keyboard, already filtered (velocity > 0). */
export interface MidiNoteOn {
  /** MIDI note number, 60 = middle C. */
  note: number;
  velocity: number;
  /** MIDI notes currently held BEFORE this one arrived (chord building). */
  held: number[];
}

/**
 * Pure MIDI step-entry handler: spells the pitch from the key signature at the cursor,
 * writes a new event of the current entry duration when no other key is held, or adds
 * the pitch to the chord just entered when keys are still held. Null when entry is off.
 */
export type MidiHandler = (state: EditorState, ev: MidiNoteOn) => KeyResult | null;
