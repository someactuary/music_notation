# Architecture

Personal piano-score editor. TypeScript, React, SVG, Bravura (SMuFL). See PLAN.md
for the roadmap. This file is the contract every module is built against.

## Pipeline

```
Score (src/model)  --engrave-->  LayoutResult (src/engraving)  --render-->  SVG (src/render)
      ^                                                                        |
      | Command (src/commands)                <-- hit-test / input (src/input) -+
```

- `src/model` — the document. Types in `score.ts`; rational time in `duration.ts`;
  pitches in `pitch.ts`; traversal helpers in `traverse.ts`; builders in `factory.ts`.
- `src/engraving` — `engrave(score, {font}) => LayoutResult`. Pure. Owns all
  notation rules (stems, beams, accidentals, spacing, breaking, collision).
- `src/render` — `LayoutResult => SVG`. Pure. Knows nothing about music, only
  primitives and SMuFL glyphs. `smufl/` holds font metadata (`generated/bravura.ts`
  from `npm run smufl:gen`).
- `src/commands` — `Command { label, apply(draft) }` with immer; history keeps
  score snapshots. All edits go through commands.
- `src/io` — `.pscore` JSON (zod-validated, versioned, migrations), MusicXML, MIDI.
- `src/input` — keyboard step entry, MIDI input, mouse hit-testing → commands.
- `src/ui` — React shell: score view, palettes, inspector.
- `src/playback` — `buildTimeline(score)`: repeats, tie merging, tempo map, velocity,
  pedal → plain tick-based data. Consumed by `src/io/midi` (file export) and by the live
  `Player`, which feeds either a Web MIDI device or the built-in sounds. See "Playback
  timeline and MIDI export".
- `src/audio` — the built-in sound engine (Web Audio): nine presets, a voice manager,
  sampled piano and synthesized instruments. See "Built-in sounds".

## Invariants

1. **Never floats for musical time.** Use `Fraction` from `duration.ts`.
2. **Ids are stable.** Never regenerate an id on edit; spanners/attachments reference them.
3. **Content vs presentation.** Deleting `score.layout` must lose no music.
4. **Engrave and render are pure functions.** No DOM, no globals, deterministic output.
5. **Units.** Model: fractions of a whole note. Layout: staff spaces (sp), y down,
   system-local coordinates. Render: converts sp → mm/px. SMuFL metadata uses y UP;
   flip when reading anchors/bboxes.
6. **Piano first.** Part with 2 staves; `staff` overrides on events/notes for cross-staff.
7. **Tests or it didn't happen.** Engraving changes need golden SVG or structural tests.

## Coordinate conventions for engraving

- Staff line positions: top line at `staff.y`, lines every 1 sp downward.
  Middle line = `staff.y + 2`. A note on staff step `s` (0 = middle line, +1 = one
  step up = half a space) is drawn at `y = staff.y + 2 - s * 0.5`.
- Treble clef: middle line is B4 → diatonic(B4) = 34. Bass clef: middle line D3 → 22.
  Alto: C4 → 28. Tenor: A3 → 26.
- Noteheads are placed by SMuFL origin (left edge, vertical center on the staff position).
  Stem attaches at anchor `stemUpSE` / `stemDownNW` (flip y).
- Standard stem length 3.5 sp; extend to middle line for notes beyond ledger lines.

## Working rules for agents

- Do not change files under `src/model/*.ts`, `src/engraving/layout-types.ts`,
  `src/engraving/index.ts`, `src/commands/types.ts`, or `package.json` without saying
  so explicitly in your report. If a contract is blocking you, implement around it and
  report the gap; the architect will change the contract.
- Do not edit `src/render/smufl/generated/*`; change the generator instead.
- Run `npm run typecheck && npm test` before reporting. Report: what changed, tests
  added, known gaps.
- Path alias `@/` = `src/`.

## Editor contracts (M1)

- `src/input/types.ts` defines `Cursor`, `Selection`, `EntryState`, `EditorState`,
  `KeyStroke`, `KeyResult`, `KeyHandler`. The keystroke handler is a pure function;
  the React store applies its `commands` through `History`, then its cursor/entry updates.
- `MeasureLayout.columns` (system-coordinate x per onset) is how the UI places the cursor
  and hit-tests empty space. Elements are hit-tested via `data-id`/`data-role` on SVG nodes.
- Note entry semantics (MuseScore-like): the cursor sits at a time offset in one voice.
  Writing an event of length L at offset T replaces the span [T, T+L) in that voice:
  events fully inside are removed, an event straddling the span's end is shortened to the
  remainder and re-expressed as rests (notes are not preserved past a partial overwrite in
  M1). Writing never crosses the barline: if T+L exceeds the measure, the write is refused
  with a message. Voice contents always sum exactly to the measure length; a voice with
  no notes is a single `measureRest`.

## M2 contracts

### Actions
`src/input/types.ts` defines `PaletteAction` and `ActionHandler`. UI palettes, the staves
panel, and mouse drags produce actions; `handleAction` in `src/input/actions.ts` (pure)
turns them into a `KeyResult`; the store applies it exactly like a keystroke.

### Voices
- `Voice.index` 0..3. Voice 0 always exists. Other voices are created on demand when the
  cursor writes into them and are filled with rests to the measure length.
- Engraving: if a staff-measure has content in more than one voice, voice 0 (and 2) stems
  go up, voice 1 (and 3) stems go down, regardless of pitch; rests in voice 0 sit higher
  (shifted up by 1 sp), voice 1 rests sit lower (shifted down by 1 sp). A single-voice
  measure keeps the pitch-based stem rule. Accidental memory is shared per staff.
- Rests may be `invisible` (drawn nothing, still occupy time). `RestEvent.invisible`.

### Tuplets
- `TupletGroup` may nest. Sounding length = notated × normal/actual, see traverse.ts.
- Entry: `{kind:"tuplet", actual, normal}` on a selected event of duration d replaces it
  with a TupletGroup whose `unit` is d / normal (e.g. quarter → triplet of eighths), with
  the original note(s) first and rests for the remaining slots. Writing at a cursor that
  lies inside a tuplet writes into the tuplet's own grid (durations are notated in the
  tuplet's unit; the span-replace works on the tuplet's `items`); an event that does not fit
  inside the tuplet is refused.
- Engraving: bracket + number (tupletBracketThickness), on the stem side, bracket omitted
  when all notes are beamed as one group; number centred.

### Attachments and spanners (engraving)
- Live in `src/engraving/attachments.ts` and `src/engraving/spanners.ts`, called once each
  from engrave.ts after notes and ties, before vertical extents. They may add primitives to
  a system and must report their vertical extents so systems don't collide.
- Placement uses a per-staff skyline (`src/engraving/skyline.ts`): top/bottom ink profile
  of the staff's notes/stems/beams per x range; items are stacked outward from the skyline.
