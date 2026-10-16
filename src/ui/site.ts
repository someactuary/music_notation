/**
 * The published website (`npm run build:web`, GitHub Pages) versus the full local app
 * (`npm run dev`). The website has no local server, so PDF/photo import (Audiveris,
 * homr) isn't available there; it can be installed and used offline instead.
 */
export const IS_WEBSITE = import.meta.env.MODE === "web";

/** Where people get the full version (with PDF/photo import). */
export const FULL_VERSION_URL = "https://github.com/someactuary/music_notation#getting-started";

/** On the website, registers the service worker that saves the app for offline use. */
export function registerOfflineSupport(): void {
  if (!IS_WEBSITE || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Offline use is a bonus; the app works the same without it.
    });
  });
}
