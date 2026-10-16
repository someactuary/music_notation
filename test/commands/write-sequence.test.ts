import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { frac, newPianoScore, note, rest, type Score, type VoiceItem } from "@/model";
import type { Cursor } from "@/input/types";
import { sequenceFits, writeSequence } from "@/commands/edit";

function cursorAt(measureIndex: number, offset = frac(0)): Cursor {
  return { partIndex: 0, measureIndex, staffIndex: 0, voiceIndex: 0, offset };
}

function voiceOf(score: Score, measureIndex: number, staffIndex = 0) {
  return score.parts[0]!.measures[measureIndex]!.staves[staffIndex]!.voices[0]!;
}

/** Narrows a VoiceItem to a note/rest event for assertions; fails loudly on a tuplet. */
function asEvent(item: VoiceItem) {
  if (item.kind === "tuplet") throw new Error("expected a note/rest event, got a tuplet");
  return item;
}

describe("writeSequence", () => {
  it("a whole note written at beat 3 of 4/4 splits into a half tied to a half in the next measure", () => {
    const score = newPianoScore({ measureCount: 2 }); // 4/4
    const cmd = writeSequence(cursorAt(0, frac(1, 2)), [note("C4", 1)]);

    const next = produce(score, (d) => cmd.apply(d));

    const m0 = voiceOf(next, 0).items;
    // untouched quarter-rest half + the written half
    expect(m0.map((i) => i.kind)).toEqual(["rest", "note"]);
    expect(asEvent(m0[1]!).duration).toEqual({ base: 2, dots: 0 });
    if (m0[1]!.kind !== "note") throw new Error("expected a note");
    expect(m0[1]!.notes[0]!.pitch.step).toBe("C");
    expect(m0[1]!.notes[0]!.tieStart).toBe(true);

    // measure 1 only gets a half note (the written span is only 1/2 whole note long);
    // the other half of the measure stays a rest, so contents still sum exactly.
    const m1 = voiceOf(next, 1).items;
    expect(m1).toHaveLength(2);
    expect(asEvent(m1[0]!).duration).toEqual({ base: 2, dots: 0 });
    if (m1[0]!.kind !== "note") throw new Error("expected a note");
    expect(m1[0]!.notes[0]!.pitch.step).toBe("C");
    expect(m1[0]!.notes[0]!.tieStart).toBeUndefined();
    expect(m1[1]!.kind).toBe("rest");

    // the two tied pieces are different note ids (fresh id on the extra piece)
    if (m0[1]!.kind !== "note" || m1[0]!.kind !== "note") throw new Error("expected notes");
    expect(m0[1]!.notes[0]!.id).not.toBe(m1[0]!.notes[0]!.id);
  });

  it("a dotted half written at beat 4 of 4/4 becomes a quarter tied to a half in the next measure", () => {
    const score = newPianoScore({ measureCount: 2 });
    const cmd = writeSequence(cursorAt(0, frac(3, 4)), [note("D4", 2, 1)]); // dotted half = 3/4

    const next = produce(score, (d) => cmd.apply(d));

    const m0 = voiceOf(next, 0).items;
    expect(m0).toHaveLength(3); // 3/4 of rests (a half on beat 1, a quarter on beat 3) + the written quarter
    expect(m0.slice(0, 2).map((i) => asEvent(i).duration)).toEqual([
      { base: 2, dots: 0 },
      { base: 4, dots: 0 },
    ]);
    const last0 = m0[m0.length - 1]!;
    expect(asEvent(last0).duration).toEqual({ base: 4, dots: 0 });
    if (last0.kind !== "note") throw new Error("expected a note");
    expect(last0.notes[0]!.tieStart).toBe(true);

    // the remaining 1/2 (dotted half minus the quarter used up in measure 0) is a
    // half note in measure 1, leaving the other half of the measure as a rest.
    const m1 = voiceOf(next, 1).items;
    expect(m1).toHaveLength(2);
    expect(asEvent(m1[0]!).duration).toEqual({ base: 2, dots: 0 });
    if (m1[0]!.kind !== "note") throw new Error("expected a note");
    expect(m1[0]!.notes[0]!.pitch.step).toBe("D");
    expect(m1[0]!.notes[0]!.tieStart).toBeUndefined();
    expect(m1[1]!.kind).toBe("rest");
  });

  it("a rest split across the barline becomes two plain rests, no ties", () => {
    const score = newPianoScore({ measureCount: 2 });
    const cmd = writeSequence(cursorAt(0, frac(1, 2)), [rest(1)]); // whole rest from beat 3

    const next = produce(score, (d) => cmd.apply(d));

    const m0 = voiceOf(next, 0).items;
    expect(m0.every((i) => i.kind === "rest")).toBe(true);
    // measure 1 ends up all rests too (the written half-rest piece + the untouched
    // trailing half), which normalizes back to a single whole measureRest.
    const m1 = voiceOf(next, 1).items;
    expect(m1).toHaveLength(1);
    expect(m1[0]!.kind).toBe("rest");
    expect(asEvent(m1[0]!).duration).toEqual({ base: 1, dots: 0 });
    if (m1[0]!.kind !== "rest") throw new Error("expected a rest");
    expect(m1[0]!.measureRest).toBe(true);
  });

  it("writes several events back to back, appending a measure once the score runs out", () => {
    const score = newPianoScore({ measureCount: 1 }); // 4/4, one measure
    const events = [note("C4", 4), note("D4", 4), note("E4", 4), note("F4", 4), note("G4", 4)]; // 5 quarters = 5/4
    const cmd = writeSequence(cursorAt(0), events);

    const next = produce(score, (d) => cmd.apply(d));

    expect(next.parts[0]!.measures).toHaveLength(2);
    expect(next.measures).toHaveLength(2);
    // final barline followed the appended measure
    expect(next.measures[0]!.barline).toBeUndefined();
    expect(next.measures[1]!.barline).toBe("final");

    const m0 = voiceOf(next, 0).items;
    expect(m0.map((i) => (i.kind === "note" ? i.notes[0]!.pitch.step : i.kind))).toEqual(["C", "D", "E", "F"]);
    const m1 = voiceOf(next, 1).items;
    expect(m1).toHaveLength(3); // G quarter + a quarter rest and a half rest
    expect(asEvent(m1[0]!).kind).toBe("note");
    if (m1[0]!.kind !== "note") throw new Error("expected a note");
    expect(m1[0]!.notes[0]!.pitch.step).toBe("G");
    expect(m1[1]!.kind).toBe("rest");
  });

  it("voice contents always sum exactly to the measure length after a split write", () => {
    const score = newPianoScore({ measureCount: 2, timeSig: { numerator: 3, denominator: 4 } });
    const cmd = writeSequence(cursorAt(0, frac(1, 4)), [note("C4", 1)]); // whole note from beat 2 of 3/4

    const next = produce(score, (d) => cmd.apply(d));

    for (const measureIndex of [0, 1]) {
      const items = voiceOf(next, measureIndex).items;
      const total = items.reduce((acc, i) => {
        const ev = asEvent(i);
        const d = ev.duration;
        const p = 2 ** d.dots;
        return acc + (2 * p - 1) / (d.base * p);
      }, 0);
      expect(total).toBeCloseTo(0.75);
    }
  });

  it("sequenceFits reports true for a write that resolves inside a tuplet and fits its grid", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = voiceOf(score, 0);
    const n1 = note("C4", 8);
    const n2 = note("D4", 8);
    const n3 = note("E4", 8);
    voice.items = [
      { kind: "tuplet", id: "tup", ratio: { actual: 3, normal: 2, unit: 8 }, items: [n1, n2, n3] },
      rest(2),
      rest(4),
    ];

    // cursor at 0 is the tuplet's own start: an eighth fits its first slot.
    expect(sequenceFits(score, cursorAt(0), [note("F4", 8)])).toBe(true);
    // cursor at 1/4 is right after the tuplet: plenty of room in the rest of the measure.
    expect(sequenceFits(score, cursorAt(0, frac(1, 4)), [note("F4", 2)])).toBe(true);
  });

  it("sequenceFits reports false when a write starting outside an existing tuplet would reach into it", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = voiceOf(score, 0);
    const n1 = note("C4", 8);
    const n2 = note("D4", 8);
    const n3 = note("E4", 8);
    voice.items = [
      rest(4), // [0, 1/4)
      { kind: "tuplet", id: "tup", ratio: { actual: 3, normal: 2, unit: 8 }, items: [n1, n2, n3] }, // [1/4, 1/2)
      rest(2), // [1/2, 1)
    ];

    expect(sequenceFits(score, cursorAt(0), [note("F4", 2)])).toBe(false); // half note from offset 0 reaches into the tuplet
  });
});
