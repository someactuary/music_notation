# Personal Music Notation Software

A personal bare-bones score editor built with Claude
Create, edit, engrave, and print scores in your browser locally.

Built with TypeScript, React, SVG rendering, and the Bravura music font.
Uses Audiveris or homr (requires internet connection) to transcribe pdf's or images to scores with mixed results.

## Getting Started

### Prerequisites
- Node.js 18 or later
- npm or yarn

### Installation

```bash
npm install
```

### Running the Development Server

```bash
npm run dev
```

Open your browser to the URL shown (typically http://localhost:5173).

### Testing

Run the full test suite:

```bash
npm test
```

Run type checking:

```bash
npm run typecheck
```

### Generating SMuFL Metadata

To regenerate glyph and metrics tables from the Bravura font:

```bash
npm run smufl:gen
```

## Directory Layout

```
personal_music_notation/
├── src/
│   ├── model/           # Score types, durations (rational), pitch, schema
│   ├── commands/        # Command pattern, undo/redo, edit operations
│   ├── engraving/       # Layout engine: semantic pass, spacing, line breaking
│   ├── render/          # LayoutResult → SVG; SMuFL glyph tables
│   ├── input/           # Keyboard step entry, MIDI input, hit-testing
│   ├── io/              # File I/O: .pscore JSON, MusicXML, MIDI export, OMR
│   ├── playback/        # Score → timeline: tempo map, repeats, dynamics, pedal; live Player
│   ├── audio/           # Built-in sounds: Web Audio engine, 9 presets, sampled piano, plucks
│   └── ui/              # React shell: editor, palettes, inspector
├── fonts/               # Bravura music font and metadata
├── test/
│   ├── fixtures/        # Sample scores for testing
│   └── golden/          # Reference SVG renders
├── docs/                # Documentation and references
├── public/              # Static assets
└── scripts/             # Build and utility scripts
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a detailed overview of the design, pipeline, and invariants.

## License

This project uses the **Bravura** music font, licensed under the SIL Open Font License (OFL). See [fonts/OFL.txt](fonts/OFL.txt) for details.

For the optical music recognition function, this project uses Audiveris and homr, which uses the GNU Affero General Public License (AGPL).

The project code is under the license specified in the repository root.
