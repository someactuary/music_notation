/**
 * "Import PDF or photo…" wizard (docs/ARCHITECTURE.md "M4 contracts: PDF import (OMR)"
 * and "Second OMR engine: homr"). Steps: check which engines are available -> choose an
 * engine and a file -> upload + watch progress -> pick cleanup options -> hand the
 * imported Score to the caller. Owns no score state itself; `onImported` is the only way
 * anything leaves.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { OMR_ENGINES, type OmrEngine, type OmrJob, type OmrStatus } from "@/io/omr-api";
import { cancelOmrJob, fetchOmrResults, getOmrStatus, pollOmrJob, submitOmrJob } from "@/io/omr-client";
import { importMusicXml, MusicXmlError } from "@/io/musicxml";
import { cleanupOmrScore } from "@/io/omr-cleanup";
import { mergeOmrPages } from "@/io/omr-merge";
import type { OmrCleanupOptions, OmrReviewItem } from "@/io/omr-cleanup";
import type { Score } from "@/model";
import { FULL_VERSION_URL, IS_WEBSITE } from "./site";

export interface ImportedFromOmr {
  score: Score;
  review: OmrReviewItem[];
  /** The original PDF's bytes, kept for the compare panel — null when the upload wasn't a PDF (an image). */
  pdfBytes: ArrayBuffer | null;
  pdfFilename: string;
}

export interface ImportPdfDialogProps {
  onClose: () => void;
  onImported: (result: ImportedFromOmr) => void;
}

type Step =
  | { kind: "status" }
  | { kind: "choose" }
  | { kind: "uploading"; file: File; sourceBytes: ArrayBuffer | null; job: OmrJob | null; startedAt: number }
  | {
      kind: "options";
      file: File;
      sourceBytes: ArrayBuffer | null;
      /** One MusicXML result per page for homr; a single .mxl for Audiveris. */
      resultBuffers: ArrayBuffer[];
      warnings: string[];
    };

interface ErrorState {
  message: string;
  retry: () => void;
}

const ACCEPTED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg"];
const SETUP_COMMAND = "bash scripts/setup-omr.sh";
const ENGINE_STORAGE_KEY = "pmn.omrEngine";

const ENGINE_INFO: Record<OmrEngine, { label: string; description: string }> = {
  audiveris: {
    label: "Audiveris",
    description: "Best for clean PDFs and scans. Also reads lyrics, dynamics, and other text.",
  },
  homr: {
    label: "homr",
    description:
      "Better for phone photos, including skewed or curved pages. Reads notes only (no lyrics or text), " +
      "and may miss the time signature.",
  },
};

function loadEngine(): OmrEngine {
  try {
    const saved = localStorage.getItem(ENGINE_STORAGE_KEY);
    if (saved && (OMR_ENGINES as readonly string[]).includes(saved)) return saved as OmrEngine;
  } catch {
    // Storage unavailable (private window, blocked site data): use the default.
  }
  return "audiveris";
}

function saveEngine(engine: OmrEngine): void {
  try {
    localStorage.setItem(ENGINE_STORAGE_KEY, engine);
  } catch {
    // Not worth surfacing; the choice just won't be remembered.
  }
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^./]+$/, "");
}

