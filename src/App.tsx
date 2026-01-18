import { useEffect, useMemo, useState } from "react";
import "./App.css";

import { PdfCanvas } from "./components/PdfCanvas";
import { SvgOverlay } from "./components/SvgOverlay";
import type { OverlayRequest } from "./components/SvgOverlay";
import { RoomListPanel } from "./components/RoomListPanel";
import { RoomDetailsPanel } from "./components/RoomDetailsPanel";
import { api } from "./api";
import type { Room, Point } from "./types";

const SNAP_STORAGE_KEY = "iface.snapEnabled";
const SNAP_TOGGLE_EVENT = "iface:snap-toggle";

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

function roomHasPolygon(r: Room | null): boolean {
  if (!r) return false;
  const p: any = (r as any).polygon;
  if (!p) return false;
  if (Array.isArray(p)) return p.length >= 3;
  if (Array.isArray(p?.polygon)) return p.polygon.length >= 3;
  return false;
}

export default function App() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  const [adminMode, setAdminMode] = useState(true);
  const [drawingRoomId, setDrawingRoomId] = useState<string | null>(null);
  const [drawSessionId, setDrawSessionId] = useState(0);

  const [scale, setScale] = useState(1.2);
  const [size, setSize] = useState({ w: 800, h: 600 });

  const [snapUi, setSnapUi] = useState<boolean>(() => readSnapFromStorage());

  // ✅ Requests vers l’overlay (delete, etc.)
  const [overlayRequest, setOverlayRequest] = useState<OverlayRequest>({ kind: "none" });

  useEffect(() => {
    api.getRooms().then((r) => {
      setRooms(r);
      if (r.length && !selectedRoomId) setSelectedRoomId(r[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRoom = useMemo(
    () => rooms.find((r) => r.id === selectedRoomId) ?? null,
    [rooms, selectedRoomId]
  );

  async function commitPolygon(roomId: string, poly: Point[]) {
    const saved = await api.updatePolygon(roomId, { page: 0, polygon: poly });
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

  const canDeletePolygon = adminMode && !!selectedRoomId && roomHasPolygon(selectedRoom);

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
          <button className="nav-item nav-item-active">
            <span className="nav-icon" aria-hidden="true">
              ⌂
            </span>
            Dashboard
          </button>
          <button className="nav-item">
            <span className="nav-icon" aria-hidden="true">
              ▦
            </span>
            Plans
          </button>
          <button className="nav-item">
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
            </div>
          </div>
        </aside>

        {/* MAIN */}
        <main className="dash-main">
          <div className="card plan-card">
            <div className="card-header">
              <div>
                <div className="card-title">Plan</div>
                <div className="card-subtitle">PDF + overlay</div>
              </div>

              <div className="card-meta">
                <span className="meta-chip">Zoom x{scale.toFixed(2)}</span>
                <span className="meta-chip">Sélection: {selectedRoom?.numero ?? "—"}</span>
              </div>
            </div>

            <div className="card-content plan-content">
              <div className="plan-viewport">
                <div className="plan-stage">
                  <PdfCanvas
                    pdfUrl="/Pour CHATGPT.pdf"
                    scale={scale}
                    onSize={(w, h) => setSize({ w, h })}
                  />

                  <SvgOverlay
                    width={size.w}
                    height={size.h}
                    rooms={rooms}
                    services={[]}
                    selectedRoomId={selectedRoomId}
                    onSelectRoom={setSelectedRoomId}
                    adminMode={adminMode}
                    drawingRoomId={drawingRoomId}
                    drawSessionId={drawSessionId}
                    onPolygonCommit={commitPolygon}
                    request={overlayRequest}
                    onRequestHandled={() => setOverlayRequest({ kind: "none" })}
                  />
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* RIGHT */}
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

                {/* ✅ SUPPRESSION POLYGONE */}
                <div style={{ marginTop: 10 }}>
                  <button
                    className="btn"
                    disabled={!canDeletePolygon}
                    onClick={() => {
                      if (!selectedRoomId) return;
                      setOverlayRequest({ kind: "deletePolygon", roomId: selectedRoomId });
                    }}
                    title={!canDeletePolygon ? "Sélectionne une pièce avec un polygone" : "Supprimer le polygone"}
                  >
                    Supprimer polygone
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

                <div className="hint">Zoom ne concerne que la zone de dessin (PDF + overlay).</div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Pièces</div>
                  <div className="card-subtitle">Liste & sélection</div>
                </div>
              </div>

              {/* ✅ IMPORTANT : pas de card-scroll ici → pas d’ascenseur interne */}
              <div className="card-content">
                <RoomListPanel
                  rooms={rooms}
                  selectedRoomId={selectedRoomId}
                  onSelectRoom={setSelectedRoomId}
                />
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Détails</div>
                  <div className="card-subtitle">Infos & photo</div>
                </div>
              </div>

              {/* ✅ IMPORTANT : pas de card-scroll ici → pas d’ascenseur interne */}
              <div className="card-content">
                <RoomDetailsPanel room={selectedRoom} />
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
