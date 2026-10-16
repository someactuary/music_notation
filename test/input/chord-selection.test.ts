import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { frac, newPianoScore, note, rest, type NoteEvent, type Score } from "@/model";
import { defaultEditorState, handleKey } from "@/input/step-entry";
import type { EditorState, KeyResult } from "@/input/types";

function apply(score: Score, result: KeyResult | null): Score {
  return (result?.commands ?? []).reduce<Score>((s, c) => produce(s, (d) => c.apply(d)), score);
}

function pitches(score: Score, measureIndex: number, i: number): string[] {
  const ev = score.parts[0]!.measures[measureIndex]!.staves[0]!.voices[0]!.items[i] as NoteEvent;
  return ev.notes.map((n) => `${n.pitch.step}${n.pitch.alter === -1 ? "b" : n.pitch.alter === 1 ? "#" : ""}${n.pitch.octave}`);
}

const shiftKey = (key: string) => ({ key, shift: true, mod: false, alt: false });

/** Note entry on, cursor after the last of three quarter notes C4 E4 G4 (then a rest). */
function setup(): { score: Score; state: (ids: string[]) => EditorState; c: NoteEvent; e: NoteEvent } {
  const score = newPianoScore({ measureCount: 2 });
  const c = note("C4", 4);
  const e = note("E4", 4);
  score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [c, e, note("G4", 4), rest(4)];
  const base = defaultEditorState(score);
  const state = (ids: string[]): EditorState => ({
    ...base,
    entry: { ...base.entry, active: true },
    cursor: { ...base.cursor, offset: frac(3, 4) },
    selection: { ids },
  });
  return { score, state, c, e };
}

describe("Shift+letter (add a chord note)", () => {
  it("with nothing selected, adds to the note just before the cursor", () => {
    const { score, state } = setup();
    const next = apply(score, handleKey(state([]), shiftKey("B")));
    expect(pitches(next, 0, 2)).toEqual(["G4", "B4"]);
  });

  it("with a note selected, adds to that note's chord, not the one before the cursor", () => {
    const { score, state, c } = setup();
    const next = apply(score, handleKey(state([c.notes[0]!.id]), shiftKey("E")));
    expect(pitches(next, 0, 0)).toEqual(["C4", "E4"]);
    expect(pitches(next, 0, 2)).toEqual(["G4"]);
  });

  it("with several notes selected, adds to each chord, each in the octave just above its own top note", () => {
    const { score, state, c, e } = setup();
    const next = apply(score, handleKey(state([c.notes[0]!.id, e.notes[0]!.id]), shiftKey("G")));
    expect(pitches(next, 0, 0)).toEqual(["C4", "G4"]);
    expect(pitches(next, 0, 1)).toEqual(["E4", "G4"]);
  });

  it("spells the added note by the key where the selected chord is", () => {
    const { score, state } = setup();
    // Measure 2 is in F major (B flat); the cursor stays in measure 1 (C major).
    score.measures[1]!.keySig = { fifths: -1, mode: "major" };
    const d = note("D4", 4);
    score.parts[0]!.measures[1]!.staves[0]!.voices[0]!.items = [d, rest(4), rest(2)];
    const next = apply(score, handleKey(state([d.notes[0]!.id]), shiftKey("B")));
    expect(pitches(next, 1, 0)).toEqual(["D4", "Bb4"]);
  });

  it("says so when only rests are selected", () => {
    const { score, state } = setup();
    const restId = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items[3]!.id;
    const result = handleKey(state([restId]), shiftKey("C"));
    expect(result?.commands).toEqual([]);
    expect(result?.message).toMatch(/not a rest/);
  });
});

describe("Delete with notes of a chord selected", () => {
  const key = (k: string, mod = false) => ({ key: k, shift: false, mod, alt: false });

  /** A C-E-G chord, then a lone A4, then a half rest. Note entry off. */
  function chordSetup() {
    const score = newPianoScore({ measureCount: 1 });
    const chord: NoteEvent = { ...note("C4", 4), notes: [] };
    chord.notes = [note("C4", 4).notes[0]!, note("E4", 4).notes[0]!, note("G4", 4).notes[0]!];
    const lone = note("A4", 4);
    score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [chord, lone, rest(2)];
    const at = (ids: string[]): EditorState => ({ ...defaultEditorState(score), selection: { ids } });
    const [c, e, g] = chord.notes;
    return { score, at, c: c!.id, e: e!.id, g: g!.id, lone };
  }

  const firstItem = (s: Score) => s.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items[0]!;

  it("removes only the selected note and keeps the rest of the chord", () => {
    const { score, at, e } = chordSetup();
    expect(pitches(apply(score, handleKey(at([e]), key("Delete"))), 0, 0)).toEqual(["C4", "G4"]);
  });

  it("removes several selected notes of one chord", () => {
    const { score, at, c, g } = chordSetup();
    expect(pitches(apply(score, handleKey(at([c, g]), key("Backspace"))), 0, 0)).toEqual(["E4"]);
  });

  it("with every note of the chord selected, removes the whole chord (it becomes a rest)", () => {
    const { score, at, c, e, g } = chordSetup();
    expect(firstItem(apply(score, handleKey(at([c, e, g]), key("Delete")))).kind).toBe("rest");
  });

  it("handles a mixed selection: part of one chord and a whole single note", () => {
    const { score, at, g, lone } = chordSetup();
    const next = apply(score, handleKey(at([g, lone.notes[0]!.id]), key("Delete")));
    expect(pitches(next, 0, 0)).toEqual(["C4", "E4"]);
    expect(next.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items[1]!.kind).toBe("rest");
  });

  it("cut (⌘X) still takes the whole chord, so the clipboard matches what disappears", () => {
    const { score, at, e } = chordSetup();
    const result = handleKey(at([e]), key("x", true));
    expect(result?.clipboard).toBeTruthy();
    expect(firstItem(apply(score, result)).kind).toBe("rest");
  });
});
