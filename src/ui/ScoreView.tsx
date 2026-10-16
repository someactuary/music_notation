import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { LayoutResult, Ref } from "@/engraving/layout-types";
import { renderPages } from "@/render/svg";
import type { SmuflFontData } from "@/render/smufl/types";
import type { Cursor, Selection } from "@/input/types";
import type { PlayPosition } from "@/playback/position";
import {
  cursorX,
  findSystemForMeasure,
  hitTestElement,
  idsInRect,
  measureAtPoint,
  MOVABLE_ROLES,
  selectionBoxes,
  staffY,
  type ElementHit,
  type MeasureHit,
  type Rect,
} from "./layout-utils";

export interface ClickModifiers {
  shift: boolean;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod: boolean;
}

export interface ScoreViewProps {
  layout: LayoutResult;
  font: SmuflFontData;
  /** Show data-id/data-role attributes for hit-testing. Default false. */
  idAttributes?: boolean;
  cursor?: Cursor;
  selection?: Selection;
  /** Show the entry cursor line. Only meaningful while note entry is active. */
  entryActive?: boolean;
  /** Fired when a click lands on (or inside) an element carrying a data-id. */
  onClickElement?: (id: string, role: Ref["role"], modifiers: ClickModifiers) => void;
  /** Fired when a click lands on empty page space; xSp/ySp are page-local staff-space coordinates. */
  onClickEmpty?: (pageIndex: number, xSp: number, ySp: number) => void;
  /** Fired when a rubber-band drag over empty space completes. `additive` means "union with the current selection" (shift was held). */
  onSelectMany?: (ids: string[], additive: boolean) => void;
  /** Fired when a notehead drag completes with a non-zero vertical movement. */
  onDragPitch?: (noteId: string, diatonicDelta: number) => void;
  /** Fired when dragging a movable marking (see `MOVABLE_ROLES`) completes with a non-zero movement; `dx`/`dy` are the drag's own delta in page-space sp, to be added to whatever offset the marking already has. */
  onDragMarking?: (id: string, dx: number, dy: number) => void;
  /** Where playback is; drawn as a line across the whole system, and the view follows it. Null/absent when not playing. */
  playhead?: PlayPosition | null;
  /**
   * Small +/− buttons on the hovered measure: "+" inserts an empty measure after it
   * (`onInsertMeasure(measureIndex + 1)`), "−" deletes it. Omit both to hide the controls.
   */
  onInsertMeasure?: (index: number) => void;
  onDeleteMeasure?: (measureIndex: number) => void;
}

/** Gap (sp) between the measure controls and the top staff line. */
const MEASURE_CONTROLS_LIFT_SP = 1;

const CURSOR_COLOR = "#2f7cf6";
/** Cursor line colour while voice 2 (index 1) is active, so the active voice is visible at a glance. */
const ACTIVE_VOICE_CURSOR_COLOR = "#2e9e5b";
const CURSOR_WIDTH_SP = 0.1;
const CURSOR_OPACITY = 0.55;
const CURSOR_OVERHANG_SP = 0.5;
/** Cursor sits just before the column, not through the note/rest glyph. */
const CURSOR_X_OFFSET_SP = 0.6;

const PLAYHEAD_COLOR = "#e8590c";
const PLAYHEAD_WIDTH_SP = 0.22;
const PLAYHEAD_OPACITY = 0.9;
const PLAYHEAD_OVERHANG_SP = 1;
/** Like the cursor, the playhead sits just before its column rather than through the notehead. */
const PLAYHEAD_X_OFFSET_SP = 0.3;

const SELECTION_COLOR = "#2f7cf6";
const SELECTION_PADDING_SP = 0.35;
const SELECTION_STROKE_SP = 0.14;
const SELECTION_RADIUS_SP = 0.3;

const RUBBER_BAND_FILL = "rgba(47, 124, 246, 0.08)";
const RUBBER_BAND_STROKE_SP = 0.06;
const RUBBER_BAND_DASH = "0.25,0.18";

