import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

import { PdfCanvas } from "./components/PdfCanvas";
import { SvgOverlay } from "./components/SvgOverlay";
import type { OverlayRequest } from "./components/SvgOverlay";

import { RoomListPanel } from "./components/RoomListPanel";
import { RoomDetailsPanel, type RoomDetailsPanelHandle } from "./components/RoomDetailsPanel";
import { DraggableWindow } from "./components/DraggableWindow";

import { api } from "./api";
import type { Room, Point, ServiceColor } from "./types";

const SNAP_STORAGE_KEY = "iface.snapEnabled";
const SNAP_TOGGLE_EVENT = "iface:snap-toggle";

const GRID_ENABLED_KEY = "iface.gridEnabled";
const GRID_SIZE_KEY = "iface.gridSizePx";

const SERVICE_COLORS_KEY = "iface.serviceColors.v1";

// ✅ Pro: filter toggle persistence
const PAGES_ONLY_WITH_POLYS_KEY = "iface.pages.onlyWithPolys";

const UI_ZOOM_KEY = "iface.uiZoom";
const UI_ZOOM_MIN = 0.7;
const UI_ZOOM_MAX = 1.1;
const UI_ZOOM_DEFAULT = 0.75;

type PageView = "dashboard" | "plans" | "settings";
type ServiceEntry = ServiceColor & { uid: string };

