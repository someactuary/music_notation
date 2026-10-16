import { describe, expect, it } from "vitest";
import { frac, newPianoScore, note, rest, type Score, type VoiceItem } from "@/model";
import { History } from "@/commands/history";
import { makeTuplet } from "@/commands/edit";
import { addStaff } from "@/commands/staves";
import { defaultEditorState, handleKey } from "@/input/step-entry";
import type { ClipboardContent, Cursor, EditorState, EntryState, KeyResult, KeyStroke, Selection } from "@/input/types";

/** Narrows a VoiceItem to a RestEvent for assertions. */
function asRest(item: VoiceItem) {
  if (item.kind !== "rest") throw new Error("expected a rest event");
  return item;
}

/**
 * A tiny stand-in for the real store (src/ui): applies `KeyResult.commands` through
 * `History`, then adopts cursor/selection/entry, exactly as ARCHITECTURE.md describes.
 */
class Harness {
  history: History;
  cursor: Cursor;
  selection: Selection;
  entry: EntryState;
  clipboard: ClipboardContent | null;

  constructor(score: Score) {
    const initial = defaultEditorState(score);
    this.history = new History(score);
    this.cursor = initial.cursor;
    this.selection = initial.selection;
    this.entry = initial.entry;
    this.clipboard = initial.clipboard;
  }

  private state(): EditorState {
    return { score: this.history.current, cursor: this.cursor, selection: this.selection, entry: this.entry, clipboard: this.clipboard };
  }

  press(partial: Partial<KeyStroke> & { key: string }): KeyResult | null {
    const stroke: KeyStroke = { key: partial.key, shift: partial.shift ?? false, mod: partial.mod ?? false, alt: partial.alt ?? false };
    const result = handleKey(this.state(), stroke);
    if (result === null) return null;
    for (const cmd of result.commands) this.history.execute(cmd);
    if (result.history === "undo") this.history.undo();
    if (result.history === "redo") this.history.redo();
    if (result.cursor) this.cursor = result.cursor;
    if (result.selection) this.selection = result.selection;
    if (result.entry) this.entry = result.entry;
    if (result.clipboard !== undefined) this.clipboard = result.clipboard;
    return result;
  }

  voiceItems(measureIndex = 0, staffIndex = 0) {
    return this.history.current.parts[0]!.measures[measureIndex]!.staves[staffIndex]!.voices[0]!.items;
  }
}

