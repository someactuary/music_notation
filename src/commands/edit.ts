/**
 * Note-entry editing commands: span-replace writes (`writeEvent`), erasing to rests,
 * chord editing, transposition, and appending measures. See docs/ARCHITECTURE.md's
 * "Editor contracts (M1)" section for the exact span-replace semantics implemented
 * here by `writeEvent`.
 */
import type { Draft } from "immer";
import { emptyVoice, newId, rest } from "@/model";
import {
  add,
  eq,
  frac,
  fracToString,
  lt,
  measureLength as timeSigMeasureLength,
  mul,
  notated,
  notatedToFraction,
  NOTE_VALUES,
  sub,
  ZERO,
  type Fraction,
  type NotatedDuration,
  type NoteValue,
  type TimeSignature,
} from "@/model/duration";
import { itemLength, positionedEvents } from "@/model/traverse";
import { comparePitch, pitchEquals, type Alter, type Pitch } from "@/model/pitch";
import type {
  Note,
  NoteEvent,
  RestEvent,
  Score,
  TupletGroup,
  Voice,
  VoiceItem,
} from "@/model/score";
import { addMeasures } from "./basic";
import { locateEvent, locateNote, type Event } from "./locate";
import { captureStemBaseline, reconcileStemAfterPitchChange, type StemBaseline } from "./notation";
import { decomposeDuration, restsFor, restsAt, type RestMeter } from "./rhythm";
import { transposeSemitone } from "./transpose";
import type { Command } from "./types";
import type { Cursor } from "@/input/types";

/** Thrown by `writeEvent` when the write can't be performed. Prefer `canWrite` to check first. */
export class WriteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteRefused";
  }
}

/**
 * The notated length of the measure at `measureIndex`, from the time signature in
 * effect (the most recent `MeasureAttributes.timeSig` at or before this measure) or
 * this measure's own `actualLength` pickup override.
 */
/**
 * The meter rests in `measureIndex` are grouped by (see `restsAt`): its time signature,
 * and, for a short first measure (a pickup), an origin that lines its offsets up with the
 * END of a full bar. Undefined when no time signature is in effect.
 */
function restMeterAt(score: Score, measureIndex: number): RestMeter | undefined {
  let ts: TimeSignature | undefined;
  for (let i = 0; i <= measureIndex; i++) {
    const ma = score.measures[i];
    if (!ma) break;
    if (ma.timeSig) ts = ma.timeSig;
  }
  if (!ts) return undefined;
  const full = timeSigMeasureLength(ts);
  const actual = score.measures[measureIndex]?.actualLength;
  const origin = measureIndex === 0 && actual && lt(actual, full) ? sub(full, actual) : ZERO;
  return { timeSig: ts, origin };
}

export function measureLengthAt(score: Score, measureIndex: number): Fraction {
  let ts: TimeSignature | undefined;
  for (let i = 0; i <= measureIndex; i++) {
    const ma = score.measures[i];
    if (!ma) break;
    if (ma.timeSig) ts = ma.timeSig;
  }
  const actual = score.measures[measureIndex]?.actualLength;
  if (actual) return actual;
  if (!ts) throw new Error(`measureLengthAt: no time signature in effect at measure ${measureIndex}`);
  return timeSigMeasureLength(ts);
}

/** Voice items positioned at the top level only (tuplets are opaque blocks, not descended into). */
function topLevelPositions(items: readonly VoiceItem[]): { item: VoiceItem; offset: Fraction; length: Fraction }[] {
  const out: { item: VoiceItem; offset: Fraction; length: Fraction }[] = [];
  let t = ZERO;
  for (const item of items) {
    const length = itemLength(item);
    out.push({ item, offset: t, length });
    t = add(t, length);
  }
  return out;
}

function isSoleMeasureRest(voice: { items: readonly VoiceItem[] }): boolean {
  const only = voice.items.length === 1 ? voice.items[0] : undefined;
  return !!only && only.kind === "rest" && only.measureRest === true;
}

/**
 * Returns a refusal message if writing an event of length `len` at `cursor` isn't
 * allowed, or `null` if it's fine. Pure; never throws for the conditions it checks
 * (missing cursor targets are still reported as a message, not an exception).
 *
 * A cursor whose offset lies inside an existing tuplet resolves to that tuplet's own
 * grid (see `resolveWriteTarget`): `len` is then checked against the tuplet's own
 * notated capacity rather than the measure, and a write that would spill outside the
 * tuplet is refused ("Does not fit in the tuplet") rather than silently escaping it.
 * A cursor outside any tuplet that would overlap one is still refused as before
 * ("Cannot write into a tuplet yet").
 *
 * A cursor addressing a voice index that doesn't exist yet is not refused on that
 * account: `writeSpan` creates it (a fresh measure-rest voice) on demand, so it's
 * checked here as if it already existed in that shape (i.e. anything that fits the
 * measure is fine).
 */
