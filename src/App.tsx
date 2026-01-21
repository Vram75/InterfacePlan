import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import "./App.css";

import { PdfCanvas } from "./components/PdfCanvas";
import { SvgOverlay } from "./components/SvgOverlay";
import type { OverlayRequest } from "./components/SvgOverlay";

import { RoomListPanel } from "./components/RoomListPanel";
import { RoomDetailsPanel } from "./components/RoomDetailsPanel";

import { api } from "./api";
import type { Room, Point, ServiceColor } from "./types";

const SNAP_STORAGE_KEY = "iface.snapEnabled";
const SNAP_TOGGLE_EVENT = "iface:snap-toggle";

const GRID_ENABLED_KEY = "iface.gridEnabled";
const GRID_SIZE_KEY = "iface.gridSizePx";

const SERVICE_COLORS_KEY = "iface.serviceColors.v1";

type PageView = "dashboard" | "plans" | "settings";
type PanelId = "plan" | "rooms" | "details";

type PanelState = {
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
};

function safeParse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
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

function readGridEnabled(): boolean {
  try {
    const v = localStorage.getItem(GRID_ENABLED_KEY);
    if (v == null) return false;
    const s = String(v).trim().toLowerCase();
    return !(s === "0" || s === "false" || s === "off" || s === "no");
  } catch {
    return false;
  }
}

