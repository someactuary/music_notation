/**
 * The published website (`npm run build:web`, GitHub Pages) versus the full local app
 * (`npm run dev`). The website has no local server, so PDF/photo import (Audiveris,
 * homr) isn't available there.
 */
export const IS_WEBSITE = import.meta.env.MODE === "web";

/** Where people get the full version (with PDF/photo import). */
export const FULL_VERSION_URL = "https://github.com/someactuary/music_notation#getting-started";

/**
 * Removes the offline copy an earlier version of the website saved (the offline/install
 * feature was rolled back on 2026-10-16). Together with the clean-up sw.js the website
 * now publishes, this makes sure a browser that visited before stops serving a stale copy.
 */
export function removeOfflineSupport(): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
    .catch(() => undefined);
  if ("caches" in window) {
    void caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pmn-")).map((k) => caches.delete(k))))
      .catch(() => undefined);
  }
}