export function canWrite(score: Score, cursor: Cursor, len: Fraction): string | null {
  const part = score.parts[cursor.partIndex];
  if (!part) return `No part at index ${cursor.partIndex}`;
  const pm = part.measures[cursor.measureIndex];
  if (!pm) return `No measure at index ${cursor.measureIndex}`;
  const sm = pm.staves[cursor.staffIndex];
  if (!sm) return `No staff at index ${cursor.staffIndex}`;

  let measureLen: Fraction;
  try {
    measureLen = measureLengthAt(score, cursor.measureIndex);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const voice = sm.voices.find((v) => v.index === cursor.voiceIndex);
  if (!voice) {
    // Not created yet: behaves exactly like a fresh (sole-measureRest) voice would.
    return lt(measureLen, add(cursor.offset, len))
      ? `Does not fit in the measure: ${fracToString(cursor.offset)} + ${fracToString(len)} exceeds ${fracToString(measureLen)}`
      : null;
  }

  const target = resolveWriteTarget(voice, cursor.offset, measureLen, true);
  return spanRefusal(
    target.owner.items,
    target.capacity,
    target.offset,
    len,
    target.allowSoleMeasureRest,
    target.allowSoleMeasureRest ? "Does not fit in the measure" : "Does not fit in the tuplet",
  );
}

/** Any node holding a `VoiceItem[]`: a `Voice` or a `TupletGroup`. Shared shape for the tuplet-aware span-replace helpers below. */
interface ItemsOwner {
  items: VoiceItem[];
}

/**
 * Resolution of a (voice-relative) offset to the innermost container it actually
 * addresses: the voice itself, or — if the offset lies inside an existing tuplet's
 * span — that tuplet (recursively, for nested tuplets). `offset`/`capacity` are
 * re-expressed in the resolved container's own local notated grid (see
 * docs/ARCHITECTURE.md's "Tuplets" M2 contract: `offset_in_tuplet_notated =
 * (offset - tupletStart) * actual/normal`). `scale` is the cumulative notated->sounding
 * factor from the resolved container back up to the voice (1 at top level), used to
 * convert a write's notated length into the cursor-advancement (sounding) length.
 */
interface WriteTarget {
  owner: ItemsOwner;
  offset: Fraction;
  capacity: Fraction;
  allowSoleMeasureRest: boolean;
  scale: Fraction;
}

function resolveWriteTarget(
  owner: ItemsOwner,
  offset: Fraction,
  capacity: Fraction,
  allowSoleMeasureRest: boolean,
  scale: Fraction = frac(1),
): WriteTarget {
  const items = owner.items;
  const positions =
    allowSoleMeasureRest && isSoleMeasureRest({ items })
      ? [{ item: items[0]!, offset: ZERO, length: capacity }]
      : topLevelPositions(items);

  for (const { item, offset: itemOffset, length } of positions) {
    if (item.kind !== "tuplet") continue;
    const end = add(itemOffset, length);
    if (!lt(offset, itemOffset) && lt(offset, end)) {
      const localOffset = mul(sub(offset, itemOffset), frac(item.ratio.actual, item.ratio.normal));
      const nextScale = mul(scale, frac(item.ratio.normal, item.ratio.actual));
      return resolveWriteTarget(item, localOffset, tupletCapacity(item), false, nextScale);
    }
  }
  return { owner, offset, capacity, allowSoleMeasureRest, scale };
}

/** The total notated length of a tuplet's own items (`actual` copies of `unit`), i.e. its capacity in its own local grid. */
function tupletCapacity(group: TupletGroup): Fraction {
  return mul(frac(group.ratio.actual), notatedToFraction(notated(group.ratio.unit)));
}

/**
 * True if `[spanStart, spanEnd)` overlaps any leaf event nested inside a tuplet that
 * is itself one of `items` (i.e. writing this span from outside would reach into a
 * tuplet). Coordinates are local to `items`. Reuses `positionedEvents` (which already
 * flattens nested tuplets correctly) by wrapping `items` as a throwaway voice.
 */
function overlapsNestedTuplet(items: VoiceItem[], spanStart: Fraction, spanEnd: Fraction): boolean {
  for (const pe of positionedEvents({ id: "scan", index: 0, items })) {
    if (pe.tuplets.length === 0) continue;
    const end = add(pe.offset, pe.length);
    if (lt(pe.offset, spanEnd) && lt(spanStart, end)) return true;
  }
  return false;
}

/** Core refusal check shared by `canWrite` and the duration-changing commands: does `len` fit at `offset` within a container of `capacity`, without reaching into a nested tuplet from outside it? */
function spanRefusal(
  items: VoiceItem[],
  capacity: Fraction,
  offset: Fraction,
  len: Fraction,
  allowSoleMeasureRest: boolean,
  capacityLabel: string,
): string | null {
  const spanEnd = add(offset, len);
  if (lt(capacity, spanEnd)) {
    return `${capacityLabel}: ${fracToString(offset)} + ${fracToString(len)} exceeds ${fracToString(capacity)}`;
  }
  const isSole = allowSoleMeasureRest && isSoleMeasureRest({ items });
  if (!isSole && overlapsNestedTuplet(items, offset, spanEnd)) {
    return "Cannot write into a tuplet yet";
  }
  return null;
}

/** A copy of `event` with a new notated `duration`, keeping the same id, notes (ids, pitches, ties) and every other field. */
function withDuration(event: Event, duration: NotatedDuration): Event {
  if (event.kind === "rest") return { ...event, duration };
  return { ...event, duration, notes: event.notes.map((n) => ({ ...n })) };
}

/** The prefix of `event` (which starts at `start`) before the write span starts, re-expressed to fit `prefixLen`. */
function prefixPieces(event: Event, start: Fraction, prefixLen: Fraction, meter: RestMeter | undefined): VoiceItem[] {
  if (event.kind === "rest") return restsAt(start, prefixLen, meter);
  try {
    const decomposed = decomposeDuration(prefixLen);
    if (decomposed.length === 1) {
      const shortened: NoteEvent = { ...event, duration: decomposed[0]! };
      return [shortened];
    }
  } catch {
    // not representable as a single notated value (or at all) -> fall back to rests
  }
  return restsAt(start, prefixLen, meter);
}

/**
 * Collapses a voice to a single `measureRest` if every item in it is a rest.
 * No-op if it's already that shape. Never touches a voice containing a tuplet.
 */
export function normalizeVoice(voice: { items: VoiceItem[] }): void {
  if (!voice.items.every((i) => i.kind === "rest")) return;
  if (isSoleMeasureRest(voice)) return;
  voice.items = [{ kind: "rest", id: newId(), duration: { base: 1, dots: 0 }, measureRest: true }];
}

/**
 * Writes `event` at `cursor`, implementing the span-replace semantics from
 * docs/ARCHITECTURE.md: in the addressed voice, the span [offset, offset+len) is
 * replaced. Events wholly inside the span are dropped; an event straddling the
 * start is shortened to its prefix (kept as the same note if the shortened prefix
 * is a single notated value, otherwise re-expressed as rests); an event straddling
 * the end has its remainder re-expressed as rests. Throws `WriteRefused` if the
 * write doesn't fit the measure or would touch a tuplet.
 */
export function writeEvent(cursor: Cursor, event: NoteEvent | RestEvent): Command {
  return {
    label: event.kind === "rest" ? "Write rest" : "Write note",
    apply(draft) {
      const len = notatedToFraction(event.duration);
      const refusal = canWrite(draft, cursor, len);
      if (refusal) throw new WriteRefused(refusal);
      writeSpan(draft, cursor, len, [{ ...event }]);
    },
  };
}

/**
 * Core span-replace within one container's items (a voice's top-level items, or a
 * tuplet's own items when the write resolved inside it): replaces [spanStart,
 * spanStart + spanLen) with `newItems`. Shared by `writeSpan` and the
 * duration-changing commands (`setDurationAt`/`toggleDotAt`). Callers are
 * responsible for checking `spanRefusal`/`canWrite` first (this never refuses).
 */
function spanReplace(
  items: VoiceItem[],
  spanStart: Fraction,
  spanLen: Fraction,
  newItems: VoiceItem[],
  allowSoleMeasureRest: boolean,
  capacity: Fraction,
  /** How to group the rests this creates; undefined inside a tuplet (its own grid). */
  meter: RestMeter | undefined,
): VoiceItem[] {
  const spanEnd = add(spanStart, spanLen);
  const positions =
    allowSoleMeasureRest && isSoleMeasureRest({ items })
      ? [{ item: items[0]!, offset: ZERO, length: capacity }]
      : topLevelPositions(items);

  const out: VoiceItem[] = [];
  let insertedNew = false;
  for (const { item, offset, length } of positions) {
    const end = add(offset, length);
    const overlaps = lt(offset, spanEnd) && lt(spanStart, end);
    if (!overlaps) {
      out.push(item);
      continue;
    }
    // Guarded by canWrite/spanRefusal (called by every caller before this): an
    // overlapping item here is never a tuplet.
    const ev = item as Event;
    if (lt(offset, spanStart)) {
      out.push(...prefixPieces(ev, offset, sub(spanStart, offset), meter));
    }
    if (!insertedNew) {
      out.push(...newItems);
      insertedNew = true;
    }
    if (lt(spanEnd, end)) {
      out.push(...restsAt(spanEnd, sub(end, spanEnd), meter));
    }
  }
  if (!insertedNew) out.push(...newItems);
  return out;
}

/**
 * Writes `newItems` at `cursor` in the voice it addresses, resolving into an
 * enclosing tuplet's own grid first if the cursor's offset lies inside one (see
 * `resolveWriteTarget`). If the voice doesn't exist yet, creates it (index
 * `cursor.voiceIndex`, filled with a measureRest, per docs/ARCHITECTURE.md's Voices
 * M2 contract) and keeps `sm.voices` sorted by index. Shared by `writeEvent` (single
 * item) and `writeSequence` (one call per measure-bounded chunk of a split event).
 * Callers are responsible for checking `canWrite` first (this never refuses).
 */
function writeSpan(draft: Draft<Score>, cursor: Cursor, spanLen: Fraction, newItems: VoiceItem[]): void {
  const part = draft.parts[cursor.partIndex]!;
  const pm = part.measures[cursor.measureIndex]!;
  const sm = pm.staves[cursor.staffIndex]!;
  let voice = sm.voices.find((v) => v.index === cursor.voiceIndex);
  if (!voice) {
    voice = emptyVoice(cursor.voiceIndex);
    sm.voices.push(voice);
    sm.voices.sort((a, b) => a.index - b.index);
  }
  const measureLen = measureLengthAt(draft, cursor.measureIndex);

  const target = resolveWriteTarget(voice, cursor.offset, measureLen, true);
  const meter = target.allowSoleMeasureRest ? restMeterAt(draft, cursor.measureIndex) : undefined;
  const out = spanReplace(target.owner.items, target.offset, spanLen, newItems, target.allowSoleMeasureRest, target.capacity, meter);
  target.owner.items = out;
  if (target.allowSoleMeasureRest) normalizeVoice(voice);
}

/**
 * The sounding length a write of `notatedLen` at `cursor` would actually advance the
 * cursor by: `notatedLen` unchanged at top level, or scaled down by the enclosing
 * tuplet ratios if `cursor.offset` lies inside one (see `resolveWriteTarget`'s
 * `scale`). Used by step-entry so cursor advancement inside a tuplet matches the
 * tuplet's own sounding rate rather than the notated one.
 */
export function soundingLengthAt(score: Score, cursor: Cursor, notatedLen: Fraction): Fraction {
  const voice = score.parts[cursor.partIndex]?.measures[cursor.measureIndex]?.staves[cursor.staffIndex]?.voices.find(
    (v) => v.index === cursor.voiceIndex,
  );
  if (!voice) return notatedLen;
  let measureLen: Fraction;
  try {
    measureLen = measureLengthAt(score, cursor.measureIndex);
  } catch {
    return notatedLen;
  }
  const target = resolveWriteTarget(voice, cursor.offset, measureLen, true);
  return mul(notatedLen, target.scale);
}

/** Ensures the score has at least `measureIndex + 1` measures, appending empty ones (same logic as `addMeasures`, so the final barline follows) as needed. */
function ensureMeasureExists(draft: Draft<Score>, measureIndex: number): void {
  while (draft.measures.length <= measureIndex) {
    addMeasures(1).apply(draft);
  }
}

/** One piece of a (possibly split) note or rest: which measure/offset it lands at, and its notated length. */
interface WriteSlot {
  measureIndex: number;
  offset: Fraction;
  duration: NotatedDuration;
}

/** A copy of `base` (a rest) re-expressed with `duration`, given a fresh id unless `keepId`. Never a measure-rest. */
function pieceForRest(base: RestEvent, duration: NotatedDuration, keepId: boolean): RestEvent {
  const piece: RestEvent = { ...base, id: keepId ? base.id : newId(), duration };
  delete piece.measureRest;
  if (!keepId) delete piece.grace;
  return piece;
}

/** A copy of `base` (a note/chord) re-expressed with `duration`, same pitches, given fresh ids unless `keepId`. `forceTie` sets tieStart on every note regardless of the original (used for every piece but the last of a split). */
function pieceForNote(base: NoteEvent, duration: NotatedDuration, keepId: boolean, forceTie: boolean): NoteEvent {
  const notes: Note[] = base.notes.map((n) => {
    const note: Note = { ...n, id: keepId ? n.id : newId() };
    if (forceTie) note.tieStart = true;
    return note;
  });
  const piece: NoteEvent = { ...base, id: keepId ? base.id : newId(), duration, notes };
  if (!keepId) delete piece.grace;
  return piece;
}

/**
 * Writes `events` back to back starting at `cursor`, splitting any event that doesn't
 * fit in the remaining part of its measure: the fitting part is written and the
 * remainder continues into the next measure (and the next, as many times as needed).
 * A split note is re-expressed as several notated pieces (via `decomposeDuration`),
 * tied together (`tieStart` on every piece but the last; same pitches; fresh ids on
 * every piece but the first). A split rest is just split into plain rests. Measures
 * are appended as needed (see `ensureMeasureExists`), so this never refuses on
 * overflow — only (like `writeEvent`) if the span would touch an existing tuplet.
 */
export function writeSequence(cursor: Cursor, events: readonly (NoteEvent | RestEvent)[]): Command {
  return {
    label: "Write sequence",
    apply(draft) {
      let measureIndex = cursor.measureIndex;
      let offset = cursor.offset;

      for (const event of events) {
        let remaining = notatedToFraction(event.duration);
        const chunks: { measureIndex: number; offset: Fraction; len: Fraction }[] = [];

        while (!eq(remaining, ZERO)) {
          ensureMeasureExists(draft, measureIndex);
          const measureLen = measureLengthAt(draft, measureIndex);
          const available = sub(measureLen, offset);
          const chunkLen = lt(available, remaining) ? available : remaining;
          chunks.push({ measureIndex, offset, len: chunkLen });
          remaining = sub(remaining, chunkLen);
          offset = add(offset, chunkLen);
          if (eq(offset, measureLen)) {
            measureIndex += 1;
            offset = ZERO;
          }
        }

        const slots: WriteSlot[] = [];
        for (const chunk of chunks) {
          let pieceOffset = chunk.offset;
          for (const duration of decomposeDuration(chunk.len)) {
            slots.push({ measureIndex: chunk.measureIndex, offset: pieceOffset, duration });
            pieceOffset = add(pieceOffset, notatedToFraction(duration));
          }
        }

        slots.forEach((slot, i) => {
          const isFirst = i === 0;
          const isLast = i === slots.length - 1;
          const piece: NoteEvent | RestEvent =
            event.kind === "rest"
              ? pieceForRest(event, slot.duration, isFirst)
              : pieceForNote(event, slot.duration, isFirst, !isLast);

          const slotCursor: Cursor = { ...cursor, measureIndex: slot.measureIndex, offset: slot.offset };
          const slotLen = notatedToFraction(slot.duration);
          const refusal = canWrite(draft, slotCursor, slotLen);
          if (refusal) throw new WriteRefused(refusal);
          writeSpan(draft, slotCursor, slotLen, [piece]);
        });
      }
    },
  };
}

/** Total length of writing `events` back to back. Pure. */
export function sequenceLength(events: readonly (NoteEvent | RestEvent)[]): Fraction {
  return events.reduce((acc, e) => add(acc, notatedToFraction(e.duration)), ZERO);
}

/**
 * True if `writeSequence(cursor, events)` would not need to touch any existing tuplet
 * along the way (measures it would still need to append never contain tuplets, so
 * those always "fit"). Pure; does not check whether measures would need appending.
 */
export function sequenceFits(score: Score, cursor: Cursor, events: readonly (NoteEvent | RestEvent)[]): boolean {
  let measureIndex = cursor.measureIndex;
  let offset = cursor.offset;
  let remaining = sequenceLength(events);

  while (!eq(remaining, ZERO)) {
    const measureCount = score.parts[cursor.partIndex]?.measures.length ?? 0;
    if (measureIndex >= measureCount) return true; // beyond existing measures: would be appended, never a tuplet
    let measureLen: Fraction;
    try {
      measureLen = measureLengthAt(score, measureIndex);
    } catch {
      return true;
    }
    const available = sub(measureLen, offset);
    const chunkLen = lt(available, remaining) ? available : remaining;
    if (canWrite(score, { ...cursor, measureIndex, offset }, chunkLen)) return false;
    remaining = sub(remaining, chunkLen);
    offset = add(offset, chunkLen);
    if (eq(offset, measureLen)) {
      measureIndex += 1;
      offset = ZERO;
    }
  }
  return true;
}

/** Replaces the event with id `eventId` with rests of the same length, then normalizes the voice. */
export function eraseEvent(eventId: string): Command {
  return {
    label: "Erase event",
    apply(draft) {
      const hit = locateEvent(draft, eventId);
      if (!hit) throw new Error(`eraseEvent: no event with id "${eventId}"`);
      const len = notatedToFraction(hit.event.duration);
      // At top level the rests are grouped by the meter from where the note stood.
      const start = hit.tuplets.length === 0 ? topLevelPositions(hit.items)[hit.index]?.offset : undefined;
      const rests = start ? restsAt(start, len, restMeterAt(draft, hit.measureIndex)) : restsFor(len);
      hit.items.splice(hit.index, 1, ...rests);
      normalizeVoice(hit.voice);
    },
  };
}

/** Adds `pitch` to the chord at `eventId`, keeping notes sorted ascending by pitch. No-op if the pitch is already present. */
export function addNoteToEvent(eventId: string, pitch: Pitch): Command {
  return {
    label: "Add note",
    apply(draft) {
      const hit = locateEvent(draft, eventId);
      if (!hit) throw new Error(`addNoteToEvent: no event with id "${eventId}"`);
      if (hit.event.kind !== "note") throw new Error(`addNoteToEvent: event "${eventId}" is not a note event`);
      if (hit.event.notes.some((n) => pitchEquals(n.pitch, pitch))) return;
      const newNote: Note = { id: newId(), pitch };
      hit.event.notes.push(newNote);
      hit.event.notes.sort((a, b) => comparePitch(a.pitch, b.pitch));
    },
  };
}

/** Removes note `noteId` from event `eventId`. If it was the last note in the chord, the event is erased to rests. */
export function removeNoteFromEvent(eventId: string, noteId: string): Command {
  return {
    label: "Remove note",
    apply(draft) {
      const hit = locateEvent(draft, eventId);
      if (!hit) throw new Error(`removeNoteFromEvent: no event with id "${eventId}"`);
      if (hit.event.kind !== "note") throw new Error(`removeNoteFromEvent: event "${eventId}" is not a note event`);
      const idx = hit.event.notes.findIndex((n) => n.id === noteId);
      if (idx === -1) throw new Error(`removeNoteFromEvent: no note with id "${noteId}" on event "${eventId}"`);
      if (hit.event.notes.length === 1) {
        eraseEvent(eventId).apply(draft);
        return;
      }
      hit.event.notes.splice(idx, 1);
    },
  };
}

/** Changes the alteration of note `noteId`, keeping its chord sorted (alter affects sounding pitch order). */
export function setNoteAlter(noteId: string, alter: Alter): Command {
  return {
    label: "Set note alter",
    apply(draft) {
      const hit = locateNote(draft, noteId);
      if (!hit) throw new Error(`setNoteAlter: no note with id "${noteId}"`);
      hit.note.pitch = { ...hit.note.pitch, alter };
      hit.notes.sort((a, b) => comparePitch(a.pitch, b.pitch));
    },
  };
}

/** Transposes the given notes by a fixed number of semitones or octaves. */
/**
 * Transposes every note in `noteIds` by `by`. For each touched event, if its stem
 * direction was tracking convention before the move, and the move changes what
 * convention would pick, flips the stem to match — the same rule `setNotePitch` uses
 * for mouse-dragged pitch changes (docs/ARCHITECTURE.md's "Flip stem direction on
 * pitch change"), applied here too since these arrow-key moves go through this
 * command instead. Baselines are captured once per event, before any of its notes'
 * pitches change (a chord can have more than one of its notes in `noteIds`), and
 * reconciled once per event after every pitch (and the chord re-sort below) is done —
 * so transposing an entire selected section is still one baseline/reconcile pass per
 * event touched, not per note.
 */
export function transposeNotes(noteIds: readonly string[], by: { semitones: number } | { octaves: number }): Command {
  return {
    label: "Transpose notes",
    apply(draft) {
      const touchedEventIds = new Set<string>();
      const stemBaselines = new Map<string, StemBaseline | undefined>();
      for (const noteId of noteIds) {
        const hit = locateNote(draft, noteId);
        if (!hit) continue;
        if (!touchedEventIds.has(hit.event.id)) {
          stemBaselines.set(hit.event.id, captureStemBaseline(draft, hit.event.id));
        }
        touchedEventIds.add(hit.event.id);
        if ("octaves" in by) {
          hit.note.pitch = { ...hit.note.pitch, octave: hit.note.pitch.octave + by.octaves };
          continue;
        }
        const dir: 1 | -1 = by.semitones >= 0 ? 1 : -1;
        let pitch = hit.note.pitch;
        for (let i = 0; i < Math.abs(by.semitones); i++) pitch = transposeSemitone(pitch, dir);
        hit.note.pitch = pitch;
      }
      // Re-sort every touched chord: alter/octave changes can change sounding order.
      for (const eventId of touchedEventIds) {
        const hit = locateEvent(draft, eventId);
        if (hit && hit.event.kind === "note") hit.event.notes.sort((a, b) => comparePitch(a.pitch, b.pitch));
      }
      for (const eventId of touchedEventIds) {
        reconcileStemAfterPitchChange(draft, eventId, stemBaselines.get(eventId));
      }
    },
  };
}

/** Appends one empty measure to the end of the score. */
export function appendMeasure(): Command {
  return addMeasures(1);
}

// ---------------------------------------------------------------------------
// Duration changes on existing events, and tuplets.
// ---------------------------------------------------------------------------

/** Shared body of `setDurationAt`/`toggleDotAt`: span-replace the event at `eventId` in place, keeping its id/notes/ties, using the same rules as `writeEvent` (a longer duration overwrites following time, a shorter one fills with rests), refusing across a barline or into a tuplet from outside. Works whether the event is at the top level of a voice or inside a tuplet (using the tuplet's own notated capacity as the boundary instead of the measure's). */
function applyDurationChange(draft: Draft<Score>, eventId: string, duration: NotatedDuration): void {
  const hit = locateEvent(draft, eventId);
  if (!hit) throw new Error(`setDurationAt: no event with id "${eventId}"`);

  const positions = topLevelPositions(hit.items);
  const at = positions[hit.index];
  if (!at) throw new Error(`setDurationAt: internal error locating event "${eventId}"`);

  const spanStart = at.offset;
  const newLen = notatedToFraction(duration);
  const allowSoleMeasureRest = hit.tuplets.length === 0;
  const capacity = allowSoleMeasureRest
    ? measureLengthAt(draft, hit.measureIndex)
    : tupletCapacity(hit.tuplets[hit.tuplets.length - 1]!);

  const refusal = spanRefusal(
    hit.items,
    capacity,
    spanStart,
    newLen,
    allowSoleMeasureRest,
    allowSoleMeasureRest ? "Does not fit in the measure" : "Does not fit in the tuplet",
  );
  if (refusal) throw new WriteRefused(refusal);

  const updated = withDuration(hit.event, duration);
  const meter = allowSoleMeasureRest ? restMeterAt(draft, hit.measureIndex) : undefined;
  const out = spanReplace(hit.items, spanStart, newLen, [updated], allowSoleMeasureRest, capacity, meter);
  if (allowSoleMeasureRest) {
    hit.voice.items = out;
    normalizeVoice(hit.voice);
  } else {
    hit.tuplets[hit.tuplets.length - 1]!.items = out;
  }
}

/**
 * Changes the notated duration of the event with id `eventId`, replacing it in place
 * (same id, notes, ties) using the span-replace rules from docs/ARCHITECTURE.md: a
 * longer duration overwrites following time (trimmed to rests at the far end), a
 * shorter one leaves the freed time as rests. Throws `WriteRefused` if the new span
 * would cross the barline, or reach into a tuplet from outside it (or, for an event
 * that itself lives inside a tuplet, past that tuplet's own notated end).
 */
export function setDurationAt(eventId: string, duration: NotatedDuration): Command {
  return {
    label: "Set duration",
    apply(draft) {
      applyDurationChange(draft, eventId, duration);
    },
  };
}

/** Toggles the augmentation dots on the event with id `eventId`: 0 -> 1 -> 0; an existing double/triple dot also collapses straight to 0. Same span-replace/refusal rules as `setDurationAt`. */
export function toggleDotAt(eventId: string): Command {
  return {
    label: "Toggle dot",
    apply(draft) {
      const hit = locateEvent(draft, eventId);
      if (!hit) throw new Error(`toggleDotAt: no event with id "${eventId}"`);
      const dots: NotatedDuration["dots"] = hit.event.duration.dots === 0 ? 1 : 0;
      applyDurationChange(draft, eventId, { base: hit.event.duration.base, dots });
    },
  };
}

/** Toggles whether the rest with id `eventId` is drawn (still occupies time either way). Used by the "h" key on the current selection. */
export function toggleRestInvisible(eventId: string): Command {
  return {
    label: "Toggle rest visibility",
    apply(draft) {
      const hit = locateEvent(draft, eventId);
      if (!hit) throw new Error(`toggleRestInvisible: no event with id "${eventId}"`);
      if (hit.event.kind !== "rest") throw new Error(`toggleRestInvisible: event "${eventId}" is not a rest`);
      hit.event.invisible = !hit.event.invisible;
    },
  };
}

interface LocatedTuplet {
  group: TupletGroup;
  /** The array directly holding `group` — a voice's top-level items, or an enclosing TupletGroup's items (for a nested tuplet). */
  items: VoiceItem[];
  index: number;
  voice: Voice;
  measureIndex: number;
}

function findTupletInItems(items: VoiceItem[], id: string): { items: VoiceItem[]; index: number; group: TupletGroup } | undefined {
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind !== "tuplet") continue;
    if (item.id === id) return { items, index, group: item };
    const nested = findTupletInItems(item.items, id);
    if (nested) return nested;
  }
  return undefined;
}

