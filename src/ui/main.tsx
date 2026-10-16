import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BRAVURA_FONT_FACE_CSS } from "@/render/fonts";
import { App } from "./App";
import { removeOfflineSupport } from "./site";

// Inject the Bravura @font-face declaration (single source of truth in
// src/render/fonts.ts) before the app renders, so index.html doesn't need to
// duplicate it.
const fontStyle = document.createElement("style");
fontStyle.textContent = BRAVURA_FONT_FACE_CSS;
document.head.appendChild(fontStyle);

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element in index.html");

removeOfflineSupport();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
