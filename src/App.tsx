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
// Polygons detection (robust formats) + lock after commit
// --------------------
function extractPolygonForPage(room: any, pageIndex: number): Point[] | undefined {
  if (!room) return undefined;

  const polys = room.polygons;
  if (Array.isArray(polys)) {
    for (const entry of polys) {
      if (!entry) continue;
      const p = typeof entry.page === "number" ? entry.page : typeof entry.pageIndex === "number" ? entry.pageIndex : undefined;
      if (p !== pageIndex) continue;

      const pts = entry.polygon ?? entry.points ?? entry;
      if (Array.isArray(pts)) return pts as Point[];
      if (pts && Array.isArray(pts.polygon)) return pts.polygon as Point[];
    }
  }

  const page = typeof room.page === "number" && Number.isFinite(room.page) ? room.page : 0;
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
// --------------------

export default function App() {
  const [pageView, setPageView] = useState<PageView>("dashboard");

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  const [adminMode, setAdminMode] = useState(true);
  const [drawingRoomId, setDrawingRoomId] = useState<string | null>(null);
  const [drawSessionId, setDrawSessionId] = useState(0);

  const [scale, setScale] = useState(1.2);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // ✅ Multi-pages (PDF)
  const [currentPage, setCurrentPage] = useState(0); // 0-based
  const [pageCount, setPageCount] = useState(1);

  const [snapUi, setSnapUi] = useState<boolean>(() => readSnapFromStorage());
  const [gridEnabled, setGridEnabled] = useState<boolean>(() => readGridEnabled());
  const [gridSizePx, setGridSizePx] = useState<number>(() => readGridSizePx());

  const [overlayRequest, setOverlayRequest] = useState<OverlayRequest>({ kind: "none" });

  // ✅ services with stable uid
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
      setRooms(r);
      if (r.length && !selectedRoomId) setSelectedRoomId(r[0].id);

      // Seed services from rooms (non-destructive)
      const used = new Set(r.map((x) => (x.service ?? "").trim()).filter((s) => s.length > 0));
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

  // Clamp current page when pageCount changes
  useEffect(() => {
    setCurrentPage((p) => Math.max(0, Math.min(p, Math.max(1, pageCount) - 1)));
  }, [pageCount]);

  // ✅ Keyboard: PageUp / PageDown for PDF pages (only in Plans)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (pageView !== "plans") return;
      if (isTypingTarget(e.target)) return;

      if (e.key === "PageUp") {
        e.preventDefault();
        setCurrentPage((p) => Math.max(0, p - 1));
        setDrawingRoomId(null);
        setOverlayRequest({ kind: "none" });
        setDrawSessionId((x) => x + 1);
      }

      if (e.key === "PageDown") {
        e.preventDefault();
        setCurrentPage((p) => Math.min(Math.max(1, pageCount) - 1, p + 1));
        setDrawingRoomId(null);
        setOverlayRequest({ kind: "none" });
        setDrawSessionId((x) => x + 1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pageView, pageCount]);

  // ✅ Commit polygon with optimistic lock (page-aware)
  async function commitPolygon(roomId: string, page: number, poly: Point[]) {
    // Optimistic: lock immediately on that page
    setRooms((prev) =>
      prev.map((r: any) => {
        if (r.id !== roomId) return r;

        const next: any = { ...r, page, polygon: poly };

        // Maintain multi-polygons format if present
        if (Array.isArray(r.polygons)) {
          const others = r.polygons.filter((x: any) => (typeof x?.page === "number" ? x.page : undefined) !== page);
          next.polygons = [...others, { page, polygon: poly }];
        }

        return next;
      })
    );

    setDrawingRoomId(null);
    setDrawSessionId((x) => x + 1);

    try {
      const saved = await api.updatePolygon(roomId, { page, polygon: poly }); // ⚠️ page obligatoire
      setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
    } catch (e) {
      const refreshed = await api.getRooms();
      setRooms(refreshed);
      throw e;
    }
  }

  async function handleSaveRoom(room: Room) {
    const saved = await api.updateRoom(room);
    setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
  }

  async function handleUploadPhoto(roomId: string, file: File) {
    const saved = await api.uploadPhoto(roomId, file);
    setRooms((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
  }

  // ---- Services UI actions (NO resort while typing) ----
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

  const canDeletePolygon = adminMode && !!selectedRoomId && roomHasPolygonOnPage(selectedRoom as any, currentPage);
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
              <b>PageUp/PageDown</b> pages PDF
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
                    {services.map((s) => (
                      <div className="service-row" key={s.uid}>
                        <div className="swatch" style={{ background: sanitizeServiceColor(s.service, s.color) }} />

                        <input
                          className="select"
                          value={s.service}
                          onChange={(e) => updateService(s.uid, { service: e.target.value })}
                          onBlur={() => normalizeAndSortServices()}
                        />

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

                <div className="hint" style={{ marginTop: 12 }}>
                  Dans “Détails”, si une pièce n’a pas de service ou un service non présent ici, afficher <b>non attribué</b>.
                </div>
              </div>
            </div>
          </main>
        )}

        {/* PLANS */}
        {pageView === "plans" && (
          <main className="dash-main">
            <div className="card plan-card">
              <div className="card-header">
                <div>
                  <div className="card-title">Plan</div>
                  <div className="card-subtitle">PDF multi-pages + overlay</div>
                </div>

                {/* Barre du haut du panneau Plan */}
                <div className="plan-header-right">
                  <div className="card-meta">
                    <button
                      className="btn btn-icon"
                      title="Page précédente (PageUp)"
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
                      title="Page suivante (PageDown)"
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
                            {rooms.map((r: any) => {
                              const already = roomHasPolygonOnPage(r, currentPage);
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
                    <div className="plan-layer">
                      <PdfCanvas
                        pdfUrl="/Pour CHATGPT.pdf"
                        scale={scale}
                        page={currentPage + 1}          // 1-based for pdf.js
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
                          page={currentPage}            // 0-based for our overlay / backend
                          rooms={rooms}
                          services={services.map(({ uid: _uid, ...rest }) => rest)}
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
                    services={services.map(({ uid: _uid, ...rest }) => rest)}
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
