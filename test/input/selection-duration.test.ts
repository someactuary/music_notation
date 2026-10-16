import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { chord, newPianoScore, note, type Score, type VoiceItem } from "@/model";
import { defaultEditorState, handleKey } from "@/input/step-entry";
import type { EditorState, KeyResult } from "@/input/types";

function apply(score: Score, result: KeyResult | null): Score {
  return (result?.commands ?? []).reduce<Score>((s, c) => produce(s, (d) => c.apply(d)), score);
}

/** "C4/q" style summary of a voice: pitch(es) or "r", then base value and dots. */
function summary(items: VoiceItem[]): string[] {
  return items.map((i) => {
    if (i.kind === "tuplet") return "tuplet";
    const what = i.kind === "note" ? i.notes.map((n) => `${n.pitch.step}${n.pitch.octave}`).join("+") : "r";
    return `${what}/${i.duration.base}${".".repeat(i.duration.dots)}`;
  });
}

const press = (key: string) => ({ key, shift: false, mod: false, alt: false });

/** Four quarter notes C D E F in measure 1 of 2; `entryOn` toggles note entry. */
function setup(entryOn: boolean) {
  const score = newPianoScore({ measureCount: 2 });
  const items = [chord(["C4", "E4"], 4), note("D4", 4), note("E4", 4), note("F4", 4)];
  score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = items;
  const base = defaultEditorState(score);
  const at = (ids: string[]): EditorState => ({ ...base, entry: { ...base.entry, active: entryOn }, selection: { ids } });
  const voice = (s: Score) => summary(s.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items);
  return { score, at, voice, first: items[0]!.id, second: items[1]!.id, firstNote: (items[0] as { notes: { id: string }[] }).notes[0]!.id };
}

describe.each([false, true])("duration keys on a selection (note entry %s)", (entryOn) => {
  it("lengthening a chord overwrites the note after it", () => {
    const { score, at, voice, firstNote } = setup(entryOn);
    expect(voice(apply(score, handleKey(at([firstNote]), press("2"))))).toEqual(["C4+E4/2", "E4/4", "F4/4"]);
  });

  it("shortening fills the freed time with rests", () => {
    const { score, at, voice, firstNote } = setup(entryOn);
    expect(voice(apply(score, handleKey(at([firstNote]), press("8"))))).toEqual(["C4+E4/8", "r/8", "D4/4", "E4/4", "F4/4"]);
  });

  it("'.' dots the selection, overwriting the first half of the next note (its remainder becomes a rest)", () => {
    const { score, at, voice, firstNote } = setup(entryOn);
    expect(voice(apply(score, handleKey(at([firstNote]), press("."))))).toEqual(["C4+E4/4.", "r/8", "E4/4", "F4/4"]);
  });

  it("works on 1, 2, 4, 8, 6 (16th) and 3 (32nd)", () => {
    const { score, at, voice, second } = setup(entryOn);
    const sixteenth = voice(apply(score, handleKey(at([second]), press("6"))));
    expect(sixteenth.slice(0, 2)).toEqual(["C4+E4/4", "D4/16"]);
    const whole = voice(apply(score, handleKey(at([second]), press("1"))));
    expect(whole).toEqual(["C4+E4/4", "D4/4", "E4/4", "F4/4"]); // a whole note would cross the barline: refused
  });
});

describe("duration keys on a selection: details", () => {
  it("a digit gives the plain value even with a dot pending for note entry", () => {
    const { score, at, voice, firstNote } = setup(true);
    const state = at([firstNote]);
    const dotted = { ...state, entry: { ...state.entry, dots: 1 as const } };
    expect(voice(apply(score, handleKey(dotted, press("2"))))[0]).toBe("C4+E4/2");
  });

  it("with note entry on, the digit also becomes the duration for the next typed note", () => {
    const { at, firstNote } = setup(true);
    expect(handleKey(at([firstNote]), press("8"))?.entry).toMatchObject({ base: 8, dots: 0 });
  });

  it("says why when the new length would cross the barline", () => {
    const { at, second } = setup(false);
    expect(handleKey(at([second]), press("1"))?.message).toBeTruthy();
  });

  it("changes several selected notes, the later ones first, so none is lost mid-change", () => {
    const { score, at, voice, first, second } = setup(false);
    // Halving both: C+E and D each become eighths.
    const ids = [first, second].flatMap((id) => {
      const ev = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items.find((i) => i.id === id)!;
      return ev.kind === "note" ? ev.notes.map((n) => n.id) : [id];
    });
    expect(voice(apply(score, handleKey(at(ids), press("8"))))).toEqual(["C4+E4/8", "r/8", "D4/8", "r/8", "E4/4", "F4/4"]);
  });
});
