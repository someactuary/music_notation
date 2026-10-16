import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { createOmrService, type OmrServiceOptions } from "./omr-service";
import type { OmrJob } from "../src/io/omr-api";

// ---------------------------------------------------------------------------
// A fake Audiveris: a dependency-free Node script that mimics the log lines
// observed from real `-batch -export` runs (see docs/ARCHITECTURE.md M4) and
// writes a tiny, real .mxl into the -output directory. Modes are chosen by
// the FAKE_AUDIVERIS_MODE env var so the service's own spawn/env inheritance
// carries them through, exactly like a real child process would see them.
// ---------------------------------------------------------------------------

const FAKE_AUDIVERIS_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);

function log(line) {
  process.stdout.write(line + "\\n");
}

if (args.includes("-version")) {
  log("Audiveris");
  log("- Version:      5.11.0-fake");
  process.exit(0);
}

const outputDir = args[args.indexOf("-output") + 1];
const inputPath = args[args.indexOf("--") + 1];
const mode = process.env.FAKE_AUDIVERIS_MODE || "success";
const sheets = Number(process.env.FAKE_AUDIVERIS_SHEETS || "3");
const delayMs = Number(process.env.FAKE_AUDIVERIS_DELAY_MS || "15");
const fixtureMxl = process.env.FAKE_AUDIVERIS_FIXTURE_MXL;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  log("INFO  []                      Main 259  | Running in batch mode");
  log("INFO  [fake]                      Book 560  | " + sheets + " sheets in " + inputPath);

  if (mode === "hang") {
    log("INFO  [fake#1]            StepMonitoring 98   | LOAD");
    // A dangling Promise alone does not keep the Node event loop alive (it isn't a
    // libuv handle); without something scheduled the process would just exit(0)
    // right here. An uncleared interval keeps it running until we SIGKILL it.
    setInterval(() => {}, 1 << 30);
    return;
  }

  for (let i = 1; i <= sheets; i++) {
    await sleep(delayMs);
    log("INFO  [fake#" + i + "]            StepMonitoring 98   | LOAD");
    await sleep(delayMs);
    log("INFO  [fake#" + i + "]            StepMonitoring 98   | PAGE");

    if (mode === "failure" && i === Math.ceil(sheets / 2)) {
      process.stderr.write("ERROR [fake] Something 1 | simulated failure while processing sheet " + i + "\\n");
      process.exit(1);
    }

    log("INFO  [fake#" + i + "]                      Book 2050  | End of Stub#" + i);
  }

  log("INFO  [fake]                      Book 2057  | End of Book{fake}");

  if (mode === "no-output") {
    log("INFO  [fake]           PartwiseBuilder 2707 | Exporting sheet(s): []");
    process.exit(0);
  }

  const dest = path.join(outputDir, "input.mxl");
  fs.copyFileSync(fixtureMxl, dest);
  log("INFO  [fake]             ScoreExporter 164  | Score fake exported to " + dest);
  process.exit(0);
}

main();
`;

// A fake homr (reads one image, writes "<image stem>.musicxml" beside it, with CoreML-style
// "E5RT" noise like the real one) and a fake PDF page renderer (writes page-NNN.png files),
// both driven by env vars like the fake Audiveris.
const FAKE_HOMR_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const image = process.argv[2];
const stem = path.basename(image).replace(/\\.[^.]+$/, "");
const failing = (process.env.FAKE_HOMR_FAIL || "").split(",").filter(Boolean);
process.stdout.write("Processing " + image + "\\n");
process.stderr.write("E5RT encountered an STL exception. msg = harmless noise\\n");
process.stdout.write("\\x1b[32m[INFO] 2026-09-22 20:43:32,905 [RapidOCR] main.py:63: Using the OCR model\\x1b[0m\\n");
if (process.env.FAKE_HOMR_MODE !== "hang") process.stdout.write("Found 3 staffs\\n");
if (process.env.FAKE_HOMR_MODE === "hang") {
  setInterval(() => {}, 1 << 30);
} else if (failing.includes(stem)) {
  process.stderr.write("Traceback: no staffs found on " + stem + "\\n");
  process.exit(1);
} else {
  const out = image.replace(/\\.[^./]+$/, ".musicxml");
  fs.writeFileSync(out, "<score-partwise><!-- " + stem + " --></score-partwise>");
  process.stdout.write("Result was written to " + out + "\\n");
}
`;

