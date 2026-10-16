/**
 * Bravura web font loading for the browser. This is the one file in
 * src/render allowed to touch the DOM (`document`) — keep it out of the pure
 * engrave/render path (docs/ARCHITECTURE.md invariant 4). Safe to import from
 * a node/vitest environment: every DOM access is guarded.
 */

/**
 * Where the app is served from: "/" locally, "/music_notation/" on the website (GitHub
 * Pages serves the repo under its name). Vite sets BASE_URL from the build's `base`.
 */
const BASE = (import.meta.env?.BASE_URL as string | undefined) ?? "/";

/** @font-face declaration for Bravura, served from public/fonts. */
export const BRAVURA_FONT_FACE_CSS = `
@font-face {
  font-family: "Bravura";
  src:
    url("${BASE}fonts/Bravura.woff2") format("woff2"),
    url("${BASE}fonts/Bravura.otf") format("opentype");
  font-weight: normal;
  font-style: normal;
  font-display: block;
}
`.trim();

/**
 * Ensures the Bravura font face is loaded (and rasterized at the given size)
 * before glyphs are drawn/measured, so the first paint doesn't show tofu.
 * No-op (resolves immediately) outside a browser.
 */
export function ensureFontLoaded(): Promise<FontFace[]> {
  if (typeof document === "undefined" || !document.fonts) {
    return Promise.resolve([]);
  }
  return document.fonts.load('4px "Bravura"');
}
