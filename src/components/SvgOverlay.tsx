import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Room, ServiceColor } from "../types";

export type OverlayRequest =
  | { kind: "none" }
  | { kind: "deletePolygon"; roomId: string }
  | { kind: "duplicatePolygon"; fromRoomId: string; toRoomId: string };

type Point = { x: number; y: number };

type Mode =
  | { kind: "view" }
  | { kind: "draw"; roomId: string }
  | { kind: "dragVertex"; roomId: string; idx: number }
  | { kind: "vertexSelected"; roomId: string; idx: number }
  | { kind: "dragPoly"; roomId: string; start: Point; origin: Point[] };

const UI = {
  fillOpacity: 0.55,
  strokeWidth: 1,
  strokeWidthSelected: 3,
  handleRadius: 6,
  handleRadiusActive: 7,
  previewStrokeWidth: 2,

  // Snap (px)
  snapFirstRadiusPx: 18,
  snapMidRadiusPx: 24,

  // Insertion Alt+clic
  edgeInsertPxThreshold: 16, // ⬅️ plus permissif
  insertEndEps: 0.06,

  // Hit-test arêtes (invisible)
  edgeHitStrokePx: 22, // ⬅️ plus permissif

  // Grid
  gridStrokeOpacity: 0.18,
  gridStrokeWidth: 1,
};

const SNAP_STORAGE_KEY = "iface.snapEnabled";
const SNAP_TOGGLE_EVENT = "iface:snap-toggle";

function isTypingTarget(target: unknown): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.getAttribute("contenteditable") === "true"
  );
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function toSvgPoints(poly: Point[], w: number, h: number) {
  return poly.map((p) => `${p.x * w},${p.y * h}`).join(" ");
}

function toPathD(poly: Point[], w: number, h: number) {
  if (!poly.length) return "";
  const pts = poly.map((p) => ({ x: p.x * w, y: p.y * h }));
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;
  d += " Z";
  return d;
}

function centroid(poly: Point[]) {
  const n = poly.length || 1;
  return {
    x: poly.reduce((a, p) => a + p.x, 0) / n,
    y: poly.reduce((a, p) => a + p.y, 0) / n,
  };
}

function pointer(svg: SVGSVGElement, clientX: number, clientY: number): Point {
  const r = svg.getBoundingClientRect();
  return {
    x: clamp01((clientX - r.left) / Math.max(1, r.width)),
    y: clamp01((clientY - r.top) / Math.max(1, r.height)),
  };
}

function pxDist(a: Point, b: Point, w: number, h: number) {
  const dx = (a.x - b.x) * w;
  const dy = (a.y - b.y) * h;
  return Math.hypot(dx, dy);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function projectPointToSegment(p: Point, a: Point, b: Point): { proj: Point; t: number } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const c2 = vx * vx + vy * vy;
  if (c2 <= 1e-12) return { proj: a, t: 0 };
  let t = (vx * wx + vy * wy) / c2;
  t = Math.max(0, Math.min(1, t));
  return { proj: { x: a.x + t * vx, y: a.y + t * vy }, t };
}

function insertVertexOnNearestEdgeIfClose(
  poly: Point[],
  p: Point,
  pxThreshold: number,
  w: number,
  h: number,
  endEps: number
): { ok: true; poly: Point[]; insertAfterIdx: number; projected: Point } | { ok: false } {
  if (poly.length < 3) return { ok: false };

  let bestIdx = -1;
  let bestDist = Infinity;
  let bestProj: Point = poly[0];

  let fallbackIdx = 0;
  let fallbackDist = Infinity;
  let fallbackProj: Point = poly[0];

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const { proj, t } = projectPointToSegment(p, a, b);
    const d = pxDist(p, proj, w, h);

    if (d < fallbackDist) {
      fallbackDist = d;
      fallbackIdx = i;
      fallbackProj = proj;
    }

    if (t > endEps && t < 1 - endEps && d < bestDist) {
      bestDist = d;
      bestIdx = i;
      bestProj = proj;
    }
  }

  const useIdx = bestIdx >= 0 ? bestIdx : fallbackIdx;
  const useDist = bestIdx >= 0 ? bestDist : fallbackDist;
  const useProj = bestIdx >= 0 ? bestProj : fallbackProj;

  if (useDist > pxThreshold) return { ok: false };

  const out = poly.slice();
  out.splice(useIdx + 1, 0, useProj);
  return { ok: true, poly: out, insertAfterIdx: useIdx, projected: useProj };
}