describe("handleKey: note entry", () => {
  it('"n 5 c d e f" fills a 4/4 measure with quarters and advances into the next measure', () => {
    const h = new Harness(newPianoScore({ measureCount: 2 }));
    h.press({ key: "n" });
    expect(h.entry.active).toBe(true);
    h.press({ key: "4" }); // quarter
    h.press({ key: "c" });
    h.press({ key: "d" });
    h.press({ key: "e" });
    h.press({ key: "f" });

    expect(h.cursor).toEqual({ partIndex: 0, measureIndex: 1, staffIndex: 0, voiceIndex: 0, offset: frac(0) });

    const items = h.voiceItems(0);
    expect(items).toHaveLength(4);
    const spelled = items.map((it) => {
      if (it.kind !== "note") throw new Error("expected a note event");
      return `${it.notes[0]!.pitch.step}${it.notes[0]!.pitch.octave}`;
    });
    expect(spelled).toEqual(["C4", "D4", "E4", "F4"]);
  });

  it('"n 4 c", "6 d", "6 e" refuses the third write (doesn\'t fit the measure) with a message, leaving the score untouched', () => {
    const h = new Harness(newPianoScore({ measureCount: 1 })); // 4/4
    h.press({ key: "n" });
    h.press({ key: "8" }); // eighth
    h.press({ key: "c" }); // 1/8 used; writing into the sole measureRest immediately re-expresses
    // the remaining 7/8 as rests (half + quarter + eighth: 7/8 has no single-dot form)
    h.press({ key: "2" }); // half
    h.press({ key: "d" }); // overwrites the half-rest piece exactly: 1/8 + 1/2 = 5/8 used
    h.press({ key: "2" }); // half again
    const result = h.press({ key: "e" }); // would bring it to 9/8: refused

    expect(result?.commands).toEqual([]);
    expect(result?.message).toMatch(/does not fit/i);
    // eighth C4, half D4, and the untouched quarter-rest + eighth-rest tail from the first write
    expect(h.voiceItems(0).map((it) => it.kind)).toEqual(["note", "note", "rest", "rest"]);
  });

  it("nearest-octave rule: from a C4 reference, typing g lands on G3 (distance 3 beats G4's distance 4)", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" }); // reference is now C4
    h.press({ key: "g" });

    const ev = h.voiceItems(0)[1]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    // MuseScore-users might expect G4 (a 5th up); the specified diatonic-distance rule
    // strictly prefers G3 (|25-28|=3) over G4 (|32-28|=4), so that's what we assert.
    expect(ev.notes[0]!.pitch).toEqual({ step: "G", alter: 0, octave: 3 });
  });

  it("nearest-octave rule: from a C4 reference, typing b lands on B3", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" });
    h.press({ key: "b" });

    const ev = h.voiceItems(0)[1]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    expect(ev.notes[0]!.pitch).toEqual({ step: "B", alter: 0, octave: 3 });
  });

  it("Shift+letter adds a note to the chord before the cursor without moving the cursor", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" });
    const cursorBefore = h.cursor;

    h.press({ key: "e", shift: true });

    expect(h.cursor).toEqual(cursorBefore);
    const ev = h.voiceItems(0)[0]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    expect(ev.notes.map((n) => `${n.pitch.step}${n.pitch.octave}`)).toEqual(["C4", "E4"]);
  });

  it("Shift+letter with a rest (or nothing) before the cursor does nothing but report a message", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    const result = h.press({ key: "c", shift: true }); // cursor is at the very start; nothing before it

    expect(result?.commands).toEqual([]);
    expect(result?.message).toBeTruthy();
    expect(h.voiceItems(0)).toHaveLength(1);
    expect(h.voiceItems(0)[0]!.kind).toBe("rest");
  });

  it('"0" enters a rest of the current duration and advances the cursor', () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" }); // quarter
    h.press({ key: "c" }); // quarter C4 at offset 0; cursor -> 1/4
    h.press({ key: "0" }); // quarter rest at offset 1/4; cursor -> 1/2

    expect(h.cursor.offset).toEqual(frac(1, 2));
    const items = h.voiceItems(0);
    expect(items[0]!.kind).toBe("note");
    expect(items[1]!.kind).toBe("rest");
    expect(asRest(items[1]!).duration).toEqual({ base: 4, dots: 0 });
    expect(asRest(items[1]!).measureRest).toBeUndefined();
  });

  it('"0" in an otherwise-empty measure still normalizes back to a single measureRest (an all-rest voice always collapses)', () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "0" }); // quarter rest at offset 0; the other 3/4 is also rests

    expect(h.cursor.offset).toEqual(frac(1, 4));
    const items = h.voiceItems(0);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("rest");
    expect(asRest(items[0]!).measureRest).toBe(true);
  });

  it("integration: writing through step-entry follows the writeEvent span-replace rules", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    voice.items = [note("C4", 2), note("D4", 2)]; // two half notes filling 4/4
    const h = new Harness(score);
    h.entry = { ...h.entry, active: true, base: 4 }; // quarter, entry mode on, cursor at offset 0

    h.press({ key: "e" }); // overwrites the first half of the first half note

    const items = h.voiceItems(0);
    expect(items).toHaveLength(3);
    expect(items[0]!.kind).toBe("note");
    expect(items[1]!.kind).toBe("rest");
    expect(asRest(items[1]!).duration).toEqual({ base: 4, dots: 0 }); // remainder of the overwritten half note
    expect(items[2]!.kind).toBe("note"); // untouched D4 half note
  });

  it("key-signature-aware letter entry: in D major, typing f enters F#", () => {
    const score = newPianoScore({ measureCount: 1, keySig: { fifths: 2, mode: "major" } }); // D major: F#, C#
    const h = new Harness(score);
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "f" });

    const ev = h.voiceItems(0)[0]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    expect(ev.notes[0]!.pitch).toEqual({ step: "F", alter: 1, octave: 4 });
  });

  it('"+" sets a pending sharp for the next letter and is cleared after use; with a note selected it applies immediately', () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "+" });
    expect(h.entry.alter).toBe(1);

    h.press({ key: "c" });
    let ev = h.voiceItems(0)[0]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    expect(ev.notes[0]!.pitch).toEqual({ step: "C", alter: 1, octave: 4 });
    expect(h.entry.alter).toBeNull();

    // the just-entered C# is selected: "-" should apply immediately instead of setting a pending alter
    h.press({ key: "-" });
    ev = h.voiceItems(0)[0]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    expect(ev.notes[0]!.pitch.alter).toBe(-1);
    expect(h.entry.alter).toBeNull();
  });

  it("leaves mod+= / mod+- / mod+0 unhandled so they reach the browser's zoom", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" }); // entry active and a note selected: plain +/-/0 would all be handled
    for (const key of ["=", "+", "-", "0"]) {
      expect(h.press({ key, mod: true })).toBeNull();
    }
    const ev = h.voiceItems(0)[0]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    expect(ev.notes[0]!.pitch.alter).toBe(0);
    expect(h.voiceItems(0)).toHaveLength(3); // the C plus the rest-filled remainder (quarter + half rest), no extra rest entered
  });
});

describe("handleKey: erase", () => {
  it("Backspace erases the note before the cursor to a rest, and normalizes an all-rest measure to a measureRest", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" });
    expect(h.cursor.offset).toEqual(frac(1, 4));

    h.press({ key: "Backspace" });

    expect(h.cursor.offset).toEqual(frac(0));
    const items = h.voiceItems(0);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("rest");
    expect(asRest(items[0]!).measureRest).toBe(true);
  });

  it("Delete erases the event at the cursor without moving the cursor", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    voice.items = [note("C4", 4), rest(4), rest(2)];
    const h = new Harness(score);
    h.entry = { ...h.entry, active: true };
    const cursorBefore = h.cursor;

    h.press({ key: "Delete" });

    expect(h.cursor).toEqual(cursorBefore);
    expect(h.voiceItems(0)[0]!.kind).toBe("rest");
  });
});

