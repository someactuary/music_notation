# Piano Score Editor — Project Plan

Personal-use music notation software focused on piano scores: create, edit,
engrave, print, and (optionally) play back.

Status: M1 DONE 2026-09-13. M2 next. All section-10 decisions confirmed by Frank.

---

## 1. Guiding constraints

- Single user, macOS, pianist. Optimize for fast entry and good-looking piano
  output, not for orchestral breadth or collaboration.
- Grand staff is the default and first-class object. Cross-staff notes,
  pedal marks, fingering, voices per staff, and hand-splitting are core, not
  afterthoughts.
- Output quality target: "looks like a real published edition" (Henle-ish),
  because you will be reading these at the piano.
- Everything must be testable without a human eye where possible: golden SVG
  renders, model round-trips, MusicXML corpus round-trips.

## 2. Technology stack **[confirm]**

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | One language for model, layout, UI, and playback; huge ecosystem for SVG/MIDI/audio. |
| Rendering | Hand-rolled SVG engraver using a SMuFL font (Bravura or Leland) | Piano notation (cross-staff beams, voices, pedal, ottava) fights VexFlow's abstractions. SMuFL gives glyph metrics + engraving defaults from `*_metadata.json`. |
| App shell | Vite web app first; wrap in Tauri later for a native .app | Browser gives print-to-PDF, Web MIDI, Web Audio for free. Tauri adds native file dialogs and a dock icon when wanted. |
| UI framework | Solid or React (lean toward Solid for fine-grained updates on a big score) | The score canvas is custom SVG anyway; the framework only drives panels/palettes. |
| State/undo | Immutable score model + command pattern | Undo/redo is non-negotiable in a notation editor. |
| Tests | Vitest + snapshot SVG tests + a small MusicXML corpus | Layout regressions are visual; snapshots catch them. |
| Print/PDF | Paginated SVG → `window.print()` initially; `svg2pdf.js`/`pdf-lib` later for direct export | Browser print with `@page` CSS is good enough to start. |

Alternative considered: VexFlow for rendering. Faster to first pixel, but we would
hit its walls on piano-specific layout within weeks. Rejected unless you want
a quick prototype first.

Alternative considered: LilyPond as the engraver (write a LilyPond file, shell
out, show the PDF). Best-looking output on day one, but no interactive editing,
slow feedback loop. Could be an *export* target later.

## 2a. Reference software (what to borrow)

