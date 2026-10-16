/**
 * Pure `PaletteAction` handler (docs/ARCHITECTURE.md's "Actions" M2 contract):
 * `handleAction` turns a UI palette/staves-panel/mouse-drag action into a
 * `KeyResult`, exactly like `handleKey` does for keystrokes. The store applies it
 * the same way. Never mutates `state`.
 */
import { produce } from "immer";
import { add, clefAt, cmp, diatonic, fromDiatonic, keyAlter, newId, notated, ZERO, type Anchor, type Score } from "@/model";
import { locateEvent, locateNote } from "@/commands/locate";
import { addMeasures, removeMeasure, setMeta, setNotePitch } from "@/commands/basic";
import { makeTuplet, setDurationAt, toggleDotAt } from "@/commands/edit";
import {
  addAttachment,
  addSpanner,
  eventAnchor,
  locateEventAnchor,
  removeAttachment,
  removeSpanner,
  setFingering,
  toggleArticulation,
  toggleStemDirection,
} from "@/commands/notation";
import { addStaff, removeStaff, setBracket, setClef, setStaffName } from "@/commands/staves";
import { setKeySignature } from "@/commands/keysig";
import { setClefChange } from "@/commands/clefs";
import {
  clearForcedBreaks,
  clearNudge,
  setMeasuresPerSystem,
  setNudge,
  setSystemsPerPage,
  togglePageBreak,
  toggleSystemBreak,
} from "@/commands/layout";
import type { Command } from "@/commands/types";
import {
  absoluteOffset,
  eventAtCursor,
  eventBeforeCursor,
  idsForEvent,
  keySignatureAt,
  resolveSelection,
  type SelectedEvent,
} from "./navigation";
import type { ActionHandler, Cursor, EditorState } from "./types";

/** The event before the cursor, resolved to a `SelectedEvent` (same shape `resolveSelection` produces), or `[]` if there is none. */
function eventBeforeCursorAsSelected(state: EditorState): SelectedEvent[] {
  const before = eventBeforeCursor(state.score, state.cursor);
  if (!before) return [];
  return resolveSelection(state.score, { ids: idsForEvent(before.event) });
}

/** Selection if non-empty; else (only while note entry is active) the event before the cursor. Applies to most notation actions per docs/ARCHITECTURE.md. */
function targetEvents(state: EditorState): SelectedEvent[] {
  const selected = resolveSelection(state.score, state.selection);
  if (selected.length > 0) return selected;
  if (!state.entry.active) return [];
  return eventBeforeCursorAsSelected(state);
}

/** Selection's first event if non-empty; else the event before the cursor (regardless of entry mode) — used by "tuplet". */
function tupletTarget(state: EditorState): SelectedEvent | undefined {
  const selected = resolveSelection(state.score, state.selection);
  if (selected.length > 0) return selected[0];
  return eventBeforeCursorAsSelected(state)[0];
}

/** The cursor at the offset right after `sel`'s own span, in its own voice. */
function afterSelectedEvent(score: Score, sel: SelectedEvent): Cursor | undefined {
  const voiceCursor: Cursor = { partIndex: sel.partIndex, measureIndex: sel.measureIndex, staffIndex: sel.staffIndex, voiceIndex: sel.voiceIndex, offset: ZERO };
  const positioned = eventAtCursor(score, { ...voiceCursor, offset: sel.offset });
  if (!positioned) return undefined;
  return { ...voiceCursor, offset: add(positioned.offset, positioned.length) };
}

/** The next event after `sel` in its own voice, crossing into the next measure if `sel` was the last event in its own. */
function nextEventInVoice(score: Score, sel: SelectedEvent): SelectedEvent | undefined {
  const after = afterSelectedEvent(score, sel);
  if (!after) return undefined;
  const direct = eventAtCursor(score, after);
  if (direct) return resolveSelection(score, { ids: idsForEvent(direct.event) })[0];
  const measureCount = score.parts[after.partIndex]?.measures.length ?? 0;
  if (after.measureIndex + 1 >= measureCount) return undefined;
  const crossed = eventAtCursor(score, { ...after, measureIndex: after.measureIndex + 1, offset: ZERO });
  return crossed ? resolveSelection(score, { ids: idsForEvent(crossed.event) })[0] : undefined;
}