function messageOf(err: unknown): string {
  if (err instanceof MusicXmlError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ImportPdfDialog({ onClose, onImported }: ImportPdfDialogProps) {
  const [step, setStep] = useState<Step>({ kind: "status" });
  const [status, setStatus] = useState<OmrStatus | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [keep, setKeep] = useState<OmrCleanupOptions["keep"]>("essentials");
  const [keepLayout, setKeepLayout] = useState(true);
  const [engine, setEngine] = useState<OmrEngine>(loadEngine);
  const [now, setNow] = useState(() => Date.now());

  const abortRef = useRef<AbortController | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchStatus = useCallback(async () => {
    if (IS_WEBSITE) return; // no import service behind the website; see the notice below
    setError(null);
    setStatus(null);
    try {
      const s = await getOmrStatus();
      setStatus(s);
      const anyAvailable = OMR_ENGINES.some((e) => s.engines[e].available);
      // Fall back to an installed engine if the remembered one isn't.
      setEngine((current) => (s.engines[current].available ? current : (OMR_ENGINES.find((e) => s.engines[e].available) ?? current)));
      setStep(anyAvailable ? { kind: "choose" } : { kind: "status" });
    } catch (err) {
      setError({
        message:
          `Couldn't reach the PDF/photo import service (${messageOf(err)}). ` +
          "It runs alongside the app when you start it with npm run dev.",
        retry: () => void fetchStatus(),
      });
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Ticks the elapsed-time display while a job is in flight; OmrJob.elapsedMs (server
  // time) is preferred once a poll response has arrived, this just fills the gap before
  // the first one lands and keeps the display live between polls.
  useEffect(() => {
    if (step.kind !== "uploading") return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [step.kind]);

  async function startUpload(file: File) {
    setError(null);
    const sourceBytes = extensionOf(file.name) === "pdf" ? await file.arrayBuffer() : null;
    const startedAt = Date.now();
    setStep({ kind: "uploading", file, sourceBytes, job: null, startedAt });
    const controller = new AbortController();
    abortRef.current = controller;
    jobIdRef.current = null;
    try {
      const id = await submitOmrJob(file, file.name, engine);
      jobIdRef.current = id;
      const job = await pollOmrJob(id, {
        signal: controller.signal,
        intervalMs: 700,
        onProgress: (job) => setStep((s) => (s.kind === "uploading" ? { ...s, job } : s)),
      });
      const resultBuffers = await fetchOmrResults(job);
      setStep({ kind: "options", file, sourceBytes, resultBuffers, warnings: job.warnings ?? [] });
    } catch (err) {
      if (controller.signal.aborted) {
        // Cancelled by the user (handleCancelUpload already moved the step back).
        return;
      }
      setError({ message: messageOf(err), retry: () => void startUpload(file) });
    }
  }

  function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!file) return;
    const ext = extensionOf(file.name);
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setError({ message: `Unsupported file type ".${ext}" — choose a PDF, PNG, or JPG.`, retry: () => setError(null) });
      return;
    }
    void startUpload(file);
  }

  function handleCancelUpload() {
    abortRef.current?.abort();
    const id = jobIdRef.current;
    if (id) void cancelOmrJob(id).catch(() => {});
    setStep({ kind: "choose" });
  }

  function handleOpenInEditor(optionsStep: Extract<Step, { kind: "options" }>) {
    try {
      const merged = mergeOmrPages(optionsStep.resultBuffers.map((buffer) => importMusicXml(buffer)));
      const cleaned = cleanupOmrScore(merged.score, { keep, keepLayout });
      const { score } = cleaned;
      const review = [...merged.review, ...cleaned.review].sort((a, b) => a.measureIndex - b.measureIndex);
      if (!score.meta.title) score.meta.title = titleFromFilename(optionsStep.file.name);
      onImported({ score, review, pdfBytes: optionsStep.sourceBytes, pdfFilename: optionsStep.file.name });
    } catch (err) {
      setError({ message: messageOf(err), retry: () => handleOpenInEditor(optionsStep) });
    }
  }

  // homr reads no text at all, so the OCR data only matters for Audiveris.
  const ocrWarning = engine === "audiveris" && status?.available && status.ocrLanguages.length === 0;
  const pageLabel = (n: number) => (n === 1 ? "page" : "pages");

  function chooseEngine(next: OmrEngine) {
    setEngine(next);
    saveEngine(next);
  }

  if (IS_WEBSITE) {
    return (
      <div className="import-dialog-overlay" role="presentation" onPointerDown={(e) => e.stopPropagation()}>
        <div className="import-dialog" role="dialog" aria-label="Import PDF or photo">
          <div className="import-dialog-header">
            <strong>Import PDF or photo</strong>
            <button type="button" onClick={onClose} aria-label="Close import dialog">
              &times;
            </button>
          </div>
          <p>
            Turning a PDF or a photo of sheet music into an editable score isn&apos;t available on the website. The
            music-recognition programs it uses (Audiveris and homr) have to run on your own computer.
          </p>
          <p>
            To use it, install the full version: see{" "}
            <a href={FULL_VERSION_URL} target="_blank" rel="noreferrer">
              Getting Started
            </a>
            .
          </p>
          <p className="import-dialog-hint">
            You can still open MusicXML files (.musicxml, .xml, .mxl) here with the Open button. Most notation programs
            can export them.
          </p>
          <div className="import-dialog-actions">
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="import-dialog-overlay" role="presentation" onPointerDown={(e) => e.stopPropagation()}>
      <div className="import-dialog" role="dialog" aria-label="Import PDF or photo">
        <div className="import-dialog-header">
          <strong>Import PDF or photo</strong>
          <button type="button" onClick={onClose} aria-label="Close import dialog">
            &times;
          </button>
        </div>

        {ocrWarning && step.kind !== "status" && (
          <p className="import-dialog-warning">
            No OCR language data installed — lyrics and other text may be misread.
          </p>
        )}

        {error ? (
          <div className="import-dialog-error">
            <p>{error.message}</p>
            <div className="import-dialog-actions">
              <button type="button" onClick={error.retry}>
                Retry
              </button>
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            {step.kind === "status" &&
              (status === null ? (
                <p>Checking the OMR service…</p>
              ) : (
                <div>
                  <p>{status.hint ?? "No OMR engine is available."}</p>
                  <pre className="import-dialog-code">
                    <code>{SETUP_COMMAND}</code>
                  </pre>
                  <div className="import-dialog-actions">
                    <button type="button" onClick={() => void fetchStatus()}>
                      Check again
                    </button>
                    <button type="button" onClick={onClose}>
                      Close
                    </button>
                  </div>
                </div>
              ))}

            {step.kind === "choose" && (
              <div>
                <fieldset className="import-dialog-fieldset">
                  <legend>Recognize with</legend>
                  {OMR_ENGINES.map((e) => {
                    const engineStatus = status?.engines[e];
                    const available = engineStatus?.available ?? false;
                    return (
                      <label key={e} className={`import-dialog-radio${available ? "" : " is-disabled"}`}>
                        <input
                          type="radio"
                          name="omr-engine"
                          checked={engine === e}
                          disabled={!available}
                          onChange={() => chooseEngine(e)}
                        />
                        <span>
                          <strong>{ENGINE_INFO[e].label}</strong>: {ENGINE_INFO[e].description}
                          {!available && engineStatus?.hint && (
                            <span className="import-dialog-hint import-dialog-engine-hint">{engineStatus.hint}</span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
                <p>Choose a PDF, a scan, or a photo of the music.</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  style={{ display: "none" }}
                  onChange={handleFileSelected}
                />
                <div className="import-dialog-actions">
                  <button type="button" onClick={() => fileInputRef.current?.click()}>
                    Choose file…
                  </button>
                  <button type="button" onClick={onClose}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {step.kind === "uploading" && (
              <div>
                <p>
                  Recognizing {step.file.name} with {ENGINE_INFO[step.job?.engine ?? engine].label}…
                </p>
                {step.job?.sheetsTotal != null ? (
                  <progress value={step.job.sheetsDone} max={step.job.sheetsTotal} className="import-dialog-progress" />
                ) : (
                  <progress className="import-dialog-progress" />
                )}
                <p className="import-dialog-hint">
                  {step.job?.sheetsTotal != null
                    ? `${step.job.sheetsDone} / ${step.job.sheetsTotal} ${pageLabel(step.job.sheetsTotal)}`
                    : "Working…"}
                  {" · "}
                  Elapsed {formatElapsed(step.job?.elapsedMs ?? now - step.startedAt)}
                </p>
                {step.job?.message && <p className="import-dialog-hint">{step.job.message}</p>}
                <div className="import-dialog-actions">
                  <button type="button" onClick={handleCancelUpload}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {step.kind === "options" && (
              <div>
                {step.warnings.map((w) => (
                  <p key={w} className="import-dialog-warning">
                    {w}
                  </p>
                ))}
                <fieldset className="import-dialog-fieldset">
                  <legend>What to import</legend>
                  <label className="import-dialog-radio">
                    <input type="radio" checked={keep === "essentials"} onChange={() => setKeep("essentials")} />
                    Notes only: staves, clefs, key and time signatures, notes, rests, ties (recommended)
                  </label>
                  <label className="import-dialog-radio">
                    <input type="radio" checked={keep === "all"} onChange={() => setKeep("all")} />
                    Everything recognized: also slurs, dynamics, lyrics, tempo, articulations
                  </label>
                </fieldset>
                <label className="import-dialog-checkbox">
                  <input type="checkbox" checked={keepLayout} onChange={(e) => setKeepLayout(e.target.checked)} />
                  Keep the original page and system breaks
                </label>
                <div className="import-dialog-actions">
                  <button type="button" onClick={() => handleOpenInEditor(step)}>
                    Open in editor
                  </button>
                  <button type="button" onClick={onClose}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