/** Finds a TupletGroup by id anywhere in the score, including nested inside another tuplet. */
function locateTuplet(score: Draft<Score>, id: string): LocatedTuplet | undefined {
  for (const part of score.parts) {
    for (let measureIndex = 0; measureIndex < part.measures.length; measureIndex++) {
      const pm = part.measures[measureIndex]!;
      for (const sm of pm.staves) {
        for (const voice of sm.voices) {
          const hit = findTupletInItems(voice.items, id);
          if (hit) return { ...hit, voice, measureIndex };
        }
      }
    }
  }
  return undefined;
}

/**
 * Turns the event with id `eventId` (of notated duration `d`, no dots) into a
 * `TupletGroup` of `actual` notes in the time of `normal`, per docs/ARCHITECTURE.md:
 * unit = d / normal (e.g. quarter / 2 = eighth, for a 3:2 triplet), containing the
 * original event (same id/notes/ties, shortened to `unit`) first, then `actual - 1`
 * rests of `unit`. The group occupies exactly the same sounding span the original
 * event did, so this never touches surrounding events. Refuses (`WriteRefused`) if
 * `d` has dots, or `d / normal` isn't a plain note value (e.g. a quarter can't make a
 * 5:4 tuplet: quarter/4 = sixteenth * ... doesn't land on a single note value only
 * when base*normal isn't itself a supported note value).
 */
