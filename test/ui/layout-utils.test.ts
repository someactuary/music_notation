import { describe, expect, it } from "vitest";
import { engrave } from "@/engraving";
import { BRAVURA } from "@/render/smufl";
import { frac, newId, newPianoScore, note } from "@/model";
import type { Score } from "@/model";
import { minuet } from "../fixtures/minuet";
import { cursorX, findSystemForMeasure, hitTestPoint, locateEvent, MEASURE_HOVER_ABOVE_SP, measureAtPoint, staffY } from "@/ui/layout-utils";

/** A single 4/4 measure: treble has a half + two quarters (columns at 0, 1/2, 3/4); bass is a whole rest. */
function makeSingleMeasureScore(): Score {
  const score = newPianoScore({ measureCount: 1 });
  const part = score.parts[0]!;
  part.measures[0]!.staves[0]!.voices = [
    { id: newId(), index: 0, items: [note("C5", 2), note("D5", 4), note("E5", 4)] },
  ];
  return score;
}

describe("findSystemForMeasure", () => {
  it("finds the page/system/measure for a given global measure index", () => {
    const layout = engrave(minuet(), { font: BRAVURA });
    const loc0 = findSystemForMeasure(layout, 0);
    expect(loc0).not.toBeNull();
    expect(loc0!.system.index).toBe(0);
    expect(loc0!.measure.measureIndex).toBe(0);
  });

  it("puts the 16-bar minuet's B section (measures 8-15) on the second system", () => {
    const layout = engrave(minuet(), { font: BRAVURA });
    const loc = findSystemForMeasure(layout, 8);
    expect(loc).not.toBeNull();
    expect(loc!.system.index).toBe(1);
    expect(loc!.measure.measureIndex).toBe(8);
    // Sanity check: the whole B section is on that same system.
    for (let m = 8; m <= 15; m++) {
      expect(findSystemForMeasure(layout, m)!.system.index).toBe(1);
    }
    // And the A section is on the first.
    for (let m = 0; m <= 7; m++) {
      expect(findSystemForMeasure(layout, m)!.system.index).toBe(0);
    }
  });

  it("returns null for an out-of-range measure index", () => {
    const layout = engrave(minuet(), { font: BRAVURA });
    expect(findSystemForMeasure(layout, 999)).toBeNull();
  });
});

describe("cursorX", () => {
  it("returns the exact column x for an onset that has one", () => {
    const layout = engrave(makeSingleMeasureScore(), { font: BRAVURA });
    const { measure } = findSystemForMeasure(layout, 0)!;
    const half = measure.columns.find((c) => c.offset.num === 0)!;
    const quarter = measure.columns.find((c) => c.offset.num === 1 && c.offset.den === 2)!;
    expect(cursorX(measure, frac(0))).toBeCloseTo(half.x, 6);
    expect(cursorX(measure, frac(1, 2))).toBeCloseTo(quarter.x, 6);
  });

  it("interpolates linearly between neighbouring columns", () => {
    const layout = engrave(makeSingleMeasureScore(), { font: BRAVURA });
    const { measure } = findSystemForMeasure(layout, 0)!;
    const lo = measure.columns.find((c) => c.offset.num === 0)!;
    const hi = measure.columns.find((c) => c.offset.num === 1 && c.offset.den === 2)!;
    // frac(1,4) sits exactly halfway between offset 0 and offset 1/2.
    const expected = lo.x + 0.5 * (hi.x - lo.x);
    expect(cursorX(measure, frac(1, 4))).toBeCloseTo(expected, 6);
  });

  it("places an offset past the last column just before the barline", () => {
    const layout = engrave(makeSingleMeasureScore(), { font: BRAVURA });
    const { measure } = findSystemForMeasure(layout, 0)!;
    const expected = measure.x + measure.width - 1;
    expect(cursorX(measure, frac(1))).toBeCloseTo(expected, 6);
  });
});

describe("staffY", () => {
  it("returns the top-line y of the requested part/staff", () => {
    const layout = engrave(makeSingleMeasureScore(), { font: BRAVURA });
    const { system } = findSystemForMeasure(layout, 0)!;
    const treble = system.staves.find((s) => s.partIndex === 0 && s.staffIndex === 0)!;
    const bass = system.staves.find((s) => s.partIndex === 0 && s.staffIndex === 1)!;
    expect(staffY(system, 0, 0)).toBe(treble.y);
    expect(staffY(system, 0, 1)).toBe(bass.y);
    expect(staffY(system, 0, 1)).toBeGreaterThan(staffY(system, 0, 0));
  });

  it("throws for a staff that doesn't exist in the system", () => {
    const layout = engrave(makeSingleMeasureScore(), { font: BRAVURA });
    const { system } = findSystemForMeasure(layout, 0)!;
    expect(() => staffY(system, 0, 5)).toThrow();
  });
});

