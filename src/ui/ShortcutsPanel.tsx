/** Keyboard reference shown in-app. Keep in sync with src/input/step-entry.ts and docs/SHORTCUTS.md. */
const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Modes",
    rows: [
      ["N", "Toggle note entry (required before typing notes)"],
      ["Esc", "Leave note entry, clear selection"],
    ],
  },
  {
    title: "Durations (entry on)",
    rows: [
      ["1 / 2 / 4", "Whole / half / quarter"],
      ["8 / 6 / 3", "Eighth / 16th / 32nd"],
      [".", "Toggle dot (Alt+. double dot)"],
      ["(entry off) 1-8/.", "With a selection: set duration / toggle dot on it instead"],
    ],
  },
  {
    title: "Pitches and rests (entry on)",
    rows: [
      ["A … G", "Enter pitch (nearest octave, key signature applied), cursor advances"],
      ["Shift+A … G", "Add pitch above the top note of the chord just entered"],
      ["0", "Rest of the current duration"],
      ["+ / -", "Next note sharp / flat (or alter selected notes)"],
      ["T", "Toggle tie on last entered / selected note"],
      ["Backspace / Delete", "Erase note before / at the cursor"],
    ],
  },
  {
    title: "Change pitch",
    rows: [
      ["↑ / ↓", "Selected (or last) note up / down a semitone"],
      ["Shift+↑ / ↓", "Up / down an octave"],
    ],
  },
  {
    title: "Voices",
    rows: [
      ["V", "Cycle the cursor's voice 0 ↔ 1"],
      ["⌘⌥1 … ⌘⌥4", "Set the cursor's voice directly"],
      ["H", "Toggle invisible on selected rest(s)"],
    ],
  },
  {
    title: "Lyrics",
    rows: [
      ["L / ⌘L", "Enter lyric mode on the selected note (or the note before the cursor)"],
      ["⌘⇧L", "Enter lyric mode on the next verse"],
      ["(lyric mode) type", "Append to the syllable"],
      ["(lyric mode) Space", "Commit and move to the next note"],
      ["(lyric mode) -", "Commit with a hyphen and move on"],
      ["(lyric mode) _", "Mark a melisma extender and move on"],
      ["(lyric mode) ← / →", "Move between notes without editing"],
      ["(lyric mode) Enter / Esc", "Leave lyric mode"],
    ],
  },
  {
    title: "Notation",
    rows: [
      ["S", "Slur (first/last selected, or to the next note)"],
      ["X", "Flip stem direction"],
      ["< / >", "Crescendo / diminuendo hairpin"],
      ["⌘3 / ⌘5 / ⌘6 / ⌘7", "Triplet / quintuplet / sextuplet / septuplet"],
      ["⌘2 / ⌘9", "Duplet (2:3) / 9:8 tuplet"],
    ],
  },
  {
    title: "Playback",
    rows: [
      ["Space", "Play from the cursor / pause / resume"],
      ["Esc", "Stop playback"],
    ],
  },
  {
    title: "Navigate",
    rows: [
      ["← / →", "Previous / next note"],
      ["Home / End", "Start / end of measure"],
      ["⌘← / ⌘→", "Previous / next measure"],
      ["Tab", "Cycle through all staves of the part"],
      ["Click", "Select a note or place the cursor"],
    ],
  },
  {
    title: "Measures",
    rows: [
      ["Hover + / −", "Insert an empty measure after this one / delete this measure"],
      ["Enter / ⇧Enter", "Insert an empty measure after / before the cursor's measure"],
      ["⌘⌫", "Delete the cursor's measure"],
    ],
  },
  {
    title: "History",
    rows: [
      ["⌘Z / ⌘⇧Z", "Undo / redo"],
    ],
  },
];

export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside className="shortcuts-panel" aria-label="Keyboard shortcuts">
      <div className="shortcuts-header">
        <strong>Keyboard shortcuts</strong>
        <button type="button" onClick={onClose} aria-label="Close shortcuts">
          ×
        </button>
      </div>
      {SECTIONS.map((s) => (
        <section key={s.title}>
          <h4>{s.title}</h4>
          <table>
            <tbody>
              {s.rows.map(([k, v]) => (
                <tr key={k}>
                  <td className="shortcut-key">{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <p className="shortcuts-footnote">Typing past the last measure appends a new one. ⌘ is Ctrl on Windows/Linux.</p>
    </aside>
  );
}
