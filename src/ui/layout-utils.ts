/**
 * Pure geometry/lookup helpers over a `LayoutResult`, shared by the editor
 * store and `ScoreView`. No DOM, no React — see docs/ARCHITECTURE.md
 * invariant 4 (engrave/render are pure); this module keeps that property for
 * the UI's own coordinate math.
 *
 * Coordinate systems, per src/engraving/layout-types.ts:
 *  - `MeasureLayout.columns[].x` and `StaffLayout.y` are SYSTEM-local.
 *  - `System.x`/`System.y` place a system on its Page.
 *  - `hitTestPoint` takes and everything it returns in system-local space is
 *    converted to PAGE-local sp, matching the SVG viewBox `ScoreView` clicks
 *    are measured against.
 */
import { eq, lt, sub, toNumber, ZERO, type Fraction } from "@/model/duration";
import type { Id, Score } from "@/model";
import { allEvents, type Event } from "@/model/traverse";
import type {
  GlyphPrim,
  LayoutResult,
  LinePrim,
  MeasureLayout,
  Page,
  PathPrim,
  PolygonPrim,
  Primitive,
  Ref,
  System,
  TextPrim,
} from "@/engraving/layout-types";
import { glyphBBox } from "@/render/smufl";
import type { SmuflFontData } from "@/render/smufl/types";

// ---------------------------------------------------------------------------
// findSystemForMeasure
// ---------------------------------------------------------------------------

export interface MeasureLocation {
  page: Page;
  system: System;
  measure: MeasureLayout;
}