describe("handleKey: ties and transposition", () => {
  it('"t" toggles a tie on the note before the cursor', () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" });

    h.press({ key: "t" });
    let ev = h.voiceItems(0)[0]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    expect(ev.notes[0]!.tieStart).toBe(true);

    h.press({ key: "t" });
    ev = h.voiceItems(0)[0]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    expect(ev.notes[0]!.tieStart).toBe(false);
  });

  it("ArrowUp/ArrowDown transpose the note before the cursor by a semitone, Shift by an octave", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" });

    h.press({ key: "ArrowUp" });
    let ev = h.voiceItems(0)[0]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    expect(ev.notes[0]!.pitch).toEqual({ step: "C", alter: 1, octave: 4 });

    h.press({ key: "ArrowDown", shift: true });
    ev = h.voiceItems(0)[0]!;
    if (ev.kind !== "note") throw new Error("expected a note event");
    expect(ev.notes[0]!.pitch).toEqual({ step: "C", alter: 1, octave: 3 });
  });
});

describe("handleKey: cursor navigation", () => {
  it("ArrowRight/ArrowLeft move across events and measures; Home/End jump within a measure; mod+Arrow jumps measures", () => {
    const score = newPianoScore({ measureCount: 2 });
    const voice0 = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    voice0.items = [note("C4", 4), note("D4", 4), rest(2)]; // 1/4 + 1/4 + 1/2
    const h = new Harness(score);

    h.press({ key: "ArrowRight" });
    expect(h.cursor).toMatchObject({ measureIndex: 0, offset: frac(1, 4) });
    h.press({ key: "ArrowRight" });
    expect(h.cursor).toMatchObject({ measureIndex: 0, offset: frac(1, 2) });
    h.press({ key: "ArrowRight" }); // no more events in measure 0: crosses into measure 1
    expect(h.cursor).toMatchObject({ measureIndex: 1, offset: frac(0) });

    h.press({ key: "ArrowLeft" }); // back to measure 0's last event
    expect(h.cursor).toMatchObject({ measureIndex: 0, offset: frac(1, 2) });

    h.press({ key: "Home" });
    expect(h.cursor.offset).toEqual(frac(0));
    h.press({ key: "End" });
    expect(h.cursor.offset).toEqual(frac(1, 2));

    h.press({ key: "ArrowRight", mod: true });
    expect(h.cursor).toMatchObject({ measureIndex: 1, offset: frac(0) });
    h.press({ key: "ArrowLeft", mod: true });
    expect(h.cursor).toMatchObject({ measureIndex: 0, offset: frac(0) });
    // stops (doesn't wrap) at the score's start
    h.press({ key: "ArrowLeft", mod: true });
    expect(h.cursor).toMatchObject({ measureIndex: 0, offset: frac(0) });
  });

  it("Tab toggles staffIndex between 0 and 1, keeping measure/offset", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "Tab" });
    expect(h.cursor).toMatchObject({ staffIndex: 1, measureIndex: 0, offset: frac(0) });
    h.press({ key: "Tab" });
    expect(h.cursor.staffIndex).toBe(0);
  });

  it("Escape turns off entry mode and clears the selection", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" });
    expect(h.selection.ids).toHaveLength(1);

    h.press({ key: "Escape" });

    expect(h.entry.active).toBe(false);
    expect(h.selection.ids).toEqual([]);
  });

  it("ArrowRight from offset 0 with nothing selected selects the measure's FIRST event, not the second", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const c = note("C4", 4);
    const d = note("D4", 4);
    voice.items = [c, d, rest(2)];
    const h = new Harness(score);
    expect(h.selection.ids).toEqual([]); // nothing selected, cursor at offset 0

    h.press({ key: "ArrowRight" });

    expect(h.selection.ids).toEqual([c.notes[0]!.id]);
    // the cursor still advances past the now-selected first event, same as before
    expect(h.cursor.offset).toEqual(frac(1, 4));
  });

  it("ArrowRight with something already selected keeps selecting the next event as before", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const c = note("C4", 4);
    const d = note("D4", 4);
    voice.items = [c, d, rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [c.notes[0]!.id] }; // already selected, unlike the previous test

    h.press({ key: "ArrowRight" });

    expect(h.selection.ids).toEqual([d.notes[0]!.id]);
  });

  it("ArrowRight from offset 0 in a measure with a single whole-note event selects it and stays put", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const whole = note("C4", 1);
    voice.items = [whole];
    const h = new Harness(score);

    h.press({ key: "ArrowRight" });

    expect(h.selection.ids).toEqual([whole.notes[0]!.id]);
    expect(h.cursor.offset).toEqual(frac(0));
  });
});

describe("handleKey: undo/redo", () => {
  it("mod+z undoes and mod+shift+Z redoes the last write", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" });
    expect(h.voiceItems(0)[0]!.kind).toBe("note");

    h.press({ key: "z", mod: true });
    expect(h.voiceItems(0)).toHaveLength(1);
    expect(h.voiceItems(0)[0]!.kind).toBe("rest");
    expect(asRest(h.voiceItems(0)[0]!).measureRest).toBe(true);

    h.press({ key: "Z", mod: true, shift: true });
    expect(h.voiceItems(0)[0]!.kind).toBe("note");
  });
});