function LockGlyph(props: { x: number; y: number; size?: number; opacity?: number }) {
  const size = props.size ?? 16;
  const opacity = props.opacity ?? 0.65;
  const scale = size / 24;
  const tx = props.x - size / 2;
  const ty = props.y - size / 2;

  return (
    <g transform={`translate(${tx} ${ty}) scale(${scale})`} opacity={opacity} pointerEvents="none">
      <path
        d="M17 8h-1V6a4 4 0 10-8 0v2H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V10a2 2 0 00-2-2zm-7 0V6a2 2 0 114 0v2h-4zm3 7.73V18a1 1 0 11-2 0v-2.27a2 2 0 112 0z"
        fill="#111"
      />
    </g>
  );
}

type DraftSnapInfo = { kind: "none" } | { kind: "first" } | { kind: "mid"; segIdx: number };

function extractPolygonEntryForPage(
  room: any,
  pageIndex: number
): { polygon?: Point[]; locked?: boolean } {
  if (!room) return {};

  const polys = room.polygons;
  if (Array.isArray(polys)) {
    for (const entry of polys) {
      if (!entry) continue;
      const p =
        typeof entry.page === "number"
          ? entry.page
          : typeof entry.pageIndex === "number"
            ? entry.pageIndex
            : undefined;
      if (p !== pageIndex) continue;

      const pts = entry.polygon ?? entry.points ?? entry;
      if (Array.isArray(pts)) return { polygon: pts as Point[], locked: !!entry.locked };
      if (pts && Array.isArray(pts.polygon)) return { polygon: pts.polygon as Point[], locked: !!entry.locked };
      return { locked: !!entry.locked };
    }
  }

  // Legacy fallback: single polygon + page
  const page = typeof room.page === "number" && Number.isFinite(room.page) ? room.page : 0;
  if (page === pageIndex) {
    const poly = room.polygon;
    if (Array.isArray(poly)) return { polygon: poly as Point[], locked: !!room.locked };
    if (poly && Array.isArray(poly.polygon)) return { polygon: poly.polygon as Point[], locked: !!room.locked };
    return { locked: !!room.locked };
  }

  return {};
}


function readSnapFromStorage(): boolean {
  try {
    const v = localStorage.getItem(SNAP_STORAGE_KEY);
    if (v == null) return true;
    const s = String(v).trim().toLowerCase();
    if (s === "0" || s === "false" || s === "off" || s === "no") return false;
    return true;
  } catch {
    return true;
  }
}

function writeSnapToStorage(v: boolean) {
  try {
    localStorage.setItem(SNAP_STORAGE_KEY, v ? "1" : "0");
  } catch {}
}

function snapPointToGrid(p: Point, gridSizePx: number, w: number, h: number): Point {
  const gs = Math.max(2, gridSizePx);
  const xPx = p.x * w;
  const yPx = p.y * h;
  const sxPx = Math.round(xPx / gs) * gs;
  const syPx = Math.round(yPx / gs) * gs;
  return {
    x: clamp01(sxPx / Math.max(1, w)),
    y: clamp01(syPx / Math.max(1, h)),
  };
}

function looksLikePixels(poly: Point[]): boolean {
  return poly.some((p) => p.x > 1.001 || p.y > 1.001 || p.x < -0.001 || p.y < -0.001);
}

function normalizeFromPixels(poly: Point[], w: number, h: number): Point[] {
  const W = Math.max(1, w);
  const H = Math.max(1, h);
  return poly.map((p) => ({ x: clamp01(p.x / W), y: clamp01(p.y / H) }));
}

function clampNormalized(poly: Point[]): Point[] {
  return poly.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }));
}