- Articulations: on the notehead side opposite the stem (staccato/tenuto/accent/marcato/
  staccatissimo/portato), 0.5 sp gap, never on a staff line (move to the next space);
  marcato always above. Fermata above the staff (below for voice 1). Fingering above the
  notehead (below for the lower staff's voice 1 optionally), small sans-serif digits.
- Dynamics below the staff for the upper staff, and below for the lower staff too (piano
  convention: dynamics go between the staves for the upper staff… keep it simple: below
  the anchored staff unless placement says above), Bravura dynamic glyphs, left-aligned to
  the anchored note's x. Hairpins on the same lane as dynamics, 1 sp opening, never
  overlapping a dynamic text (leave 0.5 sp).
- Pedal: "Ped." glyph (keyboardPedalPed) at the start and "*" (keyboardPedalUp) at the end
  for style "text"; a bracket line for style "line". Below the bottom staff of the part.
- Slurs: cubic Bézier from just outside the start notehead to the end notehead, side
  opposite the stems (above when stems differ), height grows with length (0.5–2.5 sp),
  raised to clear the skyline between the endpoints. Split at system breaks like ties.
- Tempo text bold with metronome glyph (metNoteQuarterUp etc. + " = 120") above the top
  staff at the anchored x. Expression text italic, placement above/below by `placement`.
- Ottava: "8va"/"8vb" glyph + dashed line with a hook, above/below.
- All new primitives carry refs with the roles already listed in layout-types.ts.

### Staves
- Commands: addStaff(atIndex, clef, name?), removeStaff(index) (refuse if last; drops
  spanners/attachments on that staff and shifts staffIndex of later ones), setClef(index,
  clef) (sets initialClef), setStaffName, setBracket. Cursor `staffIndex` clamps.
- Engraving: `Part.bracket` chooses brace (default for 2+ staves), a bracket (SMuFL
  bracket glyph top/bottom with a thick line), or nothing. Staff names left of the first
  system, right-aligned, abbreviations on later systems; the system indent grows to fit.
- Tab cycles through all staves of the part.

## M3 contracts

### Lyrics
- Model: `NoteEvent.lyrics: Lyric[]` (verse, text, syllabic, extend). Rests never carry lyrics.
- Engraving (`src/engraving/lyrics.ts`, called from engrave.ts after attachments): one lane
  per verse below the staff (verse 0 nearest), lane top = max(skyline bottom, staff bottom
  + 2 sp) + 1 sp; verse pitch 1.9 sp; text 1.7 sp serif, style "lyric", centred on the
  notehead x (left-aligned on the notehead for melismas is NOT done; always centred).
  Hyphens (single "-" text) centred between syllables with syllabic begin/middle; repeated
  every ~6 sp on long gaps; extender line (0.12 sp thick) from the end of an `extend`
  syllable to the last note of the melisma. Lyric widths must widen spacing columns:
  spacing.ts gets a per-column minimum from the widest lyric (estimated 0.55 × size × chars
  + 0.6 sp padding). Refs: role "lyric", id = event id.
- Entry (`src/input/step-entry.ts`): with a note selected, `L` (or ⌘L) enters lyric mode
  on that event (verse from `entry.lyric?.verse ?? 0`; `⌘⇧L` next verse). In lyric mode:
  printable characters append to the syllable (creating the Lyric if missing, syllabic
  "single"); Backspace deletes a character (an empty syllable is removed); Space commits
  and moves to the next NoteEvent in the voice (syllabic stays single/end); "-" commits
  as begin/middle (the next syllable becomes end or middle accordingly) and moves on; "_"
  marks `extend` and moves on; Left/Right move between notes without changing text; Enter
  or Escape leaves lyric mode. Every keystroke is one command (grouped undo).

### MIDI input
- `src/input/midi-entry.ts` exports `handleMidiNote: MidiHandler`. Spelling: choose the
  spelling of the MIDI number that matches the key signature at the cursor (its sharps or
  flats), else natural, else sharp for sharp keys / flat for flat keys / sharp in C major.
  With no keys held: write a NoteEvent of the current entry duration (same code path as a
  typed letter, cursor advances, chordMode ignored). With keys held: add the pitch to the
  event before the cursor (chord). Entry must be active; otherwise null.
- `src/ui/midi.ts` wraps Web MIDI (`navigator.requestMIDIAccess`), tracks held notes per
  device, and feeds `store.applyMidi(ev)`. A toolbar select lists inputs; the status bar
  shows the connection state.

### MusicXML
- `src/io/musicxml.ts`: `importMusicXml(xml | mxl ArrayBuffer): Score`,
  `exportMusicXml(score): string`. Partwise only. Parse with `DOMParser` (browser and
  jsdom); .mxl via `fflate` (unzip, read META-INF/container.xml rootfile).
- Import maps: parts → Parts (a part with `<staves>2` → two staves), divisions → Fraction,
  attributes (time, key, clef incl. octave-change, staves), notes/chords/rests (voice,
  staff, type+dots, tuplets via time-modification + tuplet notations, ties, accidentals
  incl. cautionary/parentheses, stem, beam hints ignored, notehead), grace notes,
  articulations, fermata, ornaments, fingering, lyrics (syllabic/extend), directions
  (dynamics, wedges, pedal, octave-shift, words, metronome), slurs (numbered), barlines
  (repeats, endings), measure numbers/implicit pickup, backup/forward (multi-voice),
  part names → staff names when a part has one staff and the score has several parts.
  Unknown elements are ignored, never fatal. Voice contents are re-validated with
  `validateScore`; gaps in a voice are filled with invisible rests.
- Export is the inverse, producing MusicXML 4.0 partwise with `<divisions>` = LCM of all
  denominators (capped sensibly), and must round-trip every fixture through
  import(export(score)) structurally (pitches, durations, voices, ties, tuplets, lyrics,
  dynamics, slurs).

### MusicXML schema check
`npx tsx scripts/export-musicxml.ts <dir>` exports every fixture and re-exports the corpus.
Validate with the W3C schema (github.com/w3c/musicxml, `schema/musicxml.xsd` plus
`xlink.xsd` and `xml.xsd`, imports pointed at the local copies):
`xmllint --noout --schema musicxml.xsd <dir>/*.musicxml`. As of 2026-09-14 all 16 exports
and the 3 corpus files validate. Not yet opened in MuseScore (not installed here).

## M4 contracts: PDF import (OMR)

Recognition is done by **Audiveris** (open source, Java, bundled runtime), installed at
`~/Applications/Audiveris.app` (or `/Applications`, or `$PMN_AUDIVERIS`), with Tesseract
English data in `~/Library/Application Support/AudiverisLtd/audiveris/tessdata/`.
`scripts/setup-omr.sh` installs both idempotently. Evaluated 2026-09-15 on two digital
PDFs: pitches, rhythms, keys, meters, pickups, clefs and voices correct on every page
checked; without OCR data, lyric glyphs are misread as dynamics/trills, so OCR data is
required.

Pipeline: PDF → local OMR service → .mxl → `importMusicXml` → `cleanupOmrScore` → editor.

- **Service** (`server/omr-service.ts`): framework-free `(req, res, next)` handler mounted by
  a Vite plugin in `vite.config.ts` (`configureServer`), so it exists wherever
  `npm run dev` runs; the dev server listens on localhost only. Spawns Audiveris with an
  argument array (never a shell): `-batch -export -output <jobDir> -- <jobDir>/input.pdf`.
  One job runs at a time (FIFO queue); job dirs under `.omr-jobs/` (gitignored), removed
  on DELETE or 1 h after completion; 10-minute timeout per job. Uploads: max 50 MB, magic
  bytes must be `%PDF`, PNG or JPEG. Progress comes from the Audiveris log (sheet count
  and per-sheet completion). API types in `src/io/omr-api.ts`.
- **Client** (`src/io/omr-client.ts`): fetch wrappers + polling.
- **Cleanup** (`src/io/omr-cleanup.ts`, pure): options keep essentials/all and keep layout;
  drops generic part/staff names ("Voice", "Piano", "P1", "Part 1", "Staff 1", "MusicXML
  Part"); when keepLayout is false clears systemBreaks/pageBreaks; produces a review list
  (voices the importer padded with invisible rests, overfull voices, validation issues).
- **UI**: "Import PDF…" → status check (setup hint if Audiveris missing) → upload →
  progress → options (essentials default, keep layout default on) → load. A "Compare"
  side panel renders the original PDF page with pdf.js (kept in memory for the session),
  synced to the page containing the cursor's measure via `layout.pageBreaks`; review items
  listed with click-to-jump.
- **Engraving fix**: staves inside a system are spaced by content: the gap between staff k
  and k+1 is max(default gap, below-extent of k + above-extent of k+1 + 1.5 sp), where
  extents include lyric lanes, dynamics, ledger-line notes, beams and slurs.
- Sample PDFs live in `sample_sheet_music/` (gitignored, third-party). Tests may use them
  only when present (`describe.skipIf`), and must never copy lyric text or other text from
  them into the repo: assert counts and structure only.

### Staff spacing internals (M4)
Engraving runs horizontal layout once, then the vertical passes twice
(`layoutSystems(slotsOf, withFrame)` in engrave.ts): a first pass with staves 1000 sp
apart and no frame, `measureStaffExtents` (src/engraving/staff-spacing.ts) to measure
each staff's ink above and below its lines, then `staffSlots(parts, settings, extents)`
(vertical.ts) and a second pass that draws everything, including brace/bracket, labels
and barlines, at the final positions. Every system carries its own staff positions in
`EmitSystem.slots`; `buildSites(systems)` and the skyline read them. Known limits: one
tall item anywhere widens the whole system; the brace indent is sized from the default
spacing; the rule assumes no item sits more than 500 sp from its staff.

### Running OMR tests
`npm test` skips the real-Audiveris test. Run it on purpose with
`PMN_OMR_REAL=1 npx vitest run server/omr-real-run.test.ts` (needs Audiveris and the
local sample PDF).

### Second OMR engine: homr (2026-09-22)

Audiveris does well on clean PDFs but badly on phone photos: on 2026-09-22 it crashed on
one photo and lost track of which staff belongs to which part on a cropped one. The
iOS photo-app bake-off (2026-09-21, `play_from_photos/bakeoff`) measured **homr**
(open source, AGPL, Python + ONNX/CoreML models) at 96% rhythm-consistent measures on
phone photos vs Audiveris's 86%. homr is now a second engine; the user picks one per
import. Audiveris stays the default because homr reads no text (lyrics, dynamics, tempo,
titles from OCR are lost) and often writes no time signature (the importer then assumes
4/4, and cleanup pads and flags the measures).

- **Install**: `bash scripts/setup-omr.sh --homr` runs `uv tool install --python 3.12
  homr` and `homr --init` (downloads ~110 MB of models once). Found at `opts.homrPath`,
  `$PMN_HOMR`, or `~/.local/bin/homr`. `GET /status` now also returns
  `engines: { audiveris, homr }`, each `{ available, path?, version?, hint? }`; the old
  top-level fields still describe Audiveris.
- **Jobs**: `POST /jobs?engine=homr` (default `audiveris`; anything else is 400). homr reads
  one image and writes `<stem>.musicxml` beside it, so for a PDF the service first renders
  each page to a 300 dpi PNG with `scripts/pdf-to-png.swift` (PDFKit, honors `/Rotate`;
  ~1 s per page) and then runs homr once per page, reporting page progress through
  `sheetsDone/sheetsTotal`. A page homr can't read becomes an entry in
  `OmrJob.warnings` and is skipped; the job fails only if no page could be read. The
  timeout covers the whole job; cancel kills whichever step is running. homr's CoreML
  "E5RT" warnings are dropped from the log, and its colored `[INFO] … file.py:NN:` prefix
  is stripped from the progress message.
- **Results**: `OmrJob.resultCount` says how many results a done job has (1 for Audiveris,
  one per read page for homr); `GET /jobs/:id/result?index=N` serves each (plain
  MusicXML for homr, `…musicxml+xml`). The client's `fetchOmrResults(job)` gets them all.
- **Joining pages** (`src/io/omr-merge.ts`, pure): each page is imported on its own
  (`importMusicXml` always gives one part) and `mergeOmrPages` appends them. homr sometimes
  drops a staff on a page (e.g. the small solo staff above a piano), so every page's staves
  are lined up with the fullest page's by clef (best-matching offset, topmost on a tie);
  missing staves get whole-measure rests and a `page-mismatch` review item. Cross-staff
  events, spanner/attachment staff indices and measure anchors are shifted with their page;
  a page's restated key/time signature is dropped unless it changes; a page that opens in
  a different clef than its staff was left in gets a clef change; each later page starts
  with a page break.
- **Instrument**: both engines label parts "Voice" with MIDI program 54 (choir "oohs").
  Now that the importer keeps a file's program, `cleanupOmrScore` resets every part to
  program 0 (piano): an OMR engine's instrument is a guess, never a reading of the page.
- **UI**: the dialog is now "Import PDF or photo". The choose step has a "Recognize with"
  radio pair (Audiveris / homr, with one-line strengths; an engine that isn't installed is
  disabled and shows its setup hint); the choice is remembered in `localStorage`
  (`pmn.omrEngine`). The OCR warning only shows for Audiveris. Progress counts pages; job
  warnings show above the import options.
- Verified 2026-09-22 with the real engine: a 2-page phone-photo PDF (11 s, 491 note
  events, one `page-mismatch`) and a phone JPEG that crashed Audiveris (5.6 s, 32
  measures), then through the dialog in headless Chromium. Known limits: homr misses time
  signatures and small cue-size staves; on a photo cropped through the clefs it guesses
  the clefs (wrong pitches for that system), as Audiveris does.

## Clef changes (2026-09-22)

Piano music often moves a hand between treble and bass mid-piece. The model always
stored this (`StaffMeasure.clefChanges`, `{ at, clef }` at any measure-relative offset),
and MusicXML import/export and `.pscore` kept it, but the engraver only honored a change
at a measure's very start, and even then drew no clef mid-system. A change later in the
measure was ignored: the notes after it were placed by the old clef (bass notes hanging
on ledger lines below a treble staff), though playback was right. Found on an
Audiveris import of a piano piece whose left hand switches clef mid-measure.

- **Model** (`src/model/clefs.ts`): `clefAt(score, part, staff, measure, offset)` is the
  one answer to "which clef is in force here" (a change applies from its own offset on,
  including an event starting exactly there); `clefEnteringMeasure`, `clefInMeasureAt`.
  Clef changes have no id in the model, so `clefChangeId({measureId, partIndex,
  staffIndex, at})` encodes a stable one (`clefchange|<measureId>|p|s|n/d`) for
  selection, and `parseClefChangeId` reads it back.
- **Engraving**: `planClefs` (engrave.ts) walks every staff's changes once, giving each
  measure its opening clef, its mid-measure `clefMarks`, its closing clef, and a
  `trailingClef` (the next measure's offset-0 change). A change that restates the clef
  in force draws nothing. `layoutStaffMeasure` places each event by the clef at its own
  offset (noteheads, ledger lines, stems, beams, accidental positions).
  - A mid-measure change is drawn at `ENGRAVING.clefChangeScale` (0.7) in front of the
    first column at or after its offset; `reserveClefLeads` (spacing.ts) widens that
    column's `left` by the clef plus `clefChangeGapSp`, so it pushes the notes rather
    than overlapping them.
  - A change at a measure's start is drawn small before the PREVIOUS measure's barline
    (the measure's new `tail` width), the standard placement; when that measure ends a
    system, the same glyph is the courtesy clef, and the new system's prefix shows the
    new clef at full size.
  - Glyphs carry `ref: { id: clefChangeId, role: "clefChange" }`; the role is in
    `SELECTABLE_ROLES`.
- **Import**: a clef MusicXML places at or past a measure's end (Audiveris writes one at
  the end of the measure before; a misread rhythm can put one past the end) moves to
  offset 0 of the next measure, unless that measure states its own opening clef; one after
  the final barline is dropped. The past-the-end case always comes with a broken-rhythm
  measure that cleanup already flags for review.
- **Editing**: a "Clef" palette group with Treble and Bass buttons (`{ kind:
  "clefChange", clef }`) applies `setClefChange` (commands/clefs.ts) at the earliest
  selected note, or at the cursor (offset 0 = from the start of that measure). It
  replaces a change at the same point, removes one that would restate the clef already in
  force, and at the very start of the piece sets the staff's opening clef. Clicking a
  drawn clef change selects it; Delete runs `removeClefChange(id)`. The status bar shows
  the clef at the cursor. The Staves panel still sets a staff's opening clef for the
  whole piece. No keyboard shortcut (Frank's call).
- Verified on Tifa's Theme: with homr's reading, every clef change on the page (bass
  before the last eighth of m3, courtesy treble at the end of system 1, bass before the
  E♭ in m6) is drawn where the original has it. Audiveris's reading has one spurious
  bass clef in m1 (its misread, flagged for review with the rest of that measure).
  Editor round trip (add, select, Delete, Undo) checked in headless Chromium.

## Inserting and deleting measures (2026-10-16)

Frank fixes OMR imports where a measure is beyond repair (e.g. five beats in 4/4) by
deleting the whole measure. Enter / ⇧Enter / ⌘⌫ already inserted and deleted measures,
but weren't listed in the Shortcuts panel, so he hadn't found them.

- **Hover controls** (`ScoreView`): over a measure (its whole system height plus
  `MEASURE_HOVER_ABOVE_SP` above the top staff, see `measureAtPoint` in layout-utils.ts),
  two small round buttons sit at its closing barline just above the top staff: "+" sends
  `{ kind: "insertMeasure", index: measureIndex + 1 }`, "−" sends
  `{ kind: "deleteMeasure", measureIndex }` (disabled when it's the only measure). They're
  HTML over the page and stop pointer events from reaching the page's click/drag handling;
  hidden while dragging and in print. Undo restores a deleted measure.
- **Actions** (actions.ts) keep the cursor on the same music (it moves with a measure
  inserted before it or deleted before it; inside a deleted measure it goes to the start of
  what follows) and clear the selection after a delete (its ids may be gone).
- **Commands** (basic.ts) now keep what the surrounding music depends on:
  - `removeMeasure`: a time or key signature the measure declared moves to the next
    measure (unless it declares its own), so deleting measure 1 no longer drops the piece's
    meter and key; the clef each staff is left in carries onto the next measure (or
    becomes the staff's opening clef when measure 1 is deleted); a final barline moves to
    the new last measure.
  - `addMeasures`: later measure anchors and forced system/page breaks move with their
    music (they used to stay at the old index); inserting before measure 1 moves the
    opening time and key signature onto the new first measure.

## Manual layout control (2026-09-15)

Requested by Frank after PDF import left a real file with a sparse last page (a
9-page piano PDF's original page breaks no longer matched once measures were edited).

- **Mid-song key signature changes.** `MeasureAttributes.keySig` already supported this
  at the model level (M1's "key signature at every system" rule already draws the new
  key, with cancellation naturals, from the measure it's set on). The only thing
  missing was a way to set it: `setKeySignature(measureIndex, keySig | null)`
  (`src/commands/keysig.ts`). `null` doesn't erase a key change, it removes the
  *explicit* one at that measure so the key already in effect one measure earlier
  continues (`keySignatureAt` reads the most recent explicit `keySig` at or before a
  measure). Key-aware note entry needs no change: it already calls `keySignatureAt` at
  the cursor's measure. UI: the Key group in the second toolbar row (`Palettes.tsx`)
  shows the key in effect at the cursor's measure and a Clear button enabled only when
  that exact measure carries an explicit change.
- **Manual line/page breaks and caps.** `LayoutHints` gained two optional fields,
  `measuresPerSystem` and `systemsPerPage` (`src/model/score.ts`, zod schema in
  `src/io/pscore.ts`). Both are upper bounds only: `planSystems`
  (`src/engraving/breaking.ts`) and `paginate` (`src/engraving/vertical.ts`) treat
  reaching the cap exactly like reaching a forced break — it can only make a
  line/page *shorter* than it would otherwise be; a measure/system that would overflow
  the available width/height still breaks first regardless of the cap, and a forced
  break resets the count for what follows rather than "using up" part of it. Commands:
  `toggleSystemBreak`/`togglePageBreak` (act on one measure, no-op at measure 0),
  `setMeasuresPerSystem`/`setSystemsPerPage` (the global caps), and
  `clearForcedBreaks` (empties both break lists — the one-click fix for the sparse-page
  case, since it hands every measure back to automatic fill-to-width/height breaking).
  All five are `src/commands/layout.ts`. UI: the Layout group in `Palettes.tsx` — two
  number inputs (blank = automatic) and three buttons, all reading/acting on the
  cursor's measure via `PaletteAction`s `toggleSystemBreak`/`togglePageBreak` (no
  measure index in the action itself, same pattern as `tempo`/`text` reading
  `state.cursor`).
- Verified end to end on Frank's real 99-measure imported file: clearing its imported
  forced breaks (which had frozen a specific page at "just 4 measures left" after
  earlier measures were removed) took it from 15 pages to 11.

## Selectable markings, and a real click-hit-testing bug (2026-09-15)

Frank reported: slurs/fermatas/beams/other markings couldn't be selected to move or
delete, and on a staff with multiple voices only one voice was ever selectable.

**Root cause of the multi-voice bug** (confirmed live with `elementFromPoint`, not
guessed): every glyph is drawn as an SVG `<text>` at a fixed font-size spanning a full
4-staff-space em-box (src/render/svg.ts), regardless of the actual ink (a notehead is
~1sp tall). The browser's own DOM hit-testing (`closest("[data-id]")`, which ScoreView
used to rely on) uses that whole em-box, not the visible glyph — so two glyphs within
about a staff's height of each other (routine for two voices on one staff) had
overlapping invisible hit regions, and the later-painted one always won, silently
stealing clicks meant for an earlier voice's notes. Rubber-band selection was never
affected — `idsInRect` already used real geometry, never DOM hit-testing.

**The fix, which also delivers marking selection**: `src/ui/layout-utils.ts` gained
`selectablePrimBox` — real page-space geometry for every `Primitive` type (glyph via
SMuFL bbox, text via an estimated ink box, line/polygon via their own points, path via
every (x,y) pair in its `d` string, a safe convex-hull-style over-approximation for the
cubic Béziers ties/slurs use). `selectionBoxes`/`idsInRect` now use it for every
`SELECTABLE_ROLES` role, not just notehead/rest, merging a marking's several primitives
(e.g. a hairpin's two lines) into one outline per system. `ScoreView`'s click routing
was switched from DOM `closest("[data-id]")` to a new pure `hitTestElement`, which picks
whichever selectable box's own centre is closest to the click point — the DOM attributes
(`idAttributes`) still exist for debugging/print but click detection no longer needs them.

**What's selectable** (`SELECTABLE_ROLES`): notes, rests, ties, slurs, hairpins, pedal,
ottava, dynamics, tempo, text, fermatas, real per-note articulations, fingering,
tuplets, lyrics, ornaments. Deliberately excludes derived/structural sub-parts (stem,
flag, dot, accidental, clef, keysig, timesig, barline, ledger, measure) — clicking those
selects nothing on its own. "beam" resolves to its first note's id (a beam has no
independent model identity) — a useful, better-than-nothing click target, not "select
the whole beamed group"; there is no "delete a beam" (re-beaming would need a new
`NoteEvent.beam` override command, not built here).

**What's deletable**: `deleteSelection` (step-entry.ts, used by Delete/Backspace and
Cmd+X) checks each selected id against `score.spanners`/`score.attachments` by id first
(→ `removeSpanner`/`removeAttachment`, also clearing any nudge for that id) before
falling back to the existing note/event erase path. See "Delete strips a tie/decoration
before erasing the note" below for what that erase path itself does before it actually
erases anything. Fingering still has no removal path of its own — clearing it goes
through the fingering palette/action, not Delete.

**What's movable**: `MOVABLE_ROLES` — spanners and placement-only attachments that carry
their own id independent of any note (slur, hairpin, pedal, ottava, dynamic, tempo,
text, fermata). Dragging one in ScoreView shows a free (unsnapped) ghost outline and, on
release, calls `onDragMarking(id, dx, dy)`; App.tsx adds that delta to the marking's
existing offset (`score.layout.nudges[id]`) and dispatches `setNudge` (absolute value,
so one drag is one undo step). `src/engraving/nudges.ts`'s `applyNudges` is one
post-processing pass in engrave.ts, translating every primitive of a nudged id by its
offset — chosen over threading a nudge into each of the dozen attachment/spanner kinds'
own placement math. Known limitation: it runs after the system's vertical extent is
measured, so a large nudge can push content outside the space reserved for it; nudges
are for small position tweaks, not freely relocating a marking (re-anchor it instead).
Ties, real articulations, fingering, tuplets and beams share an id with their host
note/event and aren't independently nudgeable.

**Why fermata has its own `Ref` role**: it used to share `"articulation"` with real
per-note articulation glyphs (staccato, tenuto, accent), which are correctly excluded
from `MOVABLE_ROLES` (multiple articulations on one note share one id — there's no
single thing to move). But a fermata is its own `Attachment` with its own id, so it
belongs in `MOVABLE_ROLES` — discovered by testing the actual drag in a browser and
finding it silently did nothing, which the shared role masked.

## Marking drag autoscroll, and delete-strips-decorations (2026-09-16)

Two bugs reported against Frank's real "Be Still, My Soul" file, both in the markings
work above.

**Bug 1 — dragging a marking scrolled the page away.** `ScoreView`'s cursor-follow
effect (`useEffect` scrolling the container so the text cursor's system stays in view)
was keyed on `[cursorMeasure, layout]`. `layout` is a brand-new object on every score
edit (`engrave.ts` always returns a fresh result), so *any* edit — including dragging a
marking to nudge it — re-ran the effect and scrolled back to wherever the cursor
happened to be, often a different page than the one being edited. Fixed by keeping
`layout` as a dependency (it's genuinely read inside the effect) but adding a
`lastScrolledMeasure` ref that makes the effect a no-op unless `cursorMeasure` itself
has changed since the last time it actually scrolled — so a layout-identity change with
no real cursor movement (a nudge, or any other edit) no longer triggers a scroll.
Keyboard/compare-panel navigation, which does change `cursorMeasure`, is unaffected.
Verified live against the real file: dragging a slur now leaves scroll position
untouched (confirmed pixel-identical before/after), while 400 consecutive ArrowRight
presses still autoscrolls as before.

**Bug 2 — Delete on a marking erased the whole note.** Selection carries only ids, no
role — so once a click resolved to, say, a tie or an accent (both of which reuse their
host note *event's* id, since neither has an id of its own), `deleteSelection` had no
way to tell "delete this decoration" apart from "delete this note," and always erased
the note. Root-caused against Frank's real file: several slurs in measures 67–79
visually overlap a tie curve closely enough that a click resolves to the tie instead
(same id-sharing mechanism as ties/articulations generally, not a hit-testing bug to
fix on its own — see "What's selectable" above). Fixed in `eraseSelected`
(step-entry.ts): before erasing a resolved note event, it now checks whether that event
has any tied notes (`Note.tieStart`) or note-level decorations (articulations,
ornaments, arpeggio, tremolo — the new `clearEventDecorations` in
`commands/notation.ts`) and, if so, strips those instead of erasing the event, leaving
a status message ("Removed the tie/marking — press Delete again to remove the note").
A second Delete on the now-undecorated note erases it normally. Verified live against
the real file at measures 67–79: selecting a tied chord's tie and pressing Delete
untied all three notes in the chord and left them in place; selecting an accent and
pressing Delete removed just the accent; a second Delete erased the note both times.
Carry-over: this strips *all* of an event's note-level decorations at once — e.g. an
accent and an ornament on the same note both go on the first Delete — not one at a
time; there's no way to target a single one without its own id, same limitation noted
under "What's movable."

## Editable score info, remembered filename, Save As, app rename (2026-09-18)

Renamed the app from "Personal Music Notation" to "Sheet Music Assistant" (`index.html`
title, `App.tsx`'s toolbar) — display text only, no change to the package name or repo.

**Editable title/subtitle/composer/lyricist**: these were only ever set by import or
the New Score form, with no way to edit them afterward. Added `setScoreMeta(patch)`
(`src/commands/meta.ts`) — one command taking a `Partial<ScoreMeta>`, so each field
commits as its own undo step (an empty string clears that field rather than storing
it) — wired through `PaletteAction` the same way every other UI-triggered edit is
(`src/input/types.ts`, `src/input/actions.ts`). `src/ui/ScoreInfoPanel.tsx` is a new
toggleable panel (same open/close pattern as StavesPanel) with one text input per
field, committing on blur, matching StavesPanel's staff-name fields exactly. Also
discovered `lyricist` was captured in the model (including by MusicXML import) but
never engraved anywhere — added it to `emitTitleBlock` (`engrave.ts`), top-left,
mirroring composer's top-right placement (the usual "Words by.../Music by..."
convention); gave it its own `"lyricist"` text style/`Ref` role rather than reusing
`"composer"`'s, parallel to why fermata got its own role above.

**Remembered filename + Save As**: the app has no File System Access API access (it's
download-based, `input[type=file]` for Open, `<a download>` for Save) so there's no
real "current file" concept without new state for it. Added `fileName` (React state in
`App.tsx`, persisted to `localStorage` under `pmn.filename` the same way MIDI input
selection already was) — set on Open (`file.name`), set to whatever name a Save/Save As
actually wrote, and cleared on New/New SATB/loading a sample/importing a PDF (all
"this is now a different, unsaved document" actions). Plain Save reuses it (swapping
the extension to `.pscore` even if the document was opened from MusicXML, since Save
always writes the native format); Save As always prompts (`window.prompt`, there's no
in-browser save-location dialog otherwise) defaulting to the current name, and forces
a `.pscore` extension on whatever's typed. The filename displays in the toolbar next to
the app name (`.toolbar-doc` wrapper, `.toolbar-filename` span) and in the browser tab
title — the two places a document's name customarily shows up.

## Flip stem direction (2026-09-18)

Frank reported stems "flipping to the wrong direction" when using the up/down arrow
keys to move notes in his real file `Rob_Mullins_Etudes_Bb.pscore` (OMR-imported,
gitignored). Investigated at length before finding the real story: `NoteEvent.stem` is
never written by any pitch-editing command (`setNotePitch`, `transposeNotes`) — every
solo-note and beam-group stem-direction path in `src/engraving/semantic.ts` prefers an
explicit `stem` over any pitch computation, and this was verified by direct
engraving-output inspection (a dragged note, an octave-transposed note, and one member
of a 6-note beam group moved 2 octaves all kept their original rendered direction).
So pitch editing was never the cause. The actual note Frank pointed to (bar 8, the A)
already had `stem: "down"` sitting in the *imported* file, most likely an Audiveris
OMR misread of the original engraving — and there was no way to fix that misread
without re-doing the whole passage's rhythm/pitches, since nothing in the app ever
wrote to `NoteEvent.stem`.

Added a real fix, not just an explanation: `toggleStemDirection(eventIds)`
(`src/commands/notation.ts`) explicitly sets `event.stem`, wired up as `flipStem`
(`PaletteAction`, "X" key — MuseScore's own convention for this — and a "Flip Stem"
button in the Articulations palette group). Converges the whole selection to one
direction per press (up unless every selected event is already "up") rather than
flipping each event independently, so selecting an entire beamed run and flipping it
actually moves the beam's shared direction — which is decided by whichever member's
`stem` `buildBeamGroups` finds first, so flipping only one non-first member would
otherwise visibly do nothing. Verified against the actual reported note: selecting it
and pressing the Flip Stem button (then "X" to flip back) correctly toggled both the
stored field and the rendered `<line>` primitive's direction.

**Follow-up, same day: automatic reconciliation on pitch change.** Frank clarified
what he actually wanted: not just a manual fix, but the stem to flip *on its own*
whenever moving a note changes which direction convention would pick — "if it changes
the stem direction, then the stem needs to flip" — and efficiently for a whole
selected section moved at once, not just one note at a time. Added
`captureStemBaseline`/`reconcileStemAfterPitchChange` (`src/commands/notation.ts`),
called from both pitch-changing commands (`setNotePitch` — mouse drag; `transposeNotes`
— arrow keys): before the pitch change, capture what direction convention would pick
for the event *right now*; after, if the event's stem was tracking that (matching it,
or the common case of no override at all skips this entirely) and convention would now
pick something else, update the stem to match. Deliberately does **not** touch a stem
that was already sitting away from convention (a deliberate `toggleStemDirection` flip,
or a stale OMR misread nobody's corrected yet) — an unrelated pitch nudge shouldn't
silently discard that choice, and it means a note that's *already* wrong (like Frank's
originally-reported one) needs one `toggleStemDirection` to re-anchor it before this
starts tracking it automatically. Convention itself now accounts for multi-voice
staves too (`voiceStemDirection` instead of pitch, when the staff carries more than one
voice) and clef changes (the clef at the note's own offset, via the model's `clefAt`;
see "Clef changes") — beaming is the one thing deliberately left out, same
one-note-at-a-time caveat as the manual flip above. `transposeNotes` captures one
baseline per *event* before any of its notes' pitches change (a chord can have more
than one note in the same transpose call) and reconciles once per event after, so
transposing a whole selected passage is still one pass, not one per note. Verified
live against the real file: after one manual correction, moving the note down an
octave and back up with the arrow keys correctly flipped its stem both ways with no
further manual steps.

## Toolbar redesign (2026-09-18)

Frank found the New/Open/Save row "ugly and busy" and asked for icons, plus moving
Shortcuts and Score Info to the far right under the MIDI controls. `src/ui/icons.tsx`
has six small hand-drawn 16x16 stroke icons (New/Open/Save/Undo/Redo/Print) — no icon
library in this project's dependencies, and pulling one in for six glyphs isn't worth
the bundle weight. New/Open/Save/Save As are now one `.toolbar-group` cluster, a
`.toolbar-divider` separates Undo/Redo into their own cluster, and Shortcuts/Score Info
moved to the end of the toolbar, after the MIDI controls. Save As, Export MusicXML, and
the panel/import/compare/sample controls stayed as text — less frequent or more
specific actions that benefit from an explicit label, unlike the six everyday ones.

One real bug on the way: the icons rendered as blank buttons at first — every SVG's
computed width was ~1px, not the 16px set via its own `width`/`height` attributes.
Root cause: an SVG is a normal flex item, and `.icon-button`'s `display: inline-flex`
let it shrink under the button's fixed `width: 2rem`, and something in Chromium's flex
sizing (verified: not a page-specific CSS conflict, no other rule touched these
elements) let that shrink go almost to zero instead of stopping at content size. Fixed
with an explicit `.icon-button svg { flex-shrink: 0; width: 16px; height: 16px; }` —
a known gotcha for SVGs inside flex containers generally, worth remembering for any
future icon work in this app.

Also folded a duplicate into an existing command while this was in progress: the
"editable score info" panel from earlier today (see above) had added a new
`setScoreMeta` (`src/commands/meta.ts`) without noticing `setMeta` already existed,
unused, in `src/commands/basic.ts`. Consolidated onto `setMeta` (now with `setScoreMeta`'s
clear-on-empty-string behavior, which the original didn't have) and deleted
`commands/meta.ts`; the `setTitle` command next to it is untouched — it's a
long-standing minimal test fixture for undo/redo mechanics (`test/commands/history.test.ts`),
not a real editing feature, unrelated to this.

## Toolbar redesign, round 2 (2026-09-19)

Cosmetic follow-up to the redesign above, all in `src/ui/icons.tsx` and `App.tsx`:

- **Undo/Redo** got real curved-arrow icons (a hooked line + small arrowhead) instead
  of the plain left/right triangles from the first pass — those worked but didn't read
  as "undo" at a glance the way a curved arrow does.
- **Save As** got its own icon: a narrower floppy disk plus a separate "+", not
  overlapping it. The first idea (two overlapping floppy disks) was dropped because
  making the front one look "on top" needs its fill to match the button's *current*
  background (plain vs. hover), which would drift out of sync — keeping the two shapes
  apart entirely avoids that class of bug altogether.
- **Import PDF** got a document-with-a-"PDF"-badge icon (`PdfIcon`) — deliberately a
  generic red badge, not a reproduction of Adobe's own PDF mark.
- **Staves** got real treble+bass clef glyphs stacked vertically (`ClefIcon`, App.tsx),
  reusing the same Bravura-glyph-as-text-character technique the notation palettes
  already use for their own buttons (`Smufl` in `Palettes.tsx`, now exported for this)
  rather than drawing a generic staff/bracket shape from scratch — more legible, and an
  app with real clef glyphs on hand has no reason not to use them.
- Tooltips on every icon button are now bare labels ("Save", "New", …) instead of the
  first pass's fuller text ("New score", "Open…").
- (Superseded 2026-09-20: see "Built-in sounds and the toolbar reorganization".) Every
  remaining button that doesn't have a clear icon (Export MusicXML, Compare with
  PDF, Samples, MIDI, Shortcuts, Score Info) now lives in one `.toolbar-text-group`
  with `margin-left: auto`, so it's pushed to the toolbar's far right as a block while
  the icon buttons stay a tight cluster next to the document name — replacing the
  first pass's `.toolbar-doc { margin-right: auto }`, which would otherwise have split
  the leftover space between *two* auto margins once this group also had one, pushing
  the icons toward the middle instead of keeping them flush left.

Verified with a zoomed screenshot of the actual rendered toolbar (`body.style.zoom`,
since the icons are only 16px) rather than just reading the SVG path data — this is
what caught that the plain-triangle Undo/Redo icons from the first pass, while
technically fine, were worth replacing with something more recognizable once actually
compared side by side with a real curved-arrow rendering.

## Playback timeline and MIDI export (2026-09-20)

Frank asked for MIDI export "with high fidelity to the score", then to work out playback
options. The design goal was one place that decides *how the score sounds*, so a file
export and any future in-app player can never disagree.

**`src/playback/timeline.ts` — `buildTimeline(score, options): Timeline`.** Pure
(score in, plain data out; the score is untouched). Output: per-staff tracks of notes
(MIDI pitch, velocity, on/off **ticks**), sustain-pedal controllers, lyrics, plus a
score-wide tempo map, time/key signatures, rehearsal marks, and `playedMeasures` (which
score measure each stretch of ticks came from — what a playhead will need). PPQ is 960,
divisible by 3, 5 and 2^6, so triplets, quintuplets and 64ths are exact. Musical time is
`Fraction`s of a whole note throughout (invariant 1) until the final step, where every
boundary is rounded once with the same function — so a tied note's end and the next
note's start always land on the same tick, and a septuplet's seven notes tile their beat
with no gap or overlap (tested). Ticks exist only in this layer, as PLAN.md intended.

What it follows: repeat signs and 1st/2nd endings (`unfold.ts`; D.C./D.S./coda have no
model representation so aren't followed); ties (merged into one sustained note, pairing
reused from the engraver's `resolveTies` so playback and the drawn ties can't disagree,
and only merged when the two notes are contiguous in *played* time so a repeat jump
correctly re-strikes); tuplets; pickup measures; time/key signature changes; ottava
(sounding pitch = written pitch + shift; written pitches are what's stored, per the
MusicXML importer); dynamics and hairpins as note-on velocity (`dynamics.ts`; a
dynamic applies to the whole part, since piano dynamics sit between the staves; a
hairpin ramps toward the marking written at its end, else moves a fixed step); accents/
sforzando/marcato as attack velocity; sustain pedal from pedal spanners and Ped./* marks
(one pedal per *part*, so all its staves share one MIDI channel; releases sort before
presses on a tick so a pedal change stays a change, and a depth count stops overlapping
marks releasing early); grace notes (acciaccatura before the beat, appoggiatura out of
the principal note); lyrics (first verse) as MIDI lyric events; slurs as legato. Tempo
comes from metronome marks (any beat unit), tempo words ("Andante", …), and metronome
marks that arrived as plain text — including OCR-garbled ones like "J=110", since
Frank's scanned scores produce them. A first tempo mark only sets the music *before*
it if it's within two measures of the start; one deep in the piece says nothing about
how it began, so the default (120) applies instead.

**Two interpretations** (`PlaybackOptions.interpretation`). *expressive* (default):
articulations shorten notes (staccato is capped in absolute length, so a staccato half
note is short rather than a quarter long), non-slurred notes lift a 64th early, and
ornaments (trill/mordent/turn, neighbours taken from the key signature), tremolo and
arpeggios are played out, fermatas hold ×2 by slowing the *tempo* over the anchored
event (so every staff stretches together and note ticks stay notated), and
rit./accel./a tempo become tempo ramps. *literal*: every note sounds exactly its notated
length with explicit tempo marks only — the right export for carrying notation into
another notation program, where realised ornaments would just be noise to re-quantize.

One model fact worth remembering: a spanner's **end anchor on an event means the end of
that event** (the importer picks "the event that ends where the stop mark sits";
the engraver draws to it), so an 8va or pedal ending on a note includes it — but a
slur's end uses that note's *attack*, or the last note would be joined to whatever follows.

**`src/io/midi/` — the file.** `smf.ts` is a byte-level Standard MIDI File writer;
`export.ts` lays a `Timeline` out as format 1: a conductor track (title, composer,
copyright, tempo map, time/key signatures, rehearsal markers) then one track per staff.
Events sharing a tick are ordered so a note ends before the same key restrikes, a pedal
release precedes a press, and both come before that tick's note-ons. UI: "Export MIDI ▾"
in the toolbar's text group, a two-item menu (Performance / Notation-exact) that names the
file after the current document.

**How it was verified** — with tools other than the code that wrote it: `test/io/smf-reader.ts`
is an independent SMF parser used by the tests (all 15 fixture scores, both modes: valid,
positive-length notes, no same-key overlap, pedal never left down, and every written note
sounds exactly once with ties merged); the real files were also read by Python's `mido`
(same note counts and length as the timeline) and by **Apple's own `AVAudioSequencer`**,
which loaded them (sequence length exactly matching) and rendered audio offline through
macOS's built-in sound bank. That last step also answered a playback question: macOS can
render a MIDI file to audio with no third-party software — `afconvert` cannot (it doesn't
read MIDI), but a small Swift program over `AVAudioEngine` manual rendering can, about
180x faster than real time.

Not modeled: glissando spans, two-note (fingered) tremolo, half pedal, D.C./D.S./coda,
text-only crescendo/diminuendo without a hairpin. Interpretation numbers (velocities for
each dynamic, articulation lengths, ramp depths) are conventional ones from notation
software, kept together in `interpret.ts` to retune by ear.

## Playback through a MIDI device (2026-09-20)

Frank chose to hear the score on his digital piano, so playback sends the timeline to a Web
MIDI output. (In-browser sounds were considered and deferred at first, then built the same
day — see "Built-in sounds"; macOS-rendered audio via `scripts/render-midi.swift` stays a
validation tool.) Reuses the timeline from the section
above, so what plays is exactly what "Export MIDI ▸ Performance" would write.

**`src/playback/`** — `messages.ts` turns a timeline's notes and pedal into channel messages
and owns the same-tick ordering (note-off, pedal lift, pedal press, note-on); the file
writer and the player both use it, so a saved file and a live performance can't disagree.
`tempo-clock.ts` converts ticks <-> seconds through the tempo map both ways (binary search).
`position.ts` maps a tick to a score measure + offset (what a playhead needs, following
repeats) and a cursor position to a start tick. `player.ts` is the transport, written against
an injected sink/clock/timer so it's tested with a fake clock (no browser, no device): a
look-ahead scheduler — a 25 ms timer hands the sink every message due in the next 200 ms
(1.2 s when the tab is hidden, since hidden tabs' timers are throttled to ~1 s), each with its
exact timestamp, so musical timing doesn't depend on timer jitter. A message already handed
to Web MIDI can't be reliably recalled (`MIDIOutput.clear()` isn't dependable across
browsers), so **stop sends note-offs and a pedal lift twice** — now, and again just after the
last message already scheduled — otherwise a note scheduled but not yet fired would sound
after Stop and stick. Starting mid-piece re-presses the sustain pedal if the music had it
down there. Speed scales real time only. **Only notes and sustain are sent — no program
change, volume or pan**, unlike the file, so the piano keeps the sound and volume it's set to.

**UI.** `MidiInputs` became `MidiPorts` (`src/ui/midi.ts`) and gained output listing/
selection and a `send(bytes, atMs)` whose timestamps are on `performance.now()`'s clock (Web
MIDI's); it swallows a send to a port that vanished mid-playback rather than throwing into
the timer. `useMidiPorts` (the port state, moved out of `App.tsx` along with the input logic)
remembers the chosen input and output in localStorage; with nothing remembered it plays on
the output whose *name matches the selected input*, since a digital piano shows up as both.
`usePlayback` builds the timeline at Play time from the current score, mirrors the player's
status via its `subscribe` (so no `setState` in an effect), and follows it with a
`requestAnimationFrame` loop throttled to ~30 Hz. Toolbar: Play/Pause and Stop icons (Space
toggles, Esc stops; Space blurs a focused toolbar button so its key-up doesn't also "click"
it), a speed select (50-125%), and labelled In / Out device selects. Play from the cursor
(the note you last clicked). `ScoreView` draws the playhead as an orange line across the
whole system, interpolated between note columns, and scrolls to follow it instead of the
cursor while playing. Play asks for MIDI access on first use (a user gesture) and says why
if there is no output. The toolbar now wraps to two rows instead of overflowing.

**Verified** in the real app with a fake Web MIDI piano injected into the page (headless
Chrome has no MIDI devices) that records every message and timestamp: notes at exact tempo
spacing, handed over 79-200 ms before they're due, no program/volume/pan, silence messages on
stop; Play/Pause/Space/Stop states, a frozen playhead while paused, Play starting at the
clicked bar. **Not yet tried with a real piano** — that is the first thing to check: whether
the piano responds on MIDI channel 1 (the first part's channel) and honours the sustain pedal
message.


## Built-in sounds and the toolbar reorganization (2026-09-20)

Frank asked for playback "with a basic set of sounds (ala GarageBand presets)" and for the
busy toolbar to be tidied ("put all the MIDI things together and use icons").

**`src/audio/`** — an `AudioEngine` implementing the same `MidiSink` the Player already
drives, so the scheduler, timeline and playhead are unchanged: the sink is now "built-in
sounds" or "MIDI device". `player.ts`'s `MidiSink` gained an optional `clear()`; the engine
implements it (it *can* recall scheduled notes, unlike a MIDI port), and `Player.silence()`
calls it first, still followed by the double note-off for sinks that can't.
- `presets.ts` — the nine presets as plain data (Grand Piano, Electric Piano, Organ,
  Harpsichord, Strings, Warm Pad, Harp, Vibraphone, Music Box) so the UI lists them without
  touching Web Audio. `instruments.ts` — one voice factory per preset.
- `voices.ts` — `VoiceManager`: note-on/off with sustain-pedal bookkeeping (a released key
  keeps sounding while the pedal is down), retrigger of a held pitch, and voice stealing
  past 40. Retrigger *splices* the old voice out of its bookkeeping before killing it,
  otherwise a later pedal lift would "release" a dead voice. Pure and unit-tested with a
  fake spawner.
- `engine.ts` — the graph: voices → bus → (dry | shared convolver reverb, IR generated in
  code, per-preset send) → compressor → make-up gain → volume → soft limiter (transparent
  to 0.6, then a smooth curve to 0.9) → destination. The `AudioContext` is created lazily
  from a user gesture (autoplay rules). Envelopes use `setTargetAtTime` with
  `cancelAndHoldAtTime` on release so a release arriving mid-decay starts from the current
  level. `send()` converts the Player's `performance.now()` timestamps to audio-clock time.
  `preview()` plays a short arpeggio, used to audition a preset when it's clicked.
- **Grand Piano is sampled**: the Salamander Grand Piano (Alexander Holm, CC BY 3.0), the
  compact 30-sample Tone.js set, one sample every three semitones, ~2.3 MB of mp3 in
  `public/samples/salamander/` (credit in that folder's README and in the Sound menu),
  fetched and decoded on first use; other pitches play the nearest sample re-tuned with
  `playbackRate` (at most ±1.5 semitones). The recording is a real, stretch-tuned piano, so
  the top octave measures ~10 cents sharp of equal temperament — left as is. (Earlier I
  told Frank the set was ~1.2 MB; it's 2.3 MB.)
- **Everything else is synthesized**: electric piano = two-operator FM whose modulation
  index decays (bark → mellow); organ = drawbar sines; strings/pad = detuned sawtooth
  ensembles through a swept low-pass with slow vibrato; vibraphone/music box = decaying
  inharmonic bar/tine partials. Harpsichord and harp are **Karplus–Strong plucks rendered
  in JS** (`karplus.ts`) into buffers, not Web Audio delay loops (a delay in a feedback
  loop can't be shorter than one 128-sample block, capping pitch at ~344 Hz).
- **Karplus details worth keeping**: the classic two-point-average loop filter strangles
  the *fundamental* of high notes (more trips per second, each losing a little), so up the
  keyboard the filter weight `s` is cut back (`0.5·(500/f)³`, floor 0.01) and the
  fractional part of the loop delay is made up by a first-order **allpass** rather than by
  interpolation (which also low-passes). The seed burst has its mean removed and a ~7 Hz
  DC-block runs over the result; at MIDI 93 a leftover DC term had put the tuning 36 cents
  out. Tested to within 6 cents at MIDI 36-93, and for high notes not fading to nothing.
- Calibration was done by rendering every preset offline (`OfflineAudioContext`, driven
  from headless Chromium against the dev server) and measuring per-note tuning by
  autocorrelation, level in a window mid-note, tail after release, NaNs and peak: all
  synths within ~1 cent (music box reads +14 cents on low notes; inharmonic partials fool
  the estimator), levels within a few dB of each other, peak below 0 dBFS.

**UI.** `useSound` owns the engine and the choices (target `builtin | midi`, instrument,
volume — each remembered in localStorage via the new `storage.ts`, which `useMidiPorts` and
the filename memory now share) and gives `usePlayback` one stable sink that forwards to
whichever target is selected (a ref kept current by the setter; the Player is built once).
`usePlayback` now takes `{ sink, ensureOutput }` instead of the MIDI port object. Play with
the built-in target starts the engine (loading the piano the first time, with a "Loading
piano samples…" hint next to the transport); switching target stops playback first.
Picking a preset auditions it unless the score is playing (then it's heard live).

**Toolbar.** Left to right: document name; New / Open / Save / Save As; Undo / Redo; Print /
Staves / Import PDF; Play / Stop / speed; then a right-aligned cluster of icons: **Sound &
MIDI**, Export MusicXML, Compare with PDF, then Shortcuts and Score Info. All the MIDI
things are in one popover (`ToolbarMenu` + `SoundMenu`): *Play through* (Built-in sounds |
MIDI device) with the preset grid + volume, or the output select; *MIDI keyboard* (connect,
input select); *Export MIDI file* (Performance | Notation-exact); the sample credit. A small
green light on the icon means a MIDI device is connected. `ToolbarMenu` closes on an outside
click or Escape — Escape is handled in the capture phase and stopped, so closing a menu
doesn't also stop playback. The Samples select moved into the New-score form ("Or open a
sample"). The cluster is one flex container so at narrow widths it wraps as a unit and
stays right-aligned. `window.__pmnEngine` (dev builds only) exposes the engine for e2e
checks.

**Verified** in headless Chromium and real Chrome: Play with the piano schedules the
score's notes; an `AnalyserNode` tapped on the engine's output during live playback read a
peak of ~0.74 and ~0 after Esc; preset switching (and its audition); persistence keys;
Escape closing the menu without stopping playback; zoomed/2x screenshots of the toolbar at
1400 and 1000 px. **Not verified by ear** — Frank should judge the sounds; the levels and
tuning are measured, not the taste.
