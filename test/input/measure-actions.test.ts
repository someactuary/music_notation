import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { frac, newPianoScore, note, ZERO, type Score } from "@/model";
import { defaultEditorState } from "@/input/step-entry";
import { handleAction } from "@/input/actions";
import type { Cursor, EditorState, KeyResult } from "@/input/types";

function state(score: Score, cursor?: Partial<Cursor>, ids: string[] = []): EditorState {
  const base = defaultEditorState(score);
  return { ...base, cursor: { ...base.cursor, ...cursor }, selection: { ids } };
}

function apply(score: Score, result: KeyResult | null): Score {
  return (result?.commands ?? []).reduce<Score>((s, c) => produce(s, (d) => c.apply(d)), score);
}

/** Four measures, each with a different whole note on the top staff so they're easy to tell apart. */
function numbered(): Score {
  const score = newPianoScore({ measureCount: 4 });
  ["C5", "D5", "E5", "F5"].forEach((p, mi) => {
    score.parts[0]!.measures[mi]!.staves[0]!.voices[0]!.items = [note(p, 1)];
  });
  return score;
}

function firstPitches(score: Score): string[] {
  return score.parts[0]!.measures.map((pm) => {
    const item = pm.staves[0]!.voices[0]!.items[0]!;
    return item.kind === "note" ? `${item.notes[0]!.pitch.step}${item.notes[0]!.pitch.octave}` : "rest";
  });
}

describe("insertMeasure action (the + button)", () => {
  it("inserts an empty measure at the index, after the hovered measure", () => {
    const score = numbered();
    const next = apply(score, handleAction(state(score), { kind: "insertMeasure", index: 2 }));
    expect(firstPitches(next)).toEqual(["C5", "D5", "rest", "E5", "F5"]);
  });

  it("moves the cursor along when the new measure lands before it", () => {
    const score = numbered();
    const result = handleAction(state(score, { measureIndex: 3 }), { kind: "insertMeasure", index: 1 });
    expect(result?.cursor?.measureIndex).toBe(4);
    const unaffected = handleAction(state(score, { measureIndex: 0 }), { kind: "insertMeasure", index: 1 });
    expect(unaffected?.cursor).toBeUndefined();
  });
});

describe("deleteMeasure action (the − button)", () => {
  it("deletes exactly that measure", () => {
    const score = numbered();
    const result = handleAction(state(score), { kind: "deleteMeasure", measureIndex: 1 });
    expect(firstPitches(apply(score, result))).toEqual(["C5", "E5", "F5"]);
    expect(result?.message).toMatch(/Deleted measure 2/);
  });

  it("keeps the cursor on the same music, and clears a selection that may point into the deleted measure", () => {
    const score = numbered();
    const later = handleAction(state(score, { measureIndex: 3, offset: frac(1, 2) }, ["x"]), { kind: "deleteMeasure", measureIndex: 1 });
    expect(later?.cursor).toMatchObject({ measureIndex: 2, offset: frac(1, 2) });
    expect(later?.selection).toEqual({ ids: [] });
    const inside = handleAction(state(score, { measureIndex: 1, offset: frac(1, 2) }), { kind: "deleteMeasure", measureIndex: 1 });
    expect(inside?.cursor).toMatchObject({ measureIndex: 1, offset: ZERO });
    const lastOne = handleAction(state(score, { measureIndex: 3 }), { kind: "deleteMeasure", measureIndex: 3 });
    expect(lastOne?.cursor?.measureIndex).toBe(2);
  });

  it("refuses to delete the only measure", () => {
    const score = newPianoScore({ measureCount: 1 });
    const result = handleAction(state(score), { kind: "deleteMeasure", measureIndex: 0 });
    expect(result?.commands).toEqual([]);
    expect(result?.message).toMatch(/only measure/);
  });
});
