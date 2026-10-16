/**
 * Help / FAQ content for the "?" panel (HelpPanel.tsx). Add an entry by appending to
 * `FAQ`; keep answers in plain language, written for someone using the app, not
 * building it.
 *
 * Inline markup in any text: `keys` render as keyboard keys, **text** as bold.
 */

/** A paragraph, or a bulleted list of items. */
export type HelpBlock = string | { list: string[] };

export interface FaqEntry {
  /** Stable id (used as the React key and for linking later). */
  id: string;
  question: string;
  answer: HelpBlock[];
}

export const FAQ: FaqEntry[] = [
  {
    id: "chords",
    question: "How do I enter a chord? Do the notes need separate voices?",
    answer: [
      "No. A chord is one note with several pitches stacked on a single stem, all in one voice.",
      "With note entry on (`N`):",
      {
        list: [
          "**Keyboard:** type the bottom note, then hold `Shift` and type each note above it. For example `C`, then `Shift`+`E`, then `Shift`+`G` gives a C major chord. Each added pitch goes in the nearest octave above the chord's current top note, with the key signature applied.",
          "**MIDI keyboard:** play the keys together. A key pressed while others are still held joins the chord.",
          "**Adding to an existing chord later:** click one of its notes to select it, then press `Shift`+letter. With several chords selected, the note is added to each. With nothing selected, `Shift`+letter adds to the note just before the cursor.",
          "**Imports:** chords from MusicXML files and from PDF/photo recognition (Audiveris, homr) come in as chords.",
        ],
      },
      "Editing a chord:",
      {
        list: [
          "Click one notehead to select just that pitch. Then drag it up or down, press `+` / `-` to sharpen or flatten it, or `↑` / `↓` to move it a semitone (`Shift`+`↑` / `↓` for an octave).",
          "`Delete` removes just the **selected** note(s) and keeps the rest of the chord. To remove the whole chord, select all of its notes (for example, drag a box around it) and press `Delete`.",
        ],
      },
      "`Shift`+letter only adds notes **above** the chord's top note, so enter the lowest note first. To get a note below an existing chord, add it and then move it down an octave with `Shift`+`↓`, or drag it down.",
      "You only need a second voice when notes on the same staff move in **different rhythms** at the same time, such as a held half note under moving eighth notes. Press `V` (or the Voice 1/2 button) to switch voices. The two voices get opposite stem directions.",
    ],
  },
  {
    id: "change-duration",
    question: "How do I change how long a note or chord is?",
    answer: [
      "Click the note (or one note of the chord) to select it, then press a duration key: `1` whole, `2` half, `4` quarter, `8` eighth, `6` 16th, `3` 32nd. Press `.` to add or remove a dot. The Duration buttons in the palette do the same. This works with note entry on or off.",
      {
        list: [
          "**Longer:** the note writes over whatever follows it. A note it only partly covers turns into a rest for the time left over.",
          "**Shorter:** the time it frees up is filled with rests.",
          "A note can't be made longer than the space left in its measure. If it would run past the barline, nothing changes and the status bar tells you why.",
        ],
      },
      "A digit always gives the plain value; press `.` afterwards for a dotted one. With note entry on, the digit also becomes the length of the next note you type.",
      "**While typing notes,** a dot applies to the next note only: `8` `.` then the note gives a dotted eighth, and the dot switches itself off. So a dotted eighth followed by a 16th is `8` `.` [note] `6` [note]. The duration itself stays until you change it.",
      "Right after you type a note, the duration keys set up the **next** note; they don't change the one you just typed. To change a note you've already entered, click it first.",
    ],
  },
];

export type InlinePiece = { kind: "text" | "key" | "bold"; text: string };

/** Splits help text into plain text, `key` and **bold** pieces. Unmatched markers stay literal. */
export function parseInline(text: string): InlinePiece[] {
  const out: InlinePiece[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { kind: "key", text: m[1] } : { kind: "bold", text: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
