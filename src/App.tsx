import { useEffect, useMemo, useState } from "react";
import "./App.css";

import { PdfCanvas } from "./components/PdfCanvas";
import { SvgOverlay } from "./components/SvgOverlay";
import type { OverlayRequest } from "./components/SvgOverlay";

import { RoomListPanel } from "./components/RoomListPanel";
import { RoomDetailsPanel } from "./components/RoomDetailsPanel";
import { FloatingPanel, type FloatingRect } from "./components/FloatingPanel";

import { api } from "./api";
import type { Point, Room, ServiceColor } from "./types";

const SNAP_STORAGE_KEY = "iface.snapEnabled";
const SNAP_TOGGLE_EVENT = "iface:snap-toggle";

const GRID_ENABLED_KEY = "iface.gridEnabled";
const GRID_SIZE_KEY = "iface.gridSizePx";

const LAYOUT_KEY = "iface.layout.v1";
const SERVICE_COLORS_KEY = "iface.serviceColors.v1";

type PageView = "dashboard" | "plans" | "settings";
type PanelKey = "controls" | "rooms" | "details";
type PanelMode = "dock" | "float";

type LayoutState = {
  mode: Record<PanelKey, PanelMode>;
  collapsed: Record<PanelKey, boolean>;
  rect: Record<PanelKey, FloatingRect>;
};

const DEFAULT_LAYOUT: LayoutState = {
  mode: { controls: "dock", rooms: "dock", details: "dock" },
  collapsed: { controls: false, rooms: false, details: false },
  rect: {
    controls: { x: 40, y: 92, w: 430, h: 560 },
    rooms: { x: 500, y: 92, w: 420, h: 560 },
    details: { x: 940, y: 92, w: 460, h: 700 },
  },
};

function safeParse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function readLayout(): LayoutState {
  const parsed = safeParse<Partial<LayoutState>>(localStorage.getItem(LAYOUT_KEY));
  if (!parsed) return DEFAULT_LAYOUT;
  return {
    mode: { ...DEFAULT_LAYOUT.mode, ...(parsed.mode ?? {}) } as LayoutState["mode"],
    collapsed: { ...DEFAULT_LAYOUT.collapsed, ...(parsed.collapsed ?? {}) } as LayoutState["collapsed"],
    rect: { ...DEFAULT_LAYOUT.rect, ...(parsed.rect ?? {}) } as LayoutState["rect"],
  };
}

function writeLayout(v: LayoutState) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(v));
  } catch {}
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

function clampScale(next: number) {
  return Math.min(3, Math.max(0.4, +next.toFixed(2)));
}

function isTypingTarget(target: unknown): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.getAttribute("contenteditable") === "true";
}

