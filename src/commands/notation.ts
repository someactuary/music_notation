/**
 * Attachment and spanner commands (docs/ARCHITECTURE.md's "Attachments and spanners"
 * M2 contract): adding/removing them, toggling an articulation across a set of
 * events, setting a note's fingering, and helpers to build an `Anchor` (plus the
 * part/staff it lives on) from an event id — used by src/input/actions.ts to turn a
 * selection into a notation object without re-walking the score itself.
 */
import type { Draft } from "immer";
import { clefAt, positionedEvents, ZERO } from "@/model";
import type { Anchor, Articulation, Attachment, Fraction, Id, Note, NoteEvent, Score, Spanner, StemDirection, Voice } from "@/model";
import { staffStep } from "@/engraving/geometry";
import { stemDirectionForSteps, voiceStemDirection } from "@/engraving/semantic";
import { locateEvent, locateNote } from "./locate";
import type { Command } from "./types";

/** An `{kind:"event"}` anchor for `eventId`. Does not check that the event exists. */
export function eventAnchor(eventId: Id): Anchor {
  return { kind: "event", eventId };
}

export interface EventLocation {
  anchor: Anchor;
  partIndex: number;
  /** The staff the anchor should render on: the event's `staff` cross-staff override if set, else the staff it's actually stored on. */
  staffIndex: number;
}

/** Locates `eventId` in `score` and returns an event anchor for it plus its part/staff index, or `undefined` if the event doesn't exist. */
export function locateEventAnchor(score: Score, eventId: Id): EventLocation | undefined {
  const hit = locateEvent(score, eventId);
  if (!hit) return undefined;
  return { anchor: eventAnchor(eventId), partIndex: hit.partIndex, staffIndex: hit.event.staff ?? hit.staffIndex };
}

/**
 * Sets each event's beam override: "begin" starts a new beam at it, "continue" joins it to
 * the beam before it, "end" closes the beam after it, "none" gives it its own flag, and
 * "auto" removes the override (automatic grouping by beat). Rests and missing ids are skipped.
 */
export function setBeamModes(changes: { eventId: Id; beam: NonNullable<NoteEvent["beam"]> }[]): Command {
  return {
    label: "Set beaming",
    apply(draft) {
      for (const { eventId, beam } of changes) {
        const hit = locateEvent(draft, eventId);
        if (!hit || hit.event.kind !== "note") continue;
        if (beam === "auto") delete hit.event.beam;
        else hit.event.beam = beam;
      }
    },
  };
}

/** Adds `att` to the score. Callers are responsible for giving it a fresh id. */
export function addAttachment(att: Attachment): Command {
  return {
    label: "Add attachment",
    apply(draft) {
      draft.attachments.push(att);
    },
  };
}

/** Removes the attachment with id `id`, if any (no-op otherwise). */
export function removeAttachment(id: Id): Command {
  return {
    label: "Remove attachment",
    apply(draft) {
      draft.attachments = draft.attachments.filter((a) => a.id !== id);
    },
  };
}

/** Adds `sp` to the score. Callers are responsible for giving it a fresh id. */
export function addSpanner(sp: Spanner): Command {
  return {
    label: "Add spanner",
    apply(draft) {
      draft.spanners.push(sp);
    },
  };
}

/** Removes the spanner with id `id`, if any (no-op otherwise). */
export function removeSpanner(id: Id): Command {
  return {
    label: "Remove spanner",
    apply(draft) {
      draft.spanners = draft.spanners.filter((s) => s.id !== id);
    },
  };
}

/**
 * Toggles `articulation` on every id in `eventIds` that resolves to a `NoteEvent`
 * (ids that resolve to a rest, or don't resolve at all, are ignored): adds it to
 * every one that lacks it if ANY of them lacks it, otherwise (all already have it)
 * removes it from all of them.
 */
/**
 * Clears every note-level decoration on event `eventId` that has no id of its own
 * (articulations, ornaments, arpeggio, tremolo — see docs/ARCHITECTURE.md's
 * "Selectable markings": these share the event's id, unlike a fermata or a spanner,
 * so there's nothing more specific to remove them by). A no-op on a rest, or on a
 * note event that carries none of these. Ties are handled separately (`toggleTie`
 * operates per note, not per event) — see `deleteSelection` in step-entry.ts, which
 * uses both together so pressing Delete on a decorated note strips its decorations
 * before it ever erases the note itself.
 */
export function clearEventDecorations(eventId: Id): Command {
  return {
    label: "Clear note decorations",
    apply(draft) {
      const hit = locateEvent(draft, eventId);
      if (!hit || hit.event.kind !== "note") return;
      delete hit.event.articulations;
      delete hit.event.ornaments;
      delete hit.event.arpeggio;
      delete hit.event.tremolo;
    },
  };
}

export function toggleArticulation(eventIds: readonly Id[], articulation: Articulation): Command {
  return {
    label: "Toggle articulation",
    apply(draft) {
      const hits = eventIds
        .map((id) => locateEvent(draft, id))
        .filter((h) => h !== undefined && h.event.kind === "note");
      if (hits.length === 0) return;
      const allHave = hits.every((h) => h!.event.kind === "note" && (h!.event.articulations ?? []).includes(articulation));
      for (const h of hits) {
        if (h!.event.kind !== "note") continue;
        const current = h!.event.articulations ?? [];
        h!.event.articulations = allHave
          ? current.filter((a) => a !== articulation)
          : current.includes(articulation)
            ? current
            : [...current, articulation];
      }
    },
  };
}

/** Measure-relative offset of `eventId` in `voice` (0 if it isn't a top-level or tuplet event, e.g. a grace note). */
function eventOffsetInVoice(voice: Voice, eventId: Id): Fraction {
  return positionedEvents(voice).find((pe) => pe.event.id === eventId)?.offset ?? ZERO;
}

