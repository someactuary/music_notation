/**
 * The palette's Beam toggle (docs/ARCHITECTURE.md "Beam toggle"). One button whose state
 * follows the selection:
 *  - one note: on when it is beamed to the note before it; pressing breaks the beam just
 *    before it (four eighths become 2 + 2 with the third selected), pressing again rejoins;
 *  - several notes: on when they are all in one beam; pressing gives them separate flags;
 *    off, pressing beams them together.
 * "Beamed" means what the engraver actually draws, automatic grouping included
 * (`beamGroupsOfVoice`).
 */
import { produce } from "immer";
import { measureLengthAt } from "@/commands/edit";
import { beamGroupsOfVoice } from "@/engraving/semantic";
import { setBeamModes } from "@/commands/notation";
import type { Command } from "@/commands/types";
import type { Id, NoteEvent, Score, TimeSignature } from "@/model";
import { cmp, positionedEvents } from "@/model";
import { absoluteOffset, resolveSelection, type SelectedEvent } from "./navigation";
import type { Selection } from "./types";

export interface BeamToggleState {
  enabled: boolean;
  pressed: boolean;
  /** Tooltip: what pressing does now, or why it can't. */
  title: string;
}

type BeamMode = NonNullable<NoteEvent["beam"]>;

function timeSigAt(score: Score, measureIndex: number): TimeSignature {
  let ts: TimeSignature = { numerator: 4, denominator: 4 };
  for (let i = 0; i <= measureIndex && i < score.measures.length; i++) {
    const declared = score.measures[i]!.timeSig;
    if (declared) ts = declared;
  }
  return ts;
}

/** Only notes of an eighth or shorter can be beamed. */
function isBeamableNote(e: SelectedEvent): boolean {
  return e.event.kind === "note" && e.event.duration.base >= 8;
}

function voiceOf(score: Score, e: SelectedEvent) {
  return score.parts[e.partIndex]?.measures[e.measureIndex]?.staves[e.staffIndex]?.voices.find(
    (v) => v.index === e.voiceIndex,
  );
}

/** The beam groups of the voice `e` lives in, as the engraver would draw them. */
function groupsAround(score: Score, e: SelectedEvent): Id[][] {
  const voice = voiceOf(score, e);
  if (!voice) return [];
  return beamGroupsOfVoice(voice, timeSigAt(score, e.measureIndex), measureLengthAt(score, e.measureIndex));
}

function connectedToPrevious(score: Score, e: SelectedEvent): boolean {
  return groupsAround(score, e).some((g) => g.indexOf(e.event.id) > 0);
}

/** The note right before `e` in its voice and measure, if it's a beamable note. */
function previousBeamable(score: Score, e: SelectedEvent): NoteEvent | undefined {
  const voice = voiceOf(score, e);
  if (!voice) return undefined;
  const events = positionedEvents(voice).map((pe) => pe.event);
  const i = events.findIndex((ev) => ev.id === e.event.id);
  const prev = i > 0 ? events[i - 1] : undefined;
  return prev && prev.kind === "note" && prev.duration.base >= 8 ? prev : undefined;
}

function sameVoice(a: SelectedEvent, b: SelectedEvent): boolean {
  return (
    a.partIndex === b.partIndex &&
    a.measureIndex === b.measureIndex &&
    a.staffIndex === b.staffIndex &&
    a.voiceIndex === b.voiceIndex
  );
}

function selectedNotes(score: Score, selection: Selection): SelectedEvent[] {
  return resolveSelection(score, selection)
    .filter(isBeamableNote)
    .sort((a, b) =>
      cmp(absoluteOffset(score, a.measureIndex, a.offset), absoluteOffset(score, b.measureIndex, b.offset)),
    );
}

export function beamToggleState(score: Score, selection: Selection): BeamToggleState {
  const notes = selectedNotes(score, selection);
  if (notes.length === 0) {
    return { enabled: false, pressed: false, title: "Beam: select eighth notes (or shorter) to beam or unbeam them" };
  }
  if (notes.length === 1) {
    const e = notes[0]!;
    if (connectedToPrevious(score, e)) return { enabled: true, pressed: true, title: "Break the beam before this note" };
    if (!previousBeamable(score, e)) {
      return { enabled: false, pressed: false, title: "Beam: no eighth note (or shorter) right before this one to join" };
    }
    return { enabled: true, pressed: false, title: "Beam this note to the note before it" };
  }
  if (!notes.every((n) => sameVoice(n, notes[0]!))) {
    return { enabled: false, pressed: false, title: "Beam: select notes in one measure and one voice" };
  }
  const groups = groupsAround(score, notes[0]!);
  const together = groups.some((g) => notes.every((n) => g.includes(n.event.id)));
  return together
    ? { enabled: true, pressed: true, title: "Give these notes separate flags" }
    : { enabled: true, pressed: false, title: "Beam these notes together" };
}

/** What pressing the Beam toggle does to the current selection. */
export function beamToggleCommands(score: Score, selection: Selection): { commands: Command[]; message?: string } {
  const state = beamToggleState(score, selection);
  if (!state.enabled) return { commands: [], message: state.title.replace(/^Beam: /, "") };
  const notes = selectedNotes(score, selection);

  if (notes.length === 1) {
    const e = notes[0]!;
    if (state.pressed) return { commands: [setBeamModes([{ eventId: e.event.id, beam: "begin" }])] };
    // Rejoin: drop this note's override, and the previous note's if it blocks the join;
    // if automatic grouping still keeps them apart (e.g. across a beat), force it.
    const prev = previousBeamable(score, e)!;
    const changes: { eventId: Id; beam: BeamMode }[] = [{ eventId: e.event.id, beam: "auto" }];
    if (prev.beam === "end" || prev.beam === "none") changes.push({ eventId: prev.id, beam: "auto" });
    const trial = produce(score, (d) => setBeamModes(changes).apply(d));
    if (!connectedToPrevious(trial, e)) changes[0] = { eventId: e.event.id, beam: "continue" };
    return { commands: [setBeamModes(changes)] };
  }

  if (state.pressed) {
    return { commands: [setBeamModes(notes.map((n) => ({ eventId: n.event.id, beam: "none" as const })))] };
  }
  const last = notes.length - 1;
  return {
    commands: [
      setBeamModes(
        notes.map((n, i) => ({ eventId: n.event.id, beam: (i === 0 ? "begin" : i === last ? "end" : "continue") as BeamMode })),
      ),
    ],
  };
}
