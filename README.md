# Personal Music Notation Software

A personal bare-bones score editor built with Claude.

Create, edit, engrave, and print scores in your browser locally.

Built with TypeScript, React, SVG rendering, and the Bravura music font.
Uses Audiveris or homr (installed on your own computer; see Getting Started) to transcribe PDFs or images to scores, with mixed results.

## Use it online

**https://someactuary.github.io/music_notation/** — nothing to install. Open it in Chrome, Edge, Firefox or Safari.

- Everything except PDF/photo import works: writing and editing, playback with built-in sounds, printing, opening and saving `.pscore` files, and MusicXML import/export.
- **Install it** like an app (Chrome/Edge: the install icon in the address bar; Safari: File → Add to Dock; phone: Share → Add to Home Screen). After the first visit it also works offline.
- Your score is kept in that browser automatically. To move it to another computer, save it as a file and open it there.
- Connecting a MIDI keyboard needs Chrome or Edge (Safari doesn't support Web MIDI).
- **PDF/photo import** needs the full version below, because the recognition programs (Audiveris, homr) have to run on your own computer.

The website updates automatically every time `main` is pushed to GitHub (see `.github/workflows/website.yml`).

## Getting Started

### Prerequisites
- Node.js 18 or later
- npm or yarn

### Installation

```bash
npm install
```

### PDF/photo import (optional)

```bash
bash scripts/setup-omr.sh          # Audiveris + its OCR data
bash scripts/setup-omr.sh --homr   # also homr, better for phone photos
```

Both run entirely on your computer (homr downloads its models once, during setup).

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