describe("locateEvent", () => {
  it("locates an event by its own id", () => {
    const score = minuet();
    const event = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items[0]!;
    const loc = locateEvent(score, event.id);
    expect(loc).toEqual({ partIndex: 0, measureIndex: 0, staffIndex: 0, voiceIndex: 0, offset: frac(0) });
  });

  it("resolves a note id to its parent event's location", () => {
    const score = minuet();
    // Measure 5, staff 0: [A4 q, B4 q, C5 q] -> second note starts at offset 1/4.
    const event = score.parts[0]!.measures[5]!.staves[0]!.voices[0]!.items[1]!;
    expect(event.kind).toBe("note");
    const noteId = event.kind === "note" ? event.notes[0]!.id : "";
    const loc = locateEvent(score, noteId);
    expect(loc).toEqual({ partIndex: 0, measureIndex: 5, staffIndex: 0, voiceIndex: 0, offset: frac(1, 4) });
  });

  it("returns null for an unknown id", () => {
    expect(locateEvent(minuet(), "does-not-exist")).toBeNull();
  });
});

describe("hitTestPoint", () => {
  it("picks the staff by vertical proximity and the nearest column by x", () => {
    const layout = engrave(makeSingleMeasureScore(), { font: BRAVURA });
    const { page, system, measure } = findSystemForMeasure(layout, 0)!;
    const treble = system.staves.find((s) => s.partIndex === 0 && s.staffIndex === 0)!;
    const bass = system.staves.find((s) => s.partIndex === 0 && s.staffIndex === 1)!;
    const quarterCol = measure.columns.find((c) => c.offset.num === 1 && c.offset.den === 2)!;

    const onTreble = hitTestPoint(layout, page.index, system.x + quarterCol.x, system.y + treble.y + 2);
    expect(onTreble).toEqual({ measureIndex: 0, staffIndex: 0, offset: frac(1, 2) });

    const onBass = hitTestPoint(layout, page.index, system.x + quarterCol.x, system.y + bass.y + 2);
    expect(onBass!.staffIndex).toBe(1);
  });

  it("snaps to the nearest column even when the click isn't exactly on one", () => {
    const layout = engrave(makeSingleMeasureScore(), { font: BRAVURA });
    const { page, system, measure } = findSystemForMeasure(layout, 0)!;
    const treble = system.staves.find((s) => s.partIndex === 0 && s.staffIndex === 0)!;
    const zeroCol = measure.columns.find((c) => c.offset.num === 0)!;
    const halfCol = measure.columns.find((c) => c.offset.num === 1 && c.offset.den === 2)!;
    // A hair to the right of the first column should still snap to it.
    const x = system.x + zeroCol.x + Math.min(0.05, (halfCol.x - zeroCol.x) / 4);
    const hit = hitTestPoint(layout, page.index, x, system.y + treble.y + 2);
    expect(hit!.offset).toEqual(frac(0));
  });

  it("returns null for a page index that doesn't exist", () => {
    const layout = engrave(makeSingleMeasureScore(), { font: BRAVURA });
    expect(hitTestPoint(layout, 99, 0, 0)).toBeNull();
  });
});

describe("measureAtPoint (hover target for the measure +/− buttons)", () => {
  const score = newPianoScore({ measureCount: 3 });
  const layout = engrave(score, { font: BRAVURA });
  const page = layout.pages[0]!;
  const system = page.systems[0]!;
  const top = system.y + system.staves[0]!.y;
  const mid = (mi: number) => system.x + system.measures[mi]!.x + system.measures[mi]!.width / 2;

  it("finds the measure under the point, anywhere from the top staff to the bottom staff", () => {
    const lowerStaff = system.y + system.staves[1]!.y + 2;
    expect(measureAtPoint(layout, 0, mid(1), lowerStaff)?.measureIndex).toBe(1);
    const hit = measureAtPoint(layout, 0, mid(2), top + 1)!;
    expect(hit.measureIndex).toBe(2);
    expect(hit.top).toBeCloseTo(top, 6);
    const m2 = system.measures[2]!;
    expect(hit.right).toBeCloseTo(system.x + m2.x + m2.width, 6);
  });

  it("still counts the room above the top staff where the buttons sit, but not beyond it", () => {
    expect(measureAtPoint(layout, 0, mid(0), top - MEASURE_HOVER_ABOVE_SP + 0.5)?.measureIndex).toBe(0);
    expect(measureAtPoint(layout, 0, mid(0), top - MEASURE_HOVER_ABOVE_SP - 1)).toBeNull();
  });

  it("is null in the page margin", () => {
    expect(measureAtPoint(layout, 0, 0.5, top + 1)).toBeNull();
    expect(measureAtPoint(layout, 5, mid(0), top + 1)).toBeNull();
  });
});