function readGridEnabled(): boolean {
  try {
    const v = localStorage.getItem(GRID_ENABLED_KEY);
    if (v == null) return false;
    const s = String(v).trim().toLowerCase();
    return s === "1" || s === "true" || s === "on" || s === "yes";
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

function isValidSize(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** ✅ Règle métier : 1 pièce = 1 polygone par page. */
function roomHasPolygonOnPage(room: any, pageIndex: number): boolean {
  if (!room) return false;

  // compat legacy : room.page
  const page = typeof room.page === "number" && Number.isFinite(room.page) ? room.page : 0;
  if (page !== pageIndex) return false;

  const p = room.polygon;
  if (!p) return false;
  if (Array.isArray(p)) return p.length >= 3;
  if (Array.isArray(p?.polygon)) return p.polygon.length >= 3;
  return false;
}

// --------------------
// Services helpers
// --------------------
function readServiceColors(): ServiceColor[] {
  const parsed = safeParse<ServiceColor[]>(localStorage.getItem(SERVICE_COLORS_KEY));
  if (!parsed || !Array.isArray(parsed)) return [];
  return parsed
    .filter((x) => x && typeof x.service === "string" && typeof x.color === "string")
    .map((x) => ({ service: x.service.trim(), color: x.color.trim() }))
    .filter((x) => x.service.length > 0);
}

function writeServiceColors(v: ServiceColor[]) {
  try {
    localStorage.setItem(SERVICE_COLORS_KEY, JSON.stringify(v));
  } catch {}
}

function normalizeServiceName(s: string) {
  return s.trim();
}

function hashStringToHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function defaultColorForService(service: string): string {
  const hue = hashStringToHue(service);
  return `hsl(${hue} 55% 72%)`;
}

export default function App() {
  const [pageView, setPageView] = useState<PageView>("plans");

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  const [adminMode, setAdminMode] = useState(true);
  const [drawingRoomId, setDrawingRoomId] = useState<string | null>(null);
  const [drawSessionId, setDrawSessionId] = useState(0);

  const [scale, setScale] = useState(1.2);
  const [size, setSize] = useState({ w: 800, h: 600 });

  const [snapUi, setSnapUi] = useState<boolean>(() => readSnapFromStorage());
  const [gridEnabled, setGridEnabled] = useState<boolean>(() => readGridEnabled());
  const [gridSizePx, setGridSizePx] = useState<number>(() => readGridSizePx());

  // ✅ Multi-pages
  const [currentPage, setCurrentPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);

  // ✅ Overlay requests
  const [overlayRequest, setOverlayRequest] = useState<OverlayRequest>({ kind: "none" });

  // ✅ Dock/Float layout
  const [layout, setLayout] = useState<LayoutState>(() => readLayout());
  useEffect(() => writeLayout(layout), [layout]);

  // ✅ Services palette (IMPORTANT: jamais undefined)
  const [services, setServices] = useState<ServiceColor[]>(() => readServiceColors());
  useEffect(() => writeServiceColors(services), [services]);

  useEffect(() => {
    api.getRooms().then((r) => {
      setRooms(r);
      if (r.length && !selectedRoomId) setSelectedRoomId(r[0].id);

      // Seed palette from existing rooms
      const used = new Set(r.map((x) => (x.service ?? "").trim()).filter((s) => s.length > 0));
      if (used.size) {
        setServices((prev) => {
          const map = new Map(prev.map((p) => [p.service.trim(), p.color]));
          let changed = false;
          for (const s of used) {
            const key = normalizeServiceName(s);
            if (!map.has(key)) {
              map.set(key, defaultColorForService(key));
              changed = true;
            }
          }
          if (!changed) return prev;
          return Array.from(map.entries())
            .map(([service, color]) => ({ service, color }))
            .sort((a, b) => a.service.localeCompare(b.service, "fr"));
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setCurrentPage((p) => Math.max(0, Math.min(p, Math.max(1, pageCount) - 1)));
  }, [pageCount]);

  const selectedRoom = useMemo(() => rooms.find((r) => r.id === selectedRoomId) ?? null, [rooms, selectedRoomId]);

  async function commitPolygon(roomId: string, pageIndex: number, poly: Point[]) {
    const saved = await api.updatePolygon(roomId, { page: pageIndex, polygon: poly });
    setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
  }

  async function handleSaveRoom(room: Room) {
    const saved = await api.updateRoom(room);
    setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));

    const svc = (saved.service ?? "").trim();
    if (svc) {
      setServices((prev) => {
        const key = normalizeServiceName(svc);
        if (prev.some((x) => x.service.trim() === key)) return prev;
        return [...prev, { service: key, color: defaultColorForService(key) }].sort((a, b) =>
          a.service.localeCompare(b.service, "fr")
        );
      });
    }
  }

  async function handleUploadPhoto(roomId: string, file: File) {
    const saved = await api.uploadPhoto(roomId, file);
    setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
  }

  // Snap UI sync (S)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "s") return;
      if (isTypingTarget(e.target)) return;
      setTimeout(() => setSnapUi(readSnapFromStorage()), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Snap UI sync (event)
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
    const next = !gridEnabled;
    setGridEnabled(next);
    writeGridEnabled(next);
  }

  // Zoom shortcuts +/-
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

  const canDeletePolygon =
    adminMode && !!selectedRoomId && roomHasPolygonOnPage(rooms.find((x) => x.id === selectedRoomId) as any, currentPage);

  const overlayReady = isValidSize(size.w) && isValidSize(size.h);

  // -----------------------
  // Dock/Float helpers
  // -----------------------
  function undockPanel(k: PanelKey) {
    setLayout((l) => ({ ...l, mode: { ...l.mode, [k]: "float" } }));
  }
  function dockPanel(k: PanelKey) {
    setLayout((l) => ({ ...l, mode: { ...l.mode, [k]: "dock" } }));
  }
  function toggleCollapsed(k: PanelKey) {
    setLayout((l) => ({ ...l, collapsed: { ...l.collapsed, [k]: !l.collapsed[k] } }));
  }
  function setRect(k: PanelKey, next: FloatingRect) {
    setLayout((l) => ({ ...l, rect: { ...l.rect, [k]: next } }));
  }

  // -----------------------
  // Panels content
  // -----------------------
  const ControlsPanel = (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Contrôles</div>
          <div className="card-subtitle">Édition & zoom</div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn" onClick={() => toggleCollapsed("controls")} type="button">
            {layout.collapsed.controls ? "Déplier" : "Replier"}
          </button>
          <button
            className="btn"
            onClick={() => (layout.mode.controls === "dock" ? undockPanel("controls") : dockPanel("controls"))}
            type="button"
          >
            {layout.mode.controls === "dock" ? "Détacher" : "Dock"}
          </button>

          <label className="switch">
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

      {!layout.collapsed.controls && (
        <div className="card-content">
          <div className="controls-row">
            <button className="btn" onClick={toggleSnapFromButton} type="button">
              Snap: {snapUi ? "ON" : "OFF"} (S)
            </button>

            <button className="btn" onClick={toggleGridFromButton} type="button">
              Grille: {gridEnabled ? "ON" : "OFF"}
            </button>

            <button className="btn btn-icon" onClick={() => setScale((s) => clampScale(s - 0.1))} title="Zoom - (-)" type="button">
              −
            </button>
            <button className="btn btn-icon" onClick={() => setScale((s) => clampScale(s + 0.1))} title="Zoom + (+)" type="button">
              +
            </button>
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <label className="label">Taille grille (px)</label>
            <input
              className="input"
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
            <div className="hint">La grille sert aussi au snap si activée.</div>
          </div>

          <div style={{ marginTop: 10 }}>
            <button
              className="btn"
              disabled={!canDeletePolygon}
              onClick={() => {
                if (!selectedRoomId) return;
                setOverlayRequest({ kind: "deletePolygon", roomId: selectedRoomId });
              }}
              type="button"
            >
              Supprimer polygone (page)
            </button>
          </div>

          {adminMode && (
            <div className="field">
              <label className="label">Dessiner un polygone pour…</label>
              <select
                className="select"
                value={drawingRoomId ?? ""}
                onChange={(e) => {
                  const next = e.target.value || null;
                  setDrawingRoomId(next);
                  setDrawSessionId((x) => x + 1);
                }}
              >
                <option value="">— Choisir une pièce —</option>
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
          )}

          <div className="hint">Page: {currentPage + 1}/{pageCount} • Zoom = PDF + overlay</div>
        </div>
      )}
    </div>
  );

  const RoomsPanel = (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Pièces</div>
          <div className="card-subtitle">Liste & sélection</div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn" onClick={() => toggleCollapsed("rooms")} type="button">
            {layout.collapsed.rooms ? "Déplier" : "Replier"}
          </button>
          <button
            className="btn"
            onClick={() => (layout.mode.rooms === "dock" ? undockPanel("rooms") : dockPanel("rooms"))}
            type="button"
          >
            {layout.mode.rooms === "dock" ? "Détacher" : "Dock"}
          </button>
        </div>
      </div>

      {!layout.collapsed.rooms && (
        <div className="card-content">
          <RoomListPanel rooms={rooms} selectedRoomId={selectedRoomId} onSelectRoom={setSelectedRoomId} />
        </div>
      )}
    </div>
  );

  const DetailsPanel = (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Détails</div>
          <div className="card-subtitle">Infos & photo</div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn" onClick={() => toggleCollapsed("details")} type="button">
            {layout.collapsed.details ? "Déplier" : "Replier"}
          </button>
          <button
            className="btn"
            onClick={() => (layout.mode.details === "dock" ? undockPanel("details") : dockPanel("details"))}
            type="button"
          >
            {layout.mode.details === "dock" ? "Détacher" : "Dock"}
          </button>
        </div>
      </div>

      {!layout.collapsed.details && (
        <div className="card-content">
          <RoomDetailsPanel room={selectedRoom} services={services} onSave={handleSaveRoom} onUploadPhoto={handleUploadPhoto} />
        </div>
      )}
    </div>
  );

  return (
    <div className="dash-root">
      <header className="dash-topbar">
        <div className="brand">
          <div className="brand-badge" aria-hidden="true">▦</div>
          <div className="brand-text">
            <div className="brand-title">Interface</div>
            <div className="brand-subtitle">Plan d’étage • édition</div>
          </div>
        </div>

        <div className="topbar-actions">
          <div className="search">
            <span className="search-icon" aria-hidden="true">⌕</span>
            <input className="search-input" placeholder="Rechercher…" />
          </div>
          <div className="pill">{rooms.length} pièce(s)</div>
        </div>
      </header>

      <div className="dash-body">
        {/* Sidebar */}
        <aside className="dash-sidebar">
          <div className="nav-title">Navigation</div>

          <button className={`nav-item ${pageView === "dashboard" ? "nav-item-active" : ""}`} onClick={() => setPageView("dashboard")} type="button">
            <span className="nav-icon" aria-hidden="true">⌂</span>
            Dashboard
          </button>

          <button className={`nav-item ${pageView === "plans" ? "nav-item-active" : ""}`} onClick={() => setPageView("plans")} type="button">
            <span className="nav-icon" aria-hidden="true">▦</span>
            Plans
          </button>

          <button className={`nav-item ${pageView === "settings" ? "nav-item-active" : ""}`} onClick={() => setPageView("settings")} type="button">
            <span className="nav-icon" aria-hidden="true">⛭</span>
            Paramètres
          </button>

          <div className="spacer" />

          <div className="help-card">
            <div className="help-title">Raccourcis</div>
            <div className="help-text">
              <b>S</b> Snap • <b>+</b>/<b>-</b> Zoom • <b>Shift</b> orthogonal
              <br />
              <b>Alt+clic</b> insérer • <b>Delete</b> supprimer sommet
              <br />
              <b>Ctrl/⌘</b> drag = déplacer polygone
            </div>
          </div>
        </aside>

        {/* Main */}
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
                <div className="hint">Va dans “Plans” pour éditer.</div>
              </div>
            </div>
          </main>
        )}

        {pageView === "settings" && (
          <main className="dash-main">
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Paramètres</div>
                  <div className="card-subtitle">Layout & palette</div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setLayout(DEFAULT_LAYOUT)}
                    title="Réinitialiser la disposition (dock/float + tailles)"
                  >
                    Reset layout
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setLayout((l) => ({
                        ...l,
                        mode: { controls: "dock", rooms: "dock", details: "dock" },
                      }));
                    }}
                  >
                    Tout dock
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setLayout((l) => ({
                        ...l,
                        mode: { controls: "float", rooms: "float", details: "float" },
                        collapsed: { controls: false, rooms: true, details: true },
                      }));
                    }}
                  >
                    Tout flottant
                  </button>
                </div>
              </div>

              <div className="card-content">
                <div className="hint">
                  Ici tu peux gérer la disposition des panneaux. Les couleurs de services sont auto-seed depuis tes pièces.
                </div>
              </div>
            </div>
          </main>
        )}

        {pageView === "plans" && (
          <main className="dash-main">
            <div className="card plan-card">
              <div className="card-header">
                <div>
                  <div className="card-title">Plan</div>
                  <div className="card-subtitle">PDF multi-pages + overlay</div>
                </div>

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
              </div>

              <div className="card-content plan-content">
                <div className="plan-viewport">
                  <div className="plan-stage">
                    <div className="plan-layer">
                      <PdfCanvas
                        pdfUrl="/Pour CHATGPT.pdf"
                        scale={scale}
                        page={currentPage + 1}
                        onPageCount={setPageCount}
                        onSize={(w, h) => {
                          // ✅ anti-NaN : on ignore toute taille invalide
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
          </main>
        )}

        {/* Docked right column (only docked panels appear here) */}
        {pageView === "plans" && (
          <aside className="dash-right">
            <div className="right-sticky">
              {layout.mode.controls === "dock" && ControlsPanel}
              {layout.mode.rooms === "dock" && RoomsPanel}
              {layout.mode.details === "dock" && DetailsPanel}
            </div>
          </aside>
        )}

        {/* Floating panels */}
        {pageView === "plans" && layout.mode.controls === "float" && (
          <FloatingPanel
            title="Contrôles"
            rect={layout.rect.controls}
            onRect={(r) => setRect("controls", r)}
            onDock={() => dockPanel("controls")}
          >
            {ControlsPanel}
          </FloatingPanel>
        )}

        {pageView === "plans" && layout.mode.rooms === "float" && (
          <FloatingPanel
            title="Pièces"
            rect={layout.rect.rooms}
            onRect={(r) => setRect("rooms", r)}
            onDock={() => dockPanel("rooms")}
          >
            {RoomsPanel}
          </FloatingPanel>
        )}

        {pageView === "plans" && layout.mode.details === "float" && (
          <FloatingPanel
            title="Détails"
            rect={layout.rect.details}
            onRect={(r) => setRect("details", r)}
            onDock={() => dockPanel("details")}
          >
            {DetailsPanel}
          </FloatingPanel>
        )}
      </div>
    </div>
  );
}
