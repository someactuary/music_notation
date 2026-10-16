/**
 * Small monochrome toolbar icons (16x16, stroke = currentColor so they inherit the
 * toolbar's text color). Hand-drawn rather than pulled from an icon library — there
 * isn't one in this project's dependencies, and pulling one in for a handful of
 * glyphs isn't worth the bundle weight. Mostly plain outlines; PdfIcon is the one
 * exception with fixed-color fills (a red "PDF" badge reads correctly regardless of
 * the button's background, unlike a shape meant to mask another one behind it).
 */
import type { ReactNode } from "react";

function IconBase({ children }: { children: ReactNode }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** A page with a folded corner: New. */
export function NewIcon() {
  return (
    <IconBase>
      <path d="M4 1.5h5.5L12 4v9.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5Z" />
      <path d="M9.5 1.5V4H12" />
    </IconBase>
  );
}

/** A folder: Open. */
export function OpenIcon() {
  return (
    <IconBase>
      <path d="M1.5 4a1 1 0 0 1 1-1h3l1.2 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4Z" />
    </IconBase>
  );
}

/** A floppy disk: Save. */
export function SaveIcon() {
  return (
    <IconBase>
      <path d="M2.5 1.5h8l3 3v9a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" />
      <path d="M4.5 1.5v4h5v-4" />
      <path d="M4.5 9.5h7v4.5h-7Z" />
    </IconBase>
  );
}

/** A curved arrow looping back to the left: Undo. */
export function UndoIcon() {
  return (
    <IconBase>
      <path d="M5 6.5H10a3.5 3.5 0 0 1 0 7H7.5" />
      <path d="M7 4 4 6.5 7 9" />
    </IconBase>
  );
}

/** A curved arrow looping forward to the right: Redo (Undo, mirrored). */
export function RedoIcon() {
  return (
    <IconBase>
      <path d="M11 6.5H6a3.5 3.5 0 0 0 0 7h2.5" />
      <path d="M9 4 12 6.5 9 9" />
    </IconBase>
  );
}

/** A (narrower) floppy disk plus a "+": Save As, a save under a new name. Drawn with
 * no overlapping fills — unlike two overlapping disks, this doesn't need one shape to
 * mask the other, which would need its fill to match whatever the button's current
 * background is (plain, hover) and drift out of sync with it. */
export function SaveAsIcon() {
  return (
    <IconBase>
      <path d="M1.5 1.5h6l2 2v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
      <path d="M3.5 1.5v3h4v-3" />
      <path d="M3.5 9h4v3.5h-4Z" />
      <path d="M12.5 6v5M10 8.5h5" />
    </IconBase>
  );
}

/** A page with a small "PDF" tag: Import PDF. Deliberately generic (a plain document
 * shape plus a text badge), not a reproduction of Adobe's own PDF mark. */
export function PdfIcon() {
  return (
    <IconBase>
      <path d="M4 1.5h5.5L12 4v9.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5Z" />
      <path d="M9.5 1.5V4H12" />
      <rect x={3.5} y={8.3} width={7} height={4} rx={0.7} fill="#c0392b" stroke="none" />
      <text x={7} y={11.3} textAnchor="middle" fontSize={3.1} fontWeight="bold" fill="#fff" stroke="none" fontFamily="sans-serif">
        PDF
      </text>
    </IconBase>
  );
}

/** A printer: sheet feeding through a body onto a tray. */
export function PrintIcon() {
  return (
    <IconBase>
      <path d="M4.5 5.5v-4h6v4" />
      <path d="M2.5 10.5h-1v-5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v5h-1" />
      <path d="M4 8.5h8v6H4Z" />
    </IconBase>
  );
}

/** A right-pointing triangle: Play. */
export function PlayIcon() {
  return (
    <IconBase>
      <path d="M4.5 2.5v11l9-5.5Z" fill="currentColor" />
    </IconBase>
  );
}

/** Two bars: Pause. */
export function PauseIcon() {
  return (
    <IconBase>
      <path d="M4.5 2.5h2.5v11H4.5ZM9 2.5h2.5v11H9Z" fill="currentColor" />
    </IconBase>
  );
}

/** A square: Stop. */
export function StopIcon() {
  return (
    <IconBase>
      <path d="M3.5 3.5h9v9h-9Z" fill="currentColor" />
    </IconBase>
  );
}

/** A speaker giving off sound waves: the Sound & MIDI menu. */
export function SoundIcon() {
  return (
    <IconBase>
      <path d="M1.5 6h2.7L8 2.8v10.4L4.2 10H1.5Z" />
      <path d="M10.3 5.6a3.4 3.4 0 0 1 0 4.8" />
      <path d="M12.3 3.6a6.2 6.2 0 0 1 0 8.8" />
    </IconBase>
  );
}

/** Angle brackets around a slash: Export MusicXML. */
export function XmlIcon() {
  return (
    <IconBase>
      <path d="M5.2 4.5 1.8 8l3.4 3.5" />
      <path d="M10.8 4.5 14.2 8l-3.4 3.5" />
      <path d="M9.1 3 6.9 13" />
    </IconBase>
  );
}

/** A keyboard: Shortcuts. */
export function KeyboardIcon() {
  return (
    <IconBase>
      <rect x={1.5} y={3.5} width={13} height={9} rx={1.2} />
      <path d="M4.2 6.5h.01M6.7 6.5h.01M9.3 6.5h.01M11.8 6.5h.01M4.2 8.8h.01M6.7 8.8h.01M9.3 8.8h.01M11.8 8.8h.01" />
      <path d="M5.3 10.9h5.4" />
    </IconBase>
  );
}

/** A circled question mark: Help & FAQ. */
export function HelpIcon() {
  return (
    <IconBase>
      <circle cx={8} cy={8} r={6.2} />
      <path d="M6.1 6.2a1.95 1.95 0 1 1 2.75 1.8c-.55.25-.85.7-.85 1.3v.4" />
      <path d="M8 11.4h.01" />
    </IconBase>
  );
}

/** A circled "i": Score Info. */
export function InfoIcon() {
  return (
    <IconBase>
      <circle cx={8} cy={8} r={6.2} />
      <path d="M8 7.3v3.9" />
      <path d="M8 4.9h.01" />
    </IconBase>
  );
}

/** Two pages side by side: Compare with PDF. */
export function CompareIcon() {
  return (
    <IconBase>
      <path d="M1.5 3h5.6v10H1.5Z" />
      <path d="M8.9 3h5.6v10H8.9Z" />
      <path d="M3.3 6h2M3.3 8.3h2M10.7 6h2M10.7 8.3h2" />
    </IconBase>
  );
}