/** Resolves the start/end events for a slur/hairpin/pedal/ottava span: the first and last of the target events (chronologically), which must share a staff, or (if there's exactly one) it and the next event in its voice. */
function resolveSpanEndpoints(state: EditorState): { start: SelectedEvent; end: SelectedEvent } | { error: string } {
  const targets = targetEvents(state);
  if (targets.length === 0) return { error: "Nothing selected" };
  if (targets.length === 1) {
    const start = targets[0]!;
    const end = nextEventInVoice(state.score, start);
    if (!end) return { error: "No next event to span to" };
    return { start, end };
  }
  const sorted = [...targets].sort((a, b) =>
    cmp(absoluteOffset(state.score, a.measureIndex, a.offset), absoluteOffset(state.score, b.measureIndex, b.offset)),
  );
  const start = sorted[0]!;
  const end = sorted[sorted.length - 1]!;
  if (start.staffIndex !== end.staffIndex) return { error: "Selection spans more than one staff" };
  return { start, end };
}

/**
 * Selected events, latest first. Duration changes run in this order: lengthening an
 * event overwrites what follows it, so a later selected event must be changed before an
 * earlier one can overwrite (and remove) it.
 */
function latestFirst(score: Score, events: SelectedEvent[]): SelectedEvent[] {
  return [...events].sort((a, b) =>
    cmp(absoluteOffset(score, b.measureIndex, b.offset), absoluteOffset(score, a.measureIndex, a.offset)),
  );
}

/** Anchor (+ part/staff) for tempo/text: the first selected event, or the cursor's own measure/offset if nothing is selected. Unlike `targetEvents`, this never falls back through the cursor's *event*, and doesn't require note entry to be active. */
function anchorAtSelectionOrCursor(state: EditorState): { anchor: Anchor; partIndex: number; staffIndex: number } {
  const selected = resolveSelection(state.score, state.selection);
  if (selected.length > 0) {
    const loc = locateEventAnchor(state.score, selected[0]!.event.id);
    if (loc) return loc;
  }
  return {
    anchor: { kind: "measure", measureIndex: state.cursor.measureIndex, offset: state.cursor.offset },
    partIndex: state.cursor.partIndex,
    staffIndex: state.cursor.staffIndex,
  };
}

/**
 * Applies each of `commands` independently against `score` (via a throwaway
 * `produce`) to filter out any that would throw (e.g. `WriteRefused`), returning
 * the survivors plus a message describing what was skipped. Used for actions that
 * can apply to several events at once where some may legitimately refuse (per
 * docs/ARCHITECTURE.md: "refusals become a message, the rest still apply").
 */
function commandsWithRefusalsAsMessage(score: Score, commands: readonly Command[]): { commands: Command[]; message?: string } {
  const ok: Command[] = [];
  let refused = 0;
  let lastMessage: string | undefined;
  for (const cmd of commands) {
    try {
      produce(score, (draft) => cmd.apply(draft));
      ok.push(cmd);
    } catch (err) {
      refused += 1;
      lastMessage = err instanceof Error ? err.message : String(err);
    }
  }
  if (refused === 0) return { commands: ok };
  const message = commands.length === 1 ? lastMessage : `${refused} of ${commands.length} refused: ${lastMessage}`;
  return { commands: ok, ...(message !== undefined ? { message } : {}) };
}

/** Clamps a cursor's staffIndex after the staff at `removedIndex` is gone: shifts one down if it pointed past it, then clamps into range. */
function clampStaffIndexAfterRemoval(staffIndex: number, removedIndex: number, newStaffCount: number): number {
  const shifted = staffIndex > removedIndex ? staffIndex - 1 : staffIndex;
  return Math.min(Math.max(shifted, 0), Math.max(newStaffCount - 1, 0));
}