/** Finds the page/system/measure-layout for a given global measure index. */
export function findSystemForMeasure(layout: LayoutResult, measureIndex: number): MeasureLocation | null {
  for (const page of layout.pages) {
    for (const system of page.systems) {
      const measure = system.measures.find((m) => m.measureIndex === measureIndex);
      if (measure) return { page, system, measure };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// cursorX
// ---------------------------------------------------------------------------

/**
 * X (system-local sp) of a measure-relative time offset. Exact when `offset`
 * matches a column; otherwise linearly interpolated between the neighbouring
 * columns. An offset past the last column (e.g. the cursor sitting just after
 * the last event, before the barline) resolves to `measure.x + measure.width - 1`;
 * one before the first column (should not normally happen) resolves to the
 * first column's x. Both fall out of the same interpolation formula treating
 * the missing neighbour as coincident with `offset` itself.
 */
export function cursorX(measure: MeasureLayout, offset: Fraction): number {
  const cols = measure.columns;
  if (cols.length === 0) return measure.x;

  for (const c of cols) {
    if (eq(c.offset, offset)) return c.x;
  }

  const first = cols[0]!;
  if (lt(offset, first.offset)) return first.x;

  const last = cols[cols.length - 1]!;
  const endX = measure.x + measure.width - 1;
  if (lt(last.offset, offset)) {
    return endX;
  }

  for (let i = 0; i < cols.length - 1; i++) {
    const lo = cols[i]!;
    const hi = cols[i + 1]!;
    if (lt(lo.offset, offset) && lt(offset, hi.offset)) {
      const t = toNumber(sub(offset, lo.offset)) / toNumber(sub(hi.offset, lo.offset));
      return lo.x + t * (hi.x - lo.x);
    }
  }

  // Unreachable given the checks above, but keep TypeScript (and callers) safe.
  return last.x;
}

// ---------------------------------------------------------------------------
// staffY
// ---------------------------------------------------------------------------

/** Y (system-local sp) of the top line of a given part/staff in this system. */
export function staffY(system: System, partIndex: number, staffIndex: number): number {
  const staff = system.staves.find((s) => s.partIndex === partIndex && s.staffIndex === staffIndex);
  if (!staff) throw new Error(`staffY: no staff for part ${partIndex}, staff ${staffIndex} in this system`);
  return staff.y;
}

// ---------------------------------------------------------------------------
// locateEvent
// ---------------------------------------------------------------------------

export interface EventLocation {
  partIndex: number;
  measureIndex: number;
  staffIndex: number;
  voiceIndex: number;
  offset: Fraction;
}

function collectNoteIds(event: Event, out: Id[]): void {
  if (event.kind === "note") {
    for (const n of event.notes) out.push(n.id);
  }
  if (event.grace) {
    for (const g of event.grace.events) collectNoteIds(g, out);
  }
}

/**
 * Finds the location of an event or note id anywhere in the score. A note id
 * (inside a chord, or a grace note) resolves to its parent event's location —
 * the cursor and selection both operate at event/offset granularity.
 */
export function locateEvent(score: Score, id: Id): EventLocation | null {
  for (const e of allEvents(score)) {
    const event = e.positioned.event;
    if (event.id === id) {
      return {
        partIndex: e.partIndex,
        measureIndex: e.measureIndex,
        staffIndex: e.staffIndex,
        voiceIndex: e.voice.index,
        offset: e.positioned.offset,
      };
    }
    const noteIds: Id[] = [];
    collectNoteIds(event, noteIds);
    if (noteIds.includes(id)) {
      return {
        partIndex: e.partIndex,
        measureIndex: e.measureIndex,
        staffIndex: e.staffIndex,
        voiceIndex: e.voice.index,
        offset: e.positioned.offset,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// hitTestPoint
// ---------------------------------------------------------------------------

export interface HitTestResult {
  measureIndex: number;
  staffIndex: number;
  offset: Fraction;
}

/** Signed distance from `v` to the closed interval [lo, hi]; 0 if inside. */
function distanceToRange(v: number, lo: number, hi: number): number {
  if (v < lo) return lo - v;
  if (v > hi) return v - hi;
  return 0;
}

/**
 * Nearest measure/staff/column to a click at page-local (xSp, ySp) on page
 * `pageIndex`. Picks the vertically-nearest system, then the vertically-
 * nearest staff within it (by proximity to the staff's line block), then the
 * horizontally-nearest measure, then the nearest column (onset) within that
 * measure. Returns null only if the page has no systems/staves/measures.
 */
export function hitTestPoint(layout: LayoutResult, pageIndex: number, xSp: number, ySp: number): HitTestResult | null {
  const page = layout.pages[pageIndex];
  if (!page || page.systems.length === 0) return null;

  let system: System | null = null;
  let systemDist = Infinity;
  for (const sys of page.systems) {
    const d = distanceToRange(ySp, sys.y, sys.y + sys.height);
    if (d < systemDist) {
      systemDist = d;
      system = sys;
    }
  }
  if (!system || system.staves.length === 0 || system.measures.length === 0) return null;

  let staffIndex = system.staves[0]!.staffIndex;
  let staffDist = Infinity;
  for (const st of system.staves) {
    const top = system.y + st.y;
    const bottom = top + (st.lineCount - 1);
    const d = distanceToRange(ySp, top, bottom);
    if (d < staffDist) {
      staffDist = d;
      staffIndex = st.staffIndex;
    }
  }

  let measure = system.measures[0]!;
  let measureDist = Infinity;
  for (const m of system.measures) {
    const left = system.x + m.x;
    const right = left + m.width;
    const d = distanceToRange(xSp, left, right);
    if (d < measureDist) {
      measureDist = d;
      measure = m;
    }
  }

  let offset: Fraction = ZERO;
  let colDist = Infinity;
  for (const c of measure.columns) {
    const cx = system.x + c.x;
    const d = Math.abs(xSp - cx);
    if (d < colDist) {
      colDist = d;
      offset = c.offset;
    }
  }

  return { measureIndex: measure.measureIndex, staffIndex, offset };
}

// ---------------------------------------------------------------------------
// selectionBoxes / idsInRect
// ---------------------------------------------------------------------------

export interface SelectionBox {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An axis-aligned rectangle in PAGE-local sp coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a click landed on: an id and the role of the primitive that won the hit test. */
export interface ElementHit {
  id: Id;
  role: Ref["role"];
}

/**
 * Roles that name an independently addressable model object — safe to select,
 * outline, hit-test, and (mostly) delete: notes/rests, spanners (slur, tie,
 * hairpin, pedal, ottava), attachments (dynamic, tempo, text, fermata — each
 * with its own id, independent of any note), and the note-level marks that
 * share an id with their host event/note (articulation, fingering, tuplet,
 * lyric, ornament — a note's real articulations, e.g. staccato+accent
 * together, share one id and aren't independently addressable from each
 * other, unlike a fermata, which is its own attachment). Deliberately
 * excludes purely structural/derived sub-parts of a note (stem, flag, dot,
 * accidental) and page furniture (clef, keysig, timesig, barline, ledger,
 * measure) — clicking those selects nothing on their own. "beam" is included
 * at the lowest priority: a beam has no independent model identity
 * (docs/ARCHITECTURE.md), so it resolves to the id of its first note, which is
 * still a useful, better-than-nothing click target.
 */
const SELECTABLE_ROLES: ReadonlySet<Ref["role"]> = new Set<Ref["role"]>([
  "notehead",
  "clefChange",
  "rest",
  "tie",
  "slur",
  "hairpin",
  "pedal",
  "ottava",
  "dynamic",
  "tempo",
  "text",
  "fermata",
  "articulation",
  "fingering",
  "tuplet",
  "lyric",
  "ornament",
  "beam",
]);

/**
 * Roles worth nudging as a whole (drag to reposition): spanners and
 * placement-only attachments, which carry their own id independent of any
 * note. Ties, real articulations, fingering, tuplets and beams share an id
 * with their host note/event and aren't independently repositionable this way.
 */
export const MOVABLE_ROLES: ReadonlySet<Ref["role"]> = new Set<Ref["role"]>([
  "slur",
  "hairpin",
  "pedal",
  "ottava",
  "dynamic",
  "tempo",
  "text",
  "fermata",
]);

/** Smaller wins a tie between two same-size selectable boxes covering a click point. */
const ROLE_PRIORITY: Partial<Record<Ref["role"], number>> = {
  notehead: 0,
  rest: 1,
  tie: 2,
  slur: 3,
  hairpin: 3,
  pedal: 3,
  ottava: 3,
  dynamic: 4,
  tempo: 4,
  text: 4,
  fingering: 4,
  fermata: 4,
  articulation: 5,
  tuplet: 5,
  lyric: 6,
  ornament: 6,
  beam: 9,
};

/**
 * No real font metrics exist for text primitives (docs/ARCHITECTURE.md): this
 * is the same length*size*ratio estimate the engraver itself uses for spacing
 * (see src/engraving/attachments.ts's and lyrics.ts's own `textWidth`).
 */
const TEXT_WIDTH_RATIO = 0.55;
const TEXT_ASCENT_RATIO = 0.8;
const TEXT_DESCENT_RATIO = 0.25;
/** Extra click tolerance around thin line/path shapes (ties, slurs, hairpins, pedal/ottava lines). */
const LINE_HIT_PAD_SP = 0.25;

/**
 * Page-space bounding box of a notehead/rest glyph primitive, from the SMuFL
 * font's glyph bbox. SMuFL bboxes are y UP relative to the glyph origin;
 * layout/page space is y DOWN, so the vertical extent is flipped: the bbox's
 * `ne` (max y up = visually highest point) becomes the smaller (top) page y.
 */
function glyphPrimPageBox(prim: GlyphPrim, system: System, font: SmuflFontData): Rect {
  const bbox = glyphBBox(font, prim.glyph);
  const scale = prim.scale ?? 1;
  const left = prim.x + bbox.sw[0] * scale;
  const right = prim.x + bbox.ne[0] * scale;
  const top = prim.y - bbox.ne[1] * scale;
  const bottom = prim.y - bbox.sw[1] * scale;
  return {
    x: system.x + left,
    y: system.y + top,
    w: right - left,
    h: bottom - top,
  };
}

function textPrimPageBox(prim: TextPrim, system: System): Rect {
  const w = Math.max(prim.text.length * prim.size * TEXT_WIDTH_RATIO, prim.size * TEXT_WIDTH_RATIO);
  const ascent = prim.size * TEXT_ASCENT_RATIO;
  const descent = prim.size * TEXT_DESCENT_RATIO;
  const anchor = prim.anchor ?? "start";
  const left = anchor === "middle" ? prim.x - w / 2 : anchor === "end" ? prim.x - w : prim.x;
  return { x: system.x + left, y: system.y + prim.y - ascent, w, h: ascent + descent };
}

function linePrimPageBox(prim: LinePrim, system: System): Rect {
  const x1 = Math.min(prim.x1, prim.x2) - LINE_HIT_PAD_SP;
  const x2 = Math.max(prim.x1, prim.x2) + LINE_HIT_PAD_SP;
  const y1 = Math.min(prim.y1, prim.y2) - LINE_HIT_PAD_SP;
  const y2 = Math.max(prim.y1, prim.y2) + LINE_HIT_PAD_SP;
  return { x: system.x + x1, y: system.y + y1, w: x2 - x1, h: y2 - y1 };
}

function polygonPrimPageBox(prim: PolygonPrim, system: System): Rect | null {
  if (prim.points.length === 0) return null;
  const xs = prim.points.map((p) => p[0]);
  const ys = prim.points.map((p) => p[1]);
  const x1 = Math.min(...xs);
  const x2 = Math.max(...xs);
  const y1 = Math.min(...ys);
  const y2 = Math.max(...ys);
  return { x: system.x + x1, y: system.y + y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * A safe (if slightly loose) bound on a path's curve, from every number in
 * its `d` string taken as (x,y) pairs — for a cubic Bézier, the curve always
 * lies within the convex hull of its control points, so this can only be as
 * large as, never smaller than, the true visual extent. Our path data (ties,
 * slurs — see ties.ts/spanners.ts) only ever uses M/L/C commands with
 * absolute coordinates, never relative commands or arcs, so every number is
 * genuinely part of an (x,y) pair in this order.
 */
function pathPrimPageBox(prim: PathPrim, system: System): Rect | null {
  const nums = prim.d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length < 2) return null;
  let x1 = Infinity;
  let x2 = -Infinity;
  let y1 = Infinity;
  let y2 = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i]!;
    const y = nums[i + 1]!;
    if (x < x1) x1 = x;
    if (x > x2) x2 = x;
    if (y < y1) y1 = y;
    if (y > y2) y2 = y;
  }
  return {
    x: system.x + x1 - LINE_HIT_PAD_SP,
    y: system.y + y1 - LINE_HIT_PAD_SP,
    w: x2 - x1 + 2 * LINE_HIT_PAD_SP,
    h: y2 - y1 + 2 * LINE_HIT_PAD_SP,
  };
}

/**
 * Page-space bounding box of any primitive carrying a `ref` whose role is
 * independently selectable (`SELECTABLE_ROLES`), or null otherwise (not
 * selectable, or a shape type with no usable geometry). The single place that
 * knows each `Primitive` variant's real ink extent — shared by
 * `selectionBoxes` (what to outline), `idsInRect` (rubber-band selection) and
 * `hitTestElement` (click routing), so all three agree on what a marking's
 * "hit area" is.
 */
function selectablePrimBox(prim: Primitive, system: System, font: SmuflFontData): { ref: Ref; box: Rect } | null {
  if (prim.type === "staffLines") return null;
  const ref = prim.ref;
  if (!ref || !SELECTABLE_ROLES.has(ref.role)) return null;
  const box = ((): Rect | null => {
    switch (prim.type) {
      case "glyph":
        return glyphPrimPageBox(prim, system, font);
      case "text":
        return textPrimPageBox(prim, system);
      case "line":
        return linePrimPageBox(prim, system);
      case "polygon":
        return polygonPrimPageBox(prim, system);
      case "path":
        return pathPrimPageBox(prim, system);
    }
  })();
  return box ? { ref, box } : null;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Bounding boxes (page sp coordinates) for each requested id, one per system
 * it appears in (a tie or slur broken across a system break — see
 * ties.ts/spanners.ts — gets one box per piece, not one box spanning the gap
 * between them). Every primitive sharing an id within one system (e.g. a
 * hairpin's two lines, a tempo mark's note-glyph plus two text runs) merges
 * into a single box. An id with no matching selectable primitive contributes
 * no box.
 */
export function selectionBoxes(layout: LayoutResult, font: SmuflFontData, ids: Id[]): SelectionBox[] {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  const boxes: SelectionBox[] = [];
  for (const page of layout.pages) {
    for (const system of page.systems) {
      const merged = new Map<Id, Rect>();
      for (const prim of system.primitives) {
        const hit = selectablePrimBox(prim, system, font);
        if (!hit || !wanted.has(hit.ref.id)) continue;
        const existing = merged.get(hit.ref.id);
        merged.set(hit.ref.id, existing ? unionRect(existing, hit.box) : hit.box);
      }
      for (const box of merged.values()) boxes.push({ pageIndex: page.index, ...box });
    }
  }
  return boxes;
}

/**
 * Ids of every selectable primitive on `pageIndex` whose page-space bounding
 * box intersects `rect` (edge-touching only doesn't count). Results are
 * deduplicated (a chord's notes are separate primitives/ids; a marking with
 * several primitives — e.g. a hairpin's two lines — contributes its id once).
 */
export function idsInRect(layout: LayoutResult, font: SmuflFontData, pageIndex: number, rect: Rect): Id[] {
  const page = layout.pages[pageIndex];
  if (!page) return [];
  const ids = new Set<Id>();
  for (const system of page.systems) {
    for (const prim of system.primitives) {
      const hit = selectablePrimBox(prim, system, font);
      if (!hit) continue;
      const box = hit.box;
      const intersects =
        box.x < rect.x + rect.w && box.x + box.w > rect.x && box.y < rect.y + rect.h && box.y + box.h > rect.y;
      if (intersects) ids.add(hit.ref.id);
    }
  }
  return Array.from(ids);
}

/**
 * Whichever box's own CENTRE is closest to the click point wins, not whichever box is
 * smaller: a small decoration (a fingering digit, an articulation dot) can technically
 * overlap a much bigger neighbour's box near its edge without the click being
 * anywhere near that decoration's own centre, and a pure smaller-area rule would wrongly
 * hand the click to it. Distance-to-centre naturally prefers whatever the click is
 * actually closest to the middle of. Area only breaks a genuine tie (equal distance,
 * e.g. two boxes centred on the same point), and `ROLE_PRIORITY` breaks that further.
 */
function isBetterHit(x: number, y: number, candidate: { ref: Ref; box: Rect }, best: { ref: Ref; box: Rect }): boolean {
  const dist = (box: Rect) => Math.hypot(x - (box.x + box.w / 2), y - (box.y + box.h / 2));
  const d = dist(candidate.box);
  const bestD = dist(best.box);
  if (d !== bestD) return d < bestD;
  const area = candidate.box.w * candidate.box.h;
  const bestArea = best.box.w * best.box.h;
  if (area !== bestArea) return area < bestArea;
  return (ROLE_PRIORITY[candidate.ref.role] ?? 8) < (ROLE_PRIORITY[best.ref.role] ?? 8);
}

/**
 * What's under a click at page-space (xSp, ySp) on `pageIndex`, using each
 * primitive's own tight geometry (`selectablePrimBox`) rather than the
 * browser's native DOM hit-testing.
 *
 * This matters, and isn't just a style preference: every glyph is drawn as an
 * SVG `<text>` at a fixed font-size spanning a full 4-staff-space em-box (see
 * src/render/svg.ts and docs/ARCHITECTURE.md) — regardless of how little ink
 * the actual character (say, a notehead) puts on the page. The browser's own
 * hit-testing for that `<text>` element uses its em-box, not the visible ink,
 * so two glyphs within about a staff's height of each other — routine for two
 * voices on one staff, or any dense passage — have overlapping invisible hit
 * regions, and whichever was painted later always wins. In practice that
 * silently steals clicks meant for an earlier voice's notes: found by
 * confirming with a direct `elementFromPoint` probe that a click squarely on
 * one voice's notehead was being attributed to a same-column note in the
 * other voice. Rubber-band selection (`idsInRect`) was never affected — it
 * already used this same real-geometry approach, never DOM hit-testing.
 *
 * Among every selectable primitive whose box contains the point, whichever
 * box's own centre is closest to the point wins (`isBetterHit`) — the most
 * specific hit, e.g. a notehead beats a sprawling beam polygon or a nearby
 * decoration's box that merely overlaps this one's edge without the click
 * being anywhere near ITS centre.
 */
export function hitTestElement(
  layout: LayoutResult,
  font: SmuflFontData,
  pageIndex: number,
  xSp: number,
  ySp: number,
): ElementHit | null {
  const page = layout.pages[pageIndex];
  if (!page) return null;
  let best: { ref: Ref; box: Rect } | null = null;
  for (const system of page.systems) {
    for (const prim of system.primitives) {
      const hit = selectablePrimBox(prim, system, font);
      if (!hit) continue;
      const { box } = hit;
      if (xSp < box.x || xSp > box.x + box.w || ySp < box.y || ySp > box.y + box.h) continue;
      if (!best || isBetterHit(xSp, ySp, hit, best)) best = hit;
    }
  }
  return best ? { id: best.ref.id, role: best.ref.role } : null;
}

// ---------------------------------------------------------------------------
// measureAtPoint (hover target for the measure +/− controls)
// ---------------------------------------------------------------------------

/** How far above the top staff (sp) a measure still counts as hovered: room for its +/− controls. */
export const MEASURE_HOVER_ABOVE_SP = 4;
/** How far below the bottom staff (sp) a measure still counts as hovered. */
export const MEASURE_HOVER_BELOW_SP = 2;

export interface MeasureHit {
  measureIndex: number;
  /** Page sp x of the measure's right edge (its closing barline). */
  right: number;
  /** Page sp y of the system's top staff line. */
  top: number;
}

/**
 * The measure under a page point (page sp coordinates), counting the whole height of its
 * system plus a margin above the top staff, so the pointer can travel up onto the
 * controls drawn there without the hover ending. Null over margins and between systems.
 */
export function measureAtPoint(layout: LayoutResult, pageIndex: number, xSp: number, ySp: number): MeasureHit | null {
  const page = layout.pages[pageIndex];
  if (!page) return null;
  for (const system of page.systems) {
    const first = system.staves[0];
    const last = system.staves[system.staves.length - 1];
    if (!first || !last) continue;
    const top = system.y + first.y;
    const bottom = system.y + last.y + (last.lineCount - 1);
    if (ySp < top - MEASURE_HOVER_ABOVE_SP || ySp > bottom + MEASURE_HOVER_BELOW_SP) continue;
    for (const m of system.measures) {
      const left = system.x + m.x;
      const right = left + m.width;
      if (xSp >= left && xSp <= right) return { measureIndex: m.measureIndex, right, top };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// pdfPageForMeasure
// ---------------------------------------------------------------------------

/**
 * Which page of the *original PDF* a given measure came from, for the OMR
 * compare panel (docs/ARCHITECTURE.md "M4 contracts"). `pageBreaks` is
 * `score.layout.pageBreaks` — measure indices where a new page starts, i.e.
 * a break entry `b` means "page increments at measure `b`". The result is
 * 0-based: the count of break entries at or before `measureIndex`.
 */
export function pdfPageForMeasure(pageBreaks: readonly number[], measureIndex: number): number {
  let page = 0;
  for (const b of pageBreaks) {
    if (b <= measureIndex) page++;
  }
  return page;
}