| Software | Borrow | Avoid |
|---|---|---|
| **Noteflight** (browser, you've used it) | Browser-native SVG score, keyboard step entry with auto-advancing cursor, MIDI step input, simple palettes. Closest existing model to this plan. | Cloud dependency, limited engraving control, weak cross-staff/pedal handling. |
| **Cakewalk Score Writer** (older, you've used it) | Staff-and-cursor mental model; piano-first defaults. | Its MIDI-first model where notation is a view of a MIDI track; we keep notation as the source of truth and derive playback. |
| **MuseScore 4** | Keyboard shortcuts (number = duration, letter = pitch), voice handling, palettes, Leland font, MusicXML behavior as the de-facto reference. | UI sprawl. |
| **Dorico** | Best-in-class semantic model: content vs. layout separation, "flows", auto engraving with minimal manual nudging, popovers for text entry of dynamics/tempo. Our model/layout split and the command bar idea come from here. | Complexity of its multi-layout system. |
| **Sibelius / Finale** | Keypad-driven entry (Sibelius), mature engraving rules. | Legacy formats. |
| **LilyPond** | Engraving quality benchmark; its spacing and slur algorithms are documented and worth reading. Possible export target. | Text-only workflow for interactive use. |
| **Verovio / MEI** | Clean rendering-engine architecture (data → layout → SVG), SMuFL usage. Good code to study for engraving/. | MEI as native format is overkill here. |

Rule of thumb: Noteflight for the *feel*, Dorico for the *model*, LilyPond and
Verovio for the *engraving math*, MuseScore for *shortcuts and MusicXML compatibility*.

## 3. File format

### 3.1 Native format: versioned JSON (`.pscore`)
- Human-readable, diffable, trivially loaded in TS. Schema versioned with a
  `formatVersion` and migration functions.
- Durations are exact rationals (numerator/denominator of a whole note), never
  floats. Tuplets carry an explicit ratio. Ticks are a playback-only concept.
- Every element has a stable `id` so spanners (slurs, hairpins, pedal lines,
  ottava) reference endpoints by id and survive edits.

### 3.2 Document model (sketch)
```
Score
  meta: title, composer, copyright, page/engraving settings
  parts[]              # piano = one Part with staves = 2
    staves[]           # clef per staff, staff lines, default
    measures[]         # measure-level: time sig, key sig, barline, repeats, rehearsal
      voices[]         # up to 4 per staff; each voice is a sequence
        events[]       # Note | Chord | Rest | (grace group, tuplet group)
          Note: pitch{step, alter, octave}, duration, tie, accidental
                (explicit / courtesy / auto), staffOverride (cross-staff),
                fingering, articulations[], notehead, stemDir override
  spanners[]           # slur, hairpin, pedal, ottava, trill line, tie-across-system
  attachments[]        # dynamics, tempo, text, fermata → anchored to event/measure ids
  layout hints         # forced system/page breaks, manual nudges (kept separate
                       # from musical content so "reset layout" is trivial)
```
Principle: musical content and presentation overrides live in separate trees.

### 3.3 Interchange
- **MusicXML** import/export (partwise). This unlocks MuseScore, Dorico,
  Finale, IMSLP-derived files. Aim for a correct subset (notes, voices,
  articulations, dynamics, slurs, ties, tuplets, pedal, fingering, repeats).
- **MIDI** export (and import with quantization, later).
- PDF/SVG export for printing.

## 4. Display / engraving pipeline

Model → **Semantic pass** → **Horizontal spacing** → **Line breaking** →
**Vertical layout** → **SVG render**.

1. Semantic pass (per measure, per staff)
   - Stem direction rules (single voice: by average pitch; two voices: up/down).
   - Beaming groups from time signature (and manual overrides).
   - Accidental logic: what to show given key signature and earlier notes in
     the measure; courtesy accidentals; ties across barlines.
   - Chord notehead stacking (seconds offset to the right), accidental
     stacking columns.
   - Rest positioning in multi-voice contexts.
   - Cross-staff notes: note belongs to a voice on staff A but is drawn on
     staff B; beams may span staves.

2. Horizontal spacing
   - Duration-based ideal widths (width ∝ log of duration, standard
     engraving practice) with minimum distances from glyph bounding boxes.
   - Align simultaneous onsets across both staves (and voices) into columns.
   - Prefix items (clef, key, time, accidentals) get fixed widths.

3. Line breaking
   - Start greedy (fill system to max width, then justify). Upgrade to
     Knuth–Plass style optimal breaking if greedy looks uneven.
   - Honor forced breaks from layout hints.

4. Vertical layout
   - Staff-to-staff distance for the grand staff; system spacing on page.
   - Place dynamics, pedal, text, and slurs in "lanes" with collision
     avoidance against note skylines (compute a simple skyline per staff).
   - Slurs as cubic Béziers with endpoints/heights chosen from the skyline.

5. Render
   - Pure function: `LayoutResult → SVG string/DOM`. Glyphs from a SMuFL font
     via `<text>` with the font family, metrics from the SMuFL metadata JSON.
   - Interactive mode: each element carries `data-id` for hit-testing.
   - Print mode: paginated pages at real physical size (mm), `@page` CSS.

Engraving defaults (staff line thickness, stem width, beam thickness, etc.)
come straight from the SMuFL font metadata and are user-tweakable in settings.

## 5. User input

Selection model first: a cursor (position in time × staff × voice) plus a
selection (single element, list, or a rectangular range of measures×staves).
Every edit is a Command with `apply`/`invert` for undo.

Entry modes (all can be mixed):

1. **Step entry via computer keyboard** (Dorico/MuseScore-style, primary):
   - Number keys pick duration (e.g. 5 = quarter, 6 = half, 4 = eighth).
   - Letters A–G enter pitch; nearest-octave rule; `Shift+Up/Down` octave;
     `+`/`-` sharp/flat; `.` dot; `0` rest; `T` tie; `Shift+letter` adds to
     chord; `Tab`/arrows move cursor; `V` switches voice; `X` flips staff for
     cross-staff.
   - Cursor advances automatically after each entry.
2. **MIDI keyboard step entry**: pitch(es) from the MIDI device, duration from
   the current keyboard-selected value. Holding several keys at once = chord.
   Cheap to add on top of mode 1 via Web MIDI.
3. **Mouse/trackpad**: click to select, drag to move pitch, drag handles on
   slurs/hairpins, palettes for articulations/dynamics/ornaments, context
   menus for properties.
4. **Text mini-language** in a command bar (optional, later): e.g. type
   `c4 e g c5` or `mf` or `ped` at the cursor. Fast for a pianist who thinks
   in notes.
5. **Real-time MIDI recording** with quantization (later, with playback).

Annotations: dynamics (text + hairpins), tempo (text + metronome mark),
articulations, fingering (1–5 with hand awareness), pedal (Ped./* and line
style), slurs/phrasing, ottava, expressive text, rehearsal marks, repeats.

## 6. Playback (optional, later)

- Tempo map from tempo marks; dynamics → velocity; pedal → CC64; ties merge;
  repeats/endings expanded to a linear playback sequence.
- Output: Web MIDI to an external synth/DAW, **or** Web Audio with a piano
  soundfont (e.g. via a small sampler library) so it works standalone.
- Look-ahead scheduler (Web Audio clock), moving playhead, click on a note to
  start there. Playback sequence is derived from the model, never stored.

## 7. Milestones

| # | Milestone | Definition of done |
|---|---|---|
| M0 | Skeleton + model + single staff | Repo, CI, JSON schema v1, load/save, render one staff of notes/rests with correct spacing and stems. Golden SVG tests. |
| M1 | Grand staff editor MVP | Two staves, multiple measures, key/time sigs, accidentals, beams, chords, ties, dots, line breaking. Keyboard step entry, cursor, undo/redo. |
| M2 | Expressive notation + print | Voices, tuplets, slurs, dynamics, hairpins, articulations, pedal, fingering, tempo, text. Pagination and print-to-PDF at real size. |
| M3 | Interchange + MIDI input | MusicXML import/export with corpus tests; MIDI keyboard step entry. |
| M4 | Playback | Tempo map, Web Audio piano, playhead, MIDI export. |
| M5 | Piano polish | Cross-staff beaming, ottava, grace notes, tremolo, repeats/endings, arpeggio, trills, layout nudging, Tauri packaging. |

M0 and M1 produce something you can actually use to write a short piece.

## 8. Agent plan: tiers and thinking depth

The tiering rule: **the harder it is to know when you're wrong, the higher
the tier.** Engraving algorithms fail silently (output looks "off"); UI
plumbing fails loudly (test fails, button doesn't work).

### Tier 0 — Architect / integrator (Fable, highest reasoning; this session)
- Owns: architecture, the score model schema, the TypeScript interface
  contracts between modules (`Score`, `Command`, `LayoutResult`, `Renderer`,
  `Importer/Exporter`, `PlaybackSequence`).
- Writes the contracts and a handful of reference tests *before* fanning out
  work, so lower tiers build against fixed interfaces.
- Reviews everything from Tier 1; spot-reviews Tier 2; merges worktrees;
  resolves cross-module conflicts.
- Personally verifies any subagent claim about notation correctness.

### Tier 1 — Domain specialists (Opus, high reasoning effort)
Tasks where music-engraving knowledge and algorithmic judgment matter:
- Horizontal spacing and column alignment.
- Beaming, stem direction, multi-voice rest placement.
- Accidental logic and stacking.
- Line breaking and justification.
- Slur/hairpin/pedal placement with skyline collision avoidance.
- Cross-staff beaming.
- MusicXML semantic mapping (what maps to what, and what's lossy).
- Playback tempo/dynamics/pedal interpretation.
Each task gets: the contract, a reference (Gould's *Behind Bars* rules
summarized in the prompt), and a golden-test expectation. One agent per
task, isolated worktree, must deliver tests.

### Tier 2 — Feature implementers (Sonnet, medium reasoning)
Well-specified, testable work:
- Command implementations (insert note, delete, change duration, transpose,
  add articulation…) and undo/redo.
- Keyboard step-entry state machine and key bindings.
- Web MIDI input adapter.
- Selection and hit-testing over the rendered SVG.
- Palettes, inspector panel, file open/save, settings UI.
- Pagination and print CSS; PDF export wiring.
- MusicXML parser/serializer plumbing (given Tier 1's mapping spec).
- Web Audio scheduler and soundfont loading.
Can run several in parallel in separate worktrees because they touch
different directories.

### Tier 3 — Mechanical tasks (Haiku, low reasoning)
- Generate glyph/metrics tables from SMuFL metadata JSON.
- Test fixtures: sample scores in JSON and MusicXML.
- Boilerplate: component scaffolds, config, lint/format fixes.
- Docs: keyboard shortcut reference, README.
- Bulk renames and dependency bumps.

### Supporting roles
- **Explore agents** (read-only) for "where is X handled" questions once the
  codebase is large.
- **Reviewers**: Opus for anything under `engraving/` or `model/`; Sonnet
  `/code-review` for the rest. Reviews check tests exist and pass, not just
  that code reads well.

### Workflow per milestone
1. Tier 0 writes/updates contracts + milestone task list with acceptance tests.
2. Fan out: Tier 1 tasks first (they gate the rest), Tier 2 in parallel where
   contracts allow, Tier 3 whenever.
3. Each agent works in its own git worktree on a branch, runs the full test
   suite, and reports with: what changed, tests added, known gaps.
4. Tier 0 reviews, runs golden renders, merges, updates this plan.

Rough cost shape: most tokens go to Tier 1 in M0–M2 (engraving is the hard
part), shifting to Tier 2 in M3–M5.

## 9. Proposed repository layout

```
personal_music_notation/
  src/
    model/        score types, ids, durations (rational), schema + migrations
    commands/     Command interface, undo stack, all edit commands
    engraving/    semantic pass, spacing, breaking, vertical layout, skyline
    render/       LayoutResult → SVG; SMuFL glyph tables; print pagination
    input/        keyboard step entry, MIDI input, mouse/hit-testing
    io/           .pscore load/save, MusicXML, MIDI export
    playback/     tempo map, sequence builder, Web Audio/Web MIDI output
    ui/           app shell, panels, palettes, inspector
  fonts/          Bravura or Leland (OFL) + metadata JSON
  test/
    golden/       reference SVGs
    corpus/       MusicXML sample files
  docs/           engraving rules cheat-sheet, shortcuts
```

## 10. Decisions (confirmed 2026-09-13)

1. Stack: TypeScript + own SVG engraver + SMuFL font. Confirmed.
2. Project name: `personal_music_notation`.
3. Font: Bravura.
4. Frank has a digital piano but will connect it later; MIDI input stays at M3.
5. Browser-only until features are settled; port to a native app afterwards.

UI framework: React (chosen over Solid for agent fluency and ecosystem; the
score canvas is custom SVG either way).

## 11. Progress log

- 2026-09-13: Scaffold + Tier 0 contracts committed. M0 fanned out to four
  agents in worktrees: Opus engraver (`src/engraving`), Sonnet renderer + app
  shell (`src/render`, `src/ui`), Sonnet file format + command history
  (`src/io`, `src/commands`), Haiku fixtures + docs (`test/fixtures`, README).
- 2026-09-13 (later): M0 complete. All four branches merged; 174 tests, lint and
  build green. App (`npm run dev`) engraves the six sample fixtures with a picker and
  prints. Golden SVG snapshots in test/golden. Visual check of all fixtures done by
  the architect: stems, beams (4/4, 3/4, 6/8, partial beams), accidentals with measure
  memory, chords with seconds, rests, ledger lines, brace, final barline, title, page
  layout all correct.

  Carry-overs into M1 (from engraver report + review):
  - Key signature must repeat at every system start (currently only where declared).
  - Mid-measure clef changes ignored; repeat barlines drawn as double.
  - Multi-voice: no voice-aware stems/rests, shared accidental memory.
  - Flag width not reserved in column spacing.
  - `GlyphPrim` may want non-uniform scaleX/scaleY for the brace.
  - `History` lacks label accessors for an undo/redo menu.
  - Agent process: Sonnet renderer agent stalled once with nothing written; a
    nudge to "stop exploring, write files in this order" fixed it. Include that
    ordering in Tier 2 prompts from the start.
- 2026-09-13 (M1 start): contracts added (MeasureLayout.columns, src/input/types.ts
  editor state + KeyHandler, note-entry semantics in ARCHITECTURE.md). Fanned out:
  Opus engraving (key sig per system, ties, tied-note accidentals), Sonnet commands +
  pure step-entry key handler, Sonnet editor UI (store, cursor, selection, open/save,
  autosave, undo/redo).
- 2026-09-13 (M1 done): 271 tests, lint and build green. Engraving: key signature at
  every system, key-change cancellation naturals, ties (in-measure, across barline,
  across system break) with tie-aware accidental memory. Editing: span-replace
  writeEvent with rest decomposition, erase, chord add/remove, accidentals, semitone/
  octave transpose, append measure (final barline follows). Pure keyboard step entry
  (MuseScore-style: N, 1-7 durations, ".", A-G nearest octave with key-signature
  alteration, Shift+letter chord, 0 rest, +/- pending accidental, arrows transpose,
  T tie, Backspace/Delete, Tab staff, Home/End, mod+arrows measures, mod+Z/shift+Z).
  UI: store with grouped undo per keystroke, cursor overlay from layout columns,
  click selection and empty-space hit-testing, New/Open/Save .pscore, autosave to
  localStorage, status bar. Verified by the architect in headless Chromium by typing a
  five-measure phrase (quarters, beamed eighths, chord, rest, flat, tied whole notes),
  then undo/redo and autosave.

  Carry-overs into M2:
  - Courtesy key signature at the end of the previous system (needs breaker awareness).
  - Tie tuning: long ties slightly deep (1.2 sp cap); continuation stub tight after clef.
  - No collision avoidance tie vs accidentals/articulations; multi-system ties draw only ends.
  - Entering a rest into an all-rest measure collapses to a measureRest with a new id, so
    the returned selection id is stale (harmless).
  - Duration indicator next to the cursor during entry not shown.
  - Mid-measure clef changes, repeat barlines, voices, tuplets, grace notes still absent.
  - Bass-staff entry works via Tab but nothing enforces piano range; no MIDI yet (M3).
- 2026-09-13 (M1 follow-up from Frank's feedback): Noteflight duration keys (1 whole,
  2 half, 4 quarter, 8 eighth, 6 sixteenth, 3 thirty-second); selection shown as an
  outline around noteheads/rests instead of a blue fill; cursor thin, faint, left of
  the note, and only in note-entry mode; shift/⌘-click and rubber-band multi-select;
  shift+arrows extend selection; ⌘A; ⌘C/⌘X/⌘V with an internal clipboard that pastes
  across barlines by splitting into tied notes; Enter / shift+Enter insert a measure
  after / before; ⌘Backspace removes the measure; Delete erases a multi-selection.
  In-app Shortcuts panel. 306 tests. Verified headlessly by the architect.
- 2026-09-13 (M2 start): Frank's additions: "." and duration keys act on selected notes;
  add/remove staves with clef changes for SATB. Contracts: Part.bracket, StaffDef.name/
  abbreviation, PaletteAction + ActionHandler. Fan-out (parallel): Opus E1 voices +
  tuplets + staff groups/names; Opus E2 attachments + spanners + skyline; Sonnet C1 staff
  commands, duration-on-selection, tuplet entry, notation commands, voices, handleAction,
  keys; Sonnet U1 staves panel, SATB preset, palettes, notehead drag, voice toggle.
- 2026-09-14 (M2 done): 473 tests, lint and build green. Engraving: voices (stems by
  voice, rest offsets, unison offset, invisible rests), tuplets (brackets, numbers,
  nested, beaming by outer tuplet), staff groups (brace/bracket/none) and staff names,
  articulations, fermata, dynamics lane, hairpins, slurs with skyline clearance and
  system-break splitting, pedal text/line, ottava, trill line, glissando, tempo with
  metronome glyph, expression text, fingering. Editing: staff add/remove/clef/name/
  bracket, "." and duration digits on selected notes, tuplet entry (⌘3 etc.) and writing
  inside tuplets, voice switching (V, ⌘⌥1-4) with create-on-demand, hidden rests (H),
  slur (S) / hairpins (< >) keys, palettes for dynamics, articulations, lines, marks,
  fingering, tuplets, durations; Staves panel; New SATB preset; drag a notehead to change
  pitch. Verified by the architect in headless Chromium: dot/duration on selection,
  voice-2 entry (after fixing a cursor clamp that reset the voice), triplet creation and
  fill, palettes, drag D4→F4, SATB + fifth staff with alto clef.

  Carry-overs into M3 (besides MusicXML + MIDI input):
  - ⌘A selects voice 0 only; no keyboard multi-voice selection.
  - Ornaments, arpeggio, tremolo not drawn; 15ma falls back to 8va glyph.
  - Tuplet brackets horizontal; cross-voice rest/note collisions unhandled.
  - Text widths estimated (no font metrics) for labels/tempo/expression.
  - Courtesy key signature at the end of a system before a key change still missing.
  - No "Pasted" status message; first Right-arrow from measure start skips the first note.
  - No lyrics yet (needed for choral work); no part names beyond staff names.
- 2026-09-14 (M3 start): contracts for lyrics (model + engraving/entry rules), MIDI
  handler, MusicXML signatures, fflate for .mxl. Fan-out: Opus MusicXML import/export +
  corpus; Opus lyrics/ornaments/arpeggio/tremolo engraving; Sonnet lyric entry mode,
  MIDI spelling/entry, small fixes; Sonnet MIDI device UI, lyric-mode status, MusicXML
  open/export.
- 2026-09-14 (M3 done, after a rate-limit stop and resume of all four agents): 641 tests,
  lint and build green. MusicXML import/export (partwise, .mxl, voices, tuplets, lyrics,
  directions, repeats/endings, SATB parts → staves); every fixture round-trips; all
  exports and the corpus validate against the W3C MusicXML schema with xmllint.
  Lyrics: model, engraving (verse lanes, hyphens, extenders, spacing, dynamics above
  lyric staves), entry mode (L / ⌘⇧L, Space, "-", "_"). Ornaments, arpeggio, tremolo
  drawn. MIDI: Web MIDI device UI, key-signature spelling, chords from held keys.
  Architect fixes at integration: hyphens repeated every 12 sp (one hyphen per word
  break across a barline); chord tones after a note that filled the measure now join
  it (found in the browser: MIDI G-B-D came out as G alone); Shift+letter builds chords
  upward above the top note; stale status messages cleared on the next key.

  Carry-overs into M4:
  - Exported MusicXML not yet opened in MuseScore/Dorico (schema-valid only).
  - Arpeggio uses a scaled single glyph; wiggle glyphs are excluded by gen-smufl.ts.
  - Pedal line vs lyrics collision possible (lyrics excluded from the skyline).
  - Only voice 0 carries directions on MusicXML export.
  - Earlier carry-overs still open: courtesy key signature at system end, text metrics.
- 2026-09-15: Frank re-scoped M4 from playback to PDF import ("pull PDF sheet music in
  so I can re-arrange it"): staves, key signatures, notes first; other markings if easy.
  Evaluated Audiveris 5.11 on his two samples (a 9-page piano arrangement exported as
  vector outlines, a 2-page InDesign hymnal page in the Maestro font): notes, rhythms,
  keys, meters, pickup, voices correct on checked pages; 414 vs 416 noteheads on the
  hymn; lyrics need Tesseract data (installed). Playback moves to M5.
- 2026-09-15 (M4 done: PDF import). Audiveris 5.11 behind a local service mounted in
  the Vite dev server (server/omr-service.ts; setup: scripts/setup-omr.sh); Import PDF…
  dialog with progress, "Notes only" (default) or "Everything recognized", original
  page/system breaks kept; Compare panel shows the original PDF page following the
  cursor, with a plain-language review list (measures the recognizer left short).
  Engraving: staves spaced by their content (lyric lanes, ledger notes, markings).
  Verified end to end with the real service on both samples: hymn 8.6 s, piano 90.5 s,
  noteheads 414 / 1,588, compare panel follows to the last page. Architect fixes from
  that run: overlapping pdf.js renders garbled the panel; cursor could leave the screen
  (now full-height layout with its own scroll areas); review text was jargon; the M2
  palette row and staves panel printed (extra page). 793 tests.

  Carry-overs:
  - OMR misses 8va lines, some text (tempo, accel.), invents occasional fermatas; the
    compare panel and "Notes only" are the mitigation. Titles may have OCR slips.
  - Review list covers padded voices and validation issues only; it can't know about
    wrong pitches. A side-by-side overlay or measure-level highlight would help.
  - The PDF is kept in memory only (lost on reload); scans untested (only digital PDFs).
  - Playback moved to M5.
- 2026-09-15 (feature: mid-song key changes + manual layout control). Implemented
  directly (no agent fan-out — well-scoped enough for one pass): `setKeySignature`
  command; `LayoutHints.measuresPerSystem`/`systemsPerPage` (upper-bound caps, fit
  always wins) plus `toggleSystemBreak`/`togglePageBreak`/`clearForcedBreaks`
  commands; Key and Layout palette groups. 822 tests (29 new), lint and build clean.
  Verified in the browser on Frank's real sparse-page file: Reflow took it from 15
  pages to 11; a 3-measures-per-line cap on a fresh score rendered exactly 3+3+2.
- 2026-09-15 (feature: selectable markings + a real click-hit-testing fix). Implemented
  directly. Root cause of "only one voice selectable" confirmed live with
  `elementFromPoint`: every glyph's native DOM hit area is its full 4-sp font em-box, not
  its ink, so close simultaneous notes across two voices had overlapping hit regions
  with the later-painted voice always winning. Fixed by replacing ScoreView's DOM
  `closest("[data-id]")` click routing with a pure-geometry `hitTestElement`
  (src/ui/layout-utils.ts), built on generalized per-primitive-type bounding boxes that
  also make slurs/ties/hairpins/pedal/ottava/dynamics/tempo/text/fermata/articulations/
  fingering/tuplets/lyrics/ornaments selectable (not just notes/rests). Added: delete
  routing for spanners/attachments by id (removeSpanner/removeAttachment before falling
  back to note erase), and drag-to-nudge for movable markings via a new
  `layout.nudges` post-processing pass in the engraver (src/engraving/nudges.ts).
  Verified live: the exact two-voice repro now alternates Voice 1/Voice 2 correctly on
  every click; a slur can be clicked, outlined and deleted; a fermata can be dragged
  (confirmed moved on screen and in the persisted nudge) and deleted (nudge cleared).
  867 -> 852 (net) tests incl. a direct regression test reproducing the original bug
  through the real engraving+hit-test pipeline. Found and fixed one real scoping bug
  along the way: fermata shared "articulation"'s role, which is deliberately excluded
  from MOVABLE_ROLES (multiple articulations share one id) — gave fermata its own Ref
  role since it has its own independent Attachment id.

  Carry-overs:
  - Beams have no independent model identity; clicking one selects its first note only.
  - A single articulation/ornament/fingering mark isn't independently deletable from its
    host note (no per-decoration id yet) — deleting the note removes them as a side
    effect. Toggling via the existing palette (toggleArticulation etc.) still works.
  - Large nudges can overlap neighbouring content (applied after extent measurement).
  - Text/line/path hit boxes use estimates (no real font metrics; a safe convex-hull
    bound for bezier paths), same limitation as engraving's own text spacing.
- 2026-09-16 (fix: marking-drag autoscroll jump + Delete erasing the whole note).
  Implemented directly; both reported against Frank's real "Be Still, My Soul" file.
  Root cause 1: ScoreView's cursor-follow scroll effect depended on `layout`, which is
  a fresh object on every edit, so dragging a marking (an edit) re-ran it and jumped
  the view back to the cursor's page. Fixed with a `lastScrolledMeasure` ref that skips
  the scroll unless `cursorMeasure` itself actually changed. Root cause 2: Selection
  carries only ids, no role, so a click resolving to a tie or an articulation (both
  share their host note event's id, having none of their own) left `deleteSelection`
  unable to tell "erase this decoration" from "erase this note" — it always erased the
  note. Confirmed live: several slurs in measures 67-79 visually overlap a tie closely
  enough that a click resolves to the tie. Fixed in `eraseSelected` (step-entry.ts):
  before erasing a note event, it now strips any tied notes and note-level decorations
  (new `clearEventDecorations` in commands/notation.ts) instead, with a status message,
  and only erases the event on a second Delete once nothing is left to strip. 859 tests
  (8 new), lint/typecheck/build clean. Verified live against the real file: dragging a
  slur no longer moves the scroll position at all (pixel-identical before/after); a
  tied chord's tie and a lone accent each survive one Delete with the decoration gone
  and a second Delete erases the note; 400 ArrowRight presses still autoscrolls
  normally (no navigation regression).

  Carry-over: stripping removes all of an event's note-level decorations in one step
  (e.g. an accent and an ornament on the same note both go together), not one at a
  time — same "no per-decoration id" limitation as the carry-over above.
- 2026-09-17: project folder moved from ~/personal_music_notation to
  ~/AI Projects/personal_music_notation (git history, node_modules, gitignored
  sample_sheet_music/ all carried over intact). Verified clean lint/typecheck/859
  tests from the new location; no code referenced the old absolute path.
- 2026-09-18 (feature: editable score info, remembered filename, Save As, app rename).
  Implemented directly. Renamed the app to "Sheet Music Assistant" (was "Personal
  Music Notation") in index.html and the toolbar. Title/subtitle/composer/lyricist
  were set only by import or the New Score form and had no edit path afterward — added
  `setScoreMeta` (src/commands/meta.ts) plus a new toggleable `ScoreInfoPanel` (same
  pattern as StavesPanel: one text input per field, committed on blur). Also found and
  fixed a real gap: lyricist was captured in the model (including via MusicXML import)
  but never engraved anywhere — added it to the title block, top-left, mirroring
  composer's top-right placement. Separately, the app had no notion of "the current
  file" (Open/Save are pure browser downloads, no File System Access API) — added a
  remembered `fileName` (persisted to localStorage like the existing MIDI-input
  memory), a "Save As" button that always prompts for a name, and a filename display
  in the toolbar and the browser tab title. 862 tests (3 new), lint/typecheck/build
  clean. Verified live: editing title/composer/lyricist persists and re-engraves;
  Save with no prior name derives one from the title; Save As prompts and remembers
  the new name; a plain Save afterward reuses it without re-prompting; Open sets the
  remembered name and it survives a page reload; New Score clears it.
- 2026-09-18 (fix: flip stem direction). Frank reported stems flipping to the wrong
  direction when using arrow keys to move notes, citing bar 8 of his real file
  Rob_Mullins_Etudes_Bb.pscore (the A's stem pointing down instead of up). Investigated
  thoroughly: confirmed by direct engraving-output inspection that no pitch-editing
  command (setNotePitch, transposeNotes) has ever touched NoteEvent.stem, and that
  every stem-direction code path in semantic.ts prefers an explicit stem over pitch —
  a dragged note, an octave-transposed note, and one member of a beam group moved 2
  octaves all kept their original direction. The actual cause: bar 8's A already had
  stem: "down" baked into the imported file, almost certainly an Audiveris OMR misread
  of the original engraving, with no existing way to correct it. Added a real fix —
  `toggleStemDirection` (src/commands/notation.ts), wired as a "flipStem" PaletteAction,
  the "X" key (MuseScore's own shortcut for this), and a "Flip Stem" button in the
  Articulations palette group. Converges a whole selection to one direction per press
  so flipping an entire beamed run actually moves its shared direction. 870 tests (8
  new), lint/typecheck/build clean. Verified live against the actual reported note:
  Flip Stem button then "X" correctly toggled both the model field and the rendered
  stem line.
- 2026-09-18 (feature: automatic stem reconciliation on pitch change). Same-day
  follow-up: Frank clarified he wanted the stem to flip on its own whenever a move
  changes which direction is natural, efficiently for a whole moved section, not a
  manual fix per note. Added captureStemBaseline/reconcileStemAfterPitchChange
  (src/commands/notation.ts), called from setNotePitch (mouse drag) and transposeNotes
  (arrow keys): if an event's stem was tracking convention before the move and the
  move changes what convention picks, flips it to match; leaves alone a stem already
  set against convention (deliberate flip, or an uncorrected OMR misread), and never
  touches notes with no explicit stem (they already auto-track via the existing
  no-override render path). Accounts for multi-voice staves (voice convention instead
  of pitch) and mid-score clef changes (exported clefAtMeasureStart from engrave.ts);
  beaming is out of scope, same caveat as the manual flip. transposeNotes batches one
  baseline/reconcile pass per touched event, not per note, so a whole selected section
  moved together is still efficient. 880 tests (12 new), lint/typecheck/build clean.
  Verified live: after one manual toggleStemDirection to re-anchor the already-wrong
  note, moving it down an octave and back up with arrow keys auto-flipped its stem
  both ways with no further manual steps.

  Also, while this was in progress: found the "editable score info" work from earlier
  today had added setScoreMeta (commands/meta.ts) without noticing setMeta already
  existed, unused, in commands/basic.ts. Consolidated onto setMeta (carrying over
  setScoreMeta's clear-on-empty-string behavior) and deleted commands/meta.ts.
- 2026-09-18 (redesign: toolbar). Frank found the New/Open/Save row "ugly and busy"
  and asked for icons, plus moving Shortcuts and Score Info to the far right under
  MIDI. Added six small hand-drawn icons (src/ui/icons.tsx: New/Open/Save/Undo/Redo/
  Print — no icon library in the project's dependencies) grouped into
  `.toolbar-group`s with a `.toolbar-divider` between clusters; Save As, Export
  MusicXML, and the panel/import/compare/sample controls stayed as text. Moved
  Shortcuts/Score Info to the end of the toolbar. Hit and fixed a real bug on the way:
  the icons first rendered blank because their SVGs were being flex-shrunk to ~1px
  wide inside the fixed-width icon buttons; fixed with `flex-shrink: 0` plus explicit
  pixel width/height on `.icon-button svg` (confirmed via computed-style inspection,
  not guessed) — a known gotcha for SVGs in flex containers worth remembering for any
  future icon work here. Verified live via screenshot and a functional pass (Undo
  starts disabled, New opens the form, Save downloads, Print doesn't error, toolbar
  child order matches the requested layout).
- 2026-09-19 (polish: toolbar icons round 2). Frank asked for real curved-arrow
  Undo/Redo icons (the first pass's plain triangles worked but didn't read as
  "undo" clearly), an icon for Save As, treble/bass clef glyphs for Staves, a
  PDF-style icon for Import PDF, tooltips restored on every icon (simple labels:
  "Save", "New", not "Save score"), and every remaining icon-less button pushed to
  the toolbar's far right. Implemented directly: curved-arrow Undo/Redo; a
  SaveAsIcon (a narrower floppy disk plus a separate "+", not overlapping — two
  overlapping disks would need one to mask the other with a fill matching the
  button's current background, which drifts on hover); a PdfIcon (generic
  document + red "PDF" badge, not a copy of Adobe's own mark); a ClefIcon (real
  stacked treble+bass Bravura glyphs, reusing Palettes.tsx's existing
  glyph-as-text-character technique, now exported as `Smufl`); every icon-less
  button now lives in one `.toolbar-text-group` with `margin-left: auto`,
  replacing the previous `.toolbar-doc { margin-right: auto }` (which would have
  split the leftover space between two auto-margins once both existed, pushing
  the icon cluster toward the middle instead of flush left). Verified with a
  zoomed screenshot of the real rendered toolbar, not just the SVG path data —
  this is what actually confirmed the curved arrows read correctly and the clef/
  PDF icons are legible at 16px. 880 tests still passing (no new command logic
  this round, UI-only), lint/typecheck/build clean.
- 2026-09-20 (feature: MIDI export + playback timeline; first half of the playback
  milestone). Frank asked for MIDI export "with high fidelity to the score", then to
  figure out playback options. Built a pure `buildTimeline(score, options)`
  (src/playback/) that decides everything about how the score sounds — repeats/endings,
  tie merging, tuplets, tempo map (marks, words, OCR-garbled text marks, rit./accel./a
  tempo, fermata holds), dynamics and hairpins as velocity, articulations, slurs,
  pedal, ottava, grace notes, ornaments, tremolo, arpeggios, lyrics — and a Standard
  MIDI File writer (src/io/midi/) that just lays the timeline out as a format-1 file.
  Two interpretations: "expressive" (for listening) and "literal" (notated lengths
  only, for carrying notation into another notation program), chosen from an "Export
  MIDI" menu in the toolbar. 1019 tests (139 new). Verified beyond the unit tests with
  tools other than my own code: an independent SMF parser in the tests over all 15
  fixtures in both modes; Python `mido` over both of Frank's real scores (same note
  counts and length); and Apple's own AVAudioSequencer, which loaded and rendered them
  offline through macOS's built-in sound bank. Found and fixed along the way: 15ma/15mb
  ottava sounded 23 semitones instead of 24 (caught by a test); a first tempo mark deep
  in a piece was being applied backwards to how the piece began (now only within two
  measures of the start); OCR-garbled metronome marks in Frank's scanned score ("J=110")
  were being ignored. Playback options evaluated but not yet built — see the entry
  below.
  Carry-overs: glissando, two-note tremolo, half pedal and D.C./D.S./coda aren't
  modeled; Frank's "Be Still, My Soul" has no tempo mark at the start (only an OCR'd
  "Rubato"), so it exports at the 120 default until a Tempo mark is added.
- 2026-09-20 (feature: playback through a MIDI device — second half of the playback
  milestone). Frank chose to send playback to his digital piano over Web MIDI (over
  in-browser piano samples). Added a tested look-ahead `Player` (src/playback/player.ts,
  against an injected sink/clock), a shared message/ordering module used by both the file
  writer and the player, a two-way tempo clock, tick<->score-position mapping, MIDI output
  support (`MidiInputs` renamed `MidiPorts`, gaining outputs + timestamped send), a
  `useMidiPorts` hook (port state moved out of App.tsx), a `usePlayback` hook, Play/Pause/
  Stop toolbar controls with Space/Esc, a speed select, In/Out device selects, and an orange
  playhead line that the view follows. Design points: stop sends silence twice (Web MIDI
  can't reliably recall scheduled messages); only notes and sustain are sent (no program/
  volume/pan) so the piano keeps its own sound; defaults the output to the device whose
  name matches the input. 1037 tests (18 new). Verified end to end in the real app with a
  fake MIDI piano injected into the page. Also: toolbar now wraps instead of overflowing.
  Carry-overs: NOT tried with the real piano yet — check channel 1 response and sustain-
  pedal handling; playback follows repeats but a playhead over a repeated section just
  jumps back; no loop, no per-hand mute, no click track; editing during playback doesn't
  change what's playing (the timeline is a snapshot from Play); in-browser samples remain
  the fallback if MIDI-out proves awkward.
- 2026-09-20 (feature: built-in sounds + toolbar reorganization). Frank: "the menu options
  are getting busy again ... put all the MIDI things together and use icons. Next thing is
  to create playback with a basic set of sounds (ala GarageBand presets)." Added `src/audio`:
  an `AudioEngine` (Web Audio) that is a second `MidiSink` for the existing `Player`, nine
  presets (sampled Salamander grand piano — CC BY 3.0, ~2.3 MB in `public/samples/` — plus
  synthesized electric piano, organ, harpsichord, strings, pad, harp, vibraphone, music box;
  Karplus-Strong plucks rendered in JS), a tested `VoiceManager` (pedal, retrigger, voice
  stealing), shared reverb, compressor and soft limiter. Toolbar: one "Sound & MIDI" icon
  popover holds playback target (built-in vs MIDI device), preset grid + volume, MIDI
  keyboard input, and both MIDI exports; Export MusicXML, Compare with PDF, Shortcuts and
  Score Info are icon buttons at the right; Samples moved into the New form. Choices persist
  in localStorage. 1067 tests (30 in `test/audio`). Verified in headless Chromium and real
  Chrome with a tap on the live output. Carry-overs: sounds are judged by measurement, not
  yet by Frank's ear (expect tweaks to levels/tone); notes entered by mouse/MIDI keyboard
  aren't sounded (only the score playback is); no per-part instrument choice (one sound for
  the whole score); real-piano MIDI test still pending.
- 2026-09-22 (feature: homr as a second OMR engine). Frank saw odd Audiveris results on
  tonight's imports and worried another Claude session had changed the project. It had,
  harmlessly: uncommitted work from the iOS photo-app session (importer keeps a part's MIDI
  program; per-track instruments in `render-midi.swift`; `docs/IOS-APP-HANDOFF.md`), now
  committed. The bad results came from the inputs (a cropped phone photo with cut-off
  clefs, a photo that crashed Audiveris, a scan with no printed time signature). Added homr
  (better on photos in the Sep 21 bake-off) as a choice in the import dialog: server
  renders PDF pages with `scripts/pdf-to-png.swift` and runs homr per page;
  `src/io/omr-merge.ts` joins the pages, lining staves up by clef; cleanup now always sets
  OMR imports to piano (both engines tag parts as choir "oohs"). `setup-omr.sh --homr`.
  1090 tests (21 new). Verified with the real homr and in headless Chromium. Carry-overs:
  homr writes no time signature for many pieces (import assumes 4/4); no automatic engine
  choice (photos → homr) yet; Audiveris's own log warnings (missing clefs, no time
  signature) still aren't shown in the review panel.
- 2026-09-22 (feature: clef changes). Frank: "how should we handle staff changes, e.g.
  from Treble to Bass? This is common in piano." The model/import/export already stored
  clef changes anywhere in a measure, but the engraver only honored one at a measure's
  start and never drew it mid-system, so a mid-measure change left the notes after it
  placed by the old clef. Now: notes are placed by the clef at their own offset
  (`clefAt`, src/model/clefs.ts); mid-measure changes are drawn small in front of the
  notes they apply to with room reserved; start-of-measure changes are drawn small
  before the previous barline (the courtesy clef at a system end); import moves a clef
  at/past a measure's end to the next measure; a Clef palette group (Treble, Bass) adds a
  change at the selected note or cursor; a clef change is selectable and Delete removes
  it; stem direction and the status bar use the clef at the note. 1119 tests (29 new).
  Verified on Tifa's Theme (homr's reading matches every clef change on the page) and in
  headless Chromium. Carry-overs: only Treble and Bass buttons (alto/tenor and octave
  clefs only via import or the Staves panel's opening clef); a clef change can't be
  dragged; a change on a cross-staff note uses the host staff.
- 2026-10-16 (feature: measure +/− buttons; offline OMR check). Frank: Audiveris and homr
  "don't work" offline; and asked for small + / − controls on measures to delete the
  impossible measures OMR produces. Offline: not reproduced. With the network blocked by a
  macOS sandbox (verified: outbound requests refused), homr and Audiveris CLIs, the PDF
  renderer, and the full import dialog against a sandboxed dev server all worked; neither
  engine makes network calls (homr's text reader only checks its local model files).
  Leading guess: files in iCloud Drive/Photos that aren't downloaded can't be read
  offline; asked Frank for the error text. Measures: hover +/− buttons (insert after /
  delete this measure), actions that keep the cursor on the same music, Measures section
  in the Shortcuts panel (Enter / ⇧Enter / ⌘⌫ already existed), and fixes to
  removeMeasure (keeps time/key signature, clef, final barline) and addMeasures (shifts
  breaks and anchors; inserting before measure 1 keeps the opening signatures). 1135 tests
  (16 new). Verified in headless Chromium.
- 2026-10-16 (feature: Help & FAQ panel; fix: Shift+letter on a selected note). A "?"
  toolbar button opens a Help & FAQ panel fed by src/ui/help-faq.ts, to be filled in as
  questions come up; first entry: how to enter chords (one event, not separate voices).
  Frank reported that with a note selected, Shift+letter added the pitch to the note
  before the cursor instead; it now adds to the selected chord(s). 1146 tests (11 new).
  Verified in headless Chromium. Then, at Frank's request, Delete/Backspace on some notes
  of a chord removes only those notes (whole chord when all are selected; cut still takes
  whole chords).
- 2026-10-16 (feature: duration keys on a selection). Frank: with a note or chord selected,
  1/2/4/8/6/3/. should change its duration, overwriting what follows when longer and
  leaving rests when shorter. Those rules already existed (setDurationAt), and the keys
  worked on a selection only with note entry OFF; now in both modes, digits give the plain
  value, multiple selections change latest-first. Shortcuts panel updated; FAQ entry
  "How do I change how long a note or chord is?". 1163 tests (12 new). Verified in
  headless Chromium. Limit: lengthening past the barline is refused, not tied over.
- 2026-10-16 (feature: one-shot dot). The entry dot now clears after the next note/rest is
  entered (8 . C 6 D = dotted eighth + 16th). Also fixed a regression the duration-keys
  change would have caused: typing a note auto-selects it, so a digit right after typing
  changed that note instead of the next one; duration keys now skip a "just typed"
  selection. 1170 tests (7 new). Verified in headless Chromium. Noted: rest-fill after a
  partial measure groups oddly (16, 16, 4, 16) — pre-existing; fixed next.
- 2026-10-16 (fix: rest grouping). Rests the editor fills in are now grouped by the meter
  (restsAt): beat-completing small-to-large in simple time, dotted beat rests in compound
  time, pickups aligned to the bar's end. Old tests that expected a dotted-half rest after
  a quarter in 4/4 now expect quarter + half. 1179 tests (9 new). Verified in headless
  Chromium. Not covered yet: paste and writeSequence's split rests.
- 2026-10-16 (feature: Beam toggle). Frank asked how to disconnect beamed eighths; the
  model/engraver already supported beam overrides but the editor couldn't set them. One
  palette toggle (Beam, beside Flip Stem): one note = break/rejoin the beam before it;
  several = flags/beam together. FAQ entry added. 1185 tests (6 new). Verified in headless
  Chromium. Gap: MusicXML export writes no beams.
- 2026-10-16 (website). Published the app as a static site on GitHub Pages
  (someactuary.github.io/music_notation), rebuilt on every push to main after lint + tests
  pass. Web build: base path, website notice in the import dialog, installable + offline
  (manifest, icons, generated service worker). Found and fixed an offline bug (cache
  lookups missed because of `Vary: Origin`). README "Use it online" section; corrected the
  README's "homr requires internet" (it runs offline). Verified the built site served under
  /music_notation/ in headless Chromium, online and offline.
- 2026-10-16 (feature: feedback box). Help & FAQ panel gets a "Send feedback" form,
  delivered by Web3Forms to frankc@mail.instinct.com (Frank chose Web3Forms over Typeform/
  Formspree/mailto). 8 new tests; verified in headless Chromium with the Web3Forms request
  intercepted (no real message sent).