export const handleAction: ActionHandler = (state, action) => {
  const { score, cursor } = state;

  switch (action.kind) {
    case "dynamic": {
      const targets = targetEvents(state);
      if (targets.length === 0) return { commands: [], message: "Nothing selected" };
      const loc = locateEventAnchor(score, targets[0]!.event.id);
      if (!loc) return { commands: [], message: "Nothing selected" };
      return {
        commands: [
          addAttachment({ id: newId(), kind: "dynamic", text: action.text, partIndex: loc.partIndex, staffIndex: loc.staffIndex, anchor: loc.anchor, placement: "below" }),
        ],
      };
    }

    case "articulation": {
      const targets = targetEvents(state);
      if (targets.length === 0) return { commands: [], message: "Nothing selected" };
      return { commands: [toggleArticulation(targets.map((t) => t.event.id), action.articulation)] };
    }

    case "flipStem": {
      const targets = targetEvents(state);
      if (targets.length === 0) return { commands: [], message: "Nothing selected" };
      return { commands: [toggleStemDirection(targets.map((t) => t.event.id))] };
    }

    case "slur":
    case "hairpin":
    case "pedal":
    case "ottava": {
      const resolved = resolveSpanEndpoints(state);
      if ("error" in resolved) return { commands: [], message: resolved.error };
      const { start, end } = resolved;
      const partIndex = start.partIndex;
      const bottomStaff = (score.parts[partIndex]?.staves.length ?? 1) - 1;
      const staffIndex = action.kind === "pedal" ? bottomStaff : start.staffIndex;
      const base = { id: newId(), partIndex, staffIndex, start: eventAnchor(start.event.id), end: eventAnchor(end.event.id) } as const;
      const spanner =
        action.kind === "slur"
          ? { ...base, kind: "slur" as const }
          : action.kind === "hairpin"
            ? { ...base, kind: "hairpin" as const, shape: action.shape }
            : action.kind === "pedal"
              ? { ...base, kind: "pedal" as const, style: "line" as const }
              : { ...base, kind: "ottava" as const, shift: action.shift, placement: action.shift > 0 ? ("above" as const) : ("below" as const) };
      return { commands: [addSpanner(spanner)] };
    }

    case "fermata": {
      const targets = targetEvents(state);
      if (targets.length === 0) return { commands: [], message: "Nothing selected" };
      const loc = locateEventAnchor(score, targets[0]!.event.id);
      if (!loc) return { commands: [], message: "Nothing selected" };
      return { commands: [addAttachment({ id: newId(), kind: "fermata", partIndex: loc.partIndex, staffIndex: loc.staffIndex, anchor: loc.anchor })] };
    }

    case "tempo": {
      const { anchor, partIndex, staffIndex } = anchorAtSelectionOrCursor(state);
      return {
        commands: [
          addAttachment({
            id: newId(),
            kind: "tempo",
            partIndex,
            staffIndex,
            anchor,
            ...(action.text !== undefined ? { text: action.text } : {}),
            ...(action.bpm !== undefined ? { bpm: action.bpm } : {}),
            ...(action.beatUnit !== undefined ? { beatUnit: action.beatUnit } : {}),
          }),
        ],
      };
    }

    case "text": {
      const { anchor, partIndex, staffIndex } = anchorAtSelectionOrCursor(state);
      return {
        commands: [
          addAttachment({
            id: newId(),
            kind: "text",
            text: action.text,
            style: action.style,
            partIndex,
            staffIndex,
            anchor,
            ...(action.placement !== undefined ? { placement: action.placement } : {}),
          }),
        ],
      };
    }

    case "fingering": {
      const noteIds = state.selection.ids.filter((id) => locateNote(score, id) !== undefined);
      if (noteIds.length === 0) return { commands: [], message: "Nothing selected" };
      const text = action.text.length === 0 ? null : action.text;
      return { commands: noteIds.map((id) => setFingering(id, text)) };
    }

    case "tuplet": {
      const target = tupletTarget(state);
      if (!target) return { commands: [], message: "Nothing selected" };
      return commandsWithRefusalsAsMessage(score, [makeTuplet(target.event.id, action.actual, action.normal)]);
    }

    case "setDuration": {
      const targets = latestFirst(score, resolveSelection(score, state.selection));
      if (targets.length === 0) return { commands: [], message: "Nothing selected" };
      const cmds = targets.map((t) => setDurationAt(t.event.id, notated(action.base, action.dots)));
      return commandsWithRefusalsAsMessage(score, cmds);
    }

    case "toggleDot": {
      const targets = latestFirst(score, resolveSelection(score, state.selection));
      if (targets.length === 0) return { commands: [], message: "Nothing selected" };
      return commandsWithRefusalsAsMessage(score, targets.map((t) => toggleDotAt(t.event.id)));
    }

    case "removeAttachment":
      return { commands: [removeAttachment(action.id)] };

    case "removeSpanner":
      return { commands: [removeSpanner(action.id)] };

    case "dragPitch": {
      const noteHit = locateNote(score, action.noteId);
      if (!noteHit) return { commands: [], message: "No such note" };
      const eventHit = locateEvent(score, noteHit.event.id);
      if (!eventHit) return { commands: [], message: "No such note" };
      const targetDiatonic = diatonic(noteHit.note.pitch) + action.diatonicDelta;
      const rawPitch = fromDiatonic(targetDiatonic);
      const key = keySignatureAt(score, eventHit.measureIndex);
      const alter = keyAlter(key, rawPitch.step);
      return { commands: [setNotePitch(action.noteId, { ...rawPitch, alter })] };
    }

    case "addStaff": {
      const part = score.parts[cursor.partIndex];
      const currentCount = part?.staves.length ?? 0;
      const insertAt = Math.max(0, Math.min(action.atIndex, currentCount));
      const staffIndex = cursor.staffIndex >= insertAt ? cursor.staffIndex + 1 : cursor.staffIndex;
      return {
        commands: [addStaff(action.atIndex, action.clef, action.name)],
        cursor: { ...cursor, staffIndex },
      };
    }

    case "removeStaff": {
      const part = score.parts[cursor.partIndex];
      if (!part) return { commands: [], message: "No part" };
      if (part.staves.length <= 1) return { commands: [], message: "Cannot remove the last staff" };
      const staffIndex = clampStaffIndexAfterRemoval(cursor.staffIndex, action.staffIndex, part.staves.length - 1);
      return { commands: [removeStaff(action.staffIndex)], cursor: { ...cursor, staffIndex } };
    }

    case "setClef":
      return { commands: [setClef(action.staffIndex, action.clef)] };

    case "setStaffName":
      return { commands: [setStaffName(action.staffIndex, action.name, action.abbreviation)] };

    case "setBracket":
      return { commands: [setBracket(action.bracket)] };

    case "setVoice":
      return { commands: [], cursor: { ...cursor, voiceIndex: action.voiceIndex }, message: `Voice ${action.voiceIndex + 1}` };

    case "setKeySignature":
      return { commands: [setKeySignature(cursor.measureIndex, action.keySig)] };

    case "insertMeasure": {
      const count = score.measures.length;
      const index = Math.min(Math.max(action.index, 0), count);
      // Keep the cursor on the same music: it moves along when the new measure lands before it.
      const moved = cursor.measureIndex >= index ? { cursor: { ...cursor, measureIndex: cursor.measureIndex + 1 } } : {};
      return { commands: [addMeasures(1, index)], ...moved, message: `Inserted an empty measure ${index + 1}` };
    }

    case "deleteMeasure": {
      const count = score.measures.length;
      const mi = action.measureIndex;
      if (mi < 0 || mi >= count) return { commands: [], message: "No such measure" };
      if (count <= 1) return { commands: [], message: "Cannot remove the only measure" };
      // A cursor in or after the deleted measure moves back with the music; inside it, to the start of what follows.
      const cursorMeasure =
        cursor.measureIndex > mi ? cursor.measureIndex - 1 : cursor.measureIndex === mi ? Math.min(mi, count - 2) : cursor.measureIndex;
      const nextCursor =
        cursor.measureIndex < mi ? cursor : cursor.measureIndex > mi ? { ...cursor, measureIndex: cursorMeasure } : { ...cursor, measureIndex: cursorMeasure, offset: ZERO };
      return {
        commands: [removeMeasure(mi)],
        cursor: nextCursor,
        // Ids inside the deleted measure no longer exist; don't leave them selected.
        selection: { ids: [] },
        message: `Deleted measure ${mi + 1} (Undo restores it)`,
      };
    }

    case "clefChange": {
      // At the earliest selected note, else at the cursor. A change at the cursor's
      // offset 0 applies from the start of that measure.
      const selected = [...resolveSelection(score, state.selection)].sort((a, b) =>
        cmp(absoluteOffset(score, a.measureIndex, a.offset), absoluteOffset(score, b.measureIndex, b.offset)),
      );
      const at = selected[0] ?? cursor;
      const current = clefAt(score, at.partIndex, at.staffIndex, at.measureIndex, at.offset);
      const hasChangeHere = (score.parts[at.partIndex]?.measures[at.measureIndex]?.staves[at.staffIndex]?.clefChanges ?? []).some(
        (c) => cmp(c.at, at.offset) === 0,
      );
      if (current === action.clef && !hasChangeHere) {
        return { commands: [], message: `Already in ${action.clef} clef here` };
      }
      return { commands: [setClefChange(at.partIndex, at.staffIndex, at.measureIndex, at.offset, action.clef)] };
    }

    case "clearKeySignature":
      return { commands: [setKeySignature(cursor.measureIndex, null)] };

    case "toggleSystemBreak":
      return { commands: [toggleSystemBreak(cursor.measureIndex)] };

    case "togglePageBreak":
      return { commands: [togglePageBreak(cursor.measureIndex)] };

    case "setMeasuresPerSystem":
      return { commands: [setMeasuresPerSystem(action.value)] };

    case "setSystemsPerPage":
      return { commands: [setSystemsPerPage(action.value)] };

    case "clearForcedBreaks":
      return { commands: [clearForcedBreaks()], message: "Cleared all forced breaks" };

    case "setNudge":
      return { commands: [setNudge(action.id, action.dx, action.dy)] };

    case "clearNudge":
      return { commands: [clearNudge(action.id)] };

    case "setMeta":
      return { commands: [setMeta(action.patch)] };

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
};
