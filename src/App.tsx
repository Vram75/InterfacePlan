import { useEffect, useMemo, useState } from "react";
import "./App.css";

import { PdfCanvas } from "./components/PdfCanvas";
import { SvgOverlay } from "./components/SvgOverlay";
import type { OverlayRequest } from "./components/SvgOverlay";
import { RoomListPanel } from "./components/RoomListPanel";
import { RoomDetailsPanel } from "./components/RoomDetailsPanel";
import { FloatingPanel, type FloatingRect } from "./components/FloatingPanel";
import { api } from "./api";
import type { Room, Point } from "./types";

const SNAP_STORAGE_KEY = "iface.snapEnabled";
const SNAP_TOGGLE_EVENT = "iface:snap-toggle";

const GRID_ENABLED_KEY = "iface.gridEnabled";
const GRID_SIZE_KEY = "iface.gridSizePx";

const LAYOUT_KEY = "iface.layout.v1";

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
  const parsed = safeParse<LayoutState>(localStorage.getItem(LAYOUT_KEY));
  if (!parsed) return DEFAULT_LAYOUT;

  // soft merge (évite de casser si des champs manquent)
  return {
    mode: { ...DEFAULT_LAYOUT.mode, ...(parsed.mode ?? {}) },
    collapsed: { ...DEFAULT_LAYOUT.collapsed, ...(parsed.collapsed ?? {}) },
    rect: { ...DEFAULT_LAYOUT.rect, ...(parsed.rect ?? {}) },
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

function roomGetPageIndex(r: Room | null): number {
  if (!r) return 0;
  const p: any = (r as any).page;
  return typeof p === "number" && Number.isFinite(p) ? p : 0;
}

function roomHasPolygon(r: Room | null): boolean {
  if (!r) return false;
  const p: any = (r as any).polygon;
  if (!p) return false;
  if (Array.isArray(p)) return p.length >= 3;
  if (Array.isArray(p?.polygon)) return p.polygon.length >= 3;
  return false;
}

function roomHasPolygonForPage(r: Room | null, pageIndex: number): boolean {
  if (!roomHasPolygon(r)) return false;
  return roomGetPageIndex(r) === pageIndex;
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
  const [currentPage, setCurrentPage] = useState(0); // 0-based
  const [pageCount, setPageCount] = useState(1);

  // ✅ Requests overlay (delete, etc.)
  const [overlayRequest, setOverlayRequest] = useState<OverlayRequest>({ kind: "none" });

  // ✅ Dock/Float layout
  const [layout, setLayout] = useState<LayoutState>(() => readLayout());
  useEffect(() => writeLayout(layout), [layout]);

  useEffect(() => {
    api.getRooms().then((r) => {
      setRooms(r);
      if (r.length && !selectedRoomId) setSelectedRoomId(r[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // clamp currentPage when PDF changes
  useEffect(() => {
    setCurrentPage((p) => Math.max(0, Math.min(p, Math.max(1, pageCount) - 1)));
  }, [pageCount]);

  const selectedRoom = useMemo(
    () => rooms.find((r) => r.id === selectedRoomId) ?? null,
    [rooms, selectedRoomId]
  );

  async function commitPolygon(roomId: string, pageIndex: number, poly: Point[]) {
    // ✅ IMPORTANT: page est obligatoire côté backend
    const saved = await api.updatePolygon(roomId, { page: pageIndex, polygon: poly });
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

  // Snap UI sync when shortcut used (S)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "s") return;
      if (isTypingTarget(e.target)) return;
      setTimeout(() => setSnapUi(readSnapFromStorage()), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Snap UI sync when button toggles (custom event)
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

  const canDeletePolygon =
    adminMode && !!selectedRoomId && roomHasPolygonForPage(selectedRoom, currentPage);

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
  // Panels content (single source of truth)
  // -----------------------

  const ControlsPanel = (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Contrôles</div>
          <div className="card-subtitle">Édition & zoom</div>
        </div>

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

      <div className="card-content">
        <div className="controls-row">
          <button className="btn" onClick={toggleSnapFromButton}>
            Snap: {snapUi ? "ON" : "OFF"} (S)
          </button>

          <button className="btn" onClick={toggleGridFromButton}>
            Grille: {gridEnabled ? "ON" : "OFF"}
          </button>

          <button
            className="btn btn-icon"
            onClick={() => setScale((s) => clampScale(s - 0.1))}
            title="Zoom - (-)"
          >
            −
          </button>
          <button
            className="btn btn-icon"
            onClick={() => setScale((s) => clampScale(s + 0.1))}
            title="Zoom + (+)"
          >
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
            title={
              !canDeletePolygon
                ? "Sélectionne une pièce avec un polygone sur cette page"
                : "Supprimer le polygone (page courante)"
            }
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
                setDrawingRoomId(e.target.value || null);
                setDrawSessionId((x) => x + 1);
              }}
            >
              <option value="">— Choisir une pièce —</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.numero}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="hint">
          Page: {currentPage + 1}/{pageCount} • Zoom = PDF + overlay
        </div>
      </div>
    </div>
  );

  const RoomsPanel = (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Pièces</div>
          <div className="card-subtitle">Liste & sélection</div>
        </div>
      </div>
      <div className="card-content card-scroll">
        <RoomListPanel rooms={rooms} selectedRoomId={selectedRoomId} onSelectRoom={setSelectedRoomId} />
      </div>
    </div>
  );

  const DetailsPanel = (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Détails</div>
          <div className="card-subtitle">Infos & photo</div>
        </div>
      </div>
      <div className="card-content card-scroll">
        <RoomDetailsPanel room={selectedRoom} onSave={handleSaveRoom} onUploadPhoto={handleUploadPhoto} />
      </div>
    </div>
  );

  function renderDockRight() {
    return (
      <aside className="dash-right">
        <div className="right-sticky">
          {layout.mode.controls === "dock" && (
            <div className="dock-wrap">
              <div className="dock-actions">
                <button className="btn btn-mini" onClick={() => undockPanel("controls")} title="Détacher">
                  Détacher
                </button>
              </div>
              {ControlsPanel}
            </div>
          )}

          {layout.mode.rooms === "dock" && (
            <div className="dock-wrap">
              <div className="dock-actions">
                <button className="btn btn-mini" onClick={() => undockPanel("rooms")} title="Détacher">
                  Détacher
                </button>
              </div>
              {RoomsPanel}
            </div>
          )}

          {layout.mode.details === "dock" && (
            <div className="dock-wrap">
              <div className="dock-actions">
                <button className="btn btn-mini" onClick={() => undockPanel("details")} title="Détacher">
                  Détacher
                </button>
              </div>
              {DetailsPanel}
            </div>
          )}
        </div>
      </aside>
    );
  }

  function renderFloatingPanels() {
    return (
      <>
        {layout.mode.controls === "float" && (
          <FloatingPanel
            title="Contrôles"
            rect={layout.rect.controls}
            onRectChange={(r) => setRect("controls", r)}
            onDock={() => dockPanel("controls")}
            collapsed={layout.collapsed.controls}
            onToggleCollapsed={() => toggleCollapsed("controls")}
          >
            {ControlsPanel}
          </FloatingPanel>
        )}

        {layout.mode.rooms === "float" && (
          <FloatingPanel
            title="Pièces"
            rect={layout.rect.rooms}
            onRectChange={(r) => setRect("rooms", r)}
            onDock={() => dockPanel("rooms")}
            collapsed={layout.collapsed.rooms}
            onToggleCollapsed={() => toggleCollapsed("rooms")}
          >
            {RoomsPanel}
          </FloatingPanel>
        )}

        {layout.mode.details === "float" && (
          <FloatingPanel
            title="Détails"
            rect={layout.rect.details}
            onRectChange={(r) => setRect("details", r)}
            onDock={() => dockPanel("details")}
            collapsed={layout.collapsed.details}
            onToggleCollapsed={() => toggleCollapsed("details")}
          >
            {DetailsPanel}
          </FloatingPanel>
        )}
      </>
    );
  }

  return (
    <div className="dash-root">
      {/* TOPBAR */}
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

      {/* BODY */}
      <div className="dash-body">
        {/* SIDEBAR */}
        <aside className="dash-sidebar">
          <div className="nav-title">Navigation</div>

          <button
            className={`nav-item ${pageView === "dashboard" ? "nav-item-active" : ""}`}
            onClick={() => setPageView("dashboard")}
          >
            <span className="nav-icon" aria-hidden="true">
              ⌂
            </span>
            Dashboard
          </button>

          <button
            className={`nav-item ${pageView === "plans" ? "nav-item-active" : ""}`}
            onClick={() => setPageView("plans")}
          >
            <span className="nav-icon" aria-hidden="true">
              ▦
            </span>
            Plans
          </button>

          <button
            className={`nav-item ${pageView === "settings" ? "nav-item-active" : ""}`}
            onClick={() => setPageView("settings")}
          >
            <span className="nav-icon" aria-hidden="true">
              ⛭
            </span>
            Paramètres
          </button>

          <div className="spacer" />

          <div className="help-card">
            <div className="help-title">Raccourcis</div>
            <div className="help-text">
              <b>S</b> Snap • <b>+</b>/<b>-</b> Zoom • <b>Shift</b> orthogonal
              <br />
              <b>Alt+clic</b> insérer • <b>Delete</b> supprimer sommet • <b>Ctrl/⌘</b> déplacer polygone
            </div>
          </div>
        </aside>

        {/* MAIN */}
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
                  L’éditeur multi-pages est dans <b>Plans</b>.
                </div>
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
                  <div className="card-subtitle">Préférences</div>
                </div>
              </div>
              <div className="card-content">
                <div className="hint">Écran Paramètres (à compléter).</div>
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
                    {/* ✅ IMPORTANT: plan-stage a du padding. plan-layer NON. */}
                    <div className="plan-layer">
                      <PdfCanvas
                        pdfUrl="/Pour CHATGPT.pdf"
                        scale={scale}
                        page={currentPage + 1}
                        onPageCount={setPageCount}
                        onSize={(w, h) => setSize({ w, h })}
                      />

                      <SvgOverlay
                        width={size.w}
                        height={size.h}
                        page={currentPage}
                        rooms={rooms}
                        services={[]}
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
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* floating panels */}
            {renderFloatingPanels()}
          </main>
        )}

        {/* RIGHT (dock panels only on Plans; sinon vide) */}
        {pageView === "plans" ? renderDockRight() : <aside className="dash-right"><div className="right-sticky" /></aside>}
      </div>
    </div>
  );
}