function makeUid(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `svc_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function safeParse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function readBool(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    const s = String(v).trim().toLowerCase();
    if (s === "1" || s === "true" || s === "on" || s === "yes") return true;
    if (s === "0" || s === "false" || s === "off" || s === "no") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBool(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {}
}

function readSnapFromStorage(): boolean {
  return readBool(SNAP_STORAGE_KEY, true);
}

function readGridEnabled(): boolean {
  return readBool(GRID_ENABLED_KEY, false);
}

function writeGridEnabled(v: boolean) {
  writeBool(GRID_ENABLED_KEY, v);
}

function readGridSizePx(): number {
  try {
    const v = localStorage.getItem(GRID_SIZE_KEY);
    const n = v == null ? 20 : Number(v);
    if (!Number.isFinite(n)) return 20;
    return Math.min(200, Math.max(4, Math.round(n)));
  } catch {
    return 20;
  }
}

function writeGridSizePx(v: number) {
  try {
    const n = Math.min(200, Math.max(4, Math.round(v)));
    localStorage.setItem(GRID_SIZE_KEY, String(n));
  } catch {}
}

function clampUiZoom(next: number) {
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, +next.toFixed(2)));
}

function readUiZoom(): number {
  try {
    const v = localStorage.getItem(UI_ZOOM_KEY);
    const n = v == null ? UI_ZOOM_DEFAULT : Number(v);
    if (!Number.isFinite(n)) return UI_ZOOM_DEFAULT;
    return clampUiZoom(n);
  } catch {
    return UI_ZOOM_DEFAULT;
  }
}

function writeUiZoom(v: number) {
  try {
    localStorage.setItem(UI_ZOOM_KEY, String(clampUiZoom(v)));
  } catch {}
}

function clampScale(next: number) {
  return Math.min(3, Math.max(0.4, +next.toFixed(2)));
}

function isTypingTarget(target: unknown): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.getAttribute("contenteditable") === "true";
}

function isValidSize(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

// --------------------
// Services (HEX only + picker)
// --------------------
function normalizeServiceName(s: string) {
  return s.trim();
}
function serviceKey(s: string) {
  return normalizeServiceName(s).toLowerCase();
}
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function clamp255(n: number) {
  return Math.max(0, Math.min(255, n | 0));
}
function toHexByte(n: number) {
  return clamp255(n).toString(16).padStart(2, "0");
}
function isHexColor(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v.trim());
}
function defaultColorForService(service: string): string {
  const s = service.trim() || "service";
  const h = hashString(s);
  const r = 160 + ((h >> 16) & 0x3f);
  const g = 160 + ((h >> 8) & 0x3f);
  const b = 160 + (h & 0x3f);
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}
function sanitizeServiceColor(service: string, color: string | undefined | null): string {
  const c = (color || "").trim();
  if (isHexColor(c)) return c;
  return defaultColorForService(service);
}
function sortServicesStable(list: ServiceEntry[]) {
  return [...list].sort((a, b) => a.service.localeCompare(b.service, "fr"));
}
function readServiceColorsRaw(): ServiceColor[] {
  const parsed = safeParse<ServiceColor[]>(localStorage.getItem(SERVICE_COLORS_KEY));
  if (!parsed || !Array.isArray(parsed)) return [];
  const map = new Map<string, ServiceColor>();
  for (const x of parsed) {
    if (!x || typeof x.service !== "string") continue;
    const name = normalizeServiceName(x.service);
    if (!name) continue;
    map.set(serviceKey(name), { service: name, color: sanitizeServiceColor(name, (x as any).color) });
  }
  return Array.from(map.values()).sort((a, b) => a.service.localeCompare(b.service, "fr"));
}
function writeServiceColorsRaw(v: ServiceColor[]) {
  try {
    localStorage.setItem(SERVICE_COLORS_KEY, JSON.stringify(v));
  } catch {}
}
// --------------------

// --------------------
// Polygons detection (robust formats)
// --------------------
function parsePageIndex(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function entryPageIndex(entry: any): number | undefined {
  return parsePageIndex(entry?.page ?? entry?.pageIndex);
}

function extractPolygonForPage(room: any, pageIndex: number): Point[] | undefined {
  if (!room) return undefined;

  const polys = room.polygons;
  if (Array.isArray(polys)) {
    for (const entry of polys) {
      if (!entry) continue;
      const p = entryPageIndex(entry);
      if (p !== pageIndex) continue;

      const pts = entry.polygon ?? entry.points ?? entry;
      if (Array.isArray(pts)) return pts as Point[];
      if (pts && Array.isArray(pts.polygon)) return pts.polygon as Point[];
    }
  }

  const page = parsePageIndex(room.page) ?? 0;
  if (page === pageIndex) {
    const poly = room.polygon;
    if (Array.isArray(poly)) return poly as Point[];
    if (poly && Array.isArray(poly.polygon)) return poly.polygon as Point[];
  }

  return undefined;
}

function roomHasPolygonOnPage(room: any, pageIndex: number): boolean {
  const poly = extractPolygonForPage(room, pageIndex);
  return !!poly && poly.length >= 3;
}


function roomPolygonEntryForPage(room: any, pageIndex: number): any | undefined {
  if (Array.isArray(room?.polygons)) {
    return room.polygons.find((e: any) => entryPageIndex(e) === pageIndex);
  }
  // legacy has no lock
  return undefined;
}


const LOCK_STORAGE_KEY = "iface:polygonLocked";

function lockKey(roomId: string, page: number) {
  return `${roomId}@${page}`;
}

function readLockMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LOCK_STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = !!v;
    return out;
  } catch {
    return {};
  }
}

function writeLockMap(m: Record<string, boolean>) {
  try {
    localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(m));
  } catch {}
}

function getLockOverride(roomId: string, page: number): boolean | undefined {
  const m = readLockMap();
  const k = lockKey(roomId, page);
  return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined;
}

function setLockOverride(roomId: string, page: number, locked: boolean) {
  const m = readLockMap();
  m[lockKey(roomId, page)] = locked;
  writeLockMap(m);
}

function applyLockOverridesToRooms(rooms: any[]): any[] {
  const m = readLockMap();
  if (!m || Object.keys(m).length === 0) return rooms;

  return rooms.map((r: any) => {
    const rid = r?.id;
    if (!rid) return r;
    if (!Array.isArray(r.polygons)) return r;

    const nextPolys = r.polygons.map((p: any) => {
      const page = entryPageIndex(p);
      if (typeof page !== "number") return p;
      const k = lockKey(rid, page);
      if (!Object.prototype.hasOwnProperty.call(m, k)) return p;
      return { ...p, locked: !!m[k] };
    });

    return { ...r, polygons: nextPolys };
  });
}



function mergeRoomPreserveLocks(prev: any, next: any): any {
  if (!prev) return next;
  if (!next) return next;

  const prevPolys: any[] = Array.isArray(prev.polygons) ? prev.polygons : [];
  const nextPolys: any[] = Array.isArray(next.polygons) ? next.polygons : [];

  if (nextPolys.length > 0) {
    const merged = nextPolys.map((p: any) => {
      const page = entryPageIndex(p);
      if (typeof page !== "number") return p;
      const prevEntry = prevPolys.find((x: any) => entryPageIndex(x) === page);
      if (!prevEntry) return p;
      if (p.locked == null && prevEntry.locked != null) return { ...p, locked: !!prevEntry.locked };
      return p;
    });
    return { ...next, polygons: merged };
  }

  if (prevPolys.length > 0) {
    // Backend may omit polygons; keep previous polygon entries (including locks),
    // but refresh polygon geometry from legacy fields if present.
    const merged = prevPolys.map((p: any) => ({ ...p }));
    const legacyPage = typeof next.page === "number" ? next.page : 0;
    const legacyPoly = Array.isArray(next.polygon) ? next.polygon : [];
    if (legacyPoly.length >= 3) {
      const i = merged.findIndex((x: any) => entryPageIndex(x) === legacyPage);
      if (i >= 0) merged[i] = { ...merged[i], page: legacyPage, polygon: legacyPoly };
      else merged.push({ page: legacyPage, polygon: legacyPoly, locked: false });
    }
    return { ...next, polygons: merged };
  }

  return next;
}

function mergeRoomsPreserveLocks(prevRooms: any[], nextRooms: any[]): any[] {
  const map = new Map<string, any>();
  for (const r of prevRooms || []) if (r?.id) map.set(r.id, r);
  return (nextRooms || []).map((r: any) => {
    const prev = r?.id ? map.get(r.id) : undefined;
    return prev ? mergeRoomPreserveLocks(prev, r) : r;
  });
}

function roomPolygonLockedOnPage(room: any, pageIndex: number): boolean {
  const rid = room?.id;
  if (typeof rid === "string") {
    const ov = getLockOverride(rid, pageIndex);
    if (typeof ov === "boolean") return ov;
  }
  const entry = roomPolygonEntryForPage(room, pageIndex);
  return !!entry?.locked;
}


function roomPagesWithPolygons(room: any): number[] {
  const pages = new Set<number>();

  if (Array.isArray(room?.polygons)) {
    for (const entry of room.polygons) {
      const p = entryPageIndex(entry);
      const pts = entry?.polygon;
      if (typeof p === "number" && Array.isArray(pts) && pts.length >= 3) pages.add(p);
    }
  }

  const legacyPage = parsePageIndex(room?.page) ?? 0;
  const legacyPoly = room?.polygon;
  if (Array.isArray(legacyPoly) && legacyPoly.length >= 3) pages.add(legacyPage);

  return Array.from(pages.values()).sort((a, b) => a - b);
}

function roomHasPolygonOnOtherPage(room: any, pageIndex: number): boolean {
  return roomPagesWithPolygons(room).some((p) => p !== pageIndex);
}
// --------------------

// --------------------
// Pro sidebar filter parser
// --------------------
function parsePageFilter(input: string, pageCount: number): number[] | null {
  const q = input.trim();
  if (!q) return null;

  const max = Math.max(1, pageCount);
  const toIndex = (n1based: number) => Math.max(0, Math.min(max - 1, n1based - 1));

  if (q.includes(",")) {
    const nums = q
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= max);
    const set = new Set(nums.map((n) => toIndex(n)));
    return Array.from(set).sort((a, b) => a - b);
  }

  const rangeMatch = q.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    const a = Number(rangeMatch[1]);
    const b = Number(rangeMatch[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const start = Math.max(1, Math.min(a, b));
      const end = Math.min(max, Math.max(a, b));
      const out: number[] = [];
      for (let n = start; n <= end; n++) out.push(toIndex(n));
      return out;
    }
  }

  if (/^\d+$/.test(q)) {
    const n = Number(q);
    if (Number.isFinite(n) && n >= 1 && n <= max) return [toIndex(n)];
    return [];
  }

  return null;
}
// --------------------

export default function App() {
  const [pageView, setPageView] = useState<PageView>("dashboard");

  const [rooms, setRooms] = useState<Room[]>([]);

  const roomsRef = useRef<Room[]>([]);
  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [detailsRoomId, setDetailsRoomId] = useState<string | null>(null);
  const detailsPanelRef = useRef<RoomDetailsPanelHandle | null>(null);

  const [adminMode, setAdminMode] = useState(true);
  const [drawingRoomId, setDrawingRoomId] = useState<string | null>(null);
  const [drawSessionId, setDrawSessionId] = useState(0);

  const [scale, setScale] = useState(1.2);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // Multi-pages (PDF)
  const [currentPage, setCurrentPage] = useState(0); // 0-based
  const [pageCount, setPageCount] = useState(1);

  // Pro: sidebar page filter
  const [pageFilter, setPageFilter] = useState("");

  // ✅ toggle only pages with polygons (persisted)
  const [onlyWithPolys, setOnlyWithPolys] = useState<boolean>(() => readBool(PAGES_ONLY_WITH_POLYS_KEY, false));
  useEffect(() => {
    writeBool(PAGES_ONLY_WITH_POLYS_KEY, onlyWithPolys);
  }, [onlyWithPolys]);

  const [snapUi, setSnapUi] = useState<boolean>(() => readSnapFromStorage());
  const [gridEnabled, setGridEnabled] = useState<boolean>(() => readGridEnabled());
  const [gridSizePx, setGridSizePx] = useState<number>(() => readGridSizePx());
  const [uiZoom, setUiZoom] = useState<number>(() => readUiZoom());

  useEffect(() => {
    writeUiZoom(uiZoom);
  }, [uiZoom]);

  const [overlayRequest, setOverlayRequest] = useState<OverlayRequest>({ kind: "none" });

  // services with stable uid
  const [services, setServices] = useState<ServiceEntry[]>(() => {
    const raw = readServiceColorsRaw();
    return raw.map((s) => ({ ...s, uid: makeUid() }));
  });

  useEffect(() => {
    writeServiceColorsRaw(services.map(({ uid: _uid, ...rest }) => rest));
  }, [services]);

  // Settings inputs
  const [newServiceName, setNewServiceName] = useState("");
  const [newServiceColor, setNewServiceColor] = useState<string>("#aab4c2");
  const [newServiceColorTouched, setNewServiceColorTouched] = useState(false);

  // Initial load
  useEffect(() => {
    api.getRooms().then((r) => {
      const withLocks = applyLockOverridesToRooms(r);
      setRooms((prev) => mergeRoomsPreserveLocks(prev, withLocks));

      const used = new Set(withLocks.map((x) => (x.service ?? "").trim()).filter((s) => s.length > 0));
      if (used.size) {
        setServices((prev) => {
          const map = new Map<string, ServiceEntry>();
          for (const s of prev) {
            const name = normalizeServiceName(s.service);
            if (!name) continue;
            map.set(serviceKey(name), { ...s, service: name, color: sanitizeServiceColor(name, s.color) });
          }
          let changed = false;
          for (const u of used) {
            const name = normalizeServiceName(u);
            const key = serviceKey(name);
            if (!map.has(key)) {
              map.set(key, { uid: makeUid(), service: name, color: defaultColorForService(name) });
              changed = true;
            }
          }
          const next = sortServicesStable(Array.from(map.values()));
          return changed ? next : prev;
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRoom = useMemo(() => rooms.find((r) => r.id === selectedRoomId) ?? null, [rooms, selectedRoomId]);
  const detailsRoom = useMemo(() => rooms.find((r) => r.id === detailsRoomId) ?? null, [rooms, detailsRoomId]);

  // Clamp current page when pageCount changes
  useEffect(() => {
    setCurrentPage((p) => Math.max(0, Math.min(p, Math.max(1, pageCount) - 1)));
  }, [pageCount]);

  // Sidebar-only page selection indicators (dot + badge)
  const pagesPolyStats = useMemo(() => {
    const map = new Map<number, number>(); // page -> count of polygons on that page
    for (const r of rooms as any[]) {
      const pages = roomPagesWithPolygons(r);
      for (const p of pages) map.set(p, (map.get(p) ?? 0) + 1);
    }
    return map;
  }, [rooms]);

  const pagesWithPolygons = useMemo(() => new Set<number>(pagesPolyStats.keys()), [pagesPolyStats]);

  const lockedRoomIdsOnPage = useMemo(() => {
    const s = new Set<string>();
    for (const r of rooms as any[]) {
      if (roomPolygonLockedOnPage(r, currentPage)) s.add(r.id);
    }
    return s;
  }, [rooms, currentPage]);

  // Visible pages according to filter + toggle "only with polys"
  const visiblePages = useMemo(() => {
    const total = Math.max(1, pageCount);
    const parsed = parsePageFilter(pageFilter, total);

    let base: number[];
    if (parsed) base = parsed;
    else {
      const q = pageFilter.trim();
      if (!q) base = Array.from({ length: total }, (_, p) => p);
      else {
        const out: number[] = [];
        for (let p = 0; p < total; p++) {
          const s = String(p + 1);
          if (s.includes(q)) out.push(p);
        }
        base = out;
      }
    }

    if (!onlyWithPolys) return base;
    return base.filter((p) => pagesWithPolygons.has(p));
  }, [pageCount, pageFilter, onlyWithPolys, pagesWithPolygons]);

  function goToPageIndex(nextIndex: number) {
    const total = Math.max(1, pageCount);
    const clamped = Math.max(0, Math.min(total - 1, nextIndex));

    setCurrentPage(clamped);

    // Important UX: stop drawing when page changes
    setDrawingRoomId(null);
    setOverlayRequest({ kind: "none" });
    setDrawSessionId((x) => x + 1);
  }

  function goPrevPage() {
    goToPageIndex(currentPage - 1);
  }
  function goNextPage() {
    goToPageIndex(currentPage + 1);
  }

  // If toggle hides the current page, jump to first visible (when possible)
  useEffect(() => {
    if (pageView !== "plans") return;
    if (!onlyWithPolys) return;
    if (pagesWithPolygons.has(currentPage)) return;

    const next = visiblePages[0];
    if (typeof next === "number") goToPageIndex(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyWithPolys, pageView, pagesWithPolygons, currentPage]);

  // Keyboard: PageUp/PageDown/Home/End for PDF pages (only in Plans)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (pageView !== "plans") return;
      if (isTypingTarget(e.target)) return;

      if (e.key === "PageUp") {
        e.preventDefault();
        goPrevPage();
        return;
      }
      if (e.key === "PageDown") {
        e.preventDefault();
        goNextPage();
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        goToPageIndex(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        goToPageIndex(Math.max(1, pageCount) - 1);
        return;
      }

      // Focus filter with Ctrl/Cmd+F inside Plans
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        const el = document.getElementById("sidebar-page-filter") as HTMLInputElement | null;
        el?.focus();
        el?.select?.();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pageView, currentPage, pageCount]);
  // Commit polygon (page-aware) with optimistic local update.
  async function commitPolygon(roomId: string, page: number, poly: Point[]) {
    const currentRoom = roomsRef.current.find((r: any) => r.id === roomId);
    if (currentRoom && roomHasPolygonOnOtherPage(currentRoom, page)) {
      setDrawingRoomId(null);
      setDrawSessionId((x) => x + 1);
      return;
    }
    // Optimistic update: keep existing locked flag for this page if present.
    setRooms((prev) =>
      prev.map((r: any) => {
        if (r.id !== roomId) return r;

        const next: any = { ...r };

        // Legacy fields (kept for compatibility)
        next.page = page;
        next.polygon = poly;

        if (Array.isArray(r.polygons)) {
          const existing = r.polygons.find(
            (x: any) => (typeof x?.page === "number" ? x.page : undefined) === page
          );
          const locked = !!existing?.locked;

          const others = r.polygons.filter(
            (x: any) => (typeof x?.page === "number" ? x.page : undefined) !== page
          );

          if (Array.isArray(poly) && poly.length >= 3) {
            next.polygons = [...others, { page, polygon: poly, locked }];
          } else {
            // deletion: remove entry for this page
            next.polygons = others;
          }
        }

        return next;
      })
    );

    // Reset draw UI state after commit attempt (prevents stale draw mode)
    const wasDrawing = drawingRoomId !== null;
    setDrawingRoomId(null);
    if (wasDrawing) setDrawSessionId((x) => x + 1);

    try {
      const saved = await api.updatePolygon(roomId, { page, polygon: poly }); // page obligatoire (0-based)
      const savedWithLock = applyLockOverridesToRooms([saved])[0];
      setRooms((prev) => prev.map((r: any) => (r.id === savedWithLock.id ? mergeRoomPreserveLocks(r, savedWithLock) : r)));
    } catch (e) {
      const refreshed = await api.getRooms();
      setRooms((prev) => mergeRoomsPreserveLocks(prev, applyLockOverridesToRooms(refreshed)));
      throw e;
    }
  }

  async function togglePolygonLock(roomId: string, page: number) {
    const current = roomsRef.current.find((r: any) => r.id === roomId);
    if (!current) return;

    const hasPoly = roomHasPolygonOnPage(current as any, page);
    if (!hasPoly) return;

    const nextRoom: any = { ...current };

    const polygons: any[] = Array.isArray(current.polygons) ? current.polygons.map((x: any) => ({ ...x })) : [];
    if (polygons.length === 0) {
      const legacyPage = typeof current.page === "number" ? current.page : 0;
      const legacyPoly = Array.isArray(current.polygon) ? current.polygon : [];
      if (legacyPoly.length >= 3) polygons.push({ page: legacyPage, polygon: legacyPoly, locked: false });
    }

    const idx = polygons.findIndex((x: any) => {
      const entryPage = typeof x?.page === "number" ? x.page : typeof x?.pageIndex === "number" ? x.pageIndex : undefined;
      return entryPage === page;
    });
    if (idx < 0) return;

    const lockedNow = roomPolygonLockedOnPage(current as any, page);
    polygons[idx] = { ...polygons[idx], locked: !lockedNow };
    setLockOverride(roomId, page, !lockedNow);
    nextRoom.polygons = polygons;

    setRooms((prev) => prev.map((r: any) => (r.id === roomId ? nextRoom : r)));

    try {
      const saved = await api.updateRoom(nextRoom);
      // Backend may ignore "locked": re-apply local override to the saved payload.
      const savedWithLock = applyLockOverridesToRooms([saved])[0];
      setRooms((prev) => prev.map((r: any) => (r.id === savedWithLock.id ? mergeRoomPreserveLocks(r, savedWithLock) : r)));
    } catch (e) {
      const refreshed = await api.getRooms();
      setRooms((prev) => mergeRoomsPreserveLocks(prev, applyLockOverridesToRooms(refreshed)));
      throw e;
    }
  }
  // ---- Services actions ----
  function addService() {
    const name = normalizeServiceName(newServiceName);
    if (!name) return;

    const color = isHexColor(newServiceColor) ? newServiceColor : defaultColorForService(name);
    const key = serviceKey(name);

    setServices((prev) => {
      const map = new Map<string, ServiceEntry>();
      for (const s of prev) {
        const n = normalizeServiceName(s.service);
        if (!n) continue;
        map.set(serviceKey(n), { ...s, service: n, color: sanitizeServiceColor(n, s.color) });
      }
      const existing = map.get(key);
      if (existing) map.set(key, { ...existing, service: name, color: sanitizeServiceColor(name, color) });
      else map.set(key, { uid: makeUid(), service: name, color: sanitizeServiceColor(name, color) });

      return sortServicesStable(Array.from(map.values()));
    });

    setNewServiceName("");
    setNewServiceColor("#aab4c2");
    setNewServiceColorTouched(false);
  }

  function updateService(uid: string, patch: Partial<ServiceColor>) {
    setServices((prev) => {
      const idx = prev.findIndex((s) => s.uid === uid);
      if (idx < 0) return prev;
      const next = prev.slice();
      const cur = next[idx];

      const updated: ServiceEntry = {
        ...cur,
        service: patch.service != null ? patch.service : cur.service,
        color: patch.color != null ? patch.color : cur.color,
      };

      updated.service = patch.service != null ? patch.service : cur.service;
      updated.color = sanitizeServiceColor(updated.service || cur.service, updated.color);

      next[idx] = updated;
      return next;
    });
  }

  function normalizeAndSortServices() {
    setServices((prev) => {
      const map = new Map<string, ServiceEntry>();
      for (const s of prev) {
        const name = normalizeServiceName(s.service);
        if (!name) continue;
        const key = serviceKey(name);
        const existing = map.get(key);
        if (!existing) map.set(key, { ...s, service: name, color: sanitizeServiceColor(name, s.color) });
        else map.set(key, { ...existing, service: name, color: sanitizeServiceColor(name, existing.color) });
      }
      return sortServicesStable(Array.from(map.values()));
    });
  }

  function removeService(uid: string) {
    setServices((prev) => prev.filter((s) => s.uid !== uid));
  }

  function seedServicesFromRooms() {
    const used = new Set(rooms.map((x) => (x.service ?? "").trim()).filter((s) => s.length > 0));
    if (!used.size) return;

    setServices((prev) => {
      const map = new Map<string, ServiceEntry>();
      for (const s of prev) {
        const name = normalizeServiceName(s.service);
        if (!name) continue;
        map.set(serviceKey(name), { ...s, service: name, color: sanitizeServiceColor(name, s.color) });
      }

      let changed = false;
      for (const u of used) {
        const name = normalizeServiceName(u);
        const key = serviceKey(name);
        if (!map.has(key)) {
          map.set(key, { uid: makeUid(), service: name, color: defaultColorForService(name) });
          changed = true;
        }
      }

      const next = sortServicesStable(Array.from(map.values()));
      return changed ? next : prev;
    });
  }

  function resetServices() {
    setServices([]);
  }
  // ----

  // Sync Snap UI when shortcut used (S)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "s") return;
      if (isTypingTarget(e.target)) return;
      setTimeout(() => setSnapUi(readSnapFromStorage()), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Sync Snap UI when button toggles (custom event)
  useEffect(() => {
    const onToggle = () => setTimeout(() => setSnapUi(readSnapFromStorage()), 0);
    window.addEventListener(SNAP_TOGGLE_EVENT, onToggle as EventListener);
    return () => window.removeEventListener(SNAP_TOGGLE_EVENT, onToggle as EventListener);
  }, []);

  function toggleSnapFromButton() {
    window.dispatchEvent(new CustomEvent(SNAP_TOGGLE_EVENT));
    setTimeout(() => setSnapUi(readSnapFromStorage()), 0);
  }

  function toggleGridFromButton() {
    setGridEnabled((prev) => {
      const next = !prev;
      writeGridEnabled(next);
      return next;
    });
  }

  // Global zoom shortcuts: '+' and '-'
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setScale((s) => clampScale(s + 0.1));
        return;
      }

      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setScale((s) => clampScale(s - 0.1));
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedLocked = adminMode && !!selectedRoomId && roomPolygonLockedOnPage(selectedRoom as any, currentPage);

  const canDeletePolygon = adminMode && !!selectedRoomId && roomHasPolygonOnPage(selectedRoom as any, currentPage) && !selectedLocked;
  const overlayReady = isValidSize(size.w) && isValidSize(size.h);

  return (
    <div className="dash-root">
      {/* BODY */}
      <div className={`dash-body ${pageView === "plans" ? "dash-body--floating-panels" : ""}`}>
        {/* SIDEBAR */}
        <aside className="dash-sidebar ui-zoom" style={{ ["--ui-zoom" as any]: uiZoom }}>
          <div className="nav-title">Navigation</div>

          <button className={`nav-item ${pageView === "dashboard" ? "nav-item-active" : ""}`} onClick={() => setPageView("dashboard")} type="button">
            <span className="nav-icon" aria-hidden="true">
              ⌂
            </span>
            Tableau de bord
          </button>

          <button className={`nav-item ${pageView === "plans" ? "nav-item-active" : ""}`} onClick={() => setPageView("plans")} type="button">
            <span className="nav-icon" aria-hidden="true">
              ▦
            </span>
            Plans
          </button>

          <button className={`nav-item ${pageView === "settings" ? "nav-item-active" : ""}`} onClick={() => setPageView("settings")} type="button">
            <span className="nav-icon" aria-hidden="true">
              ⛭
            </span>
            Paramètres
          </button>

          {/* Pages */}
          {pageView === "plans" && (
            <>
              <div className="nav-divider" />
              <div className="nav-title" style={{ marginTop: 10 }}>
                Pages
              </div>

              <div className="sidebar-pages-tools">
                <input
                  id="sidebar-page-filter"
                  className="sidebar-page-filter"
                  placeholder="Filtrer : 12 | 1-8 | 1,3,10 | ou “2”…"
                  value={pageFilter}
                  onChange={(e) => setPageFilter(e.target.value)}
                  spellCheck={false}
                />
                {!!pageFilter.trim() && (
                  <button className="sidebar-clear" type="button" onClick={() => setPageFilter("")} title="Effacer">
                    ✕
                  </button>
                )}
              </div>

              <label className="mini-switch" title="N’afficher que les pages qui ont des polygones">
                <input type="checkbox" checked={onlyWithPolys} onChange={(e) => setOnlyWithPolys(e.target.checked)} />
                <span className="mini-switch-track" />
                <span className="mini-switch-text">Polygones uniquement</span>
                </label>

              <div className="sidebar-pages">
                {visiblePages.length === 0 ? (
                  <div className="sidebar-empty">Aucune page</div>
                ) : (
                  visiblePages.map((p) => {
                    const active = p === currentPage;
                    const hasPoly = pagesWithPolygons.has(p);
                    const polyCount = pagesPolyStats.get(p) ?? 0;

                    return (
                      <button
                        key={`side-p-${p}`}
                        type="button"
                        className={`sidebar-page-item ${active ? "sidebar-page-item-active" : ""}`}
                        onClick={() => goToPageIndex(p)}
                        title={hasPoly ? `Page ${p + 1} (${polyCount} polygone(s))` : `Page ${p + 1}`}
                      >
                        <span className="sidebar-page-left">
                          <span className="sidebar-page-num">{p + 1}</span>
                          {hasPoly && <span className="sidebar-page-dot" aria-hidden="true" />}
                        </span>

                        {hasPoly && <span className="sidebar-page-badge">{polyCount}</span>}
                      </button>
                    );
                  })
                )}
              </div>

            </>
          )}

          <div className="spacer" />

          <div className="help-card">
            <div className="help-title">Raccourcis</div>
            <div className="help-text">
              <b>S</b> Snap • <b>+</b>/<b>-</b> Zoom • <b>Shift</b> orthogonal
              <br />
              <b>Alt+clic</b> insérer • <b>Delete</b> supprimer sommet
              <br />
              <b>Ctrl/⌘</b> drag = déplacer polygone
              <br />
              <b>PageUp/PageDown</b> pages • <b>Home/End</b> début/fin
            </div>
          </div>
        </aside>

        {/* MAIN */}
        {pageView === "dashboard" && (
          <main className="dash-main">
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Tableau de bord</div>
                  <div className="card-subtitle">Accueil</div>
                </div>
              </div>
              <div className="card-content">
                <div className="hint">
                  L’éditeur est dans <b>Plans</b>.
                </div>
              </div>
            </div>
          </main>
        )}

        {/* SETTINGS */}
        {pageView === "settings" && (
          <main className="dash-main">
            <div className="settings-main-panel">
              <div className="settings-main-header">
                <div className="card-title">Paramètres</div>
                <div className="card-subtitle"></div>
              </div>

              <div className="settings-panels">
                <section className="card settings-card settings-service-card">
                  <div className="card-header">
                    <div>
                      <div className="card-title">Paramètres de services</div>
                      <div className="card-subtitle"></div>
                    </div>
                  </div>

                  <div className="card-content">
                    <div className="field">
                      <label className="label">Ajouter un service</label>
                      <div className="settings-row">
                        <input
                          className="select"
                          placeholder="Nom"
                          value={newServiceName}
                          onChange={(e) => {
                            const v = e.target.value;
                            setNewServiceName(v);
                            if (!newServiceColorTouched) setNewServiceColor(defaultColorForService(v || "Service"));
                          }}
                        />

                        <div className="color-cell">
                          <input
                            className="color-input"
                            type="color"
                            value={isHexColor(newServiceColor) ? newServiceColor : "#aab4c2"}
                            onChange={(e) => {
                              setNewServiceColorTouched(true);
                              setNewServiceColor(e.target.value);
                            }}
                            aria-label="Couleur"
                            title="Choisir une couleur"
                          />
                          <span className="color-hex">{(isHexColor(newServiceColor) ? newServiceColor : "#aab4c2").toUpperCase()}</span>
                        </div>

                        <button className="btn btn-mini" type="button" onClick={addService}>
                          Ajouter
                        </button>
                      </div>

                      </div>

                  </div>
                </section>

                <section className="card settings-card settings-service-list-card">
                  <div className="card-header">
                    <div>
                      <div className="card-title">Services ({services.length})</div>
                      <div className="card-subtitle"></div>
                    </div>

                    <div className="settings-actions">
                      <button className="btn btn-mini" type="button" onClick={seedServicesFromRooms} title="Ajoute les services présents dans les pièces">
                        Remplissage depuis pièces
                      </button>
                      <button className="btn btn-mini" type="button" onClick={resetServices} title="Vide la palette">
                        Vider
                      </button>
                    </div>
                  </div>

                  <div className="card-content">
                    {services.length === 0 ? (
                      <div className="hint">Aucun service défini.</div>
                    ) : (
                      <div className="service-list">
                        {services.map((s) => (
                          <div className="service-row" key={s.uid}>
                            <div className="swatch" style={{ background: sanitizeServiceColor(s.service, s.color) }} />

                            <input className="select" value={s.service} onChange={(e) => updateService(s.uid, { service: e.target.value })} onBlur={() => normalizeAndSortServices()} />

                            <div className="color-cell">
                              <input
                                className="color-input"
                                type="color"
                                value={sanitizeServiceColor(s.service, s.color)}
                                onChange={(e) => updateService(s.uid, { color: e.target.value })}
                                aria-label={`Couleur ${s.service}`}
                                title="Choisir une couleur"
                              />
                              <span className="color-hex">{sanitizeServiceColor(s.service, s.color).toUpperCase()}</span>
                            </div>

                            <button className="btn btn-mini" type="button" onClick={() => removeService(s.uid)}>
                              Suppr.
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    
                  </div>
                </section>
              </div>
            </div>
          </main>
        )}

        {/* PLANS */}
        {pageView === "plans" && (
          <main className="dash-main">
            <div className="card plan-card">
              <div className="card-content plan-content">
                <div className="plan-controls">
                  <div className="plan-controls-row">
                    <div className="plan-toolbar-group">
                      <button className="btn btn-icon btn-mini" title="Page précédente (PageUp)" type="button" onClick={() => goToPageIndex(currentPage - 1)} disabled={currentPage <= 0}>
                        ◀
                      </button>

                      <span className="meta-chip">
                        Page {Math.min(pageCount, currentPage + 1)} / {pageCount}
                      </span>

                      <button
                        className="btn btn-icon btn-mini"
                        title="Page suivante (PageDown)"
                        type="button"
                        onClick={() => goToPageIndex(currentPage + 1)}
                        disabled={currentPage >= Math.max(1, pageCount) - 1}
                      >
                        ▶
                      </button>
                    </div>

                    <div className="plan-field-inline plan-field-compact plan-subbar-field">
                      <span className="plan-field-label">Espace UI</span>
                      <input
                        className="select plan-number plan-number-compact"
                        type="number"
                        min={UI_ZOOM_MIN}
                        max={UI_ZOOM_MAX}
                        step={0.01}
                        value={uiZoom}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (!Number.isFinite(n)) return;
                          setUiZoom(clampUiZoom(n));
                        }}
                      />
                    </div>

                    <div className="plan-toolbar-group">
                      <div className="plan-field-inline plan-field-compact" title="Taille de grille (px)">
                        <label className="switch switch-compact plan-field-label" title="Afficher/masquer la grille">
                          <input type="checkbox" checked={gridEnabled} onChange={toggleGridFromButton} />
                          <span className="switch-track" />
                          <span className="switch-label">Grille</span>
                        </label>
                        <input
                          className="select plan-number plan-number-compact"
                          type="number"
                          min={4}
                          max={200}
                          step={1}
                          value={gridSizePx}
                          onChange={(e) => {
                            const n = Math.min(200, Math.max(4, Math.round(Number(e.target.value) || 0)));
                            setGridSizePx(n);
                            writeGridSizePx(n);
                          }}
                        />
                      </div>

                      <div className="plan-zoom-group">
                        <button className="btn btn-icon btn-mini" type="button" onClick={() => setScale((s) => clampScale(s - 0.1))} title="Zoom - (-)">
                          −
                        </button>
                        <span className="meta-chip">Zoom x{scale.toFixed(2)}</span>
                        <button className="btn btn-icon btn-mini" type="button" onClick={() => setScale((s) => clampScale(s + 0.1))} title="Zoom + (+)">
                          +
                        </button>
                      </div>
                    </div>

                    {adminMode && (
                      <div className="plan-toolbar-group">
                        <div className="plan-field-inline plan-field-compact" style={{ minWidth: 240 }}>
                          <span className="plan-field-label">Dessiner</span>
                          <select
                            className="select"
                            value={drawingRoomId ?? ""}
                            onChange={(e) => {
                              setDrawingRoomId(e.target.value || null);
                              setDrawSessionId((x) => x + 1);
                            }}
                          >
                            <option value="">— Dessiner un polygone pour… —</option>
                            {rooms.map((r: any) => {
                              const already = roomHasPolygonOnPage(r, currentPage);
                              const hasOtherPage = roomHasPolygonOnOtherPage(r, currentPage);
                              const disabled = already || hasOtherPage;
                              return (
                                <option key={r.id} value={r.id} disabled={disabled}>
                                  {r.numero}{" "}
                                  {already ? " — déjà défini (page)" : hasOtherPage ? " — déjà défini (autre page)" : ""}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                      </div>
                    )}

                    <div className="plan-header-right">
                      <label className="switch switch-compact" title="Snap (S)">
                        <input type="checkbox" checked={snapUi} onChange={toggleSnapFromButton} />
                        <span className="switch-track" />
                        <span className="switch-label">Snap</span>
                      </label>

                      <label className="switch switch-compact" title="Activer/désactiver l’édition">
                        <input
                          type="checkbox"
                          checked={adminMode}
                          onChange={(e) => {
                            setAdminMode(e.target.checked);
                            setDrawingRoomId(null);
                            setDrawSessionId((x) => x + 1);
                          }}
                        />
                        <span className="switch-track" />
                        <span className="switch-label">Admin</span>
                      </label>
                    </div>
                  </div>

                  <div className="plan-toolbar">
                    <div className="plan-toolbar-row">
                      <div className="plan-toolbar-group">
                        <button
                          className="btn btn-mini"
                          type="button"
                          disabled={!canDeletePolygon}
                          onClick={() => {
                            if (!selectedRoomId) return;
                            setOverlayRequest({ kind: "deletePolygon", roomId: selectedRoomId });
                          }}
                          title={!canDeletePolygon ? "Aucun polygone sur cette page pour la pièce sélectionnée" : "Supprimer le polygone (page courante)"}
                        >
                          Suppr. polygone
                        </button>

                        <button
                          className="btn btn-mini"
                          type="button"
                          onClick={() => {
                            if (!selectedRoomId) return;
                            togglePolygonLock(selectedRoomId, currentPage);
                          }}
                          disabled={!adminMode || !selectedRoomId || !roomHasPolygonOnPage(selectedRoom as any, currentPage)}
                          title={
                            !adminMode || !selectedRoomId || !roomHasPolygonOnPage(selectedRoom as any, currentPage)
                              ? "Aucun polygone sur cette page pour la pièce sélectionnée"
                              : selectedLocked
                                ? "Déverrouiller le polygone (page courante)"
                                : "Verrouiller le polygone (page courante)"
                          }
                        >
                          {selectedLocked ? "Déverrouiller" : "Verrouiller"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="plan-viewport">
                  <div className="plan-stage">
                    <div className="plan-layer">
                      <PdfCanvas
                        pdfUrl="/Pour CHATGPT.pdf"
                        scale={scale}
                        page={currentPage + 1}
                        onPageCount={setPageCount}
                        onSize={(w, h) => {
                          if (!isValidSize(w) || !isValidSize(h)) return;
                          setSize({ w, h });
                        }}
                      />

                      {overlayReady && (
                        <SvgOverlay
                          width={size.w}
                          height={size.h}
                          page={currentPage}
                          rooms={rooms}
                          services={services.map(({ uid: _uid, ...rest }) => rest)}
                          selectedRoomId={selectedRoomId}
                          onSelectRoom={(roomId) => {
                            setSelectedRoomId(roomId);
                            setDetailsRoomId((prev) => (roomId && prev === roomId ? prev : null));
                          }}
                          onPolygonDoubleClick={(roomId) => {
                            setSelectedRoomId(roomId);
                            setDetailsRoomId(roomId);
                          }}
                          adminMode={adminMode}
                          drawingRoomId={drawingRoomId}
                          drawSessionId={drawSessionId}
                          onPolygonCommit={(roomId, poly) => commitPolygon(roomId, currentPage, poly)}
                          request={overlayRequest}
                          onRequestHandled={() => setOverlayRequest({ kind: "none" })}
                          gridEnabled={gridEnabled}
                          gridSizePx={gridSizePx}
                          lockedRoomIdsOnPage={lockedRoomIdsOnPage}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </main>
        )}

        {pageView === "plans" && (
          <>
            <DraggableWindow storageKey="iface.panel.rooms" defaultPosition={{ x: 88, y: 86 }} width={360}>
              <div className="card plan-card">
                <div className="card-header">
                  <div>
                    <div className="card-title">Pièces</div>
                  </div>
                </div>
                <div className="card-content card-scroll" style={{ maxHeight: "min(72vh, 760px)" }}>
                  <RoomListPanel
                    rooms={rooms}
                    selectedRoomId={selectedRoomId}
                    onSelectRoom={(roomId) => {
                      setSelectedRoomId(roomId);
                      setDetailsRoomId((prev) => (prev === roomId ? prev : null));
                    }}
                    onOpenDetails={(roomId) => {
                      setSelectedRoomId(roomId);
                      setDetailsRoomId(roomId);
                    }}
                  />
                </div>
              </div>
            </DraggableWindow>

            {detailsRoom && (
              <DraggableWindow
                storageKey="iface.panel.details"
                defaultPosition={{ x: 470, y: 86 }}
                width={360}
                collapsible={false}
              >
                <div className="card plan-card">
                  <div className="card-content card-scroll" style={{ maxHeight: "min(72vh, 760px)" }}>
                    <RoomDetailsPanel
                      ref={detailsPanelRef}
                      room={detailsRoom}
                      services={services.map(({ uid: _uid, ...rest }) => rest)}
                      onSave={async (room) => {
                        const saved = await api.updateRoom(room);
                        setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
                        setSelectedRoomId(null);
                        setDetailsRoomId(null);
                      }}
                      onUploadPhoto={async (roomId, file) => {
                        const saved = await api.uploadPhoto(roomId, file);
                        setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
                      }}
                    />
                  </div>
                </div>
              </DraggableWindow>
            )}
          </>
        )}
      </div>
    </div>
  );
}
