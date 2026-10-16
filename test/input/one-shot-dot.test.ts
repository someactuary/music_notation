import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { newPianoScore, type Score, type VoiceItem } from "@/model";
import { defaultEditorState, handleKey } from "@/input/step-entry";
import { handleMidiNote } from "@/input/midi-entry";
import type { EditorState, KeyResult } from "@/input/types";

/** Types keys one by one through the real handler, carrying score/cursor/entry along. */
function type(keys: string[], start?: (s: EditorState) => EditorState): { state: EditorState; items: string[] } {
  let state: EditorState = defaultEditorState(newPianoScore({ measureCount: 2 }));
  state = { ...state, entry: { ...state.entry, active: true } };
  if (start) state = start(state);
  for (const k of keys) {
    const shift = k.startsWith("Shift+");
    const key = shift ? k.slice(6) : k;
    state = step(state, handleKey(state, { key, shift, mod: false, alt: false }));
  }
  return { state, items: summary(state.score) };
}

function step(state: EditorState, r: KeyResult | null): EditorState {
  if (!r) return state;
  const score = r.commands.reduce<Score>((s, c) => produce(s, (d) => c.apply(d)), state.score);
  return { ...state, score, cursor: r.cursor ?? state.cursor, selection: r.selection ?? state.selection, entry: r.entry ?? state.entry };
}

function summary(score: Score): string[] {
  return score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items
    .filter((i): i is Exclude<VoiceItem, { kind: "tuplet" }> => i.kind !== "tuplet" && !(i.kind === "rest" && i.measureRest))
    .map((i) => (i.kind === "note" ? i.notes.map((n) => `${n.pitch.step}${n.pitch.octave}`).join("+") : "r") + `/${i.duration.base}${".".repeat(i.duration.dots)}`);
}

describe("the entry dot applies to one note only", () => {
  it("8 . C 6 D: a dotted eighth followed by a sixteenth, without un-dotting", () => {
    expect(type(["8", ".", "c", "6", "d"]).items.slice(0, 2)).toEqual(["C4/8.", "D4/16"]);
  });

  it("keeps the duration: after a dotted eighth, the next note is a plain eighth", () => {
    const { items, state } = type(["8", ".", "c", "d"]);
    expect(items.slice(0, 2)).toEqual(["C4/8.", "D4/8"]);
    expect(state.entry).toMatchObject({ base: 8, dots: 0 });
  });

  it("a dotted rest (0) also uses the dot up", () => {
    expect(type(["4", ".", "0", "c"]).items.slice(0, 2)).toEqual(["r/4.", "C4/4"]);
  });

  it("building a chord with Shift+letter keeps the chord dotted", () => {
    // A lands nearest the chord's bottom note (C4), so A3.
    expect(type(["8", ".", "c", "Shift+e", "Shift+g", "6", "a"]).items.slice(0, 2)).toEqual(["C4+E4+G4/8.", "A3/16"]);
  });

  it("a note played on a MIDI keyboard uses the dot up too", () => {
    let { state } = type(["8", "."]);
    state = step(state, handleMidiNote(state, { note: 60, velocity: 80, held: [] }));
    state = step(state, handleMidiNote(state, { note: 62, velocity: 80, held: [] }));
    expect(summary(state.score).slice(0, 2)).toEqual(["C4/8.", "D4/8"]);
  });
});

describe("duration keys right after typing a note set up the NEXT note", () => {
  it("'.' after typing a note doesn't dot the note just typed", () => {
    // 8 C . D: C stays a plain eighth, D is the dotted one.
    expect(type(["8", "c", ".", "d"]).items.slice(0, 2)).toEqual(["C4/8", "D4/8."]);
  });

  it("but a note clicked (cursor AT it) still has its own duration changed", () => {
    const { state } = type(["4", "c", "d", "e"]);
    const first = state.score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items[0]!;
    const ids = first.kind === "note" ? [first.notes[0]!.id] : [first.id];
    const clicked: EditorState = { ...state, selection: { ids }, cursor: { ...state.cursor, offset: { num: 0, den: 1 } } };
    const after = step(clicked, handleKey(clicked, { key: "2", shift: false, mod: false, alt: false }));
    expect(summary(after.score).slice(0, 2)).toEqual(["C4/2", "E4/4"]);
  });
});

describe("rests left behind while typing are grouped by the meter", () => {
  it("8 . C 6 D E 4 F leaves a 16th, an eighth and a quarter rest", () => {
    expect(type(["8", ".", "c", "6", "d", "e", "4", "f"]).items).toEqual([
      "C4/8.",
      "D4/16",
      "E4/16",
      "F4/4",
      "r/16",
      "r/8",
      "r/4",
    ]);
  });
});