/** Below this page-sp movement, a pointerdown/pointerup pair counts as a click, not a drag. */
const DRAG_THRESHOLD_SP = 0.3;

/** Vertical distance (sp) of one diatonic staff step (half a staff space), per docs/ARCHITECTURE.md. */
const STAFF_STEP_SP = 0.5;
/** Shared "in-progress positional edit" ghost style, for both notehead pitch-drag and marking nudge-drag. */
const DRAG_GHOST_COLOR = "#e67e22";
const DRAG_GHOST_STROKE_SP = 0.12;
const DRAG_GHOST_DASH = "0.2,0.16";

/** Converts a client-space point to the SVG's own user-space (its viewBox units) via the screen CTM. */
function clientPointToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}

function normalizedRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

/** What was under the pointer when a drag started: an element (for click/toggle) or empty space (for rubber-band/move-cursor). */
interface DragStart {
  pageIndex: number;
  startX: number;
  startY: number;
  shift: boolean;
  mod: boolean;
  onElement: ElementHit | null;
  /** The notehead's own bounding box, captured at pointerdown; only set when `onElement.role === "notehead"`. */
  noteBox: Rect | null;
  /** A movable marking's own bounding box, captured at pointerdown; only set when `onElement.role` is in `MOVABLE_ROLES`. */
  markingBox: Rect | null;
}

interface RubberBandState {
  pageIndex: number;
  rect: Rect;
}

/** Ghost outline shown while dragging a notehead to a new staff step. */
interface PitchDragState {
  pageIndex: number;
  box: Rect;
  diatonicDelta: number;
}

/** Ghost outline shown while dragging a movable marking to a new position (free, not snapped). */
interface MarkingDragState {
  pageIndex: number;
  box: Rect;
  dx: number;
  dy: number;
}

/**
 * Renders every page of a LayoutResult as inline SVG, stacked vertically,
 * each wrapped for a page-shadow look on screen (see app.css/print.css).
 * Overlays a thin entry cursor (green while voice 2 is active) and rounded
 * selection outlines (around each selected notehead/rest/marking,
 * Noteflight-style) in the existing overlay <svg>. Pointer interaction on
 * the page container is resolved by `hitTestElement` (pure geometry, not DOM
 * hit-testing — see its own doc comment) to an element click (with shift/mod
 * modifiers), a notehead drag (ghost outline snapped to the nearest staff
 * step, `onDragPitch` on release if it moved), a movable-marking drag (free
 * ghost outline, `onDragMarking` on release if it moved — see
 * `MOVABLE_ROLES`), an empty-space click, or an empty-space rubber-band drag.
 */
/**
 * The element that actually scrolls `el` into view: the nearest ancestor whose content
 * overflows and whose overflow-y lets it scroll, else the document itself.
 */
function scrollParentOf(el: HTMLElement): Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return document.scrollingElement ?? document.documentElement;
}