describe("handleKey: unhandled keys", () => {
  it("returns null for a letter outside a-g, and for keys with no effect when entry is inactive", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    expect(h.press({ key: "z" })).toBeNull(); // no mod: not undo, not in a-g
    expect(h.press({ key: "4" })).toBeNull(); // entry not active: digit is unhandled
    expect(h.press({ key: "c" })).toBeNull(); // entry not active: letter is unhandled
  });
});

describe("handleKey: clipboard", () => {
  it("mod+c with nothing selected reports 'Nothing selected' and sets no clipboard", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    const result = h.press({ key: "c", mod: true });

    expect(result?.commands).toEqual([]);
    expect(result?.message).toMatch(/nothing selected/i);
    expect(h.clipboard).toBeNull();
  });

  it("mod+c copies the selected note and reports how many", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" }); // enters C4; selects it

    const result = h.press({ key: "c", mod: true });

    expect(result?.message).toMatch(/copied 1 notes/i);
    expect(h.clipboard).not.toBeNull();
    expect(h.clipboard!.staves[0]!.items).toHaveLength(1);
  });

  it("mod+c on a selection that includes a rest reports 'N events', not 'N notes'", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const c = note("C4", 4);
    const r = rest(4);
    voice.items = [c, r, rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [c.notes[0]!.id, r.id] };

    const result = h.press({ key: "c", mod: true });

    expect(result?.message).toBe("Copied 2 events");
  });

  it("mod+v pastes two copied quarters at another measure with the same pitches", () => {
    const h = new Harness(newPianoScore({ measureCount: 3 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" });
    h.press({ key: "d" });
    // select both just-entered notes
    h.selection = { ids: [h.voiceItems(0)[0]!.id, h.voiceItems(0)[1]!.id] };
    const copyResult = h.press({ key: "c", mod: true });
    expect(copyResult?.message).toBe("Copied 2 notes");

    h.cursor = { partIndex: 0, measureIndex: 2, staffIndex: 0, voiceIndex: 0, offset: frac(0) };
    h.selection = { ids: [] };
    const pasteResult = h.press({ key: "v", mod: true });

    const items = h.voiceItems(2);
    const spelled = items.slice(0, 2).map((it) => {
      if (it.kind !== "note") throw new Error("expected a note event");
      return it.notes[0]!.pitch.step;
    });
    expect(spelled).toEqual(["C", "D"]);
    expect(h.selection.ids).toEqual([]);
    expect(h.cursor).toMatchObject({ measureIndex: 2, offset: frac(1, 2) });
    expect(pasteResult?.message).toBe("Pasted 2 notes");
  });

  it("mod+v with nothing copied reports 'Nothing to paste'", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    const result = h.press({ key: "v", mod: true });
    expect(result?.message).toMatch(/nothing to paste/i);
  });

  it("mod+x copies then erases the selection, leaving rests", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" }); // enters and selects C4

    h.press({ key: "x", mod: true });

    expect(h.clipboard).not.toBeNull();
    expect(h.selection.ids).toEqual([]);
    const items = h.voiceItems(0);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("rest");
    expect(asRest(items[0]!).measureRest).toBe(true);
    expect(h.cursor.offset).toEqual(frac(0));
  });
});

