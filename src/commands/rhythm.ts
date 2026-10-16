/**
 * Pure rhythm helpers used by the editing commands (src/commands/edit.ts).
 * No draft mutation here; these only compute values / build fresh model nodes.
 */
import { rest } from "@/model";
import {
  add,
  eq,
  frac,
  fracToString,
  lt,
  NOTE_VALUES,
  notatedToFraction,
  sub,
  ZERO,
  type Fraction,
  type NotatedDuration,
  type NoteValue,
  type TimeSignature,
} from "@/model/duration";
import type { RestEvent } from "@/model/score";

/**
 * Greedy decomposition of `len` into plain (dots: 0) notated values, largest first.
 * Works because every note value is an exact negative power of two of a whole note,
 * so any fraction whose reduced denominator is itself a power of two (<= 256, the
 * smallest supported note value) decomposes exactly, the same way its binary
 * expansion would. Throws if `len` cannot be represented at all (e.g. 1/3).
 */
function decomposePlain(len: Fraction): NotatedDuration[] {
  let remaining = len;
  const out: NotatedDuration[] = [];
  for (const base of NOTE_VALUES) {
    const value = notatedToFraction({ base, dots: 0 });
    while (!eq(remaining, ZERO) && !lt(remaining, value)) {
      out.push({ base, dots: 0 });
      remaining = sub(remaining, value);
    }
    if (eq(remaining, ZERO)) break;
  }
  if (!eq(remaining, ZERO)) {
    throw new Error(`decomposeDuration: ${fracToString(len)} is not representable in available note values`);
  }
  return out;
}

/** Is there a single base whose dotted (one dot) value equals `len` exactly? */
function singleDotted(len: Fraction): NotatedDuration | undefined {
  for (const base of NOTE_VALUES) {
    const candidate: NotatedDuration = { base, dots: 1 };
    if (eq(notatedToFraction(candidate), len)) return candidate;
  }
  return undefined;
}

/**
 * Expresses a positive fraction of a whole note as a list of notated values, largest
 * first. Uses plain (undotted) values except a single dot is allowed when it collapses
 * the whole thing into exactly one value (e.g. 3/8 -> a single dotted quarter, rather
 * than a quarter + an eighth). Throws if `len` is not representable at all (e.g. 1/3).
 */
export function decomposeDuration(len: Fraction): NotatedDuration[] {
  if (eq(len, ZERO) || len.num < 0) {
    throw new Error(`decomposeDuration: length must be positive, got ${fracToString(len)}`);
  }
  const plain = decomposePlain(len);
  if (plain.length > 1) {
    const dotted = singleDotted(len);
    if (dotted) return [dotted];
  }
  return plain;
}

/** Rest events covering exactly `len` (a whole note fraction), via decomposeDuration. */
export function restsFor(len: Fraction): RestEvent[] {
  return decomposeDuration(len).map((d) => rest(d.base, d.dots));
}

/** Where a measure's rests are measured from: its time signature, and how far into a full bar its offset 0 is (a pickup bar starts late). */
export interface RestMeter {
  timeSig: TimeSignature;
  /** Full-bar position of the measure's offset 0: 0 normally, (full length - actual length) for a pickup. */
  origin: Fraction;
}

/** Is `t` a whole multiple of `v`? */
function isMultipleOf(t: Fraction, v: Fraction): boolean {
  return (t.num * v.den) % (t.den * v.num) === 0;
}

/**
 * Rests covering [start, end), each the largest value that starts on a multiple of its
 * own length (measured from `zero`, in the same coordinates) and still fits. Filling up to a beat therefore goes
 * small to large: from the 10th 16th of a 4/4 bar to its end is a 16th, an eighth and a
 * quarter, never a quarter dangling across the middle of a beat. With `allowDotted`, a
 * dotted rest of a quarter or shorter is used where it's longer than the plain choice and
 * starts on a multiple of its undotted double (a dotted quarter rest on beat 1 or 3 of 4/4).
 */
function alignedRests(start: Fraction, end: Fraction, zero: Fraction, allowDotted: boolean): NotatedDuration[] {
  const out: NotatedDuration[] = [];
  let t = start;
  while (lt(t, end)) {
    const remaining = sub(end, t);
    const local = sub(t, zero);
    let chosen: NotatedDuration | undefined;
    for (const base of NOTE_VALUES) {
      const value = notatedToFraction({ base, dots: 0 });
      if (lt(remaining, value)) continue;
      if (!isMultipleOf(local, value)) continue;
      chosen = { base, dots: 0 };
      break;
    }
    if (allowDotted) {
      for (const base of NOTE_VALUES) {
        if (base < 4) continue; // no dotted half/whole rests in simple time
        const dotted: NotatedDuration = { base, dots: 1 };
        const dottedLen = notatedToFraction(dotted);
        if (lt(remaining, dottedLen)) continue;
        if (!isMultipleOf(local, notatedToFraction({ base: (base / 2) as NoteValue, dots: 0 }))) continue;
        if (!chosen || lt(notatedToFraction(chosen), dottedLen)) chosen = dotted;
        break;
      }
    }
    if (!chosen) throw new Error(`restsAt: ${fracToString(remaining)} at ${fracToString(t)} is not representable`);
    out.push(chosen);
    t = add(t, notatedToFraction(chosen));
  }
  return out;
}

/** Compound meters (6/8, 9/8, 12/8, 6/4, 6/16 ...) beat in dotted values. */
function compoundBeat(ts: TimeSignature): Fraction | undefined {
  if (ts.numerator <= 3 || ts.numerator % 3 !== 0 || ts.denominator < 4) return undefined;
  return frac(3, ts.denominator);
}

/**
 * Rests covering `len` from measure offset `start`, grouped by the meter the way a
 * musician writes them (Gould, "Behind Bars"): in simple time, plain rests that each
 * start on a multiple of their own length, so a partial beat is completed before larger
 * rests begin; in compound time, the same within each dotted beat, and one dotted rest for
 * a whole beat. Without a meter (inside a tuplet, whose grid isn't the bar's) or when the
 * aligned split isn't possible, falls back to `restsFor`.
 */
export function restsAt(start: Fraction, len: Fraction, meter?: RestMeter): RestEvent[] {
  if (!meter) return restsFor(len);
  try {
    // Work in positions within a full bar: a pickup's offset 0 sits `origin` into the bar.
    const barStart = add(start, meter.origin);
    const end = add(barStart, len);
    const beat = compoundBeat(meter.timeSig);
    const durations: NotatedDuration[] = [];
    if (!beat) {
      durations.push(...alignedRests(barStart, end, ZERO, true));
    } else {
      const dotted: NotatedDuration = { base: (meter.timeSig.denominator / 2) as NoteValue, dots: 1 };
      let t = barStart;
      while (lt(t, end)) {
        const beatStart = frac(Math.floor((t.num * beat.den) / (t.den * beat.num)) * beat.num, beat.den);
        const beatEnd = add(beatStart, beat);
        const stop = lt(end, beatEnd) ? end : beatEnd;
        if (eq(t, beatStart) && eq(stop, beatEnd)) durations.push(dotted);
        else durations.push(...alignedRests(t, stop, beatStart, false));
        t = stop;
      }
    }
    return durations.map((d) => rest(d.base, d.dots));
  } catch {
    return restsFor(len);
  }
}