export function SvgOverlay(props: {
  width: number;
  height: number;

  page: number; // 0-based

  rooms: Room[];
  services: ServiceColor[];

  selectedRoomId: string | null;
  onSelectRoom: (id: string | null) => void;
  onRoomHover?: (id: string | null) => void;
  onPolygonDoubleClick?: (roomId: string) => void;

  adminMode: boolean;
  drawingRoomId: string | null;
  drawSessionId: number;

  onDrawDirtyChange?: (dirty: boolean) => void;

  onPolygonCommit: (roomId: string, poly: Point[]) => void;

  request: OverlayRequest;
  onRequestHandled: () => void;

  gridEnabled: boolean;
  gridSizePx: number;
  lockedRoomIdsOnPage?: Set<string>;
}) {
  const { width: w, height: h } = props;

  const svgRef = useRef<SVGSVGElement | null>(null);

  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [draft, setDraft] = useState<Point[]>([]);
  const [hoverRaw, setHoverRaw] = useState<Point | null>(null);
  const [hoverSnap, setHoverSnap] = useState<Point | null>(null);
  const [, setHoverSnapInfo] = useState<DraftSnapInfo>({ kind: "none" });
  const [hoverInfo, setHoverInfo] = useState<{ roomId: string; point: Point } | null>(null);

  const [localPoly, setLocalPoly] = useState<Record<string, Point[] | undefined>>({});
  const [lockedByRoom, setLockedByRoom] = useState<Record<string, boolean>>({});

  const [edgePreview, setEdgePreview] = useState<{ roomId: string; projected: Point; insertAfterIdx: number } | null>(
    null
  );

  const migratedRef = useRef<Set<string>>(new Set());

  const latestDraftRef = useRef<Point[]>(draft);
  const latestModeRef = useRef<Mode>(mode);
  const latestAdminModeRef = useRef<boolean>(props.adminMode);

  useEffect(() => {
    latestDraftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    latestModeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    latestAdminModeRef.current = props.adminMode;
  }, [props.adminMode]);

  useEffect(() => {
    return () => {
      const latestDraft = latestDraftRef.current;
      const latestMode = latestModeRef.current;
      if (!latestAdminModeRef.current) return;
      if (latestMode.kind !== "draw") return;
      if (latestDraft.length < 3) return;
      props.onPolygonCommit(latestMode.roomId, latestDraft);
    };
  }, [props.onPolygonCommit]);

  const [snapEnabled, _setSnapEnabled] = useState<boolean>(() => readSnapFromStorage());
  const setSnapEnabled = (updater: boolean | ((v: boolean) => boolean)) => {
    _setSnapEnabled((prev) => {
      const next = typeof updater === "function" ? (updater as (v: boolean) => boolean)(prev) : updater;
      writeSnapToStorage(next);
      return next;
    });
  };

  const colorByService = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of props.services) m.set(s.service, s.color);
    return m;
  }, [props.services]);

  const isRoomLocked = (roomId: string | null | undefined) => {
    if (!roomId) return false;
    return props.lockedRoomIdsOnPage?.has(roomId) ?? false;
  };

  function formatSurface(surface: number | null | undefined) {
    if (surface == null || Number.isNaN(surface)) return "—";
    return `${surface.toLocaleString("fr-FR")} m²`;
  }

  useEffect(() => {
    if (props.request.kind === "deletePolygon") {
      const roomId = props.request.roomId;
      setMode({ kind: "view" });
      setDraft([]);
      setHoverRaw(null);
      setHoverSnap(null);
      setHoverSnapInfo({ kind: "none" });
      setEdgePreview(null);
      setLocalPoly((p) => ({ ...p, [roomId]: undefined }));
      props.onPolygonCommit(roomId, []);
      props.onRequestHandled();
    }
  }, [props.request, props.onRequestHandled, props.onPolygonCommit]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "s") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setSnapEnabled((v) => !v);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onToggle = () => setSnapEnabled((v) => !v);
    window.addEventListener(SNAP_TOGGLE_EVENT, onToggle as EventListener);
    return () => window.removeEventListener(SNAP_TOGGLE_EVENT, onToggle as EventListener);
  }, []);

  useEffect(() => {
    const next: Record<string, Point[] | undefined> = {};
    const lockedNext: Record<string, boolean> = {};
    const toMigrate: Array<{ roomId: string; poly: Point[] }> = [];

    for (const r of props.rooms as any[]) {
      const entry = extractPolygonEntryForPage(r, props.page);
      const raw = entry.polygon;
      lockedNext[r.id] = !!entry.locked;

      if (!raw || raw.length < 3) {
        next[r.id] = undefined;
        continue;
      }

      if (looksLikePixels(raw)) {
        const migKey = `${r.id}@${props.page}`;
        if (!migratedRef.current.has(migKey) && w > 2 && h > 2) {
          const norm = normalizeFromPixels(raw, w, h);
          next[r.id] = norm;
          migratedRef.current.add(migKey);
          toMigrate.push({ roomId: r.id, poly: norm });
        } else {
          next[r.id] = raw;
        }
      } else {
        next[r.id] = clampNormalized(raw);
      }
    }

    setLocalPoly(next);

    setLockedByRoom(lockedNext);

    for (const m of toMigrate) {
      try {
        props.onPolygonCommit(m.roomId, m.poly);
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.rooms, props.page, w, h]);

  useEffect(() => {
    props.onDrawDirtyChange?.(draft.length > 0 && mode.kind === "draw");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.length, mode.kind]);

  useEffect(() => {
    if (!props.adminMode) {
      setMode({ kind: "view" });
      setDraft([]);
      setEdgePreview(null);
      setHoverRaw(null);
      setHoverSnap(null);
      setHoverSnapInfo({ kind: "none" });
      return;
    }

    setDraft([]);
    setEdgePreview(null);
    setHoverRaw(null);
    setHoverSnap(null);
    setHoverSnapInfo({ kind: "none" });

    if (props.drawingRoomId && !isRoomLocked(props.drawingRoomId)) {
      setMode({ kind: "draw", roomId: props.drawingRoomId });
    } else {
      setMode({ kind: "view" });
    }
  }, [props.drawSessionId, props.adminMode, props.drawingRoomId]);

  useEffect(() => {
    if (mode.kind !== "draw") return;
    if (!props.drawingRoomId) return;
    if (!isRoomLocked(props.drawingRoomId)) return;
    setMode({ kind: "view" });
    setDraft([]);
    setEdgePreview(null);
    setHoverRaw(null);
    setHoverSnap(null);
    setHoverSnapInfo({ kind: "none" });
  }, [mode.kind, props.drawingRoomId, props.lockedRoomIdsOnPage]);

  function commitDraw(roomId: string, poly: Point[]) {
    if (isRoomLocked(roomId)) return;
    if (poly.length < 3) return;
    setLocalPoly((p) => ({ ...p, [roomId]: poly }));
    props.onPolygonCommit(roomId, poly);
    setDraft([]);
    setHoverRaw(null);
    setHoverSnap(null);
    setHoverSnapInfo({ kind: "none" });
    setMode({ kind: "view" });
  }

  function applyOrthogonal(raw: Point, last: Point): Point {
    const dx = (raw.x - last.x) * w;
    const dy = (raw.y - last.y) * h;
    return Math.abs(dx) >= Math.abs(dy) ? { x: raw.x, y: last.y } : { x: last.x, y: raw.y };
  }

  function computeSnapDraft(raw0: Point, shiftKey: boolean): { snapped: Point; info: DraftSnapInfo } {
    let raw = raw0;

    if (shiftKey && draft.length >= 1) raw = applyOrthogonal(raw, draft[draft.length - 1]);
    if (props.gridEnabled) raw = snapPointToGrid(raw, props.gridSizePx, w, h);

    if (!snapEnabled) return { snapped: raw, info: { kind: "none" } };

    if (draft.length >= 3) {
      const first = draft[0];
      if (pxDist(raw, first, w, h) <= UI.snapFirstRadiusPx) return { snapped: first, info: { kind: "first" } };
    }

    if (draft.length >= 2) {
      let bestD = Infinity;
      let bestMid: Point | null = null;
      let bestIdx = 0;

      for (let i = 0; i < draft.length - 1; i++) {
        const m = midpoint(draft[i], draft[i + 1]);
        const d = pxDist(raw, m, w, h);
        if (d < bestD) {
          bestD = d;
          bestMid = m;
          bestIdx = i;
        }
      }

      if (bestMid && bestD <= UI.snapMidRadiusPx) return { snapped: bestMid, info: { kind: "mid", segIdx: bestIdx } };
    }

    return { snapped: raw, info: { kind: "none" } };
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!props.adminMode) return;

      if (e.key === "Escape") {
        if (mode.kind === "draw") {
          setDraft([]);
          setHoverRaw(null);
          setHoverSnap(null);
          setHoverSnapInfo({ kind: "none" });
        }
        setMode({ kind: "view" });
        return;
      }

      if (e.key === "Enter") {
        if (mode.kind === "draw" && draft.length >= 3) commitDraw(mode.roomId, draft);
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (mode.kind === "vertexSelected") {
          e.preventDefault();
          const { roomId, idx } = mode;
          if (isRoomLocked(roomId)) return;
          if (isRoomLocked(roomId)) return false;

    if (isRoomLocked(roomId)) return;

          const poly = localPoly[roomId];
          if (!poly) return;

          const next = poly.slice();
          next.splice(idx, 1);

          if (next.length < 3) {
            setLocalPoly((p) => ({ ...p, [roomId]: undefined }));
            props.onPolygonCommit(roomId, []);
            setMode({ kind: "view" });
          } else {
            setLocalPoly((p) => ({ ...p, [roomId]: next }));
            props.onPolygonCommit(roomId, next);
            setMode({ kind: "vertexSelected", roomId, idx: Math.min(idx, next.length - 1) });
          }
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.adminMode, mode, draft, localPoly, props.onPolygonCommit]);

  useEffect(() => {
    function onMove(ev: MouseEvent) {
      if (!props.adminMode) return;
      const svg = svgRef.current;
      if (!svg) return;

      if (mode.kind === "dragVertex") {
        const raw = pointer(svg, ev.clientX, ev.clientY);
        const p0 = props.gridEnabled ? snapPointToGrid(raw, props.gridSizePx, w, h) : raw;

        const poly = localPoly[mode.roomId];
        if (!poly) return;

        const next = poly.slice();
        next[mode.idx] = p0;

        setLocalPoly((p) => ({ ...p, [mode.roomId]: next }));
        return;
      }

      if (mode.kind === "dragPoly") {
        const raw = pointer(svg, ev.clientX, ev.clientY);

        let dx = raw.x - mode.start.x;
        let dy = raw.y - mode.start.y;

        if (props.gridEnabled) {
          const dxPx = dx * w;
          const dyPx = dy * h;
          const gs = Math.max(2, props.gridSizePx);
          const sdxPx = Math.round(dxPx / gs) * gs;
          const sdyPx = Math.round(dyPx / gs) * gs;
          dx = sdxPx / Math.max(1, w);
          dy = sdyPx / Math.max(1, h);
        }

        const moved = mode.origin.map((p) => ({ x: clamp01(p.x + dx), y: clamp01(p.y + dy) }));
        setLocalPoly((p) => ({ ...p, [mode.roomId]: moved }));
      }
    }

    function onUp() {
      if (!props.adminMode) return;

      if (mode.kind === "dragVertex") {
        const poly = localPoly[mode.roomId];
        if (poly && poly.length >= 3) {
          props.onPolygonCommit(mode.roomId, poly);
          setMode({ kind: "vertexSelected", roomId: mode.roomId, idx: mode.idx });
        } else {
          props.onPolygonCommit(mode.roomId, []);
          setMode({ kind: "view" });
        }
        return;
      }

      if (mode.kind === "dragPoly") {
        const poly = localPoly[mode.roomId];
        if (poly && poly.length >= 3) props.onPolygonCommit(mode.roomId, poly);
        setMode({ kind: "view" });
      }
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [props.adminMode, mode, localPoly, props.gridEnabled, props.gridSizePx, w, h, props.onPolygonCommit]);

  function onSvgMouseMove(e: React.MouseEvent) {
    const svg = svgRef.current;
    if (!svg) return;
    if (props.onRoomHover && e.target === svg) {
      props.onRoomHover(null);
    }

    if (!props.adminMode) return;

    const raw = pointer(svg, e.clientX, e.clientY);

    if (mode.kind === "draw") {
      setHoverRaw(raw);
      setEdgePreview(null);
      const { snapped, info } = computeSnapDraft(raw, e.shiftKey);
      setHoverSnap(snapped);
      setHoverSnapInfo(info);
      return;
    }

    if (!e.altKey) {
      if (edgePreview) setEdgePreview(null);
      return;
    }

    const roomId = props.selectedRoomId;
    if (!roomId) return;
    if (isRoomLocked(roomId)) return;

    if (isRoomLocked(roomId)) return false;

    const poly = localPoly[roomId];
    if (!poly || poly.length < 3) return;

    let pForInsert = raw;
    if (props.gridEnabled) pForInsert = snapPointToGrid(pForInsert, props.gridSizePx, w, h);

    const ins = insertVertexOnNearestEdgeIfClose(poly, pForInsert, UI.edgeInsertPxThreshold, w, h, UI.insertEndEps);
    setEdgePreview(ins.ok ? { roomId, projected: ins.projected, insertAfterIdx: ins.insertAfterIdx } : null);
  }

  function onSvgMouseLeave() {
    setHoverRaw(null);
    setHoverSnap(null);
    setHoverSnapInfo({ kind: "none" });
    setEdgePreview(null);
    setHoverInfo(null);
    props.onRoomHover?.(null);
  }

  function tryAltInsertAtEvent(e: React.MouseEvent): boolean {
    if (!props.adminMode) return false;
    if (!e.altKey) return false;
    if (mode.kind === "draw") return false;

    const roomId = props.selectedRoomId;
    if (!roomId) return false;
    if (isRoomLocked(roomId)) return false;

    if (isRoomLocked(roomId)) return false;

    const poly = localPoly[roomId];
    if (!poly || poly.length < 3) return false;

    const svg = svgRef.current;
    if (!svg) return false;

    let raw = pointer(svg, e.clientX, e.clientY);
    if (props.gridEnabled) raw = snapPointToGrid(raw, props.gridSizePx, w, h);

    const p = edgePreview?.roomId === roomId ? edgePreview.projected : raw;
    const ins = insertVertexOnNearestEdgeIfClose(poly, p, UI.edgeInsertPxThreshold, w, h, UI.insertEndEps);
    if (!ins.ok) return false;

    setLocalPoly((ps) => ({ ...ps, [roomId]: ins.poly }));
    props.onPolygonCommit(roomId, ins.poly);
    setMode({ kind: "vertexSelected", roomId, idx: ins.insertAfterIdx + 1 });
    return true;
  }

  function onSvgClick(e: React.MouseEvent) {
    // ✅ guard: if already handled by a child, do nothing
    if (e.defaultPrevented) return;

    // ✅ allow Alt+click insertion even if click hits "empty" area
    if (tryAltInsertAtEvent(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (mode.kind === "vertexSelected") {
      return;
    }

    const svg = svgRef.current;
    if (!svg) return;

    if (props.adminMode && mode.kind === "draw") {
      if (isRoomLocked(mode.roomId)) return;
      const raw0 = pointer(svg, e.clientX, e.clientY);
      const { snapped, info } = computeSnapDraft(raw0, e.shiftKey);

      if (info.kind === "first" && draft.length >= 3) {
        commitDraw(mode.roomId, draft);
        return;
      }

      setDraft((d) => [...d, snapped]);
      return;
    }

    props.onSelectRoom(null);
    setMode({ kind: "view" });
  }

  function onPolygonMouseDown(e: React.MouseEvent, roomId: string) {
    // ✅ critical: avoid bubbling to svg root
    e.preventDefault();
    e.stopPropagation();

    if (!props.adminMode) return;
    if (isRoomLocked(roomId)) return;

    const isPolyMove = e.ctrlKey || e.metaKey;
    if (!isPolyMove) return;

    const svg = svgRef.current;
    if (!svg) return;

    if (isRoomLocked(roomId)) return false;

    const poly = localPoly[roomId];
    if (!poly || poly.length < 3) return;

    props.onSelectRoom(roomId);
    const start = pointer(svg, e.clientX, e.clientY);
    setMode({ kind: "dragPoly", roomId, start, origin: poly.slice() });
  }

  function onPolygonClick(e: React.MouseEvent, roomId: string) {
    // ✅ critical: avoid bubbling to svg root (which would clear selection)
    e.preventDefault();
    e.stopPropagation();

    if (!props.adminMode) {
      props.onSelectRoom(roomId);
      return;
    }

    // Alt+clic = insertion
    if (e.altKey && mode.kind !== "draw") {
      if (isRoomLocked(roomId)) return;
      props.onSelectRoom(roomId);
      // do insertion based on current event position (no dependency on clicking exactly on stroke)
      if (tryAltInsertAtEvent(e)) return;
      return;
    }

    props.onSelectRoom(roomId);
  }

  function onPolygonDoubleClick(e: React.MouseEvent, roomId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (mode.kind === "draw") return;
    props.onSelectRoom(roomId);
    props.onPolygonDoubleClick?.(roomId);
  }

  function onHandleMouseDown(e: React.MouseEvent, roomId: string, idx: number) {
    if (!props.adminMode) return;
    if (isRoomLocked(roomId)) return;
    e.preventDefault();
    e.stopPropagation();
    props.onSelectRoom(roomId);
    if (isRoomLocked(roomId)) return;
    setMode({ kind: "dragVertex", roomId, idx });
  }

  function onHandleClick(e: React.MouseEvent, roomId: string, idx: number) {
    if (!props.adminMode) return;
    if (isRoomLocked(roomId)) return;
    e.preventDefault();
    e.stopPropagation();
    props.onSelectRoom(roomId);
    setMode({ kind: "vertexSelected", roomId, idx });
  }

  const selectedRoomId = props.selectedRoomId;
  const selectedPoly = selectedRoomId ? localPoly[selectedRoomId] : undefined;

  const previewEnd = hoverSnap ?? hoverRaw;
  const previewLine =
    mode.kind === "draw" && draft.length >= 1 && previewEnd ? { a: draft[draft.length - 1], b: previewEnd } : null;

  const gridPatternId = useMemo(() => `grid-${props.gridSizePx}`, [props.gridSizePx]);

  return (
    <svg
      ref={svgRef}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ position: "absolute", inset: 0, touchAction: "none" }}
      onClick={onSvgClick}
      onMouseMove={onSvgMouseMove}
      onMouseLeave={onSvgMouseLeave}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <defs>
        <pattern
          id={gridPatternId}
          width={Math.max(2, props.gridSizePx)}
          height={Math.max(2, props.gridSizePx)}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M ${Math.max(2, props.gridSizePx)} 0 L 0 0 0 ${Math.max(2, props.gridSizePx)}`}
            fill="none"
            stroke="rgba(0,0,0,1)"
            strokeOpacity={UI.gridStrokeOpacity}
            strokeWidth={UI.gridStrokeWidth}
          />
        </pattern>
      </defs>

      {props.gridEnabled && <rect x={0} y={0} width={w} height={h} fill={`url(#${gridPatternId})`} pointerEvents="none" />}

      {props.adminMode && (
        <text x={12} y={24} style={{ fontSize: 12, userSelect: "none" }}>
          Page {props.page + 1} • Snap {snapEnabled ? "ON" : "OFF"} • Grille{" "}
          {props.gridEnabled ? `ON (${props.gridSizePx}px)` : "OFF"}
        </text>
      )}

      {props.rooms.map((r: any) => {
        const poly = localPoly[r.id];
        if (!poly || poly.length < 3) return null;

        const fill = r.service ? colorByService.get(r.service) ?? "#ccc" : "#ccc";
        const selected = r.id === selectedRoomId;
        const locked = lockedByRoom[r.id] ?? false;
        const c = centroid(poly);

        const pts = toSvgPoints(poly, w, h);
        const d = toPathD(poly, w, h);

        const showTooltip = hoverInfo?.roomId === r.id && mode.kind !== "draw";
        let tooltipX = 0;
        let tooltipY = 0;
        if (showTooltip && hoverInfo) {
          const tooltipWidth = 240;
          const tooltipHeight = 180;
          const padding = 8;
          const anchorX = hoverInfo.point.x * w;
          const anchorY = hoverInfo.point.y * h;
          tooltipX = Math.min(w - tooltipWidth - padding, Math.max(padding, anchorX - tooltipWidth / 2));
          tooltipY = Math.min(h - tooltipHeight - padding, Math.max(padding, anchorY - tooltipHeight - 6));
        }

        return (
          <g key={r.id}>
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={UI.edgeHitStrokePx}
              pointerEvents="stroke"
              onClick={(ev) => onPolygonClick(ev, r.id)}
              onDoubleClick={(ev) => onPolygonDoubleClick(ev, r.id)}
              onMouseDown={(ev) => onPolygonMouseDown(ev, r.id)}
              onMouseMove={(ev) => {
                const svg = svgRef.current;
                if (!svg) return;
                setHoverInfo({ roomId: r.id, point: pointer(svg, ev.clientX, ev.clientY) });
                props.onRoomHover?.(r.id);
              }}
              onMouseLeave={(ev) => {
                const next = ev.relatedTarget as Element | null;
                if (next && next.closest?.(".poly-tooltip, .poly-tooltip-anchor")) return;
                setHoverInfo(null);
                props.onRoomHover?.(null);
              }}
              style={{ cursor: "pointer" }}
            />

            <polygon
              points={pts}
              fill={fill}
              fillOpacity={UI.fillOpacity}
              stroke={selected ? "#000" : "#333"}
              strokeWidth={selected ? UI.strokeWidthSelected : UI.strokeWidth}
              strokeDasharray={locked ? "6 4" : undefined}
              onClick={(ev) => onPolygonClick(ev, r.id)}
              onDoubleClick={(ev) => onPolygonDoubleClick(ev, r.id)}
              onMouseDown={(ev) => onPolygonMouseDown(ev, r.id)}
              onMouseMove={(ev) => {
                const svg = svgRef.current;
                if (!svg) return;
                setHoverInfo({ roomId: r.id, point: pointer(svg, ev.clientX, ev.clientY) });
                props.onRoomHover?.(r.id);
              }}
              onMouseLeave={(ev) => {
                const next = ev.relatedTarget as Element | null;
                if (next && next.closest?.(".poly-tooltip, .poly-tooltip-anchor")) return;
                setHoverInfo(null);
                props.onRoomHover?.(null);
              }}
              style={{ cursor: "pointer" }}
            />

            {locked && (
              <LockGlyph
                x={Math.min(w - 12, Math.max(12, c.x * w))}
                y={Math.min(h - 12, Math.max(12, c.y * h - 18))}
                size={16}
                opacity={0.65}
              />
            )}

            <text
              x={c.x * w}
              y={c.y * h}
              textAnchor="middle"
              dominantBaseline="central"
              style={{ fontSize: 14, fontWeight: 700, pointerEvents: "none" }}
            >
              {r.numero}
            </text>

            {showTooltip && (
              <foreignObject
                x={tooltipX}
                y={tooltipY}
                width={240}
                height={120}
                pointerEvents="auto"
                className="poly-tooltip-anchor"
              >
                <div
                  className="poly-tooltip"
                  onMouseEnter={() => {
                    setHoverInfo((prev) => prev ?? { roomId: r.id, point: c });
                    props.onRoomHover?.(r.id);
                  }}
                  onMouseLeave={() => {
                    setHoverInfo(null);
                    props.onRoomHover?.(null);
                  }}
                >
                  <div className="poly-tooltip-header">
                    <span className="poly-tooltip-number">{r.numero || "—"}</span>
                    <span className="poly-tooltip-title">{r.designation || "—"}</span>
                  </div>
                  <div className="poly-tooltip-row">
                    <span className="poly-tooltip-label">Service</span>
                    <span className="poly-tooltip-value">{r.service || "—"}</span>
                  </div>
                  <div className="poly-tooltip-row">
                    <span className="poly-tooltip-label">Surface</span>
                    <span className="poly-tooltip-value">{formatSurface(r.surface)}</span>
                  </div>
                </div>
              </foreignObject>
            )}
          </g>
        );
      })}

      {props.adminMode && selectedRoomId && selectedPoly && selectedPoly.length >= 3 && (
        <>
          {selectedPoly.map((p, idx) => {
            const active =
              (mode.kind === "dragVertex" && mode.roomId === selectedRoomId && mode.idx === idx) ||
              (mode.kind === "vertexSelected" && mode.roomId === selectedRoomId && mode.idx === idx);

            return (
              <circle
                key={idx}
                cx={p.x * w}
                cy={p.y * h}
                r={active ? UI.handleRadiusActive : UI.handleRadius}
                fill="#fff"
                stroke="#000"
                strokeWidth={2}
                onMouseDown={(e) => onHandleMouseDown(e, selectedRoomId, idx)}
                onClick={(e) => onHandleClick(e, selectedRoomId, idx)}
                style={{ cursor: "grab" }}
              />
            );
          })}
        </>
      )}

      {props.adminMode && edgePreview && (
        <circle cx={edgePreview.projected.x * w} cy={edgePreview.projected.y * h} r={7} fill="#ff0" stroke="#000" strokeWidth={2} />
      )}

      {props.adminMode && mode.kind === "draw" && draft.length > 0 && (
        <>
          <polyline points={toSvgPoints(draft, w, h)} fill="none" stroke="#000" strokeWidth={UI.previewStrokeWidth} />

          {previewLine && (
            <line
              x1={previewLine.a.x * w}
              y1={previewLine.a.y * h}
              x2={previewLine.b.x * w}
              y2={previewLine.b.y * h}
              stroke="#000"
              strokeWidth={UI.previewStrokeWidth}
            />
          )}

          {draft.map((p, i) => (
            <circle key={i} cx={p.x * w} cy={p.y * h} r={4} fill="#000" />
          ))}
        </>
      )}
    </svg>
  );
}