function writeGridEnabled(v: boolean) {
  try {
    localStorage.setItem(GRID_ENABLED_KEY, v ? "1" : "0");
  } catch {}
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

/** 1 pièce = 1 polygone par page */
function roomHasPolygonOnPage(room: any, pageIndex: number): boolean {
  if (!room) return false;
  const page = typeof room.page === "number" && Number.isFinite(room.page) ? room.page : 0;
  if (page !== pageIndex) return false;

  const p = room.polygon;
  if (!p) return false;
  if (Array.isArray(p)) return p.length >= 3;
  if (Array.isArray(p?.polygon)) return p.polygon.length >= 3;
  return false;
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
function sortServices(list: ServiceColor[]) {
  return [...list].sort((a, b) => a.service.localeCompare(b.service, "fr"));
}
function readServiceColors(): ServiceColor[] {
  const parsed = safeParse<ServiceColor[]>(localStorage.getItem(SERVICE_COLORS_KEY));
  if (!parsed || !Array.isArray(parsed)) return [];
  const map = new Map<string, ServiceColor>();
  for (const x of parsed) {
    if (!x || typeof x.service !== "string") continue;
    const name = normalizeServiceName(x.service);
    if (!name) continue;
    map.set(serviceKey(name), { service: name, color: sanitizeServiceColor(name, (x as any).color) });
  }
  return sortServices(Array.from(map.values()));
}
function writeServiceColors(v: ServiceColor[]) {
  try {
    localStorage.setItem(SERVICE_COLORS_KEY, JSON.stringify(v));
  } catch {}
}
// --------------------

export default function App() {
  const [pageView, setPageView] = useState<PageView>("dashboard");
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{ id: PanelId; offsetX: number; offsetY: number } | null>(null);
  const resizeState = useRef<{ id: PanelId; startX: number; startY: number; startWidth: number; startHeight: number } | null>(null);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  const [adminMode, setAdminMode] = useState(true);
  const [drawingRoomId, setDrawingRoomId] = useState<string | null>(null);
  const [drawSessionId, setDrawSessionId] = useState(0);

  const [scale, setScale] = useState(1.2);
  const [size, setSize] = useState({ w: 800, h: 600 });

  const [currentPage, setCurrentPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);

  const [snapUi, setSnapUi] = useState<boolean>(() => readSnapFromStorage());
  const [gridEnabled, setGridEnabled] = useState<boolean>(() => readGridEnabled());
  const [gridSizePx, setGridSizePx] = useState<number>(() => readGridSizePx());

  const [overlayRequest, setOverlayRequest] = useState<OverlayRequest>({ kind: "none" });

  // ✅ services palette (never undefined)
  const [services, setServices] = useState<ServiceColor[]>(() => readServiceColors());
  useEffect(() => writeServiceColors(services), [services]);

  // Settings inputs
  const [newServiceName, setNewServiceName] = useState("");
  const [newServiceColor, setNewServiceColor] = useState<string>("#aab4c2");
  const [newServiceColorTouched, setNewServiceColorTouched] = useState(false);

  const [panelState, setPanelState] = useState<Record<PanelId, PanelState>>(() => {
    const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
    return {
      plan: {
        x: 32,
        y: 24,
        width: Math.min(1100, Math.round(viewportWidth * 0.7)),
        height: Math.min(780, Math.round(viewportHeight * 0.78)),
        collapsed: false,
      },
      rooms: { x: 860, y: 24, width: 360, height: 420, collapsed: false },
      details: { x: 860, y: 380, width: 360, height: 420, collapsed: false },
    };
  });
  const [panelZ, setPanelZ] = useState<Record<PanelId, number>>({
    plan: 1,
    rooms: 2,
    details: 3,
  });

  useEffect(() => {
    api.getRooms().then((r) => {
      setRooms(r);
      if (r.length && !selectedRoomId) setSelectedRoomId(r[0].id);

      // Seed services from rooms (non-destructive)
      const used = new Set(r.map((x) => (x.service ?? "").trim()).filter((s) => s.length > 0));
      if (used.size) {
        setServices((prev) => {
          const map = new Map(prev.map((p) => [serviceKey(p.service), { service: normalizeServiceName(p.service), color: sanitizeServiceColor(p.service, p.color) }]));
          let changed = false;
          for (const s of used) {
            const name = normalizeServiceName(s);
            const key = serviceKey(name);
            if (!map.has(key)) {
              map.set(key, { service: name, color: defaultColorForService(name) });
              changed = true;
            }
          }
          const next = sortServices(Array.from(map.values()));
          return changed ? next : prev;
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRoom = useMemo(() => rooms.find((r) => r.id === selectedRoomId) ?? null, [rooms, selectedRoomId]);

  useEffect(() => {
    setCurrentPage((p) => Math.max(0, Math.min(p, Math.max(1, pageCount) - 1)));
  }, [pageCount]);

  async function commitPolygon(roomId: string, page: number, poly: Point[]) {
    const saved = await api.updatePolygon(roomId, { page, polygon: poly });
    setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
  }

  async function handleSaveRoom(room: Room) {
    const saved = await api.updateRoom(room);
    setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
  }

  async function handleUploadPhoto(roomId: string, file: File) {
    const saved = await api.uploadPhoto(roomId, file);
    setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
  }

  // ---- Services UI actions
  function addService() {
    const name = normalizeServiceName(newServiceName);
    if (!name) return;

    const color = isHexColor(newServiceColor) ? newServiceColor : defaultColorForService(name);
    const key = serviceKey(name);

    setServices((prev) => {
      const map = new Map<string, ServiceColor>();
      for (const s of prev) {
        const n = normalizeServiceName(s.service);
        if (!n) continue;
        map.set(serviceKey(n), { service: n, color: sanitizeServiceColor(n, s.color) });
      }
      map.set(key, { service: name, color });
      return sortServices(Array.from(map.values()));
    });

    setNewServiceName("");
    setNewServiceColor("#aab4c2");
    setNewServiceColorTouched(false);
  }

  function updateService(index: number, patch: Partial<ServiceColor>) {
    setServices((prev) => {
      const next = prev.slice();
      const cur = next[index];
      if (!cur) return prev;

      const updated: ServiceColor = {
        service: patch.service != null ? patch.service : cur.service,
        color: patch.color != null ? patch.color : cur.color,
      };

      updated.service = normalizeServiceName(updated.service);
      updated.color = sanitizeServiceColor(updated.service || cur.service, updated.color);

      next[index] = updated;

      const map = new Map<string, ServiceColor>();
      for (const s of next) {
        const name = normalizeServiceName(s.service);
        if (!name) continue;
        map.set(serviceKey(name), { service: name, color: sanitizeServiceColor(name, s.color) });
      }
      return sortServices(Array.from(map.values()));
    });
  }

  function removeService(index: number) {
    setServices((prev) => prev.filter((_, i) => i !== index));
  }

  function seedServicesFromRooms() {
    const used = new Set(rooms.map((x) => (x.service ?? "").trim()).filter((s) => s.length > 0));
    if (!used.size) return;

    setServices((prev) => {
      const map = new Map(prev.map((p) => [serviceKey(p.service), { service: normalizeServiceName(p.service), color: sanitizeServiceColor(p.service, p.color) }]));
      let changed = false;
      for (const s of used) {
        const name = normalizeServiceName(s);
        const k = serviceKey(name);
        if (!map.has(k)) {
          map.set(k, { service: name, color: defaultColorForService(name) });
          changed = true;
        }
      }
      return changed ? sortServices(Array.from(map.values())) : prev;
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

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (resizeState.current && workspaceRef.current) {
        const { id, startX, startY, startWidth, startHeight } = resizeState.current;
        const bounds = workspaceRef.current.getBoundingClientRect();
        const minSizes: Record<PanelId, { width: number; height: number }> = {
          plan: { width: 520, height: 360 },
          rooms: { width: 280, height: 220 },
          details: { width: 280, height: 220 },
        };
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        setPanelState((prev) => {
          const panel = prev[id];
          const min = minSizes[id];
          const maxWidth = Math.max(min.width, Math.floor(bounds.width - panel.x - 24));
          const maxHeight = Math.max(min.height, Math.floor(bounds.height - panel.y - 24));
          const nextWidth = Math.min(maxWidth, Math.max(min.width, Math.round(startWidth + deltaX)));
          const nextHeight = Math.min(maxHeight, Math.max(min.height, Math.round(startHeight + deltaY)));
          return {
            ...prev,
            [id]: { ...panel, width: nextWidth, height: nextHeight },
          };
        });
        return;
      }
      if (!dragState.current || !workspaceRef.current) return;
      const { id, offsetX, offsetY } = dragState.current;
      const bounds = workspaceRef.current.getBoundingClientRect();
      const padding = 12;
      const collapsedHeight = 64;
      setPanelState((prev) => {
        const panel = prev[id];
        const panelHeight = panel.collapsed ? collapsedHeight : panel.height;
        const maxX = Math.max(padding, Math.floor(bounds.width - panel.width - padding));
        const maxY = Math.max(padding, Math.floor(bounds.height - panelHeight - padding));
        const nextX = Math.min(maxX, Math.max(padding, e.clientX - bounds.left - offsetX));
        const nextY = Math.min(maxY, Math.max(padding, e.clientY - offsetY - bounds.top));
        return {
          ...prev,
          [id]: { ...panel, x: nextX, y: nextY },
        };
      });
    };

    const onUp = () => {
      dragState.current = null;
      resizeState.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const canDeletePolygon = adminMode && !!selectedRoomId && roomHasPolygonOnPage(selectedRoom as any, currentPage);
  const overlayReady = isValidSize(size.w) && isValidSize(size.h);

  function handlePanelMouseDown(id: PanelId, event: MouseEvent<HTMLDivElement>) {
    if (!workspaceRef.current) return;
    const panel = event.currentTarget.closest(".panel") as HTMLElement | null;
    if (!panel) return;
    const panelRect = panel.getBoundingClientRect();
    dragState.current = {
      id,
      offsetX: event.clientX - panelRect.left,
      offsetY: event.clientY - panelRect.top,
    };
    event.preventDefault();
    setPanelZ((prev) => {
      const max = Math.max(...Object.values(prev));
      return { ...prev, [id]: max + 1 };
    });
  }

  function handlePanelResizeMouseDown(id: PanelId, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    resizeState.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: panelState[id].width,
      startHeight: panelState[id].height,
    };
    setPanelZ((prev) => {
      const max = Math.max(...Object.values(prev));
      return { ...prev, [id]: max + 1 };
    });
  }

  function togglePanel(id: PanelId) {
    setPanelState((prev) => ({
      ...prev,
      [id]: { ...prev[id], collapsed: !prev[id].collapsed },
    }));
  }

  return (
    <div className="dash-root">
      <header className="dash-topbar">
        <div className="brand">
          <div className="brand-badge" aria-hidden="true">
            ▦
          </div>
          <div className="brand-text">
            <div className="brand-title">Interface</div>
            <div className="brand-subtitle">Plan d’étage • édition</div>
          </div>
        </div>

        <div className="dash-tabs" role="tablist" aria-label="Navigation principale">
          <button className={`tab ${pageView === "dashboard" ? "tab-active" : ""}`} onClick={() => setPageView("dashboard")} role="tab" type="button">
            Tableau de bord
          </button>
          <button className={`tab ${pageView === "plans" ? "tab-active" : ""}`} onClick={() => setPageView("plans")} role="tab" type="button">
            Plans
          </button>
          <button className={`tab ${pageView === "settings" ? "tab-active" : ""}`} onClick={() => setPageView("settings")} role="tab" type="button">
            Paramètres
          </button>
        </div>

        <div className="topbar-actions">
          <div className="search">
            <span className="search-icon" aria-hidden="true">
              ⌕
            </span>
            <input className="search-input" placeholder="Rechercher…" />
          </div>

          <div className="pill">{rooms.length} pièce(s)</div>
        </div>
      </header>

      <div className="dash-body">
        {pageView === "dashboard" && (
          <main className="dash-main">
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Dashboard</div>
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

        {/* ✅ Paramètres > Services restauré */}
        {pageView === "settings" && (
          <main className="dash-main">
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Paramètres</div>
                  <div className="card-subtitle">Services</div>
                </div>

                <div className="settings-actions">
                  <button className="btn btn-mini" type="button" onClick={seedServicesFromRooms} title="Ajoute les services présents dans les pièces">
                    Seed depuis pièces
                  </button>
                  <button className="btn btn-mini" type="button" onClick={resetServices} title="Vide la palette">
                    Vider
                  </button>
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

                  <div className="hint">Couleurs stockées en HEX (#RRGGBB). Pas de HSL.</div>
                </div>

                <div className="settings-divider" />

                <div className="settings-title">Services ({services.length})</div>

                {services.length === 0 ? (
                  <div className="hint">Aucun service défini.</div>
                ) : (
                  <div className="service-list">
                    {services.map((s, idx) => (
                      <div className="service-row" key={`${serviceKey(s.service)}-${idx}`}>
                        <div className="swatch" style={{ background: sanitizeServiceColor(s.service, s.color) }} />

                        <input className="select" value={s.service} onChange={(e) => updateService(idx, { service: e.target.value })} />

                        <div className="color-cell">
                          <input
                            className="color-input"
                            type="color"
                            value={sanitizeServiceColor(s.service, s.color)}
                            onChange={(e) => updateService(idx, { color: e.target.value })}
                            aria-label={`Couleur ${s.service}`}
                          />
                          <span className="color-hex">{sanitizeServiceColor(s.service, s.color).toUpperCase()}</span>
                        </div>

                        <button className="btn btn-mini" type="button" onClick={() => removeService(idx)}>
                          Suppr.
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="hint" style={{ marginTop: 12 }}>
                  Dans “Détails”, si une pièce n’a pas de service ou un service non présent ici, afficher <b>non attribué</b>.
                </div>
              </div>
            </div>
          </main>
        )}

        {pageView === "plans" && (
          <main className="dash-main">
            <div className="plans-workspace" ref={workspaceRef}>
              <section
                className="panel panel-plan"
                style={{
                  transform: `translate3d(${panelState.plan.x}px, ${panelState.plan.y}px, 0)`,
                  zIndex: panelZ.plan,
                  width: panelState.plan.width,
                  height: panelState.plan.collapsed ? undefined : panelState.plan.height,
                }}
                data-collapsed={panelState.plan.collapsed}
              >
                <div className="panel-header" onMouseDown={(e) => handlePanelMouseDown("plan", e)}>
                  <div>
                    <div className="card-title">Plan</div>
                    <div className="card-subtitle">PDF + overlay</div>
                  </div>

                  <div className="panel-actions">
                    <div className="card-meta">
                      <button
                        className="btn btn-icon"
                        title="Page précédente"
                        type="button"
                        onClick={() => {
                          setCurrentPage((p) => Math.max(0, p - 1));
                          setDrawingRoomId(null);
                          setOverlayRequest({ kind: "none" });
                          setDrawSessionId((x) => x + 1);
                        }}
                        disabled={currentPage <= 0}
                      >
                        ◀
                      </button>

                      <span className="meta-chip">
                        Page {Math.min(pageCount, currentPage + 1)} / {pageCount}
                      </span>

                      <button
                        className="btn btn-icon"
                        title="Page suivante"
                        type="button"
                        onClick={() => {
                          setCurrentPage((p) => Math.min(pageCount - 1, p + 1));
                          setDrawingRoomId(null);
                          setOverlayRequest({ kind: "none" });
                          setDrawSessionId((x) => x + 1);
                        }}
                        disabled={currentPage >= pageCount - 1}
                      >
                        ▶
                      </button>

                      <span className="meta-chip">Zoom x{scale.toFixed(2)}</span>
                      <span className="meta-chip">Sélection: {selectedRoom?.numero ?? "—"}</span>
                    </div>

                    <button
                      className="panel-toggle"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        togglePanel("plan");
                      }}
                      aria-expanded={!panelState.plan.collapsed}
                    >
                      {panelState.plan.collapsed ? "Déplier" : "Replier"}
                    </button>
                  </div>
                </div>

                {!panelState.plan.collapsed && (
                  <div className="panel-body">
                    <div className="plan-toolbar">
                      <div className="plan-toolbar-row">
                        <label className="switch" title="Activer/désactiver l’édition">
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

                        <button className="btn" type="button" onClick={toggleSnapFromButton} title="Snap (S)">
                          Snap: {snapUi ? "ON" : "OFF"} (S)
                        </button>

                        <button className="btn" type="button" onClick={toggleGridFromButton} title="Afficher/masquer la grille">
                          Grille: {gridEnabled ? "ON" : "OFF"}
                        </button>

                        <div className="plan-field-inline" title="Taille de grille (px)">
                          <span className="plan-field-label">Grille</span>
                          <input
                            className="select plan-number"
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

                        <button
                          className="btn"
                          type="button"
                          disabled={!canDeletePolygon}
                          onClick={() => {
                            if (!selectedRoomId) return;
                            setOverlayRequest({ kind: "deletePolygon", roomId: selectedRoomId });
                          }}
                        >
                          Supprimer polygone
                        </button>

                        <button className="btn btn-icon" type="button" onClick={() => setScale((s) => clampScale(s - 0.1))} title="Zoom - (-)">
                          −
                        </button>
                        <button className="btn btn-icon" type="button" onClick={() => setScale((s) => clampScale(s + 0.1))} title="Zoom + (+)">
                          +
                        </button>
                      </div>

                      {adminMode && (
                        <div className="plan-toolbar-row">
                          <div className="plan-field-inline" style={{ minWidth: 320 }}>
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
                              {rooms.map((r) => {
                                const already = roomHasPolygonOnPage(r as any, currentPage);
                                return (
                                  <option key={r.id} value={r.id} disabled={already}>
                                    {r.numero} {already ? " — déjà défini (page)" : ""}
                                  </option>
                                );
                              })}
                            </select>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="plan-content">
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
                                services={services}
                                selectedRoomId={selectedRoomId}
                                onSelectRoom={setSelectedRoomId}
                                adminMode={adminMode}
                                drawingRoomId={drawingRoomId}
                                drawSessionId={drawSessionId}
                                onPolygonCommit={(roomId, poly) => commitPolygon(roomId, currentPage, poly)}
                                request={overlayRequest}
                                onRequestHandled={() => setOverlayRequest({ kind: "none" })}
                                gridEnabled={gridEnabled}
                                gridSizePx={gridSizePx}
                              />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                <button
                  className="panel-resizer"
                  type="button"
                  aria-label="Redimensionner le panneau plan"
                  onMouseDown={(e) => handlePanelResizeMouseDown("plan", e)}
                />
              </section>

              <section
                className="panel panel-side"
                style={{
                  transform: `translate3d(${panelState.rooms.x}px, ${panelState.rooms.y}px, 0)`,
                  zIndex: panelZ.rooms,
                  width: panelState.rooms.width,
                  height: panelState.rooms.collapsed ? undefined : panelState.rooms.height,
                }}
                data-collapsed={panelState.rooms.collapsed}
              >
                <div className="panel-header" onMouseDown={(e) => handlePanelMouseDown("rooms", e)}>
                  <div>
                    <div className="card-title">Pièces</div>
                    <div className="card-subtitle">Liste & sélection</div>
                  </div>
                  <div className="panel-actions">
                    <button
                      className="panel-toggle"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        togglePanel("rooms");
                      }}
                      aria-expanded={!panelState.rooms.collapsed}
                    >
                      {panelState.rooms.collapsed ? "Déplier" : "Replier"}
                    </button>
                  </div>
                </div>
                {!panelState.rooms.collapsed && (
                  <div className="panel-body panel-scroll">
                    <RoomListPanel rooms={rooms} selectedRoomId={selectedRoomId} onSelectRoom={setSelectedRoomId} />
                  </div>
                )}
                <button
                  className="panel-resizer"
                  type="button"
                  aria-label="Redimensionner le panneau pièces"
                  onMouseDown={(e) => handlePanelResizeMouseDown("rooms", e)}
                />
              </section>

              <section
                className="panel panel-side"
                style={{
                  transform: `translate3d(${panelState.details.x}px, ${panelState.details.y}px, 0)`,
                  zIndex: panelZ.details,
                  width: panelState.details.width,
                  height: panelState.details.collapsed ? undefined : panelState.details.height,
                }}
                data-collapsed={panelState.details.collapsed}
              >
                <div className="panel-header" onMouseDown={(e) => handlePanelMouseDown("details", e)}>
                  <div>
                    <div className="card-title">Détails</div>
                    <div className="card-subtitle">Infos & photo</div>
                  </div>
                  <div className="panel-actions">
                    <button
                      className="panel-toggle"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        togglePanel("details");
                      }}
                      aria-expanded={!panelState.details.collapsed}
                    >
                      {panelState.details.collapsed ? "Déplier" : "Replier"}
                    </button>
                  </div>
                </div>
                {!panelState.details.collapsed && (
                  <div className="panel-body panel-scroll">
                    <RoomDetailsPanel room={selectedRoom} services={services} onSave={handleSaveRoom} onUploadPhoto={handleUploadPhoto} />
                  </div>
                )}
                <button
                  className="panel-resizer"
                  type="button"
                  aria-label="Redimensionner le panneau détails"
                  onMouseDown={(e) => handlePanelResizeMouseDown("details", e)}
                />
              </section>
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
