import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { createOmrService } from "./server/omr-service";

/**
 * Mounts the local OMR service (server/omr-service.ts) at /api/omr, localhost only
 * (the Vite dev server already binds to localhost by default). See
 * docs/ARCHITECTURE.md "M4 contracts: PDF import (OMR)".
 */
function omrPlugin(): Plugin {
  return {
    name: "pmn-omr-service",
    configureServer(server) {
      const service = createOmrService({
        jobsDir: path.resolve(__dirname, ".omr-jobs"),
        pdfToPngCommand: ["/usr/bin/swift", path.resolve(__dirname, "scripts", "pdf-to-png.swift")],
      });
      // connect strips the "/api/omr" mount prefix before calling `handle`, so the
      // handler itself only ever sees paths like "/status" or "/jobs/:id".
      server.middlewares.use("/api/omr", service.handle);
      server.httpServer?.once("close", () => {
        void service.shutdown();
      });
    },
  };
}

/**
 * The website build only (`npm run build:web`, mode "web"). The site briefly shipped an
 * offline service worker and an install manifest (2026-10-16); Frank found the install
 * prompt and stale saved copies unexpected, so both were rolled back. Browsers that
 * already installed that worker keep running it until it's replaced, so this publishes a
 * clean-up `sw.js` at the same address: on its next update check it deletes the saved
 * copies, unregisters itself, and reloads open tabs from the network.
 */
function serviceWorkerCleanupPlugin(): Plugin {
  return {
    name: "pmn-sw-cleanup",
    apply: (_config, env) => env.command === "build" && env.mode === "web",
    generateBundle() {
      const source = `// Clean-up worker: removes the offline copy an earlier version of the site installed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("pmn-")) await caches.delete(key);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
    })(),
  );
});
`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), omrPlugin(), serviceWorkerCleanupPlugin()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  publicDir: "public",
});