describe("handleKey: measures", () => {
  it('"Enter" inserts an empty measure right after the cursor measure', () => {
    const h = new Harness(newPianoScore({ measureCount: 2 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" }); // measure 0 now has a note
    h.cursor = { ...h.cursor, measureIndex: 0, offset: frac(0) };

    h.press({ key: "Enter" });

    expect(h.history.current.parts[0]!.measures).toHaveLength(3);
    // the note is still in measure 0; the new empty measure is at index 1
    expect(h.voiceItems(0)[0]!.kind).toBe("note");
    const inserted = h.history.current.parts[0]!.measures[1]!.staves[0]!.voices[0]!.items;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.kind).toBe("rest");
  });

  it("Shift+Enter inserts an empty measure before the cursor measure and keeps the cursor on the same music", () => {
    const h = new Harness(newPianoScore({ measureCount: 2 }));
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" }); // measure 0 has a note
    h.cursor = { ...h.cursor, measureIndex: 0, offset: frac(0) };

    h.press({ key: "Enter", shift: true });

    expect(h.history.current.parts[0]!.measures).toHaveLength(3);
    expect(h.cursor.measureIndex).toBe(1); // followed its music into the shifted slot
    const music = h.history.current.parts[0]!.measures[1]!.staves[0]!.voices[0]!.items;
    expect(music[0]!.kind).toBe("note");
    const insertedBefore = h.history.current.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items;
    expect(insertedBefore[0]!.kind).toBe("rest");
  });

  it("mod+Backspace removes the cursor measure", () => {
    const h = new Harness(newPianoScore({ measureCount: 2 }));
    h.cursor = { ...h.cursor, measureIndex: 1 };

    h.press({ key: "Backspace", mod: true });

    expect(h.history.current.parts[0]!.measures).toHaveLength(1);
    expect(h.cursor).toMatchObject({ measureIndex: 0, offset: frac(0) });
  });

  it("mod+Delete refuses to remove the only measure", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    const result = h.press({ key: "Delete", mod: true });

    expect(result?.commands).toEqual([]);
    expect(result?.message).toMatch(/only measure/i);
    expect(h.history.current.parts[0]!.measures).toHaveLength(1);
  });
});

describe("handleKey: selection erase and extend", () => {
  it("Delete with a multi-note selection erases every selected note", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const c = note("C4", 4);
    const d = note("D4", 4);
    const e = note("E4", 4);
    voice.items = [c, d, e, rest(4)];
    const h = new Harness(score);
    h.selection = { ids: [c.notes[0]!.id, e.notes[0]!.id] }; // two of the three notes

    h.press({ key: "Delete" });

    const items = h.voiceItems(0);
    expect(items[0]!.kind).toBe("rest");
    expect(items[1]!.kind).toBe("note"); // D was not selected, stays a note
    expect(items[2]!.kind).toBe("rest");
    expect(h.selection.ids).toEqual([]);
    expect(h.cursor.offset).toEqual(frac(0)); // earliest erased event (C) was at offset 0
  });

  it("Backspace with a multi-note selection also erases every selected note (not just before the cursor)", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const c = note("C4", 4);
    const d = note("D4", 4);
    voice.items = [c, d, rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [c.notes[0]!.id, d.notes[0]!.id] };

    h.press({ key: "Backspace" });

    expect(h.voiceItems(0)).toHaveLength(1);
    expect(h.voiceItems(0)[0]!.kind).toBe("rest");
    expect(asRest(h.voiceItems(0)[0]!).measureRest).toBe(true);
  });

  it("shift+ArrowRight grows the selection to include the next event and moves the cursor there", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const c = note("C4", 4);
    const d = note("D4", 4);
    voice.items = [c, d, rest(2)];
    const h = new Harness(score);
    h.cursor = { ...h.cursor, offset: frac(0) };
    h.selection = { ids: [c.notes[0]!.id] };

    h.press({ key: "ArrowRight", shift: true });

    expect(h.selection.ids).toEqual(expect.arrayContaining([c.notes[0]!.id, d.notes[0]!.id]));
    expect(h.cursor.offset).toEqual(frac(1, 4));
  });

  it("shift+ArrowLeft grows the selection to include the previous event", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const c = note("C4", 4);
    const d = note("D4", 4);
    voice.items = [c, d, rest(2)];
    const h = new Harness(score);
    h.cursor = { ...h.cursor, offset: frac(1, 4) }; // at D's own start
    h.selection = { ids: [d.notes[0]!.id] };

    h.press({ key: "ArrowLeft", shift: true });

    expect(h.selection.ids).toEqual(expect.arrayContaining([c.notes[0]!.id, d.notes[0]!.id]));
    expect(h.cursor.offset).toEqual(frac(0));
  });

  it("mod+a selects every event on both staves", () => {
    const score = newPianoScore({ measureCount: 2 });
    const treble0 = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const bass0 = score.parts[0]!.measures[0]!.staves[1]!.voices[0]!;
    const c = note("C4", 1); // fills measure 0's treble staff entirely
    const g = note("C3", 1);
    treble0.items = [c];
    bass0.items = [g];
    // measure 1 keeps its default whole-measure rests on both staves.
    const h = new Harness(score);

    h.press({ key: "a", mod: true });

    // 1 note id (treble m0) + 1 rest id (treble m1) + 1 note id (bass m0) + 1 rest id (bass m1)
    expect(h.selection.ids).toHaveLength(4);
    expect(h.selection.ids).toContain(c.notes[0]!.id);
    expect(h.selection.ids).toContain(g.notes[0]!.id);
  });

  it("mod+a also selects events in every voice, not just voice 0", () => {
    const score = newPianoScore({ measureCount: 1 });
    const sm = score.parts[0]!.measures[0]!.staves[0]!;
    const v0Note = note("C4", 1);
    sm.voices[0]!.items = [v0Note];
    const v1Note = note("C3", 1);
    sm.voices.push({ id: "v1", index: 1, items: [v1Note] });
    const h = new Harness(score);

    h.press({ key: "a", mod: true });

    expect(h.selection.ids).toEqual(expect.arrayContaining([v0Note.notes[0]!.id, v1Note.notes[0]!.id]));
    // both staves' voice-1 rest tails don't exist here (only staff 0 was touched, staff
    // 1 keeps its default measureRest in voice 0), so exactly these two plus that rest.
    expect(h.selection.ids).toHaveLength(3);
  });
});

describe("handleKey: writing into a tuplet", () => {
  it('making a triplet at the cursor, then "n 8 c d e" fills its three slots and the cursor advances by the sounding length', () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const quarter = note("C4", 4);
    voice.items = [quarter, rest(4), rest(2)]; // quarter at offset 0, filling the rest of the measure

    const h = new Harness(score);
    h.history.execute(makeTuplet(quarter.id, 3, 2)); // quarter -> triplet of eighths; cursor stays at offset 0

    h.press({ key: "n" });
    h.press({ key: "8" }); // eighth
    h.press({ key: "c" });
    h.press({ key: "d" });
    h.press({ key: "e" });

    const group = h.voiceItems(0)[0]!;
    if (group.kind !== "tuplet") throw new Error("expected a tuplet");
    expect(group.items).toHaveLength(3);
    const spelled = group.items.map((it) => {
      if (it.kind !== "note") throw new Error("expected a note event");
      return it.notes[0]!.pitch.step;
    });
    expect(spelled).toEqual(["C", "D", "E"]);
    // three triplet eighths sound 1/4 total, same as the original quarter.
    expect(h.cursor).toEqual({ partIndex: 0, measureIndex: 0, staffIndex: 0, voiceIndex: 0, offset: frac(1, 4) });
  });

  it("refuses a write that doesn't fit inside the tuplet's own remaining capacity, with a tuplet-specific message", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const quarter = note("C4", 4);
    voice.items = [quarter, rest(4), rest(2)];

    const h = new Harness(score);
    h.history.execute(makeTuplet(quarter.id, 3, 2)); // triplet capacity is 3/8
    h.entry = { ...h.entry, active: true, base: 2 }; // a half note (1/2) doesn't fit in 3/8

    const result = h.press({ key: "c" });

    expect(result?.commands).toEqual([]);
    expect(result?.message).toMatch(/tuplet/i);
    // nothing was written: still the untouched triplet.
    const group = h.voiceItems(0)[0]!;
    expect(group.kind).toBe("tuplet");
  });
});

