import { describe, expect, it } from "vitest";
import { frac, ZERO, type Fraction, type TimeSignature } from "@/model";
import { restsAt } from "@/commands/rhythm";

/** "4" for a quarter rest, "8." for a dotted eighth, ... */
function rests(start: Fraction, len: Fraction, timeSig?: TimeSignature, origin: Fraction = ZERO): string[] {
  return restsAt(start, len, timeSig ? { timeSig, origin } : undefined).map(
    (r) => `${r.duration.base}${".".repeat(r.duration.dots)}`,
  );
}

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };
const TWELVE_EIGHT: TimeSignature = { numerator: 12, denominator: 8 };

describe("restsAt: rests grouped by the meter", () => {
  it("completes the beat with small rests before larger ones (the case Frank hit)", () => {
    // From the 10th 16th of 4/4 to the barline: 16th, eighth, quarter.
    expect(rests(frac(9, 16), frac(7, 16), FOUR_FOUR)).toEqual(["16", "8", "4"]);
  });

  it("4/4: a half rest only on beat 1 or 3", () => {
    expect(rests(frac(1, 4), frac(3, 4), FOUR_FOUR)).toEqual(["4", "2"]);
    expect(rests(ZERO, frac(3, 4), FOUR_FOUR)).toEqual(["2", "4"]);
    expect(rests(frac(1, 4), frac(1, 2), FOUR_FOUR)).toEqual(["4", "4"]);
  });

  it("3/4: quarter rests, a half rest only from beat 1", () => {
    expect(rests(frac(1, 4), frac(1, 2), THREE_FOUR)).toEqual(["4", "4"]);
    expect(rests(ZERO, frac(1, 2), THREE_FOUR)).toEqual(["2"]);
  });

  it("simple time allows a short dotted rest on the right boundary, never across a beat it would hide", () => {
    expect(rests(ZERO, frac(3, 8), FOUR_FOUR)).toEqual(["4."]); // beat 1
    expect(rests(frac(1, 2), frac(3, 8), FOUR_FOUR)).toEqual(["4."]); // beat 3
    expect(rests(frac(1, 4), frac(3, 8), FOUR_FOUR)).toEqual(["4", "8"]); // beat 2: would hide beat 3
    expect(rests(ZERO, frac(3, 16), FOUR_FOUR)).toEqual(["8."]);
  });

  it("6/8: a dotted quarter rest for each whole beat, and the rest of a partial beat inside it", () => {
    expect(rests(frac(1, 8), frac(5, 8), SIX_EIGHT)).toEqual(["8", "8", "4."]);
    expect(rests(frac(3, 8), frac(3, 8), SIX_EIGHT)).toEqual(["4."]);
    expect(rests(ZERO, frac(3, 4), SIX_EIGHT)).toEqual(["4.", "4."]);
  });

  it("12/8: never a plain half rest across two beats", () => {
    expect(rests(frac(3, 8), frac(6, 8), TWELVE_EIGHT)).toEqual(["4.", "4."]);
  });

  it("a pickup bar is lined up with the end of the bar", () => {
    // A 4/4 pickup of two beats is beats 3-4: offset 0 there is beat 3.
    expect(rests(ZERO, frac(1, 2), FOUR_FOUR, frac(1, 2))).toEqual(["2"]);
    expect(rests(frac(1, 8), frac(3, 8), FOUR_FOUR, frac(1, 2))).toEqual(["8", "4"]);
    // A pickup of five eighths starts three eighths into the bar: its offsets 1/8-5/8 are beats 3-4.
    expect(rests(frac(1, 8), frac(1, 2), FOUR_FOUR, frac(3, 8))).toEqual(["2"]);
    // 6/8 pickup of one eighth (the last eighth of beat 2), then nothing: just that eighth.
    expect(rests(ZERO, frac(1, 8), SIX_EIGHT, frac(5, 8))).toEqual(["8"]);
  });

  it("without a meter (inside a tuplet), falls back to plain length-based rests", () => {
    expect(rests(frac(1, 8), frac(3, 8))).toEqual(["4."]);
  });
});