/**
 * The stem direction a note event at this position would take with no explicit
 * override: the multi-voice convention (`voiceStemDirection`) when its staff carries
 * more than one voice, else the ordinary farthest-from-the-middle-line rule
 * (`stemDirectionForSteps`). Deliberately does not consider beaming — see
 * `reconcileStemAfterPitchChange`'s doc comment for why that's an accepted gap here.
 */
function naturalStemDirection(
  score: Score,
  notes: readonly Note[],
  partIndex: number,
  staffIndex: number,
  measureIndex: number,
  voiceIndex: number,
  offset: Fraction,
): StemDirection {
  const sm = score.parts[partIndex]?.measures[measureIndex]?.staves[staffIndex];
  if ((sm?.voices.length ?? 1) > 1) return voiceStemDirection(voiceIndex);
  // The clef in force at the note itself: a clef change earlier in the measure counts.
  const clef = clefAt(score, partIndex, staffIndex, measureIndex, offset);
  return stemDirectionForSteps(notes.map((n) => staffStep(n.pitch, clef)));
}

/** What `captureStemBaseline` needs `reconcileStemAfterPitchChange` to remember about an event, taken before its pitch(es) change. */
export interface StemBaseline {
  natural: StemDirection;
}

/**
 * Call before changing any of `eventId`'s notes' pitches, when the event carries an
 * explicit `stem` override that currently matches what convention would pick anyway
 * (see `reconcileStemAfterPitchChange` for why only that case matters). Returns
 * `undefined` when there's nothing to reconcile — not a note, or no explicit stem to
 * begin with — which also means callers skip the (mildly costly, clef-walking) work
 * below for the common case of a plain, never-overridden note.
 */
export function captureStemBaseline(score: Score, eventId: Id): StemBaseline | undefined {
  const hit = locateEvent(score, eventId);
  if (!hit || hit.event.kind !== "note" || hit.event.stem === undefined) return undefined;
  const staffIndex = hit.event.staff ?? hit.staffIndex;
  const offset = eventOffsetInVoice(hit.voice, eventId);
  const natural = naturalStemDirection(score, hit.event.notes, hit.partIndex, staffIndex, hit.measureIndex, hit.voiceIndex, offset);
  if (hit.event.stem !== natural) return undefined; // deliberately set against convention: never auto-touch it
  return { natural };
}

/**
 * Call after changing `eventId`'s notes' pitches (docs/ARCHITECTURE.md's "Flip stem
 * direction on pitch change"): if `baseline` says the event's stem was tracking
 * convention before the edit, and convention would now pick a different direction for
 * its new pitch(es), updates `event.stem` to match — "the stem points down instead of
 * up because I moved the note" is exactly this case. A `stem` that was already
 * deliberately set against convention (via `toggleStemDirection`, or hand-tuned after
 * import) is left alone regardless of the new pitch, so an unrelated nudge doesn't
 * quietly discard that choice. Ignores beaming, same as `naturalStemDirection`: fixing
 * one member of a beamed run this way only visibly changes the group's shared
 * direction when that member happens to be the one the beam takes its direction from
 * (`buildBeamGroups` uses the first member with an explicit `stem`) — select the whole
 * run to move it reliably, same caveat as the manual flip above.
 */
export function reconcileStemAfterPitchChange(draft: Draft<Score>, eventId: Id, baseline: StemBaseline | undefined): void {
  if (!baseline) return;
  const hit = locateEvent(draft, eventId);
  if (!hit || hit.event.kind !== "note") return;
  const staffIndex = hit.event.staff ?? hit.staffIndex;
  const offset = eventOffsetInVoice(hit.voice, eventId);
  const newNatural = naturalStemDirection(draft, hit.event.notes, hit.partIndex, staffIndex, hit.measureIndex, hit.voiceIndex, offset);
  if (newNatural !== baseline.natural) hit.event.stem = newNatural;
}

/**
 * Flips the stem direction of every note event in `eventIds`, explicitly overriding
 * `NoteEvent.stem` (docs/ARCHITECTURE.md's "Flip stem direction"): if every one is
 * already "up", sets them all to "down"; otherwise (any "down", or no override at
 * all) sets them all to "up". Converging the whole selection on one direction
 * (rather than flipping each independently) means selecting an entire beamed run and
 * flipping it actually moves the beam's shared direction, which is decided by its
 * first member with an explicit `stem` (src/engraving/semantic.ts's
 * `buildBeamGroups`) — flipping just one member in the middle of a group a beam
 * ignores would otherwise look like nothing happened.
 */
export function toggleStemDirection(eventIds: readonly Id[]): Command {
  return {
    label: "Flip stem direction",
    apply(draft) {
      const hits = eventIds
        .map((id) => locateEvent(draft, id))
        .filter((h): h is NonNullable<typeof h> => h !== undefined && h.event.kind === "note");
      if (hits.length === 0) return;
      const allUp = hits.every((h) => h.event.kind === "note" && h.event.stem === "up");
      for (const h of hits) {
        if (h.event.kind === "note") h.event.stem = allUp ? "down" : "up";
      }
    },
  };
}

/** Sets the fingering digit on note `noteId`, or clears it when `text` is `null`. */
export function setFingering(noteId: Id, text: string | null): Command {
  return {
    label: "Set fingering",
    apply(draft) {
      const hit = locateNote(draft, noteId);
      if (!hit) throw new Error(`setFingering: no note with id "${noteId}"`);
      if (text === null) delete hit.note.fingering;
      else hit.note.fingering = text;
    },
  };
}