describe("handleKey: voices", () => {
  function voiceByIndex(h: Harness, voiceIndex: number, measureIndex = 0, staffIndex = 0) {
    return h.history.current.parts[0]!.measures[measureIndex]!.staves[staffIndex]!.voices.find((v) => v.index === voiceIndex);
  }

  it('"v" cycles the cursor voice 0 -> 1 -> 0, reporting it in the message', () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    expect(h.cursor.voiceIndex).toBe(0);

    const toOne = h.press({ key: "v" });
    expect(h.cursor.voiceIndex).toBe(1);
    expect(toOne?.message).toBe("Voice 2");

    const toZero = h.press({ key: "v" });
    expect(h.cursor.voiceIndex).toBe(0);
    expect(toZero?.message).toBe("Voice 1");
  });

  it("mod+alt+1..4 sets the cursor voice directly", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));

    h.press({ key: "3", mod: true, alt: true });
    expect(h.cursor.voiceIndex).toBe(2);

    h.press({ key: "1", mod: true, alt: true });
    expect(h.cursor.voiceIndex).toBe(0);
  });

  it("writing into a voice index that doesn't exist creates it (measure-rest filled), keeping voices sorted by index", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.cursor = { ...h.cursor, voiceIndex: 1 };
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" });

    const sm = h.history.current.parts[0]!.measures[0]!.staves[0]!;
    expect(sm.voices.map((v) => v.index)).toEqual([0, 1]); // sorted, voice 0 untouched
    const voice1 = voiceByIndex(h, 1)!;
    expect(voice1.items[0]!.kind).toBe("note");
    const voice0 = voiceByIndex(h, 0)!;
    expect(voice0.items).toHaveLength(1);
    expect(voice0.items[0]!.kind).toBe("rest");
    if (voice0.items[0]!.kind === "rest") expect(voice0.items[0]!.measureRest).toBe(true);
  });

  it("creating voice 2 directly (skipping voice 1) still keeps the array sorted by index", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.cursor = { ...h.cursor, voiceIndex: 2 };
    h.press({ key: "n" });
    h.press({ key: "4" });
    h.press({ key: "c" });

    const sm = h.history.current.parts[0]!.measures[0]!.staves[0]!;
    expect(sm.voices.map((v) => v.index)).toEqual([0, 2]);
  });

  it('"h" toggles invisible on selected rests', () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const r = rest(4);
    voice.items = [r, rest(4), rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [r.id] };

    h.press({ key: "h" });
    let updated = h.voiceItems(0)[0]!;
    if (updated.kind !== "rest") throw new Error("expected a rest");
    expect(updated.invisible).toBe(true);

    h.selection = { ids: [r.id] };
    h.press({ key: "h" });
    updated = h.voiceItems(0)[0]!;
    if (updated.kind !== "rest") throw new Error("expected a rest");
    expect(updated.invisible).toBe(false);
  });

  it('"h" with nothing selected (or only notes selected) is unhandled', () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    expect(h.press({ key: "h" })).toBeNull();
  });
});

describe("handleKey: Tab cycles all staves", () => {
  it("addStaff then Tab cycles through all three staves", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 })); // treble, bass
    h.history.execute(addStaff(1, "alto")); // treble, alto, bass

    expect(h.cursor.staffIndex).toBe(0);
    h.press({ key: "Tab" });
    expect(h.cursor.staffIndex).toBe(1);
    h.press({ key: "Tab" });
    expect(h.cursor.staffIndex).toBe(2);
    h.press({ key: "Tab" });
    expect(h.cursor.staffIndex).toBe(0);
  });
});

describe("handleKey: duration digits and '.' on a selection (entry off) act on the selection", () => {
  it('a duration digit with a non-empty selection and entry OFF applies setDuration instead of changing the pending duration', () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const ev = note("C4", 4);
    voice.items = [ev, rest(4), rest(2)];
    const h = new Harness(score);
    expect(h.entry.active).toBe(false);
    h.selection = { ids: [ev.notes[0]!.id] };

    h.press({ key: "2" }); // half

    expect(h.entry.base).toBe(4); // pending duration untouched
    const items = h.voiceItems(0);
    if (items[0]!.kind !== "note") throw new Error("expected a note");
    expect(items[0]!.duration).toEqual({ base: 2, dots: 0 });
  });

  it('"." with a non-empty selection and entry OFF toggles the dot on the selection', () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const ev = note("C4", 4);
    voice.items = [ev, rest(4), rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [ev.notes[0]!.id] };

    h.press({ key: "." });

    expect(h.entry.dots).toBe(0); // pending entry state untouched
    const items = h.voiceItems(0);
    if (items[0]!.kind !== "note") throw new Error("expected a note");
    expect(items[0]!.duration).toEqual({ base: 4, dots: 1 });
  });

  it("a duration digit with entry ON still changes the pending duration, even with a selection", () => {
    const h = new Harness(newPianoScore({ measureCount: 1 }));
    h.press({ key: "n" });
    h.selection = { ids: ["something"] };

    h.press({ key: "8" });

    expect(h.entry.base).toBe(8);
  });
});

