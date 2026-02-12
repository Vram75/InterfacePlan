import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Room, ServiceColor } from "../types";

const API_BASE = "http://localhost:8000";

function resolvePhotoUrl(photoUrl: string | null | undefined): string | null {
  if (!photoUrl) return null;
  const s = String(photoUrl).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const path = s.startsWith("/") ? s : `/${s}`;
  return `${API_BASE}${path}`;
}

type AspectMode = "free" | "1:1" | "4:3";

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}
function round(n: number, d = 2) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error("Impossible de lire le fichier"));
    r.onload = () => res(String(r.result));
    r.readAsDataURL(file);
  });
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return await new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Impossible de charger l'image"));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type = "image/jpeg", quality = 0.9): Promise<Blob> {
  return new Promise((res, rej) => {
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob() a échoué"))), type, quality);
  });
}

function CropModal(props: { file: File; onCancel: () => void; onConfirm: (croppedFile: File) => void }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  const [aspect, setAspect] = useState<AspectMode>("1:1");
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // px within stage

  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const url = await fileToDataUrl(props.file);
      if (!alive) return;
      setDataUrl(url);

      const image = await loadImage(url);
      if (!alive) return;
      setImg(image);

      setZoom(1);
      setPos({ x: 0, y: 0 });
    })().catch(() => {
      setDataUrl(null);
      setImg(null);
    });

    return () => {
      alive = false;
    };
  }, [props.file]);

  // Empêche le scroll derrière la modale
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Drag global
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const d = dragRef.current;
      if (!d) return;
      setPos({ x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) });
    };
    const onUp = () => {
      setDragging(false);
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  function cropBoxSize(stageW: number, stageH: number): { w: number; h: number } {
    const maxW = Math.min(520, stageW - 64);
    const maxH = Math.min(520, stageH - 64);

    if (aspect === "free") {
      const w = maxW;
      const h = Math.min(maxH, Math.round(maxW * 0.75));
      return { w, h };
    }

    if (aspect === "1:1") {
      const s = Math.min(maxW, maxH);
      return { w: s, h: s };
    }

    // 4:3
    let w = maxW;
    let h = Math.round((w * 3) / 4);
    if (h > maxH) {
      h = maxH;
      w = Math.round((h * 4) / 3);
    }
    return { w, h };
  }

  async function confirmCrop() {
    if (!img) return;
    const stage = stageRef.current;
    if (!stage) return;

    const s = stage.getBoundingClientRect();
    const { w: cropW, h: cropH } = cropBoxSize(s.width, s.height);

    const cropLeft = (s.width - cropW) / 2;
    const cropTop = (s.height - cropH) / 2;

    const srcX = (cropLeft - pos.x) / zoom;
    const srcY = (cropTop - pos.y) / zoom;
    const srcW = cropW / zoom;
    const srcH = cropH / zoom;

    const sx = clamp(srcX, 0, img.width);
    const sy = clamp(srcY, 0, img.height);
    const sw = clamp(srcW, 1, img.width - sx);
    const sh = clamp(srcH, 1, img.height - sy);

    const maxOut = 1200;
    let outW = Math.round(sw);
    let outH = Math.round(sh);
    const scale = Math.min(1, maxOut / Math.max(outW, outH));
    outW = Math.max(1, Math.round(outW * scale));
    outH = Math.max(1, Math.round(outH * scale));

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);

    const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
    const cropped = new File([blob], `photo_cropped_${Date.now()}.jpg`, { type: "image/jpeg" });
    props.onConfirm(cropped);
  }

  function onWheelZoom(e: React.WheelEvent) {
    e.preventDefault();
    const delta = -e.deltaY;
    const step = delta > 0 ? 0.06 : -0.06;
    setZoom((z) => clamp(round(z + step, 2), 0.4, 4));
  }

  const stageStyle: React.CSSProperties = {
    position: "relative",
    width: "min(760px, 92vw)",
    height: "min(560px, 76vh)",
    borderRadius: 7,
    background:
      "linear-gradient(45deg, rgba(0,0,0,0.05) 25%, transparent 25%, transparent 50%, rgba(0,0,0,0.05) 50%, rgba(0,0,0,0.05) 75%, transparent 75%, transparent)",
    backgroundSize: "18px 18px",
    overflow: "hidden",
    border: "1px solid rgba(0,0,0,0.18)",
    cursor: dragging ? "grabbing" : "grab",
  };

  const stageRect = stageRef.current?.getBoundingClientRect();
  const cropDims = stageRect ? cropBoxSize(stageRect.width, stageRect.height) : { w: 420, h: 420 };

  const modal = (
    <div
      onMouseDown={() => props.onCancel()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.45)",
        display: "grid",
        placeItems: "center",
        padding: 18,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(920px, 96vw)",
          borderRadius: 9,
          background: "white",
          border: "1px solid rgba(0,0,0,0.12)",
          boxShadow: "0 24px 60px rgba(0,0,0,0.25)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontWeight: 900 }}>Recadrer la photo</div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, opacity: 0.7 }}>Ratio</span>
            <select
              value={aspect}
              onChange={(e) => setAspect(e.target.value as AspectMode)}
              style={{
                padding: "8px 10px",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.14)",
                background: "white",
                fontWeight: 700,
              }}
            >
              <option value="1:1">1:1</option>
              <option value="4:3">4:3</option>
              <option value="free">Libre</option>
            </select>

            <button
              onClick={props.onCancel}
              style={{
                padding: "8px 12px",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.14)",
                background: "white",
                fontWeight: 800,
              }}
            >
              Annuler
            </button>

            <button
              onClick={confirmCrop}
              style={{
                padding: "8px 12px",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.14)",
                background: "black",
                color: "white",
                fontWeight: 900,
              }}
            >
              Utiliser ce recadrage
            </button>
          </div>
        </div>

        <div style={{ padding: 14, display: "grid", gap: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Déplacer : drag • Zoom : molette ou slider</div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 800 }}>Zoom</span>
            <input
              type="range"
              min={0.4}
              max={4}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              style={{ width: 220 }}
            />
            <span style={{ fontFamily: "monospace", fontWeight: 800 }}>x{zoom.toFixed(2)}</span>
          </div>

          <div
            ref={stageRef}
            style={stageStyle}
            onWheel={onWheelZoom}
            onMouseDown={(e) => {
              setDragging(true);
              dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
            }}
          >
            {dataUrl && (
              <img
                src={dataUrl}
                alt=""
                draggable={false}
                style={{
                  position: "absolute",
                  left: pos.x,
                  top: pos.y,
                  transform: `scale(${zoom})`,
                  transformOrigin: "top left",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
              />
            )}

            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: cropDims.w,
                height: cropDims.h,
                transform: "translate(-50%, -50%)",
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
                borderRadius: 7,
                outline: "2px solid rgba(255,255,255,0.95)",
                pointerEvents: "none",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

export type RoomDetailsPanelHandle = {
  save: () => void;
};

type RoomDetailsPanelStatus = {
  saving: boolean;
  canSave: boolean;
};

type RoomDetailsPanelProps = {
  room: Room | null;
  services: ServiceColor[];
  onSave: (room: Room) => Promise<void>;
  onUploadPhoto: (roomId: string, file: File) => Promise<void>;
  onStatusChange?: (status: RoomDetailsPanelStatus) => void;
};

export const RoomDetailsPanel = forwardRef<RoomDetailsPanelHandle, RoomDetailsPanelProps>(function RoomDetailsPanel(
  props,
  ref
) {
  const [draft, setDraft] = useState<Room | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cropFile, setCropFile] = useState<File | null>(null);
  const [selectedPhotoName, setSelectedPhotoName] = useState<string | null>(null);
  const lastRoomIdRef = useRef<string | null>(null);

  useEffect(() => {
    setDraft(props.room ? { ...props.room } : null);
    setError(null);
    const nextRoomId = props.room?.id ?? null;
    if (lastRoomIdRef.current !== nextRoomId) {
      setSelectedPhotoName(null);
      lastRoomIdRef.current = nextRoomId;
    }
  }, [props.room]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await props.onSave(draft);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }, [draft, props.onSave]);

  useImperativeHandle(ref, () => ({ save }), [save]);

  useEffect(() => {
    props.onStatusChange?.({ saving, canSave: Boolean(draft) });
  }, [draft, props.onStatusChange, saving]);

  if (!props.room || !draft) {
    return (
      <div className="details-panel">
        <div className="details-panel-muted">Sélectionne une pièce.</div>
      </div>
    );
  }

  function set<K extends keyof Room>(k: K, v: Room[K]) {
    setDraft((prev) => (prev ? { ...prev, [k]: v } : prev));
  }

  const imgSrc = resolvePhotoUrl(draft.photoUrl);

  const rawService = String(draft.service ?? "").trim();
  const match = rawService
    ? props.services.find((s) => s.service.trim() === rawService) ?? null
    : null;

  // ✅ Sécurité UX :
  // - si le service stocké n’existe pas dans la palette, on force le select à "Aucun"
  // - et on affiche "non attribué"
  const serviceIsRecognized = !rawService || !!match;
  const selectValue = serviceIsRecognized ? rawService : "";

  const serviceColor = match?.color ?? null;

  return (
    <div className="details-panel">
      <div className="details-panel-header" data-drag-handle>
        <div className="details-panel-number">{draft.numero}</div>
      </div>

      {error && (
        <div
          style={{
            padding: 10,
            borderRadius: 12,
            border: "1px solid rgba(0,0,0,0.12)",
            background: "rgba(255,0,0,0.06)",
          }}
        >
          {error}
        </div>
      )}

      <div className="details-panel-section">
        <div className="details-panel-row details-panel-photo-row">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              className="details-panel-photo"
            >
              {imgSrc ? (
                <img src={imgSrc} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
              ) : (
                <span className="details-panel-muted">Pas de photo</span>
              )}
            </div>

            <div className="details-panel-upload">
              <input
                className="details-panel-file-input"
                id="room-photo-input"
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setError(null);
                  setSelectedPhotoName(f.name);
                  setCropFile(f);
                  e.currentTarget.value = "";
                }}
              />
              <label className="btn btn-mini details-panel-file-button" htmlFor="room-photo-input">
                Parcourir...
              </label>
              {selectedPhotoName && <div className="details-panel-filename">{selectedPhotoName}</div>}
            </div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label className="label">Nom de la personne</label>
            <input
              className="input"
              style={{ width: "100%" }}
              value={draft.personneNom ?? ""}
              onChange={(e) => set("personneNom", e.target.value)}
            />

            <label className="label" style={{ marginTop: 10 }}>Prénom</label>
            <input
              className="input"
              style={{ width: "100%" }}
              value={draft.personnePrenom ?? ""}
              onChange={(e) => set("personnePrenom", e.target.value)}
            />

            <label className="label" style={{ marginTop: 10 }}>Téléphone</label>
            <input
              className="input"
              style={{ width: "100%" }}
              value={draft.personneTel ?? ""}
              onChange={(e) => set("personneTel", e.target.value)}
            />
          </div>
        </div>
      </div>

      <hr className="details-panel-divider" />

      <div className="details-panel-section">
        <div className="details-panel-section-title">Localisation</div>

        <div className="details-panel-row" style={{ alignItems: "flex-start" }}>
          {/* ✅ SERVICE = select + sécurité "non attribué" */}
          <div className="field" style={{ flex: 1 }}>
            <label className="label" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span>Services</span>
              {serviceColor && (
                <span
                  title={serviceColor}
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 4,
                    background: serviceColor,
                    border: "1px solid rgba(0,0,0,0.18)",
                    display: "inline-block",
                  }}
                />
              )}
            </label>

            <select
              className="select"
              style={{ width: "100%" }}
              value={selectValue}
              onChange={(e) => set("service", e.target.value || null)}
            >
              <option value="">— Aucun —</option>
              {props.services.map((s) => (
                <option key={s.service} value={s.service}>
                  {s.service}
                </option>
              ))}
            </select>

            {!serviceIsRecognized && (
              <div
                className="hint"
                style={{
                  marginTop: 6,
                  padding: "8px 10px",
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "rgba(0,0,0,0.03)",
                }}
              >
                Service <b>non attribué</b> (valeur actuelle non trouvée dans la palette).
                <br />
                Choisis un service puis clique sur <b>Enregistrer</b>.
              </div>
            )}
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label className="label">Désignation</label>
            <input
              className="input"
              style={{ width: "100%" }}
              value={draft.designation ?? ""}
              onChange={(e) => set("designation", e.target.value)}
            />
          </div>
        </div>

        <div className="details-panel-row" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="label">Niveau</label>
            <input
              className="input"
              style={{ width: "100%" }}
              value={draft.niveau ?? ""}
              onChange={(e) => set("niveau", e.target.value)}
            />
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label className="label">Aile</label>
            <input
              className="input"
              style={{ width: "100%" }}
              value={draft.aile ?? ""}
              onChange={(e) => set("aile", e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label className="label">Surface</label>
          <input
            className="input"
            type="number"
            style={{ width: "100%" }}
            value={draft.surface ?? ""}
            onChange={(e) => set("surface", e.target.value === "" ? null : Number(e.target.value))}
          />
        </div>
      </div>

      <div className="details-panel-actions">
        <button className="btn btn-save" onClick={save} disabled={!draft || saving}>
          Enregistrer
        </button>
      </div>

      {cropFile && (
        <CropModal
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onConfirm={async (cropped) => {
            setCropFile(null);
            try {
              await props.onUploadPhoto(draft.id, cropped);
            } catch (err: any) {
              setError(String(err?.message ?? err));
            }
          }}
        />
      )}
    </div>
  );
});
