/**
 * Pure keyboard step-entry handler. See docs/ARCHITECTURE.md's "Editor contracts (M1)"
 * for the contracts this implements (`KeyHandler`, `EditorState`, etc. live in
 * src/input/types.ts and are not modified here). The store (src/ui) applies the
 * returned commands through History, then adopts the returned cursor/selection/entry.
 */
import {
  add,
  cmp,
  eq,
  lt,
  newId,
  notated,
  notatedToFraction,
  ZERO,
  type Fraction,
  type Lyric,
  type NoteEvent,
  type NoteValue,
  type Score,
} from "@/model";
import { diatonic, keyAlter, STEPS, type Alter, type Pitch, type Step } from "@/model/pitch";
import { locateEvent, locateNote } from "@/commands/locate";
import { addMeasures, removeMeasure, toggleTie } from "@/commands/basic";
import {
  addNoteToEvent,
  appendMeasure,
  canWrite,
  eraseEvent,
  setNoteAlter,
  soundingLengthAt,
  toggleRestInvisible,
  transposeNotes,
  writeEvent,
  removeNoteFromEvent,
} from "@/commands/edit";
import { setLyric, setLyricExtend } from "@/commands/lyrics";
import { clearNudge } from "@/commands/layout";
import { clearEventDecorations, removeAttachment, removeSpanner } from "@/commands/notation";
import { removeClefChange } from "@/commands/clefs";
import { parseClefChangeId } from "@/model";
import type { Command } from "@/commands/types";
import { handleAction } from "./actions";
import { copySelection, pasteAt } from "./clipboard";
import {
  absoluteOffset,
  eventAtCursor,
  chordTarget,
  eventBeforeCursor,
  eventsInVoice,
  idsForEvent,
  keySignatureAt,
  measureLength,
  nextOffset,
  prevOffset,
  resolveSelection,
  type PositionedVoiceEvent,
} from "./navigation";
import {
  DEFAULT_ENTRY_STATE,
  type ClipboardContent,
  type Cursor,
  type EditorState,
  type EntryState,
  type KeyHandler,
  type KeyResult,
  type KeyStroke,
  type Selection,
} from "./types";

/** A fresh editor state for `score`: cursor at the very start, nothing selected, entry off. */
export function defaultEditorState(score: Score): EditorState {
  return {
    score,
    cursor: { partIndex: 0, measureIndex: 0, staffIndex: 0, voiceIndex: 0, offset: ZERO },
    selection: { ids: [] },
    entry: { ...DEFAULT_ENTRY_STATE },
    clipboard: null,
  };
}

/**
 * Digit -> notated base value, Noteflight-style: 1 whole, 2 half, 4 quarter, 8 eighth,
 * 6 sixteenth, 3 thirty-second. 5, 7, 9 are unused (not in this map; the digit is ignored).
 */
const DURATION_DIGITS: Record<string, NoteValue> = { "1": 1, "2": 2, "4": 4, "8": 8, "6": 16, "3": 32 };

/** mod+alt+1..4 -> voice index 0..3 (see docs/ARCHITECTURE.md's Voices M2 contract). */
const VOICE_DIGITS: Record<string, number> = { "1": 0, "2": 1, "3": 2, "4": 3 };

/** mod+digit -> a tuplet ratio, applied via the "tuplet" action. */
const TUPLET_SHORTCUTS: Record<string, { actual: number; normal: number }> = {
  "3": { actual: 3, normal: 2 },
  "5": { actual: 5, normal: 4 },
  "6": { actual: 6, normal: 4 },
  "7": { actual: 7, normal: 4 },
  "2": { actual: 2, normal: 3 },
  "9": { actual: 9, normal: 8 },
};

/**
 * Among referenceOctave-1/+0/+1, the octave that puts `step` diatonically closest to
 * (referenceOctave, referenceStepIndex). Ties can't occur (candidates are 7 apart).
 */
