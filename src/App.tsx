import { useEffect, useMemo, useState } from "react";
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

/** Compat multi-pages : 1 pièce = 1 polygone sur une page */
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

function readServiceColors(): ServiceColor[] {
  const parsed = safeParse<ServiceColor[]>(localStorage.getItem(SERVICE_COLORS_KEY));
  if (!parsed || !Array.isArray(parsed)) return [];
  return parsed
    .filter((x) => x && typeof x.service === "string" && typeof x.color === "string")
    .map((x) => ({ service: x.service.trim(), color: x.color.trim() }))
    .filter((x) => x.service.length > 0);
}

export default function App() {
  const [pageView, setPageView] = useState<PageView>("dashboard");

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  const [adminMode, setAdminMode] = useState(true);
  const [drawingRoomId, setDrawingRoomId] = useState<string | null>(null);
  const [drawSessionId, setDrawSessionId] = useState(0);

  const [scale, setScale] = useState(1.2);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // ✅ Multi-pages
  const [currentPage, setCurrentPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);

  const [snapUi, setSnapUi] = useState<boolean>(() => readSnapFromStorage());
  const [gridEnabled, setGridEnabled] = useState<boolean>(() => readGridEnabled());
  const [gridSizePx, setGridSizePx] = useState<number>(() => readGridSizePx());

  const [overlayRequest, setOverlayRequest] = useState<OverlayRequest>({ kind: "none" });

  // ✅ IMPORTANT : services DOIT exister (sinon RoomDetailsPanel crash)
  const [services, setServices] = useState<ServiceColor[]>(() => readServiceColors());

  useEffect(() => {
    api.getRooms().then((r) => {
      setRooms(r);
      if (r.length && !selectedRoomId) setSelectedRoomId(r[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRoom = useMemo(() => rooms.find((r) => r.id === selectedRoomId) ?? null, [rooms, selectedRoomId]);

  useEffect(() => {
    setCurrentPage((p) => Math.max(0, Math.min(p, Math.max(1, pageCount) - 1)));
  }, [pageCount]);

  async function commitPolygon(roomId: string, page: number, poly: Point[]) {
    const saved = await api.updatePolygon(roomId, { page, polygon: poly }); // ⚠️ page obligatoire
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

  const canDeletePolygon =
    adminMode && !!selectedRoomId && roomHasPolygonOnPage(rooms.find((x) => x.id === selectedRoomId) as any, currentPage);

  const overlayReady = isValidSize(size.w) && isValidSize(size.h);

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

          <button className={`nav-item ${pageView === "dashboard" ? "nav-item-active" : ""}`} onClick={() => setPageView("dashboard")} type="button">
            <span className="nav-icon" aria-hidden="true">
              ⌂
            </span>
            Dashboard
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
                  L’éditeur est dans <b>Plans</b>.
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
                <div className="hint">Écran Paramètres (services etc.).</div>
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
                  <div className="card-subtitle">PDF + overlay</div>
                </div>

                {/* ✅ Barre du haut du panneau Plan = toutes les options "Contrôles" */}
                <div className="plan-header-right">
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
                        title={!canDeletePolygon ? "Aucun polygone sur cette page pour la pièce sélectionnée" : "Supprimer le polygone (page courante)"}
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
                </div>
              </div>

              <div className="card-content plan-content">
                <div className="plan-viewport">
                  <div className="plan-stage">
                    {/* ✅ repère stable PDF + SVG */}
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
                          services={services} // ✅ IMPORTANT
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

        {/* RIGHT */}
        {pageView === "plans" && (
          <aside className="dash-right">
            <div className="right-sticky">
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

              <div className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title">Détails</div>
                    <div className="card-subtitle">Infos & photo</div>
                  </div>
                </div>
                <div className="card-content card-scroll">
                  <RoomDetailsPanel
                    room={selectedRoom}
                    services={services}          // ✅ FIX: jamais undefined
                    onSave={handleSaveRoom}      // ✅ comme GitHub
                    onUploadPhoto={handleUploadPhoto} // ✅ comme GitHub
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