export function ScoreView({
  layout,
  font,
  idAttributes,
  cursor,
  selection,
  entryActive,
  onClickElement,
  onClickEmpty,
  onSelectMany,
  onDragPitch,
  onDragMarking,
  playhead,
  onInsertMeasure,
  onDeleteMeasure,
}: ScoreViewProps) {
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dragRef = useRef<DragStart | null>(null);
  const [rubberBand, setRubberBand] = useState<RubberBandState | null>(null);
  const [pitchDrag, setPitchDrag] = useState<PitchDragState | null>(null);
  const [markingDrag, setMarkingDrag] = useState<MarkingDragState | null>(null);
  const [hovered, setHovered] = useState<(MeasureHit & { pageIndex: number }) | null>(null);
  const showMeasureControls = Boolean(onInsertMeasure || onDeleteMeasure);
  const measureCount = useMemo(
    () => layout.pages.reduce((n, p) => n + p.systems.reduce((k, s) => k + s.measures.length, 0), 0),
    [layout],
  );

  const pageSvgs = useMemo(
    () =>
      renderPages(layout, {
        font,
        staffSpaceMm: layout.staffSpaceMm,
        unit: "px",
        idAttributes: idAttributes ?? false,
      }),
    [layout, font, idAttributes],
  );

  // Keep the cursor's system on screen: when the cursor moves to a measure that is
  // scrolled out of view (arrow keys, ⌘→, a review item in the compare panel), scroll
  // the score container just enough to show that system.
  //
  // `layout` is a brand new object on every edit (src/engraving/engrave.ts always
  // returns a fresh result), so it has to stay a dependency here (its own doc-comment
  // rule: a value an effect reads belongs in its dependency array). Without the guard
  // below, that means ANY edit anywhere in the score — say, dragging a marking to
  // nudge it — would re-run this effect and jump the view back to wherever the cursor
  // currently sits, which usually isn't what the user was just looking at. So the
  // effect first checks whether the cursor's measure genuinely changed since the last
  // time it actually scrolled for one, and does nothing when it hasn't.
  //
  // While playing, the view follows the playhead instead of the cursor.
  const lastScrolledMeasure = useRef<number | undefined>(undefined);
  const followMeasure = playhead?.measureIndex ?? cursor?.measureIndex;
  useEffect(() => {
    if (followMeasure === undefined || followMeasure === lastScrolledMeasure.current) return;
    lastScrolledMeasure.current = followMeasure;
    const loc = findSystemForMeasure(layout, followMeasure);
    if (!loc) return;
    const pageEl = pageRefs.current[loc.page.index];
    const svg = pageEl?.querySelector("svg");
    if (!pageEl || !svg) return;
    const scroller = scrollParentOf(pageEl);
    const svgRect = svg.getBoundingClientRect();
    const pxPerSp = svgRect.height / loc.page.heightSp;
    const margin = 24;
    const top = svgRect.top + (loc.system.y - 4) * pxPerSp - margin;
    const bottom = svgRect.top + (loc.system.y + loc.system.height + 4) * pxPerSp + margin;
    const view = scroller === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
    let delta = 0;
    if (top < view.top) delta = top - view.top;
    else if (bottom > view.bottom) delta = Math.min(bottom - view.bottom, top - view.top);
    if (delta !== 0) scroller.scrollBy({ top: delta, behavior: "smooth" });
  }, [followMeasure, layout]);

  const cursorLine = useMemo(() => {
    if (!cursor || !entryActive) return null;
    const loc = findSystemForMeasure(layout, cursor.measureIndex);
    if (!loc) return null;
    const staff = loc.system.staves.find(
      (s) => s.partIndex === cursor.partIndex && s.staffIndex === cursor.staffIndex,
    );
    if (!staff) return null;
    const x = loc.system.x + cursorX(loc.measure, cursor.offset) - CURSOR_X_OFFSET_SP;
    const topY = loc.system.y + staffY(loc.system, cursor.partIndex, cursor.staffIndex) - CURSOR_OVERHANG_SP;
    const bottomY = loc.system.y + staff.y + (staff.lineCount - 1) + CURSOR_OVERHANG_SP;
    const color = cursor.voiceIndex === 1 ? ACTIVE_VOICE_CURSOR_COLOR : CURSOR_COLOR;
    return { pageIndex: loc.page.index, x, y1: topY, y2: bottomY, color };
  }, [layout, cursor, entryActive]);

  const playheadLine = useMemo(() => {
    if (!playhead) return null;
    const loc = findSystemForMeasure(layout, playhead.measureIndex);
    const first = loc?.system.staves[0];
    const last = loc?.system.staves[loc.system.staves.length - 1];
    if (!loc || !first || !last) return null;
    return {
      pageIndex: loc.page.index,
      x: loc.system.x + cursorX(loc.measure, playhead.offset) - PLAYHEAD_X_OFFSET_SP,
      y1: loc.system.y + first.y - PLAYHEAD_OVERHANG_SP,
      y2: loc.system.y + last.y + (last.lineCount - 1) + PLAYHEAD_OVERHANG_SP,
    };
  }, [layout, playhead]);

  const boxesByPage = useMemo(() => {
    const map = new Map<number, { x: number; y: number; w: number; h: number }[]>();
    if (!selection || selection.ids.length === 0) return map;
    for (const box of selectionBoxes(layout, font, selection.ids)) {
      const arr = map.get(box.pageIndex);
      if (arr) arr.push(box);
      else map.set(box.pageIndex, [box]);
    }
    return map;
  }, [layout, font, selection]);

  function svgFor(pageIndex: number): SVGSVGElement | null {
    return pageRefs.current[pageIndex]?.querySelector("svg") ?? null;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, pageIndex: number) {
    if (event.button !== 0) return;
    const svg = svgFor(pageIndex);
    if (!svg) return;
    const pt = clientPointToSvg(svg, event.clientX, event.clientY);
    if (!pt) return;
    // Pure-geometry hit test, not DOM `elementFromPoint`/`closest` — see hitTestElement's
    // own doc comment for why: every glyph's native hit area is its full font em-box,
    // not its visible ink, so two glyphs within about a staff's height of each other
    // (routine for two voices on one staff) would otherwise silently steal each other's
    // clicks, always favouring whichever was painted later.
    const onElement = hitTestElement(layout, font, pageIndex, pt.x, pt.y);
    const noteBox = onElement?.role === "notehead" ? (selectionBoxes(layout, font, [onElement.id])[0] ?? null) : null;
    const markingBox =
      onElement && MOVABLE_ROLES.has(onElement.role) ? (selectionBoxes(layout, font, [onElement.id])[0] ?? null) : null;
    dragRef.current = {
      pageIndex,
      startX: pt.x,
      startY: pt.y,
      shift: event.shiftKey,
      mod: event.metaKey || event.ctrlKey,
      onElement,
      noteBox,
      markingBox,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** Tracks which measure the pointer is over, for the +/− controls (only while not dragging). */
  function updateHover(event: ReactPointerEvent<HTMLDivElement>, pageIndex: number) {
    if (!showMeasureControls || dragRef.current) return;
    const svg = svgFor(pageIndex);
    const pt = svg ? clientPointToSvg(svg, event.clientX, event.clientY) : null;
    const hit = pt ? measureAtPoint(layout, pageIndex, pt.x, pt.y) : null;
    setHovered((prev) =>
      hit
        ? prev && prev.pageIndex === pageIndex && prev.measureIndex === hit.measureIndex && prev.right === hit.right
          ? prev
          : { ...hit, pageIndex }
        : null,
    );
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = dragRef.current;
    if (!start) return;

    // Dragging a notehead: track a "ghost" outline at the staff step under the
    // pointer (not a rubber band). A click without movement stays a click.
    if (start.onElement?.role === "notehead") {
      if (!start.noteBox) return;
      const svg = svgFor(start.pageIndex);
      if (!svg) return;
      const pt = clientPointToSvg(svg, event.clientX, event.clientY);
      if (!pt) return;
      const dx = pt.x - start.startX;
      const dy = pt.y - start.startY;
      if (!pitchDrag && Math.hypot(dx, dy) < DRAG_THRESHOLD_SP) return;
      const diatonicDelta = Math.round(-dy / STAFF_STEP_SP);
      const box: Rect = { ...start.noteBox, y: start.noteBox.y - diatonicDelta * STAFF_STEP_SP };
      setPitchDrag({ pageIndex: start.pageIndex, box, diatonicDelta });
      return;
    }

    // Dragging a movable marking (slur, hairpin, pedal, ottava, dynamic, tempo, text):
    // a free (not snapped) ghost outline, committed as a `setNudge` on release.
    if (start.onElement && MOVABLE_ROLES.has(start.onElement.role)) {
      if (!start.markingBox) return;
      const svg = svgFor(start.pageIndex);
      if (!svg) return;
      const pt = clientPointToSvg(svg, event.clientX, event.clientY);
      if (!pt) return;
      const dx = pt.x - start.startX;
      const dy = pt.y - start.startY;
      if (!markingDrag && Math.hypot(dx, dy) < DRAG_THRESHOLD_SP) return;
      const box: Rect = { ...start.markingBox, x: start.markingBox.x + dx, y: start.markingBox.y + dy };
      setMarkingDrag({ pageIndex: start.pageIndex, box, dx, dy });
      return;
    }

    if (start.onElement) return; // other element kinds have no drag behaviour yet

    const svg = svgFor(start.pageIndex);
    if (!svg) return;
    const pt = clientPointToSvg(svg, event.clientX, event.clientY);
    if (!pt) return;
    const dx = pt.x - start.startX;
    const dy = pt.y - start.startY;
    if (!rubberBand && Math.hypot(dx, dy) < DRAG_THRESHOLD_SP) return;
    setRubberBand({ pageIndex: start.pageIndex, rect: normalizedRect(start.startX, start.startY, pt.x, pt.y) });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = dragRef.current;
    dragRef.current = null;
    const band = rubberBand;
    setRubberBand(null);
    const drag = pitchDrag;
    setPitchDrag(null);
    const mDrag = markingDrag;
    setMarkingDrag(null);
    if (!start) return;

    if (start.onElement?.role === "notehead" && drag) {
      if (drag.diatonicDelta !== 0) onDragPitch?.(start.onElement.id, drag.diatonicDelta);
      else onClickElement?.(start.onElement.id, start.onElement.role, { shift: start.shift, mod: start.mod });
      return;
    }

    if (start.onElement && MOVABLE_ROLES.has(start.onElement.role) && mDrag) {
      if (mDrag.dx !== 0 || mDrag.dy !== 0) onDragMarking?.(start.onElement.id, mDrag.dx, mDrag.dy);
      else onClickElement?.(start.onElement.id, start.onElement.role, { shift: start.shift, mod: start.mod });
      return;
    }

    if (start.onElement) {
      onClickElement?.(start.onElement.id, start.onElement.role, { shift: start.shift, mod: start.mod });
      return;
    }

    const svg = svgFor(start.pageIndex);
    const pt = svg ? clientPointToSvg(svg, event.clientX, event.clientY) : null;

    if (band) {
      const ids = idsInRect(layout, font, start.pageIndex, band.rect);
      onSelectMany?.(ids, start.shift);
      return;
    }

    const moved = pt ? Math.hypot(pt.x - start.startX, pt.y - start.startY) : 0;
    if (moved < DRAG_THRESHOLD_SP && pt) {
      onClickEmpty?.(start.pageIndex, pt.x, pt.y);
    }
  }

  return (
    <div className="page-stack">
      {layout.pages.map((page, i) => (
        <div className="page-shadow" key={page.index}>
          <div
            className="page"
            ref={(el) => {
              pageRefs.current[i] = el;
            }}
            onPointerDown={(e) => handlePointerDown(e, i)}
            onPointerMove={(e) => {
              updateHover(e, i);
              handlePointerMove(e);
            }}
            onPointerUp={handlePointerUp}
            onPointerLeave={() => setHovered(null)}
          >
            {/* SVG string comes from the pure renderer (src/render/svg.ts), not user input. */}
            <div className="page-content" dangerouslySetInnerHTML={{ __html: pageSvgs[i]! }} />
            <svg className="editor-overlay" viewBox={`0 0 ${page.widthSp} ${page.heightSp}`} aria-hidden="true">
              {(boxesByPage.get(page.index) ?? []).map((box, idx) => (
                <rect
                  key={idx}
                  x={box.x - SELECTION_PADDING_SP}
                  y={box.y - SELECTION_PADDING_SP}
                  width={box.w + 2 * SELECTION_PADDING_SP}
                  height={box.h + 2 * SELECTION_PADDING_SP}
                  rx={SELECTION_RADIUS_SP}
                  fill="none"
                  stroke={SELECTION_COLOR}
                  strokeWidth={SELECTION_STROKE_SP}
                />
              ))}
              {cursorLine && cursorLine.pageIndex === page.index && (
                <line
                  x1={cursorLine.x}
                  y1={cursorLine.y1}
                  x2={cursorLine.x}
                  y2={cursorLine.y2}
                  stroke={cursorLine.color}
                  strokeOpacity={CURSOR_OPACITY}
                  strokeWidth={CURSOR_WIDTH_SP}
                />
              )}
              {playheadLine && playheadLine.pageIndex === page.index && (
                <line
                  className="playhead"
                  x1={playheadLine.x}
                  y1={playheadLine.y1}
                  x2={playheadLine.x}
                  y2={playheadLine.y2}
                  stroke={PLAYHEAD_COLOR}
                  strokeOpacity={PLAYHEAD_OPACITY}
                  strokeWidth={PLAYHEAD_WIDTH_SP}
                />
              )}
              {pitchDrag && pitchDrag.pageIndex === page.index && (
                <rect
                  x={pitchDrag.box.x - SELECTION_PADDING_SP}
                  y={pitchDrag.box.y - SELECTION_PADDING_SP}
                  width={pitchDrag.box.w + 2 * SELECTION_PADDING_SP}
                  height={pitchDrag.box.h + 2 * SELECTION_PADDING_SP}
                  rx={SELECTION_RADIUS_SP}
                  fill="none"
                  stroke={DRAG_GHOST_COLOR}
                  strokeWidth={DRAG_GHOST_STROKE_SP}
                  strokeDasharray={DRAG_GHOST_DASH}
                />
              )}
              {markingDrag && markingDrag.pageIndex === page.index && (
                <rect
                  x={markingDrag.box.x - SELECTION_PADDING_SP}
                  y={markingDrag.box.y - SELECTION_PADDING_SP}
                  width={markingDrag.box.w + 2 * SELECTION_PADDING_SP}
                  height={markingDrag.box.h + 2 * SELECTION_PADDING_SP}
                  rx={SELECTION_RADIUS_SP}
                  fill="none"
                  stroke={DRAG_GHOST_COLOR}
                  strokeWidth={DRAG_GHOST_STROKE_SP}
                  strokeDasharray={DRAG_GHOST_DASH}
                />
              )}
              {rubberBand && rubberBand.pageIndex === page.index && (
                <rect
                  x={rubberBand.rect.x}
                  y={rubberBand.rect.y}
                  width={rubberBand.rect.w}
                  height={rubberBand.rect.h}
                  fill={RUBBER_BAND_FILL}
                  stroke={SELECTION_COLOR}
                  strokeWidth={RUBBER_BAND_STROKE_SP}
                  strokeDasharray={RUBBER_BAND_DASH}
                />
              )}
            </svg>
            {hovered && hovered.pageIndex === page.index && !rubberBand && !pitchDrag && !markingDrag && (
              <div
                className="measure-controls"
                style={{
                  left: `${(hovered.right / page.widthSp) * 100}%`,
                  top: `${((hovered.top - MEASURE_CONTROLS_LIFT_SP) / page.heightSp) * 100}%`,
                }}
                // The page container captures the pointer for clicks and drags; these are buttons.
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
              >
                {onInsertMeasure && (
                  <button
                    type="button"
                    className="measure-control"
                    title={`Insert an empty measure after measure ${hovered.measureIndex + 1}`}
                    aria-label={`Insert an empty measure after measure ${hovered.measureIndex + 1}`}
                    onClick={() => onInsertMeasure(hovered.measureIndex + 1)}
                  >
                    +
                  </button>
                )}
                {onDeleteMeasure && (
                  <button
                    type="button"
                    className="measure-control measure-control-delete"
                    disabled={measureCount <= 1}
                    title={`Delete measure ${hovered.measureIndex + 1} (Undo restores it)`}
                    aria-label={`Delete measure ${hovered.measureIndex + 1}`}
                    onClick={() => {
                      onDeleteMeasure(hovered.measureIndex);
                      setHovered(null);
                    }}
                  >
                    −
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
