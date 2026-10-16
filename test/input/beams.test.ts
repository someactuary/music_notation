import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { frac, newPianoScore, note, rest, type NoteEvent, type Score } from "@/model";
import { beamGroupsOfVoice } from "@/engraving/semantic";
import { beamToggleCommands, beamToggleState } from "@/input/beams";

const FOUR_FOUR = { numerator: 4, denominator: 4 } as const;

function apply(score: Score, ids: string[]): Score {
  const { commands } = beamToggleCommands(score, { ids });
  return commands.reduce<Score>((s, c) => produce(s, (d) => c.apply(d)), score);
}

/** Beam groups of the top staff, as pitch names. */
function groups(score: Score): string[][] {
  const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
  const byId = new Map(voice.items.map((i) => [i.id, i]));
  return beamGroupsOfVoice(voice, FOUR_FOUR, frac(1)).map((g) =>
    g.map((id) => {
      const ev = byId.get(id) as NoteEvent;
      return `${ev.notes[0]!.pitch.step}${ev.notes[0]!.pitch.octave}`;
    }),
  );
}

/** Four eighths C D E F on beats 1-2 (drawn as one beam), then a half rest. */
function eighths() {
  const score = newPianoScore({ measureCount: 1 });
  const notes = ["C5", "D5", "E5", "F5"].map((p) => note(p, 8));
  score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [...notes, rest(2)];
  const id = (i: number) => notes[i]!.notes[0]!.id;
  return { score, id };
}

describe("Beam toggle", () => {
  it("one note: shows on when beamed to the note before it; pressing breaks the beam there (4 -> 2 + 2)", () => {
    const { score, id } = eighths();
    expect(groups(score)).toEqual([["C5", "D5", "E5", "F5"]]);
    expect(beamToggleState(score, { ids: [id(2)] })).toMatchObject({ enabled: true, pressed: true });
    const broken = apply(score, [id(2)]);
    expect(groups(broken)).toEqual([
      ["C5", "D5"],
      ["E5", "F5"],
    ]);
    expect(beamToggleState(broken, { ids: [id(2)] }).pressed).toBe(false);
  });

  it("one note: pressing again rejoins it, back to automatic beaming", () => {
    const { score, id } = eighths();
    const rejoined = apply(apply(score, [id(2)]), [id(2)]);
    expect(groups(rejoined)).toEqual([["C5", "D5", "E5", "F5"]]);
    const e = rejoined.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items[2] as NoteEvent;
    expect(e.beam).toBeUndefined();
  });

  it("several notes in one beam: pressing gives them separate flags; pressing again beams them together", () => {
    const { score, id } = eighths();
    const all = [0, 1, 2, 3].map(id);
    expect(beamToggleState(score, { ids: all }).pressed).toBe(true);
    const flagged = apply(score, all);
    expect(groups(flagged)).toEqual([]);
    expect(beamToggleState(flagged, { ids: all }).pressed).toBe(false);
    expect(groups(apply(flagged, all))).toEqual([["C5", "D5", "E5", "F5"]]);
  });

  it("unbeaming part of a beam leaves the rest beamed", () => {
    const { score, id } = eighths();
    expect(groups(apply(score, [id(2), id(3)]))).toEqual([["C5", "D5"]]);
  });

  it("can join notes across a beat, which automatic beaming keeps apart", () => {
    const score = newPianoScore({ measureCount: 1 });
    // Beat 1 quarter, then eighths on beats 2 and 3: drawn as two separate beams.
    const ns = ["D5", "E5", "F5", "G5"].map((p) => note(p, 8));
    score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [note("C5", 4), ...ns, note("A5", 4)];
    expect(groups(score)).toEqual([
      ["D5", "E5"],
      ["F5", "G5"],
    ]);
    const third = ns[2]!.notes[0]!.id;
    expect(beamToggleState(score, { ids: [third] })).toMatchObject({ enabled: true, pressed: false });
    expect(groups(apply(score, [third]))).toEqual([["D5", "E5", "F5", "G5"]]);
  });

  it("is disabled, saying why, for quarter notes, nothing selected, or the first note of a measure", () => {
    const score = newPianoScore({ measureCount: 1 });
    const q = note("C5", 4);
    const e = note("D5", 8);
    score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [e, note("E5", 8), q, rest(2)];
    expect(beamToggleState(score, { ids: [] }).enabled).toBe(false);
    expect(beamToggleState(score, { ids: [q.notes[0]!.id] }).enabled).toBe(false);
    const first = beamToggleState(score, { ids: [e.notes[0]!.id] });
    expect(first.enabled).toBe(false);
    expect(first.title).toMatch(/no eighth note/);
    expect(beamToggleCommands(score, { ids: [e.notes[0]!.id] }).commands).toEqual([]);
  });
});