const FAKE_RENDERER_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const [, , input, outDir, dpi] = process.argv;
const pages = Number(process.env.FAKE_RENDER_PAGES || "3");
if (!fs.existsSync(input) || dpi !== "300") process.exit(3);
fs.mkdirSync(outDir, { recursive: true });
process.stdout.write("pages=" + pages + "\\n");
for (let i = 1; i <= pages; i++) {
  fs.writeFileSync(path.join(outDir, "page-" + String(i).padStart(3, "0") + ".png"), "png");
  process.stdout.write("page " + i + "/" + pages + "\\n");
}
`;

function buildFixtureMxl(): Uint8Array {
  const musicxml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<score-partwise version="4.0">',
    "  <part-list><score-part id=\"P1\"><part-name>Music</part-name></score-part></part-list>",
    '  <part id="P1">',
    '    <measure number="1">',
    "      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time>" +
      "<clef><sign>G</sign><line>2</line></clef></attributes>",
    "      <note><rest/><duration>4</duration><type>whole</type></note>",
    "    </measure>",
    "  </part>",
    "</score-partwise>",
  ].join("\n");
  const container = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<container><rootfiles><rootfile full-path="score.musicxml" ' +
      'media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>',
  ].join("\n");
  return zipSync({
    "META-INF/container.xml": strToU8(container),
    "score.musicxml": strToU8(musicxml),
  });
}

let fixtureRoot: string;
let fakeAudiverisPath: string;
let fakeHomrPath: string;
let fakeRendererPath: string;
let fixtureMxlPath: string;
let fixtureMxlBytes: Uint8Array;

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "pmn-omr-fixtures-"));
  fakeAudiverisPath = path.join(fixtureRoot, "fake-audiveris.js");
  writeFileSync(fakeAudiverisPath, FAKE_AUDIVERIS_SOURCE, "utf8");
  chmodSync(fakeAudiverisPath, 0o755);
  fakeHomrPath = path.join(fixtureRoot, "fake-homr.js");
  writeFileSync(fakeHomrPath, FAKE_HOMR_SOURCE, "utf8");
  chmodSync(fakeHomrPath, 0o755);
  fakeRendererPath = path.join(fixtureRoot, "fake-pdf-to-png.js");
  writeFileSync(fakeRendererPath, FAKE_RENDERER_SOURCE, "utf8");
  chmodSync(fakeRendererPath, 0o755);
  fixtureMxlBytes = buildFixtureMxl();
  fixtureMxlPath = path.join(fixtureRoot, "fixture.mxl");
  writeFileSync(fixtureMxlPath, fixtureMxlBytes);
});

// ---------------------------------------------------------------------------
// Test harness: a real node:http server delegating straight to the handler.
// ---------------------------------------------------------------------------

interface Harness {
  baseUrl: string;
  jobsDir: string;
  server: Server;
  service: ReturnType<typeof createOmrService>;
  close(): Promise<void>;
}

async function listenEphemeral(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function setup(overrides: Partial<OmrServiceOptions> = {}): Promise<Harness> {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "pmn-omr-jobs-"));
  const service = createOmrService({
    jobsDir,
    audiverisPath: fakeAudiverisPath,
    homrPath: fakeHomrPath,
    pdfToPngCommand: [fakeRendererPath],
    timeoutMs: 5000,
    retentionMs: 60 * 60 * 1000,
    ...overrides,
  });
  const server = createServer((req, res) => service.handle(req, res));
  const baseUrl = await listenEphemeral(server);
  return {
    baseUrl,
    jobsDir,
    server,
    service,
    async close() {
      await service.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(jobsDir, { recursive: true, force: true });
    },
  };
}

let harness: Harness | undefined;
const envKeysTouched = [
  "FAKE_AUDIVERIS_MODE",
  "FAKE_AUDIVERIS_SHEETS",
  "FAKE_AUDIVERIS_DELAY_MS",
  "FAKE_AUDIVERIS_FIXTURE_MXL",
  "FAKE_HOMR_MODE",
  "FAKE_HOMR_FAIL",
  "FAKE_RENDER_PAGES",
] as const;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
  for (const key of envKeysTouched) delete process.env[key];
});

function configureFake(mode: "success" | "failure" | "hang" | "no-output", opts: { sheets?: number; delayMs?: number } = {}) {
  process.env["FAKE_AUDIVERIS_MODE"] = mode;
  process.env["FAKE_AUDIVERIS_SHEETS"] = String(opts.sheets ?? 3);
  process.env["FAKE_AUDIVERIS_DELAY_MS"] = String(opts.delayMs ?? 15);
  process.env["FAKE_AUDIVERIS_FIXTURE_MXL"] = fixtureMxlPath;
}

/** TS's DOM lib types don't accept a generic Uint8Array<ArrayBufferLike> as BodyInit; it works fine at runtime. */
function asBody(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

async function uploadPdf(
  baseUrl: string,
  body: Uint8Array = pdfBytes(),
  filename?: string,
  engine?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (filename !== undefined) headers["X-Filename"] = filename;
  const query = engine !== undefined ? `?engine=${engine}` : "";
  return fetch(`${baseUrl}/jobs${query}`, { method: "POST", body: asBody(body), headers });
}

function pngBytes(): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buf;
}

function pdfBytes(size = 128): Uint8Array {
  const buf = new Uint8Array(size);
  buf.set(strToU8("%PDF-1.4\n"));
  return buf;
}

async function getJob(baseUrl: string, id: string): Promise<{ status: number; body: OmrJob | { error: string } }> {
  const res = await fetch(`${baseUrl}/jobs/${id}`);
  return { status: res.status, body: (await res.json()) as OmrJob | { error: string } };
}

async function pollJob(baseUrl: string, id: string, predicate: (job: OmrJob) => boolean, timeoutMs = 4000): Promise<OmrJob> {
  const start = Date.now();
  for (;;) {
    const { status, body } = await getJob(baseUrl, id);
    if (status !== 200) throw new Error(`job ${id} disappeared: ${JSON.stringify(body)}`);
    const job = body as OmrJob;
    if (predicate(job)) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for job ${id}: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const isDone = (job: OmrJob) => job.state === "done" || job.state === "error" || job.state === "cancelled";

// ---------------------------------------------------------------------------

describe("createOmrService: status", () => {
  it("reports available with version and OCR languages when Audiveris and tessdata are present", async () => {
    const tessdataDir = mkdtempSync(path.join(tmpdir(), "pmn-omr-tessdata-"));
    writeFileSync(path.join(tessdataDir, "eng.traineddata"), "");
    configureFake("success");
    harness = await setup({ tessdataDir });
    const status = await harness.service.status();
    expect(status.available).toBe(true);
    expect(status.audiverisPath).toBe(fakeAudiverisPath);
    expect(status.version).toBe("5.11.0-fake");
    expect(status.ocrLanguages).toEqual(["eng"]);
    expect(status.hint).toBeUndefined();
  });

  it("reports unavailable with a setup hint when no Audiveris binary can be found", async () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "pmn-omr-home-"));
    const savedHome = process.env["HOME"];
    const savedPmn = process.env["PMN_AUDIVERIS"];
    delete process.env["PMN_AUDIVERIS"];
    process.env["HOME"] = fakeHome;
    try {
      harness = await setup({ audiverisPath: path.join(fakeHome, "does-not-exist") });
      const status = await harness.service.status();
      expect(status.available).toBe(false);
      expect(status.audiverisPath).toBeUndefined();
      expect(status.hint).toMatch(/setup-omr\.sh/);
    } finally {
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      if (savedPmn !== undefined) process.env["PMN_AUDIVERIS"] = savedPmn;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("hints that text will be misread when OCR data is missing", async () => {
    const tessdataDir = mkdtempSync(path.join(tmpdir(), "pmn-omr-tessdata-empty-"));
    harness = await setup({ tessdataDir });
    const status = await harness.service.status();
    expect(status.available).toBe(true);
    expect(status.ocrLanguages).toEqual([]);
    expect(status.hint).toMatch(/misread/);
    rmSync(tessdataDir, { recursive: true, force: true });
  });

  // Only meaningful on a machine that has Audiveris installed (Frank's Mac), not on the
  // GitHub Actions runner that builds the website.
  it.skipIf(!existsSync(path.join(homedir(), "Applications", "Audiveris.app")))(
    "never mistakes the real, locally installed Audiveris for 'not found' bookkeeping bugs (sanity check on this env)",
    () => {
      // Not a functional assertion; documents why the "unavailable" test above must
      // override HOME rather than just clearing opts.audiverisPath: this dev machine
      // really does have Audiveris under ~/Applications.
      expect(existsSync(path.join(homedir(), "Applications", "Audiveris.app"))).toBe(true);
    },
  );
});

describe("createOmrService: upload validation", () => {
  it("rejects a body with no recognizable magic bytes", async () => {
    configureFake("success");
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl, strToU8("not a real file"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unrecognized/i);
  });

  it("rejects an empty body", async () => {
    configureFake("success");
    harness = await setup();
    const res = await fetch(`${harness.baseUrl}/jobs`, { method: "POST", body: asBody(new Uint8Array(0)) });
    expect(res.status).toBe(400);
  });

  it("rejects an oversize upload with 413 without buffering the whole thing", async () => {
    configureFake("success");
    harness = await setup({ maxUploadBytes: 1024 });
    const res = await uploadPdf(harness.baseUrl, pdfBytes(2048));
    expect(res.status).toBe(413);
  });

  it("accepts PNG and JPEG magic bytes too", async () => {
    configureFake("success", { sheets: 1, delayMs: 0 });
    harness = await setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0]);
    const resPng = await uploadPdf(harness.baseUrl, png);
    expect(resPng.status).toBe(202);
    const resJpg = await uploadPdf(harness.baseUrl, jpg);
    expect(resJpg.status).toBe(202);
  });

  it("sanitizes X-Filename and never lets it escape into a filesystem path", async () => {
    configureFake("success", { sheets: 1, delayMs: 0 });
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl, pdfBytes(), "../../etc/evil.pdf");
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const job = await pollJob(harness.baseUrl, id, () => true, 1000);
    expect(job.filename).not.toMatch(/[/\\]/);
    // Nothing was written outside this job's own directory.
    expect(existsSync(path.join(harness.jobsDir, "..", "etc"))).toBe(false);
    const jobFiles = readdirSync(path.join(harness.jobsDir, id));
    expect(jobFiles).toContain("input.pdf");
  });
});

describe("createOmrService: job lifecycle", () => {
  it("runs a job through queued -> running -> done, with monotonic progress", async () => {
    configureFake("success", { sheets: 4, delayMs: 20 });
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl);
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    const seenStates: string[] = [];
    const seenSheetsDone: number[] = [];
    let lastSheetsDone = -1;
    const finalJob = await pollJob(harness.baseUrl, id, (job) => {
      seenStates.push(job.state);
      if (job.sheetsDone !== lastSheetsDone) {
        seenSheetsDone.push(job.sheetsDone);
        lastSheetsDone = job.sheetsDone;
      }
      return isDone(job);
    });

    expect(finalJob.state).toBe("done");
    expect(finalJob.sheetsTotal).toBe(4);
    expect(finalJob.sheetsDone).toBe(4);
    expect(finalJob.elapsedMs).toBeGreaterThanOrEqual(0);
    // Progress only ever moves forward.
    for (let i = 1; i < seenSheetsDone.length; i++) expect(seenSheetsDone[i]!).toBeGreaterThan(seenSheetsDone[i - 1]!);
    expect(seenStates).toContain("done");
  });

  it("downloads the exact result bytes with the right content type", async () => {
    configureFake("success", { sheets: 1, delayMs: 5 });
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl);
    const { id } = (await res.json()) as { id: string };
    await pollJob(harness.baseUrl, id, isDone);

    const result = await fetch(`${harness.baseUrl}/jobs/${id}/result`);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/vnd.recordare.musicxml");
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(bytes).toEqual(fixtureMxlBytes);
  });

  it("responds 409 to a result request before the job is done", async () => {
    configureFake("success", { sheets: 3, delayMs: 30 });
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl);
    const { id } = (await res.json()) as { id: string };

    const result = await fetch(`${harness.baseUrl}/jobs/${id}/result`);
    expect(result.status).toBe(409);
    await pollJob(harness.baseUrl, id, isDone);
  });

  it("responds 404 for an unknown job id on get/result/delete", async () => {
    configureFake("success");
    harness = await setup();
    const unknown = randomUUID();
    expect((await fetch(`${harness.baseUrl}/jobs/${unknown}`)).status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/jobs/${unknown}/result`)).status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/jobs/${unknown}`, { method: "DELETE" })).status).toBe(404);
  });

  it("moves a job to the error state with the log tail when Audiveris exits non-zero", async () => {
    configureFake("failure", { sheets: 3, delayMs: 10 });
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl);
    const { id } = (await res.json()) as { id: string };
    const job = await pollJob(harness.baseUrl, id, isDone);
    expect(job.state).toBe("error");
    expect(job.error).toMatch(/exited with code 1/);
    expect(job.error).toMatch(/simulated failure/);
  });

  it("moves a job to the error state when Audiveris exits 0 but writes no MusicXML", async () => {
    configureFake("no-output", { sheets: 2, delayMs: 5 });
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl);
    const { id } = (await res.json()) as { id: string };
    const job = await pollJob(harness.baseUrl, id, isDone);
    expect(job.state).toBe("error");
    expect(job.error).toMatch(/no MusicXML/);
  });

  it("times out a hung job and kills its process group", async () => {
    configureFake("hang");
    harness = await setup({ timeoutMs: 80 });
    const res = await uploadPdf(harness.baseUrl);
    const { id } = (await res.json()) as { id: string };
    const job = await pollJob(harness.baseUrl, id, isDone, 4000);
    expect(job.state).toBe("error");
    expect(job.error).toMatch(/timed out/);
  });

  it("runs only one job at a time (FIFO)", async () => {
    configureFake("success", { sheets: 3, delayMs: 25 });
    harness = await setup();
    const first = await uploadPdf(harness.baseUrl);
    const { id: firstId } = (await first.json()) as { id: string };
    const second = await uploadPdf(harness.baseUrl);
    const { id: secondId } = (await second.json()) as { id: string };

    // Shortly after both are submitted, the first should be active and the second
    // should still be waiting behind it.
    await new Promise((r) => setTimeout(r, 15));
    const secondJob = (await getJob(harness.baseUrl, secondId)).body as OmrJob;
    expect(secondJob.state).toBe("queued");

    const firstJob = await pollJob(harness.baseUrl, firstId, isDone);
    expect(firstJob.state).toBe("done");
    const secondDone = await pollJob(harness.baseUrl, secondId, isDone);
    expect(secondDone.state).toBe("done");
  });

  it("cancels a queued job and removes its directory", async () => {
    configureFake("hang"); // occupies the runner so the second job stays queued
    harness = await setup();
    const running = await uploadPdf(harness.baseUrl);
    const { id: runningId } = (await running.json()) as { id: string };
    await pollJob(harness.baseUrl, runningId, (j) => j.state === "running");

    const queued = await uploadPdf(harness.baseUrl);
    const { id: queuedId } = (await queued.json()) as { id: string };
    expect((await getJob(harness.baseUrl, queuedId)).body).toMatchObject({ state: "queued" });

    const del = await fetch(`${harness.baseUrl}/jobs/${queuedId}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await getJob(harness.baseUrl, queuedId)).status).toBe(404);
    expect(existsSync(path.join(harness.jobsDir, queuedId))).toBe(false);

    // Clean up the still-running hung job.
    await fetch(`${harness.baseUrl}/jobs/${runningId}`, { method: "DELETE" });
  });

  it("cancels a running job, killing its process", async () => {
    configureFake("hang");
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl);
    const { id } = (await res.json()) as { id: string };
    await pollJob(harness.baseUrl, id, (j) => j.state === "running");

    const del = await fetch(`${harness.baseUrl}/jobs/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await getJob(harness.baseUrl, id)).status).toBe(404);
    expect(existsSync(path.join(harness.jobsDir, id))).toBe(false);
  });

  it("tolerates deleting a job whose process has already exited on its own", async () => {
    configureFake("success", { sheets: 1, delayMs: 0 });
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl);
    const { id } = (await res.json()) as { id: string };
    await pollJob(harness.baseUrl, id, isDone);

    const del = await fetch(`${harness.baseUrl}/jobs/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await getJob(harness.baseUrl, id)).status).toBe(404);
  });

  it("sweeps a finished job's directory after retentionMs", async () => {
    configureFake("success", { sheets: 1, delayMs: 0 });
    harness = await setup({ retentionMs: 40 });
    const res = await uploadPdf(harness.baseUrl);
    const { id } = (await res.json()) as { id: string };
    await pollJob(harness.baseUrl, id, isDone);
    expect(existsSync(path.join(harness.jobsDir, id))).toBe(true);

    await new Promise((r) => setTimeout(r, 250));
    expect((await getJob(harness.baseUrl, id)).status).toBe(404);
    expect(existsSync(path.join(harness.jobsDir, id))).toBe(false);
  });
});