function nearestOctave(step: Step, referenceOctave: number, referenceStepIndex: number): number {
  const stepIndex = STEPS.indexOf(step);
  const referenceDiatonic = referenceOctave * 7 + referenceStepIndex;
  let best = referenceOctave;
  let bestDistance = Infinity;
  for (const candidate of [referenceOctave - 1, referenceOctave, referenceOctave + 1]) {
    const distance = Math.abs(candidate * 7 + stepIndex - referenceDiatonic);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** The alteration to apply to a freshly typed letter: the pending accidental, else the key signature's. */
/**
 * True when the selection is just the note/rest right before the cursor, which is what
 * typing a note leaves behind (enter() selects what it wrote and moves the cursor past
 * it). Clicking a note instead puts the cursor AT the note, so a clicked note never
 * looks "just typed".
 */
function isJustTypedSelection(state: EditorState): boolean {
  const before = chordTarget(state.score, state.cursor);
  if (!before) return false;
  const own = new Set(idsForEvent(before.event));
  return state.selection.ids.every((id) => own.has(id));
}

function letterAlter(state: EditorState, step: Step): Alter {
  return state.entry.alter ?? keyAlter(keySignatureAt(state.score, state.cursor.measureIndex), step);
}

/** Selection ids that actually resolve to notes in the current score (rest ids are dropped). */
function selectedNoteIds(state: EditorState): string[] {
  return state.selection.ids.filter((id) => locateNote(state.score, id) !== undefined);
}

function beforeCursorNoteIds(state: EditorState): string[] {
  const before = eventBeforeCursor(state.score, state.cursor);
  if (!before || before.event.kind !== "note") return [];
  return before.event.notes.map((n) => n.id);
}

/** selection if it has notes, else (only while note entry is active) the event before the cursor. */
function transposeTargets(state: EditorState): string[] {
  const selected = selectedNoteIds(state);
  if (selected.length > 0) return selected;
  if (!state.entry.active) return [];
  return beforeCursorNoteIds(state);
}

/** selection if it has notes, else the event before the cursor (works whether or not entry is active). */
function tieTargets(state: EditorState): string[] {
  const selected = selectedNoteIds(state);
  if (selected.length > 0) return selected;
  return beforeCursorNoteIds(state);
}

function selectionOf(pe: PositionedVoiceEvent | undefined): Selection {
  if (!pe) return { ids: [] };
  return { ids: idsForEvent(pe.event) };
}

/** The mod+c status message: "Copied N notes" only when every copied item is a note, else "Copied N events" (rests and notes mixed, or rests only). */
function copiedMessage(clipboard: ClipboardContent): string {
  const items = clipboard.staves.flatMap((s) => s.items);
  const allNotes = items.every((i) => i.event.kind === "note");
  return `Copied ${items.length} ${allNotes ? "notes" : "events"}`;
}

/**
 * Erases every event in the current selection (deduplicated by event id), earliest
 * first — except a note that carries a tie and/or decorations with no id of their own
 * (articulations, ornaments, arpeggio, tremolo — see `clearEventDecorations`), which
 * only has those stripped, not erased: a tie and a slur look alike, ties always
 * resolve (by design — see ties.ts) to their start note's own id, and that note's own
 * id is indistinguishable from "the user meant to select the note itself" once it's
 * just an id in `Selection`. Stripping first rather than erasing outright means a
 * click that lands on a tie/decoration instead of the marking the user actually meant
 * can never destroy a note by surprise: Delete again, now genuinely plain, erases it.
 * Returns the commands, the cursor position of the earliest affected event
 * (undefined if the selection resolved to nothing, e.g. only stale ids), a message
 * when anything was stripped rather than erased, and `keptIds`: the selection ids of
 * every stripped (not erased) note — an erased event's id no longer exists afterwards
 * (`eraseEvent` replaces it with a fresh rest), but a stripped one is the very same
 * note, so re-selecting it is exactly keeping these ids selected. The caller uses
 * `keptIds` instead of clearing the selection, so a second Delete on the same
 * selection reaches the now-plain note and actually erases it.
 */
function eraseSelected(
  state: EditorState,
  opts: { singleNotes: boolean },
): { commands: Command[]; cursor?: Cursor; message?: string; keptIds: string[] } {
  const { score, selection } = state;
  const resolved = resolveSelection(score, selection);
  if (resolved.length === 0) return { commands: [], keptIds: [] };
  // Which notes of each chord the selection names (a notehead click selects one note).
  const selectedNotesByEvent = new Map<string, string[]>();
  for (const id of selection.ids) {
    const hit = locateNote(score, id);
    if (!hit) continue;
    const list = selectedNotesByEvent.get(hit.event.id) ?? [];
    list.push(id);
    selectedNotesByEvent.set(hit.event.id, list);
  }
  const sorted = resolved
    .map((r) => ({ ...r, absolute: absoluteOffset(score, r.measureIndex, r.offset) }))
    .sort((a, b) => cmp(a.absolute, b.absolute));

  const commands: Command[] = [];
  const keptIds: string[] = [];
  let strippedEvents = 0;
  for (const r of sorted) {
    const event = r.event;
    // Only some notes of a chord selected: remove just those notes; the rest of the chord stays.
    const chosen = selectedNotesByEvent.get(event.id) ?? [];
    if (opts.singleNotes && event.kind === "note" && chosen.length > 0 && chosen.length < event.notes.length) {
      for (const noteId of chosen) commands.push(removeNoteFromEvent(event.id, noteId));
      continue;
    }
    const tiedNoteIds = event.kind === "note" ? event.notes.filter((n) => n.tieStart).map((n) => n.id) : [];
    const hasDecorations =
      event.kind === "note" &&
      ((event.articulations?.length ?? 0) > 0 ||
        (event.ornaments?.length ?? 0) > 0 ||
        event.arpeggio !== undefined ||
        event.tremolo !== undefined);
    if (tiedNoteIds.length > 0 || hasDecorations) {
      for (const noteId of tiedNoteIds) commands.push(toggleTie(noteId));
      if (hasDecorations) commands.push(clearEventDecorations(event.id));
      keptIds.push(...idsForEvent(event));
      strippedEvents++;
    } else {
      commands.push(eraseEvent(event.id));
    }
  }

  const first = sorted[0]!;
  const cursor: Cursor = {
    partIndex: first.partIndex,
    measureIndex: first.measureIndex,
    staffIndex: first.staffIndex,
    voiceIndex: first.voiceIndex,
    offset: first.offset,
  };
  const message =
    strippedEvents === 0
      ? undefined
      : strippedEvents === sorted.length
        ? "Removed the tie/marking — press Delete again to remove the note"
        : "Removed a tie/marking from one note — press Delete again to remove it";
  return { commands, cursor, ...(message ? { message } : {}), keptIds };
}

/**
 * Erases everything in the current selection. A spanner or attachment id (a slur,
 * hairpin, pedal, ottava, dynamic, tempo, text, fermata, pedal mark — see
 * `MOVABLE_ROLES`/`SELECTABLE_ROLES` in src/ui/layout-utils.ts) isn't resolved by
 * `resolveSelection` (note/event only), so it's removed directly by its own id via
 * `removeSpanner`/`removeAttachment` — clearing any nudge recorded for it too, so
 * `layout.nudges` doesn't accumulate entries for markings that no longer exist. A clef
 * change (a `clefChangeId`) is removed with `removeClefChange`.
 * Everything else in the selection still goes through `eraseSelected`.
 */
function deleteSelection(
  state: EditorState,
  opts: { singleNotes: boolean } = { singleNotes: true },
): { commands: Command[]; cursor?: Cursor; message?: string; keptIds: string[] } {
  const { score, selection } = state;
  const spannerIds = new Set(score.spanners.map((s) => s.id));
  const attachmentIds = new Set(score.attachments.map((a) => a.id));
  const commands: Command[] = [];
  const remaining: string[] = [];
  for (const id of selection.ids) {
    if (parseClefChangeId(id)) {
      commands.push(removeClefChange(id));
      continue;
    }
    if (spannerIds.has(id)) commands.push(removeSpanner(id));
    else if (attachmentIds.has(id)) commands.push(removeAttachment(id));
    else {
      remaining.push(id);
      continue;
    }
    if (score.layout.nudges[id]) commands.push(clearNudge(id));
  }
  const erased = eraseSelected({ ...state, selection: { ids: remaining } }, opts);
  return {
    commands: [...commands, ...erased.commands],
    ...(erased.cursor ? { cursor: erased.cursor } : {}),
    ...(erased.message ? { message: erased.message } : {}),
    keptIds: erased.keptIds,
  };
}

/** Cursor + event-boundary navigation shared by ArrowLeft/ArrowRight. Crosses measures; stops at score ends. */
function moveToEvent(state: EditorState, dir: 1 | -1): KeyResult {
  const { score, cursor, selection } = state;
  if (dir === 1) {
    // With nothing selected and the cursor sitting at the very start of a measure,
    // ArrowRight selects that measure's FIRST event (the one the cursor is already
    // touching) instead of skipping straight past it to the second.
    if (selection.ids.length === 0 && eq(cursor.offset, ZERO)) {
      const first = eventAtCursor(score, cursor);
      if (first) {
        const off = nextOffset(score, cursor);
        const newCursor: Cursor = off !== null ? { ...cursor, offset: off } : cursor;
        return { commands: [], cursor: newCursor, selection: selectionOf(first) };
      }
    }
    const off = nextOffset(score, cursor);
    if (off !== null) {
      const newCursor: Cursor = { ...cursor, offset: off };
      return { commands: [], cursor: newCursor, selection: selectionOf(eventAtCursor(score, newCursor)) };
    }
    const measureCount = score.parts[cursor.partIndex]?.measures.length ?? 0;
    if (cursor.measureIndex + 1 < measureCount) {
      const newCursor: Cursor = { ...cursor, measureIndex: cursor.measureIndex + 1, offset: ZERO };
      return { commands: [], cursor: newCursor, selection: selectionOf(eventAtCursor(score, newCursor)) };
    }
    return { commands: [], cursor, selection: selectionOf(eventAtCursor(score, cursor)) }; // already at score end
  }
  const off = prevOffset(score, cursor);
  if (off !== null) {
    const newCursor: Cursor = { ...cursor, offset: off };
    return { commands: [], cursor: newCursor, selection: selectionOf(eventAtCursor(score, newCursor)) };
  }
  if (cursor.measureIndex > 0) {
    const prevMeasureIndex = cursor.measureIndex - 1;
    const events = eventsInVoice(score, { ...cursor, measureIndex: prevMeasureIndex });
    const lastOffset = events.length > 0 ? events[events.length - 1]!.offset : ZERO;
    const newCursor: Cursor = { ...cursor, measureIndex: prevMeasureIndex, offset: lastOffset };
    return { commands: [], cursor: newCursor, selection: selectionOf(eventAtCursor(score, newCursor)) };
  }
  return { commands: [], cursor, selection: selectionOf(eventAtCursor(score, cursor)) }; // already at score start
}

/** Shift+ArrowLeft/Right: grows the selection by the previous/next event in the cursor's voice (crosses measures like plain arrows) and moves the cursor there. */
function extendSelection(state: EditorState, dir: 1 | -1): KeyResult {
  const moved = moveToEvent(state, dir);
  const newCursor = moved.cursor ?? state.cursor;
  const pe = eventAtCursor(state.score, newCursor);
  const addedIds = pe ? idsForEvent(pe.event) : [];
  const ids = [...new Set([...state.selection.ids, ...addedIds])];
  return { commands: [], cursor: newCursor, selection: { ids } };
}

/** Writes a note or rest of the current entry duration at the cursor, advancing the cursor past it. */
function enter(state: EditorState, event: { kind: "note"; pitch: Pitch } | { kind: "rest" }): KeyResult {
  const { score, cursor, entry } = state;
  const duration = notated(entry.base, entry.dots);
  const len = notatedToFraction(duration);
  const refusal = canWrite(score, cursor, len);
  if (refusal) return { commands: [], message: refusal };

  const noteEvent =
    event.kind === "note"
      ? { kind: "note" as const, id: newId(), duration, notes: [{ id: newId(), pitch: event.pitch }] }
      : { kind: "rest" as const, id: newId(), duration };

  const commands: Command[] = [writeEvent(cursor, noteEvent)];
  let measureIndex = cursor.measureIndex;
  // Advance by the SOUNDING length: inside a tuplet, `len` (notated) overstates how
  // far the cursor should move (see docs/ARCHITECTURE.md's tuplet contract).
  const soundingLen = soundingLengthAt(score, cursor, len);
  let offset = add(cursor.offset, soundingLen);

  const measureLen = measureLength(score, cursor.measureIndex);
  if (!lt(offset, measureLen)) {
    // The write reached the end of the measure (canWrite already guarantees it didn't overshoot).
    measureIndex += 1;
    offset = ZERO;
    const measureCount = score.parts[cursor.partIndex]?.measures.length ?? 0;
    if (measureIndex >= measureCount) commands.push(appendMeasure());
  }

  const newCursor: Cursor = { ...cursor, measureIndex, offset };
  // The dot is one-shot: a dotted note is almost always followed by an undotted one
  // (dotted eighth + 16th), so it applies to this note/rest only. The duration stays.
  const newEntry: EntryState =
    event.kind === "note"
      ? {
          ...entry,
          alter: null,
          dots: 0,
          referenceOctave: event.pitch.octave,
          referenceStepIndex: STEPS.indexOf(event.pitch.step),
        }
      : { ...entry, alter: null, dots: 0 };
  const selectedId = noteEvent.kind === "note" ? noteEvent.notes[0]!.id : noteEvent.id;
  return { commands, cursor: newCursor, selection: { ids: [selectedId] }, entry: newEntry };
}

/**
 * Writes `pitch` as a note of the current entry duration at the cursor, advancing the
 * cursor past it — the same write/advance code path a typed letter (a-g) uses. Exported
 * for src/input/midi-entry.ts (docs/ARCHITECTURE.md's MIDI input contract: "same code
 * path as a typed letter, cursor advances").
 */
export function enterPitch(state: EditorState, pitch: Pitch): KeyResult {
  return enter(state, { kind: "note", pitch });
}

// ---------------------------------------------------------------------------
// Lyric entry (M3): see docs/ARCHITECTURE.md's "Lyrics" contract. `EntryState.lyric`
// (contract, src/input/types.ts) only stores `{eventId, verse}`; everything else
// (the syllable text/syllabic, and neighboring-note lookups for hyphenation) is
// re-derived from the score on every keystroke.
// ---------------------------------------------------------------------------

/** A NoteEvent located within a voice, with enough context to navigate to its neighbors and reconstruct a Cursor. */
interface LyricNoteLocation {
  event: NoteEvent;
  partIndex: number;
  measureIndex: number;
  staffIndex: number;
  voiceIndex: number;
  offset: Fraction;
}

function toCursor(loc: LyricNoteLocation): Cursor {
  return { partIndex: loc.partIndex, measureIndex: loc.measureIndex, staffIndex: loc.staffIndex, voiceIndex: loc.voiceIndex, offset: loc.offset };
}

/** The lyric at `verse` on `event`, if any. */
function lyricAt(event: NoteEvent, verse: number): Lyric | undefined {
  return event.lyrics?.find((l) => l.verse === verse);
}

/** Re-locates `eventId` as a `LyricNoteLocation`, or undefined if it no longer resolves to a NoteEvent. */
function locateLyricEvent(score: Score, eventId: string): LyricNoteLocation | undefined {
  const hit = locateEvent(score, eventId);
  if (!hit || hit.event.kind !== "note") return undefined;
  const voiceCursor: Cursor = { partIndex: hit.partIndex, measureIndex: hit.measureIndex, staffIndex: hit.staffIndex, voiceIndex: hit.voiceIndex, offset: ZERO };
  const positioned = eventsInVoice(score, voiceCursor).find((pe) => pe.event.id === eventId);
  if (!positioned) return undefined;
  return { event: hit.event, partIndex: hit.partIndex, measureIndex: hit.measureIndex, staffIndex: hit.staffIndex, voiceIndex: hit.voiceIndex, offset: positioned.offset };
}

/**
 * The next (`dir` 1) or previous (`dir` -1) NoteEvent in the same voice as `from`,
 * skipping rests and crossing barlines (same traversal `moveToEvent` uses). undefined
 * at the score's start/end.
 */
function adjacentNoteEvent(score: Score, from: LyricNoteLocation, dir: 1 | -1): LyricNoteLocation | undefined {
  const measureCount = score.parts[from.partIndex]?.measures.length ?? 0;
  let cur: Cursor = toCursor(from);
  for (;;) {
    if (dir === 1) {
      const off = nextOffset(score, cur);
      if (off !== null) {
        cur = { ...cur, offset: off };
      } else if (cur.measureIndex + 1 < measureCount) {
        cur = { ...cur, measureIndex: cur.measureIndex + 1, offset: ZERO };
      } else {
        return undefined;
      }
    } else {
      const off = prevOffset(score, cur);
      if (off !== null) {
        cur = { ...cur, offset: off };
      } else if (cur.measureIndex > 0) {
        const prevMeasureIndex = cur.measureIndex - 1;
        const events = eventsInVoice(score, { ...cur, measureIndex: prevMeasureIndex });
        const lastOffset = events.length > 0 ? events[events.length - 1]!.offset : ZERO;
        cur = { ...cur, measureIndex: prevMeasureIndex, offset: lastOffset };
      } else {
        return undefined;
      }
    }
    const pe = eventAtCursor(score, cur);
    if (pe && pe.event.kind === "note") {
      return { event: pe.event, partIndex: cur.partIndex, measureIndex: cur.measureIndex, staffIndex: cur.staffIndex, voiceIndex: cur.voiceIndex, offset: cur.offset };
    }
  }
}

/** True if the note immediately before `loc` in its voice has a "begin"/"middle" syllabic at `verse` (i.e. we're continuing a hyphenated word). */
function chainedFromPrevious(score: Score, loc: LyricNoteLocation, verse: number): boolean {
  const prev = adjacentNoteEvent(score, loc, -1);
  const syllabic = prev ? lyricAt(prev.event, verse)?.syllabic : undefined;
  return syllabic === "begin" || syllabic === "middle";
}

/** The NoteEvent to enter lyric mode on: the selection (if it resolves to a note), else the event before the cursor. */
function lyricEntryTarget(state: EditorState): LyricNoteLocation | undefined {
  const resolved = resolveSelection(state.score, state.selection).find((r) => r.event.kind === "note");
  if (resolved) {
    return {
      event: resolved.event as NoteEvent,
      partIndex: resolved.partIndex,
      measureIndex: resolved.measureIndex,
      staffIndex: resolved.staffIndex,
      voiceIndex: resolved.voiceIndex,
      offset: resolved.offset,
    };
  }
  const before = eventBeforeCursor(state.score, state.cursor);
  if (before && before.event.kind === "note") {
    const { partIndex, measureIndex, staffIndex, voiceIndex } = state.cursor;
    return { event: before.event, partIndex, measureIndex, staffIndex, voiceIndex, offset: before.offset };
  }
  return undefined;
}

function enterLyricMode(state: EditorState, target: LyricNoteLocation, verse: number): KeyResult {
  return {
    commands: [],
    cursor: toCursor(target),
    selection: { ids: idsForEvent(target.event) },
    entry: { ...state.entry, lyric: { eventId: target.event.id, verse } },
  };
}

/** Space / "-" / "_": advance lyric mode to the next NoteEvent in the voice (staying put at the score's end), running `commands` first. */
function lyricAdvance(state: EditorState, from: LyricNoteLocation, verse: number, commands: Command[]): KeyResult {
  const next = adjacentNoteEvent(state.score, from, 1) ?? from;
  return {
    commands,
    cursor: toCursor(next),
    selection: { ids: idsForEvent(next.event) },
    entry: { ...state.entry, lyric: { eventId: next.event.id, verse } },
  };
}

const LYRIC_SPECIAL_KEYS = new Set([" ", "-", "_"]);

/** A single character that should append to the lyric being typed: not a shortcut (no mod), not one of the specially-handled keys. Deliberately not gated on `alt` so Mac accented-letter composition (which reports the composed character with `altKey` still set) keeps working. */
function isPrintableLyricChar(key: KeyStroke): boolean {
  return !key.mod && key.key.length === 1 && !LYRIC_SPECIAL_KEYS.has(key.key);
}

/** `setLyric` args carrying over an existing lyric's `extend`, if any (setLyric would otherwise drop it back to unset). */
function withCarriedExtend(text: string, syllabic: Lyric["syllabic"], existing: Lyric | undefined): Partial<Lyric> & { text: string } {
  return existing?.extend !== undefined ? { text, syllabic, extend: existing.extend } : { text, syllabic };
}

/**
 * Handles a keystroke while `entry.lyric` is set (docs/ARCHITECTURE.md's Lyrics M3
 * entry contract). Every documented key is handled here; anything else returns null
 * so it can never fall through into note entry or another shortcut.
 */
function handleLyricKey(state: EditorState, key: KeyStroke): KeyResult | null {
  const { score, entry } = state;
  const lyricState = entry.lyric!;
  const loc = locateLyricEvent(score, lyricState.eventId);
  if (!loc) return { commands: [], entry: { ...entry, lyric: null } }; // the event vanished; bail out of lyric mode

  const verse = lyricState.verse;

  if (key.key === "Enter" || key.key === "Escape") {
    return { commands: [], entry: { ...entry, lyric: null } }; // Escape keeps whatever text was already committed
  }
  if (key.key === "ArrowLeft" || key.key === "ArrowRight") {
    const adj = adjacentNoteEvent(score, loc, key.key === "ArrowRight" ? 1 : -1);
    if (!adj) return { commands: [], selection: { ids: idsForEvent(loc.event) } }; // at the score's start/end: stays
    return {
      commands: [],
      cursor: toCursor(adj),
      selection: { ids: idsForEvent(adj.event) },
      entry: { ...entry, lyric: { eventId: adj.event.id, verse } },
    };
  }
  if (key.key === " ") {
    return lyricAdvance(state, loc, verse, []);
  }
  if (key.key === "-") {
    const existing = lyricAt(loc.event, verse);
    if (!existing || existing.text.length === 0) return lyricAdvance(state, loc, verse, []); // nothing typed yet: just move on
    const syllabic: Lyric["syllabic"] = chainedFromPrevious(score, loc, verse) ? "middle" : "begin";
    const cmd = setLyric(loc.event.id, verse, withCarriedExtend(existing.text, syllabic, existing));
    return lyricAdvance(state, loc, verse, [cmd]);
  }
  if (key.key === "_") {
    const existing = lyricAt(loc.event, verse);
    if (!existing || existing.text.length === 0) return lyricAdvance(state, loc, verse, []); // nothing to extend
    return lyricAdvance(state, loc, verse, [setLyricExtend(loc.event.id, verse, true)]);
  }
  if (key.key === "Backspace") {
    const existing = lyricAt(loc.event, verse);
    if (!existing || existing.text.length === 0) return { commands: [] };
    const text = existing.text.slice(0, -1);
    return { commands: [setLyric(loc.event.id, verse, withCarriedExtend(text, existing.syllabic, existing))] };
  }
  if (isPrintableLyricChar(key)) {
    const existing = lyricAt(loc.event, verse);
    const syllabic: Lyric["syllabic"] = existing?.syllabic ?? (chainedFromPrevious(score, loc, verse) ? "end" : "single");
    const text = (existing?.text ?? "") + key.key;
    return { commands: [setLyric(loc.event.id, verse, withCarriedExtend(text, syllabic, existing))] };
  }
  return null;
}

export const handleKey: KeyHandler = (state, key) => {
  const { score, cursor, entry } = state;
  const lower = key.key.length === 1 ? key.key.toLowerCase() : key.key;

  // ⌘L / ⌘⇧L: enter lyric mode (or, already in it, retarget to the current selection /
  // move to the next verse). Checked first, unconditionally, since mod+L is always a
  // shortcut, never literal text — unlike bare "L" below, which only enters lyric mode
  // when we're not already in it.
  if (key.mod && lower === "l") {
    const target = lyricEntryTarget(state);
    if (!target) return null;
    const verse = key.shift ? (entry.lyric?.verse ?? 0) + 1 : (entry.lyric?.verse ?? 0);
    return enterLyricMode(state, target, verse);
  }

  // In lyric mode, every other key is handled (or explicitly swallowed) here so
  // nothing falls through into note entry or another shortcut.
  if (entry.lyric) {
    return handleLyricKey(state, key);
  }

  // "l"/"L" (no mod): enter lyric mode on the selected NoteEvent (or the event before
  // the cursor), verse 0 (docs/ARCHITECTURE.md's Lyrics M3 entry contract).
  if (lower === "l") {
    const target = lyricEntryTarget(state);
    if (!target) return null;
    return enterLyricMode(state, target, 0);
  }

  // Undo / redo
  if (key.mod && lower === "z") {
    return { commands: [], history: key.shift ? "redo" : "undo" };
  }

  // mod+ArrowLeft/Right: previous/next measure at offset 0. Stops (doesn't wrap) at score ends.
  if (key.mod && (key.key === "ArrowLeft" || key.key === "ArrowRight")) {
    const measureCount = score.parts[cursor.partIndex]?.measures.length ?? 0;
    const dir = key.key === "ArrowRight" ? 1 : -1;
    const measureIndex = Math.min(Math.max(cursor.measureIndex + dir, 0), Math.max(measureCount - 1, 0));
    return { commands: [], cursor: { ...cursor, measureIndex, offset: ZERO } };
  }

  // mod+Backspace/Delete: remove the measure under the cursor.
  if (key.mod && (key.key === "Backspace" || key.key === "Delete")) {
    const measureCount = score.parts[cursor.partIndex]?.measures.length ?? 0;
    if (measureCount <= 1) return { commands: [], message: "Cannot remove the only measure" };
    const measureIndex = Math.min(cursor.measureIndex, measureCount - 2);
    return { commands: [removeMeasure(cursor.measureIndex)], cursor: { ...cursor, measureIndex, offset: ZERO } };
  }

  // mod+alt+1..4: set the cursor's voice directly (1-based digit -> 0-based voice index).
  if (key.mod && key.alt && key.key in VOICE_DIGITS) {
    const voiceIndex = VOICE_DIGITS[key.key]!;
    return { commands: [], cursor: { ...cursor, voiceIndex }, message: `Voice ${voiceIndex + 1}` };
  }

  // "v": cycles the cursor's voice 0 <-> 1.
  if (!key.mod && lower === "v") {
    const voiceIndex = cursor.voiceIndex === 0 ? 1 : 0;
    return { commands: [], cursor: { ...cursor, voiceIndex }, message: `Voice ${voiceIndex + 1}` };
  }

  // "h": toggles whether the selected rest(s) are drawn (they still occupy time).
  if (!key.mod && lower === "h") {
    const rests = resolveSelection(score, state.selection).filter((r) => r.event.kind === "rest");
    if (rests.length === 0) return null;
    return { commands: rests.map((r) => toggleRestInvisible(r.event.id)) };
  }

  // mod+digit: wrap the tuplet action's ratio shortcuts (3:2, 5:4, 6:4, 7:4, 2:3, 9:8).
  if (key.mod && !key.alt && key.key in TUPLET_SHORTCUTS) {
    const { actual, normal } = TUPLET_SHORTCUTS[key.key]!;
    return handleAction(state, { kind: "tuplet", actual, normal });
  }

  // "s": slur action.
  if (!key.mod && lower === "s") {
    return handleAction(state, { kind: "slur" });
  }

  // "x": flip stem direction (MuseScore's convention) — fixes OMR/import misreads
  // that pitch editing alone can't touch, since stem direction is otherwise frozen
  // once set (docs/ARCHITECTURE.md's "Flip stem direction").
  if (!key.mod && lower === "x") {
    return handleAction(state, { kind: "flipStem" });
  }

  // "<" / ">" (i.e. shift+"," / shift+"."): crescendo / diminuendo hairpin.
  if (key.key === "<") {
    return handleAction(state, { kind: "hairpin", shape: "cresc" });
  }
  if (key.key === ">") {
    return handleAction(state, { kind: "hairpin", shape: "dim" });
  }

  // Clipboard.
  if (key.mod && lower === "c") {
    if (state.selection.ids.length === 0) return { commands: [], message: "Nothing selected" };
    const clipboard = copySelection(state);
    if (!clipboard) return { commands: [], message: "Cannot copy tuplets yet" };
    return { commands: [], clipboard, message: copiedMessage(clipboard) };
  }
  if (key.mod && lower === "x") {
    if (state.selection.ids.length === 0) return { commands: [], message: "Nothing selected" };
    // A selection of markings only (slurs, hairpins, dynamics, ...) has nothing
    // resolveSelection recognizes as a note/rest, so there's no copy/delete mismatch
    // risk in skipping the clipboard entirely and just deleting — unlike a selection
    // that DOES include notes but can't be copied (inside a tuplet), where copying
    // nothing while still deleting the notes would be a surprising data loss.
    const hasCopyableEvent = resolveSelection(state.score, state.selection).length > 0;
    if (!hasCopyableEvent) {
      const erased = deleteSelection(state, { singleNotes: false });
      return {
        commands: erased.commands,
        selection: { ids: erased.keptIds },
        ...(erased.cursor ? { cursor: erased.cursor } : {}),
        ...(erased.message ? { message: erased.message } : {}),
      };
    }
    const clipboard = copySelection(state);
    if (!clipboard) return { commands: [], message: "Cannot copy tuplets yet" };
    const erased = deleteSelection(state, { singleNotes: false });
    return {
      commands: erased.commands,
      clipboard,
      selection: { ids: erased.keptIds },
      ...(erased.cursor ? { cursor: erased.cursor } : {}),
      ...(erased.message ? { message: erased.message } : {}),
    };
  }
  if (key.mod && lower === "v") {
    const result = pasteAt(state);
    const kr: KeyResult = { commands: result.commands, cursor: result.cursorAfter, selection: { ids: [] } };
    if (result.message) kr.message = result.message;
    return kr;
  }
  if (key.mod && lower === "a") {
    const ids: string[] = [];
    const part = score.parts[cursor.partIndex];
    if (part) {
      for (let staffIndex = 0; staffIndex < part.staves.length; staffIndex++) {
        for (let measureIndex = 0; measureIndex < part.measures.length; measureIndex++) {
          const sm = part.measures[measureIndex]?.staves[staffIndex];
          if (!sm) continue;
          for (const voice of sm.voices) {
            const voiceCursor: Cursor = { partIndex: cursor.partIndex, measureIndex, staffIndex, voiceIndex: voice.index, offset: ZERO };
            for (const pe of eventsInVoice(score, voiceCursor)) ids.push(...idsForEvent(pe.event));
          }
        }
      }
    }
    return { commands: [], selection: { ids } };
  }

  // Enter: insert an empty measure after the cursor's measure. Shift+Enter: before it,
  // keeping the cursor on the same music (which is now one measure later).
  if (key.key === "Enter") {
    if (key.shift) {
      return {
        commands: [addMeasures(1, cursor.measureIndex)],
        cursor: { ...cursor, measureIndex: cursor.measureIndex + 1 },
      };
    }
    return { commands: [addMeasures(1, cursor.measureIndex + 1)] };
  }

  if (lower === "n") {
    return { commands: [], entry: { ...entry, active: !entry.active } };
  }
  if (key.key === "Escape") {
    return { commands: [], entry: { ...entry, active: false }, selection: { ids: [] } };
  }

  // Delete/Backspace with a non-empty selection (any mode): erase every selected event.
  // The entry-mode erase-at-cursor behaviour below only applies when nothing is selected.
  if (!key.mod && (key.key === "Backspace" || key.key === "Delete") && state.selection.ids.length > 0) {
    const erased = deleteSelection(state);
    return {
      commands: erased.commands,
      selection: { ids: erased.keptIds },
      ...(erased.cursor ? { cursor: erased.cursor } : {}),
      ...(erased.message ? { message: erased.message } : {}),
    };
  }

  // With something selected, duration digits / "." change the selected notes/rests
  // (setDuration/toggleDot): longer overwrites what follows, shorter leaves rests. A digit
  // gives the plain value ("." then adds the dot). With note entry on, the digit also
  // becomes the duration for the next note typed. Exception: typing a note auto-selects
  // it, and that selection must not capture the duration keys meant for the NEXT note
  // (8 . C 6 D), so a selection that is only the just-typed note falls through to the
  // entry-duration handling below.
  const durationTargetsSelection = state.selection.ids.length > 0 && !(entry.active && isJustTypedSelection(state));
  if (!key.mod && !key.alt && durationTargetsSelection && key.key in DURATION_DIGITS) {
    const base = DURATION_DIGITS[key.key]!;
    const result = handleAction(state, { kind: "setDuration", base, dots: 0 });
    return entry.active && result ? { ...result, entry: { ...entry, base, dots: 0 } } : result;
  }
  if (!key.mod && !key.alt && durationTargetsSelection && key.key === ".") {
    return handleAction(state, { kind: "toggleDot" });
  }

  if (entry.active && key.key in DURATION_DIGITS) {
    return { commands: [], entry: { ...entry, base: DURATION_DIGITS[key.key]! } };
  }
  if (entry.active && key.key === ".") {
    const dots: EntryState["dots"] = key.alt ? (entry.dots === 2 ? 0 : 2) : entry.dots === 1 ? 0 : 1;
    return { commands: [], entry: { ...entry, dots } };
  }
  if (entry.active && !key.mod && key.key === "0") {
    return enter(state, { kind: "rest" });
  }
  if (entry.active && /^[a-g]$/.test(lower)) {
    const step = lower.toUpperCase() as Step;
    const octave = nearestOctave(step, entry.referenceOctave, entry.referenceStepIndex);
    const alter = letterAlter(state, step);
    if (key.shift) {
      // The chord(s) to add to: the selected notes' chords when anything is selected,
      // else the note just before the cursor (the one just entered).
      const selected = resolveSelection(score, state.selection);
      const targets =
        selected.length > 0
          ? selected.map((r) => ({ event: r.event, measureIndex: r.measureIndex }))
          : resolveSelection(score, { ids: [chordTarget(score, cursor)?.event.id ?? ""] }).map((r) => ({
              event: r.event,
              measureIndex: r.measureIndex,
            }));
      const chords = targets.flatMap((t) => (t.event.kind === "note" ? [{ chord: t.event, measureIndex: t.measureIndex }] : []));
      if (chords.length === 0) {
        return { commands: [], message: selected.length > 0 ? "Select a note (not a rest) to add to" : "No chord to add a note to" };
      }
      // Chords are built upward, as a pianist spells them (G, B, D = root-position G
      // major): the added pitch goes in the lowest octave strictly above each chord's
      // current top note, not in the octave nearest the last entered note.
      const stepIndex = STEPS.indexOf(step);
      return {
        commands: chords.map(({ chord, measureIndex }) => {
          const top = Math.max(...chord.notes.map((n) => diatonic(n.pitch)));
          const chordOctave = Math.floor((top - stepIndex) / 7) + 1;
          // The key signature where the chord is, which may differ from the cursor's measure.
          const chordAlter = entry.alter ?? keyAlter(keySignatureAt(score, measureIndex), step);
          return addNoteToEvent(chord.id, { step, alter: chordAlter, octave: chordOctave });
        }),
        entry: { ...entry, alter: null },
      };
    }
    return enter(state, { kind: "note", pitch: { step, alter, octave } });
  }
  if (entry.active && key.key === "Backspace") {
    const before = eventBeforeCursor(score, cursor);
    if (!before) return { commands: [], message: "Nothing to erase" };
    return { commands: [eraseEvent(before.event.id)], cursor: { ...cursor, offset: before.offset } };
  }
  if (entry.active && key.key === "Delete") {
    const at = eventAtCursor(score, cursor);
    if (!at) return { commands: [], message: "Nothing to erase" };
    return { commands: [eraseEvent(at.event.id)] };
  }

  // Not with mod: ⌘= / ⌘- / ⌘0 are the browser's zoom keys and must reach it.
  if (!key.mod && (key.key === "+" || key.key === "=" || key.key === "-")) {
    const alter: Alter = key.key === "-" ? -1 : 1;
    const targets = selectedNoteIds(state);
    if (targets.length > 0) {
      return { commands: targets.map((id) => setNoteAlter(id, alter)) };
    }
    return { commands: [], entry: { ...entry, alter } };
  }

  if (key.key === "ArrowUp" || key.key === "ArrowDown") {
    const targets = transposeTargets(state);
    if (targets.length === 0) return null;
    const dir: 1 | -1 = key.key === "ArrowUp" ? 1 : -1;
    const by = key.shift ? { octaves: dir } : { semitones: dir };
    return { commands: [transposeNotes(targets, by)] };
  }

  if (lower === "t") {
    const targets = tieTargets(state);
    if (targets.length === 0) return null;
    return { commands: targets.map((id) => toggleTie(id)) };
  }

  if (key.shift && (key.key === "ArrowLeft" || key.key === "ArrowRight")) {
    return extendSelection(state, key.key === "ArrowRight" ? 1 : -1);
  }
  if (key.key === "ArrowLeft" || key.key === "ArrowRight") {
    return moveToEvent(state, key.key === "ArrowRight" ? 1 : -1);
  }

  if (key.key === "Tab") {
    // Cycles through ALL staves of the part (0 -> 1 -> ... -> n-1 -> 0), not just two.
    const staffCount = score.parts[cursor.partIndex]?.staves.length ?? 1;
    const staffIndex = (cursor.staffIndex + 1) % staffCount;
    return { commands: [], cursor: { ...cursor, staffIndex } };
  }

  if (key.key === "Home") {
    return { commands: [], cursor: { ...cursor, offset: ZERO } };
  }
  if (key.key === "End") {
    const events = eventsInVoice(score, cursor);
    const lastOffset = events.length > 0 ? events[events.length - 1]!.offset : ZERO;
    return { commands: [], cursor: { ...cursor, offset: lastOffset } };
  }

  return null;
};