describe("handleKey: slur / hairpin / tuplet shortcuts", () => {
  it('"s" creates a slur between two selected notes', () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const c = note("C4", 4);
    const d = note("D4", 4);
    voice.items = [c, d, rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [c.notes[0]!.id, d.notes[0]!.id] };

    h.press({ key: "s" });

    expect(h.history.current.spanners).toHaveLength(1);
    expect(h.history.current.spanners[0]!.kind).toBe("slur");
  });

  it('"x" flips the selected note\'s stem direction', () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const a = note("A4", 4);
    a.stem = "down";
    voice.items = [a, rest(4), rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [a.notes[0]!.id] };

    h.press({ key: "x" });

    const items = h.history.current.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items;
    expect(items[0]!.kind === "note" && items[0]!.stem).toBe("up");
  });

  it('"<" and ">" add cresc / dim hairpins', () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const c = note("C4", 4);
    const d = note("D4", 4);
    voice.items = [c, d, rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [c.notes[0]!.id, d.notes[0]!.id] };

    h.press({ key: "<" });
    const sp = h.history.current.spanners[0]!;
    expect(sp.kind).toBe("hairpin");
    if (sp.kind === "hairpin") expect(sp.shape).toBe("cresc");

    h.press({ key: ">" });
    const sp2 = h.history.current.spanners[1]!;
    if (sp2.kind === "hairpin") expect(sp2.shape).toBe("dim");
  });

  it("mod+3 makes a triplet (3:2) of the selected event", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const ev = note("C4", 4);
    voice.items = [ev, rest(4), rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [ev.notes[0]!.id] };

    h.press({ key: "3", mod: true });

    const group = h.voiceItems(0)[0]!;
    expect(group.kind).toBe("tuplet");
    if (group.kind === "tuplet") expect(group.ratio).toEqual({ actual: 3, normal: 2, unit: 8 });
  });

  it("mod+5 / mod+2 make 5:4 and 2:3 tuplets", () => {
    const score = newPianoScore({ measureCount: 1 });
    const voice = score.parts[0]!.measures[0]!.staves[0]!.voices[0]!;
    const ev = note("C4", 4);
    voice.items = [ev, rest(4), rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [ev.notes[0]!.id] };

    h.press({ key: "5", mod: true });
    const group = h.voiceItems(0)[0]!;
    if (group.kind !== "tuplet") throw new Error("expected a tuplet");
    expect(group.ratio.actual).toBe(5);
    expect(group.ratio.normal).toBe(4);
  });
});

describe("Delete/Backspace on a selected marking (slur/hairpin/dynamic/etc.)", () => {
  function scoreWithDynamic(): { score: Score; attachmentId: string; noteId: string } {
    const score = newPianoScore({ measureCount: 1 });
    const ev = note("C4", 4);
    score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [ev, note("D4", 4), rest(2)];
    const attachmentId = "dyn-1";
    score.attachments.push({
      id: attachmentId,
      kind: "dynamic",
      text: "p",
      partIndex: 0,
      staffIndex: 0,
      anchor: { kind: "event", eventId: ev.id },
    });
    return { score, attachmentId, noteId: ev.notes[0]!.id };
  }

  it("Delete on a selected attachment removes it via removeAttachment, not eraseEvent", () => {
    const { score, attachmentId, noteId } = scoreWithDynamic();
    const h = new Harness(score);
    h.selection = { ids: [attachmentId] };

    h.press({ key: "Delete" });

    expect(h.history.current.attachments).toHaveLength(0);
    // The note the dynamic was anchored to is untouched.
    const voice = h.history.current.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items;
    expect(voice.some((it) => it.kind === "note" && it.notes[0]!.id === noteId)).toBe(true);
    expect(h.selection.ids).toEqual([]);
  });

  it("Backspace on a selected spanner removes it via removeSpanner", () => {
    const score = newPianoScore({ measureCount: 1 });
    const a = note("C4", 4);
    const b = note("D4", 4);
    score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [a, b, rest(2)];
    score.spanners.push({
      id: "slur-1",
      kind: "slur",
      partIndex: 0,
      staffIndex: 0,
      start: { kind: "event", eventId: a.id },
      end: { kind: "event", eventId: b.id },
    });
    const h = new Harness(score);
    h.selection = { ids: ["slur-1"] };

    h.press({ key: "Backspace" });

    expect(h.history.current.spanners).toHaveLength(0);
  });

  it("also clears any nudge recorded for the deleted marking", () => {
    const { score, attachmentId } = scoreWithDynamic();
    score.layout.nudges[attachmentId] = { dx: 1, dy: 1 };
    const h = new Harness(score);
    h.selection = { ids: [attachmentId] };

    h.press({ key: "Delete" });

    expect(h.history.current.layout.nudges[attachmentId]).toBeUndefined();
  });

  it("a mixed selection (a note plus a marking) deletes both: the marking by id, the note via eraseEvent", () => {
    const { score, attachmentId, noteId } = scoreWithDynamic();
    const h = new Harness(score);
    h.selection = { ids: [attachmentId, noteId] };

    h.press({ key: "Delete" });

    expect(h.history.current.attachments).toHaveLength(0);
    const voice = h.history.current.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items;
    // The note is replaced by a rest of the same duration (eraseEvent's contract).
    expect(voice.some((it) => it.kind === "note" && it.notes.some((n) => n.id === noteId))).toBe(false);
  });

  it("Cmd+X (cut) on a selected marking deletes it (it isn't copyable, so nothing lands on the clipboard for it)", () => {
    const { score, attachmentId } = scoreWithDynamic();
    const h = new Harness(score);
    h.selection = { ids: [attachmentId] };

    h.press({ key: "x", mod: true });

    expect(h.history.current.attachments).toHaveLength(0);
  });
});