export function makeTuplet(eventId: string, actual: number, normal: number): Command {
  return {
    label: "Make tuplet",
    apply(draft) {
      const hit = locateEvent(draft, eventId);
      if (!hit) throw new Error(`makeTuplet: no event with id "${eventId}"`);
      const d = hit.event.duration;
      if (d.dots !== 0) {
        throw new WriteRefused("Cannot make a tuplet from a dotted duration");
      }
      const unitDen = d.base * normal;
      if (!(NOTE_VALUES as readonly number[]).includes(unitDen)) {
        throw new WriteRefused(`A ${actual}:${normal} tuplet doesn't divide this duration into a plain note value`);
      }
      const unit = unitDen as NoteValue;

      const original = withDuration(hit.event, notated(unit, 0));
      const fillers: RestEvent[] = Array.from({ length: Math.max(0, actual - 1) }, () => rest(unit, 0));
      const group: TupletGroup = {
        kind: "tuplet",
        id: newId(),
        ratio: { actual, normal, unit },
        items: [original, ...fillers],
      };
      hit.items.splice(hit.index, 1, group);
    },
  };
}

/**
 * Replaces the tuplet group with id `tupletId` by its first item stretched to the
 * group's total notated (sounding, at the level containing it) length, if that
 * length is representable as a single notated value; otherwise by rests of that
 * length. (A first item that is itself a nested tuplet can't be "stretched" as a
 * single event, so that case always falls back to rests.)
 */
export function removeTuplet(tupletId: string): Command {
  return {
    label: "Remove tuplet",
    apply(draft) {
      const hit = locateTuplet(draft, tupletId);
      if (!hit) throw new Error(`removeTuplet: no tuplet with id "${tupletId}"`);

      const totalLen = itemLength(hit.group);
      const first = hit.group.items[0];

      let replacement: VoiceItem[];
      if (first && first.kind !== "tuplet") {
        try {
          const decomposed = decomposeDuration(totalLen);
          replacement = decomposed.length === 1 ? [withDuration(first, decomposed[0]!)] : restsFor(totalLen);
        } catch {
          replacement = restsFor(totalLen);
        }
      } else {
        replacement = restsFor(totalLen);
      }

      hit.items.splice(hit.index, 1, ...replacement);
      if (hit.items === hit.voice.items) normalizeVoice(hit.voice);
    },
  };
}