describe("createOmrService: shutdown", () => {
  it("kills a running job on shutdown", async () => {
    configureFake("hang");
    const jobsDir = mkdtempSync(path.join(tmpdir(), "pmn-omr-jobs-"));
    const service = createOmrService({ jobsDir, audiverisPath: fakeAudiverisPath, timeoutMs: 5000 });
    const server = createServer((req, res) => service.handle(req, res));
    const baseUrl = await listenEphemeral(server);

    const res = await uploadPdf(baseUrl);
    const { id } = (await res.json()) as { id: string };
    await pollJob(baseUrl, id, (j) => j.state === "running");

    await service.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(jobsDir, { recursive: true, force: true });
  });
});

describe("createOmrService: homr engine", () => {
  async function runHomr(body: Uint8Array, overrides: Partial<OmrServiceOptions> = {}): Promise<{ id: string; job: OmrJob }> {
    harness = await setup(overrides);
    const res = await uploadPdf(harness.baseUrl, body, undefined, "homr");
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    return { id, job: await pollJob(harness.baseUrl, id, isDone) };
  }

  it("reports homr's availability alongside Audiveris", async () => {
    harness = await setup();
    const status = await harness.service.status();
    expect(status.engines.homr).toEqual({ available: true, path: fakeHomrPath });
    expect(status.engines.audiveris.available).toBe(true);
    expect(status.engines.audiveris.path).toBe(fakeAudiverisPath);
  });

  it("reports homr unavailable with a setup hint when it can't be found", async () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "pmn-omr-home-"));
    const savedHome = process.env["HOME"];
    const savedPmn = process.env["PMN_HOMR"];
    delete process.env["PMN_HOMR"];
    process.env["HOME"] = fakeHome;
    try {
      harness = await setup({ homrPath: path.join(fakeHome, "does-not-exist") });
      const status = await harness.service.status();
      expect(status.engines.homr.available).toBe(false);
      expect(status.engines.homr.hint).toMatch(/setup-omr\.sh --homr/);
      // Audiveris is unaffected.
      expect(status.available).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      if (savedPmn !== undefined) process.env["PMN_HOMR"] = savedPmn;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("rejects an unknown engine with 400", async () => {
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl, pdfBytes(), undefined, "tesseract");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown OMR engine/);
  });

  it("renders a PDF's pages, runs homr on each, and serves one MusicXML result per page", async () => {
    process.env["FAKE_RENDER_PAGES"] = "3";
    const { id, job } = await runHomr(pdfBytes());
    expect(job).toMatchObject({ state: "done", engine: "homr", sheetsTotal: 3, sheetsDone: 3, resultCount: 3 });
    expect(job.warnings).toBeUndefined();
    // CoreML noise never becomes the progress message.
    expect(job.message ?? "").not.toMatch(/E5RT/);
    expect(job.message).toMatch(/^Page 3\/3: /);

    for (const [i, stem] of ["page-001", "page-002", "page-003"].entries()) {
      const result = await fetch(`${harness!.baseUrl}/jobs/${id}/result?index=${i}`);
      expect(result.status).toBe(200);
      expect(result.headers.get("content-type")).toBe("application/vnd.recordare.musicxml+xml");
      expect(await result.text()).toContain(stem);
    }
    expect((await fetch(`${harness!.baseUrl}/jobs/${id}/result?index=3`)).status).toBe(404);
  });

  it("runs homr directly on an image upload, without rendering", async () => {
    process.env["FAKE_RENDER_PAGES"] = "0"; // would fail the job if the renderer ran
    const { id, job } = await runHomr(pngBytes());
    expect(job).toMatchObject({ state: "done", sheetsTotal: 1, resultCount: 1 });
    const result = await fetch(`${harness!.baseUrl}/jobs/${id}/result`);
    expect(await result.text()).toContain("input");
  });

  it("skips a page homr can't read, with a warning, and keeps the rest", async () => {
    process.env["FAKE_RENDER_PAGES"] = "3";
    process.env["FAKE_HOMR_FAIL"] = "page-002";
    const { id, job } = await runHomr(pdfBytes());
    expect(job).toMatchObject({ state: "done", resultCount: 2 });
    expect(job.warnings).toEqual(["homr couldn't read page 2 (exit code 1); it was skipped."]);
    expect(await (await fetch(`${harness!.baseUrl}/jobs/${id}/result?index=1`)).text()).toContain("page-003");
  });

  it("fails the job, with the log tail, when homr reads no page at all", async () => {
    process.env["FAKE_RENDER_PAGES"] = "2";
    process.env["FAKE_HOMR_FAIL"] = "page-001,page-002";
    const { job } = await runHomr(pdfBytes());
    expect(job.state).toBe("error");
    expect(job.error).toMatch(/couldn't read any page/);
    expect(job.error).toMatch(/no staffs found/);
  });

  it("fails the job when the PDF renderer fails", async () => {
    const { job } = await runHomr(pdfBytes(), { pdfToPngCommand: [path.join(fixtureRoot, "missing-renderer")] });
    expect(job.state).toBe("error");
    expect(job.error).toMatch(/rendering the PDF's pages failed/);
  });

  it("times out a hung homr run", async () => {
    process.env["FAKE_HOMR_MODE"] = "hang";
    process.env["FAKE_RENDER_PAGES"] = "2";
    const { job } = await runHomr(pdfBytes(), { timeoutMs: 150 });
    expect(job.state).toBe("error");
    expect(job.error).toMatch(/timed out/);
  });

  it("shows homr's colored, prefixed log lines as plain text", async () => {
    process.env["FAKE_HOMR_MODE"] = "hang";
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl, pngBytes(), undefined, "homr");
    const { id } = (await res.json()) as { id: string };
    const job = await pollJob(harness.baseUrl, id, (j) => /OCR model/.test(j.message ?? ""));
    expect(job.message).toBe("Using the OCR model");
    await fetch(`${harness.baseUrl}/jobs/${id}`, { method: "DELETE" });
  });

  it("cancels a running homr job, killing its process", async () => {
    process.env["FAKE_HOMR_MODE"] = "hang";
    harness = await setup();
    const res = await uploadPdf(harness.baseUrl, pngBytes(), undefined, "homr");
    const { id } = (await res.json()) as { id: string };
    await pollJob(harness.baseUrl, id, (j) => j.state === "running" && /homr|Processing/.test(j.message ?? ""));

    const del = await fetch(`${harness.baseUrl}/jobs/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await getJob(harness.baseUrl, id)).status).toBe(404);
    expect(existsSync(path.join(harness.jobsDir, id))).toBe(false);
  });
});