describe("Delete/Backspace strips a tie/decorations before ever erasing the note", () => {
  // Regression: measures 67-79 of a real imported file had dense, overlapping slurs
  // and ties. Clicking near a slur sometimes resolves to a TIE instead (ties always
  // ref their start note's own id — see ties.ts), and a tie's id is indistinguishable
  // from "the user selected the note itself." Before this fix, Delete on that
  // selection erased the whole note. Now it removes the tie first.
  it("Delete on a tied note removes the tie (not the note), keeps it selected, and a second Delete then erases it", () => {
    const score = newPianoScore({ measureCount: 2 });
    const a = note("C4", 4);
    a.notes[0]!.tieStart = true;
    const b = note("C4", 4);
    score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [a, b, rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [a.notes[0]!.id] };

    const result1 = h.press({ key: "Delete" });

    const voice1 = h.voiceItems();
    expect(voice1[0]).toMatchObject({ kind: "note", notes: [{ id: a.notes[0]!.id, tieStart: false }] });
    expect(h.selection.ids).toEqual([a.notes[0]!.id]); // stays selected
    expect(result1?.message).toMatch(/press Delete again/i);

    h.press({ key: "Delete" });

    const voice2 = h.voiceItems();
    expect(voice2[0]).toMatchObject({ kind: "rest" }); // now genuinely erased
  });

  it("Delete on a note with an accent (or any articulation) clears it instead of erasing the note", () => {
    const score = newPianoScore({ measureCount: 1 });
    const ev = note("C4", 4);
    ev.articulations = ["accent"];
    score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [ev, rest(4), rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [ev.notes[0]!.id] };

    h.press({ key: "Delete" });

    const voice = h.voiceItems();
    expect(voice[0]).toMatchObject({ kind: "note" }); // still a note
    expect((voice[0] as typeof ev).articulations).toBeUndefined();
    expect(h.selection.ids).toEqual([ev.notes[0]!.id]);
  });

  it("Delete on a note with BOTH a tie and an articulation strips both in one press", () => {
    const score = newPianoScore({ measureCount: 2 });
    const a = note("C4", 4);
    a.notes[0]!.tieStart = true;
    a.articulations = ["tenuto"];
    const b = note("C4", 4);
    score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [a, rest(4), rest(2)];
    score.parts[0]!.measures[1]!.staves[0]!.voices[0]!.items = [b, rest(4), rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [a.notes[0]!.id] };

    h.press({ key: "Delete" });

    const voice = h.voiceItems();
    expect(voice[0]).toMatchObject({ kind: "note", notes: [{ tieStart: false }] });
    expect((voice[0] as typeof a).articulations).toBeUndefined();
  });

  it("Delete on a plain note (no tie, no decorations) still erases immediately, as before", () => {
    const score = newPianoScore({ measureCount: 1 });
    const ev = note("C4", 4);
    score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [ev, rest(4), rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [ev.notes[0]!.id] };

    const result = h.press({ key: "Delete" });

    expect(h.voiceItems()[0]).toMatchObject({ kind: "rest" });
    expect(h.selection.ids).toEqual([]);
    expect(result?.message).toBeUndefined();
  });

  it("a mixed selection strips the decorated note and erases the plain one, keeping only the decorated one selected", () => {
    const score = newPianoScore({ measureCount: 1 });
    const decorated = note("C4", 4);
    decorated.articulations = ["staccato"];
    const plain = note("D4", 4);
    score.parts[0]!.measures[0]!.staves[0]!.voices[0]!.items = [decorated, plain, rest(2)];
    const h = new Harness(score);
    h.selection = { ids: [decorated.notes[0]!.id, plain.notes[0]!.id] };

    h.press({ key: "Delete" });

    const voice = h.voiceItems();
    expect(voice[0]).toMatchObject({ kind: "note" }); // decorated note survives, stripped
    expect((voice[0] as typeof decorated).articulations).toBeUndefined();
    expect(voice[1]).toMatchObject({ kind: "rest" }); // plain note erased
    expect(h.selection.ids).toEqual([decorated.notes[0]!.id]);
  });
});
