import { useEffect, useMemo, useState } from "react";
import "./App.css";

import { PdfCanvas } from "./components/PdfCanvas";
import { SvgOverlay } from "./components/SvgOverlay";
import type { OverlayRequest } from "./components/SvgOverlay";

import { RoomListPanel } from "./components/RoomListPanel";
import { RoomDetailsPanel } from "./components/RoomDetailsPanel";

import { api } from "./api";
import type { Point, Room, ServiceColor } from "./types";

const SNAP_STORAGE_KEY = "iface.snapEnabled";
const SNAP_TOGGLE_EVENT = "iface:snap-toggle";

const GRID_ENABLED_KEY = "iface.gridEnabled";
const GRID_SIZE_KEY = "iface.gridSizePx";

const SERVICE_COLORS_KEY = "iface.serviceColors.v1";

type PageView = "dashboard" | "plans" | "settings";

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

function clampScale(next: number) {
  return Math.min(3, Math.max(0.4, +next.toFixed(2)));
}

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

// ✅ Multi-pages compat (room.polygons[] ou legacy room.polygon sur page 0)
function extractPolyForPage(room: any, page: number): Point[] | undefined {
  const polys = room?.polygons;
  if (Array.isArray(polys)) {
    for (const entry of polys) {
      if (!entry) continue;
      const entryPage =
        typeof entry.page === "number"
          ? entry.page
          : typeof entry.pageIndex === "number"
          ? entry.pageIndex
          : undefined;

      if (entryPage !== page) continue;

      const pts = entry.points ?? entry.polygon ?? entry;
      if (Array.isArray(pts)) return pts as Point[];
      if (pts && Array.isArray(pts.polygon)) return pts.polygon as Point[];
    }
  }

  if (page === 0) {
    const p = room?.polygon;
    if (Array.isArray(p)) return p as Point[];
    if (p && Array.isArray(p.polygon)) return p.polygon as Point[];
  }

  return undefined;
}

function roomHasPolygonForPage(r: Room | null, page: number): boolean {
  if (!r) return false;
  const poly = extractPolyForPage(r as any, page);
  return !!poly && poly.length >= 3;
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

  // ✅ Services (IMPORTANT: jamais undefined)
  const [services, setServices] = useState<ServiceColor[]>(() => readServiceColors());
  useEffect(() => writeServiceColors(services), [services]);

  // ✅ Multi-pages
  const [currentPage, setCurrentPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);

  const [overlayRequest, setOverlayRequest] = useState<OverlayRequest>({ kind: "none" });

  useEffect(() => {
    api.getRooms().then((r) => {
      setRooms(r);
      if (r.length && !selectedRoomId) setSelectedRoomId(r[0].id);

      // Seed palette à partir des rooms existantes (si service renseigné)
      const used = new Set(
        r.map((x) => (x.service ?? "").trim()).filter((s) => s.length > 0)
      );

      if (used.size) {
        setServices((prev) => {
          const map = new Map(prev.map((p) => [p.service.trim(), p.color]));
          let changed = false;
          for (const s of used) {
            const key = s.trim();
            if (!map.has(key)) {
              // Couleur fallback stable (simple) si service nouveau
              const hue = (() => {
                let h = 0;
                for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
                return h % 360;
              })();
              const color = `hsl(${hue} 55% 72%)`;
              map.set(key, color);
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

  const selectedRoom = useMemo(
    () => rooms.find((r) => r.id === selectedRoomId) ?? null,
    [rooms, selectedRoomId]
  );

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

  // Sync snap UI (S)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "s") return;
      if (isTypingTarget(e.target)) return;
      setTimeout(() => setSnapUi(readSnapFromStorage()), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Sync snap UI (event)
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
    adminMode && !!selectedRoomId && roomHasPolygonForPage(selectedRoom, currentPage);

  const overlayReady = isValidSize(size.w) && isValidSize(size.h);

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
              <b>Alt+clic</b> insérer • <b>Delete</b> supprimer sommet
              <br />
              <b>Ctrl/⌘</b> drag = déplacer polygone
            </div>
          </div>
        </aside>

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
                  <div className="card-subtitle">Palette services</div>
                </div>
              </div>
              <div className="card-content">
                <div className="hint">
                  (Tu peux compléter cet écran, mais surtout : <b>services</b> ne sera jamais undefined.)
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
          </main>
        )}

        {pageView === "plans" && (
          <aside className="dash-right">
            <div className="right-sticky">
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

                    <button className="btn btn-icon" onClick={() => setScale((s) => clampScale(s - 0.1))} title="Zoom - (-)">
                      −
                    </button>
                    <button className="btn btn-icon" onClick={() => setScale((s) => clampScale(s + 0.1))} title="Zoom + (+)">
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
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title">Pièces</div>
                    <div className="card-subtitle">Liste & sélection</div>
                  </div>
                </div>
                {/* ✅ pas de card-scroll ici */}
                <div className="card-content">
                  <RoomListPanel rooms={rooms} selectedRoomId={selectedRoomId} onSelectRoom={setSelectedRoomId} />
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title">Détails</div>
                    <div className="card-subtitle">Infos & photo</div>
                  </div>
                </div>
                {/* ✅ ICI le fix : services n’est jamais undefined */}
                <div className="card-content">
                  <RoomDetailsPanel
                    room={selectedRoom}
                    services={services}
                    onSave={handleSaveRoom}
                    onUploadPhoto={handleUploadPhoto}
                  />
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
