import { useEffect, useRef, useState } from "react";
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
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const captureRef = useRef<HTMLElement | null>(null);

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
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      setPos({ x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) });
    };

    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;

      if (captureRef.current?.hasPointerCapture(d.pointerId)) {
        captureRef.current.releasePointerCapture(d.pointerId);
      }
      setDragging(false);
      dragRef.current = null;
      captureRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

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
      data-room-details-modal="true"
      onMouseDown={() => props.onCancel()}
      className="crop-modal-overlay"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="crop-modal-panel"
      >
        <div className="crop-modal-header">
          <div className="crop-modal-title">Recadrer la photo</div>

          <div className="crop-modal-toolbar">
            <span className="crop-modal-toolbar-label">Ratio</span>
            <select
              value={aspect}
              onChange={(e) => setAspect(e.target.value as AspectMode)}
              className="crop-modal-select"
            >
              <option value="1:1">1:1</option>
              <option value="4:3">4:3</option>
              <option value="free">Libre</option>
            </select>

            <button
              onClick={props.onCancel}
              className="btn btn-mini crop-modal-btn"
            >
              Annuler
            </button>

            <button
              onClick={confirmCrop}
              className="btn btn-mini crop-modal-btn crop-modal-btn-primary"
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
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              captureRef.current = e.currentTarget;
              setDragging(true);
              dragRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                origX: pos.x,
                origY: pos.y,
              };
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

type RoomDetailsPanelProps = {
  room: Room | null;
  services: ServiceColor[];
  onSave: (room: Room) => Promise<void>;
  onUploadPhoto: (roomId: string, file: File) => Promise<void>;
};

export function RoomDetailsPanel(props: RoomDetailsPanelProps) {
  const { room, services, onSave, onUploadPhoto } = props;
  const [draft, setDraft] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isSavingRef = useRef(false);
  const pendingDraftRef = useRef<Room | null>(null);

  const [cropFile, setCropFile] = useState<File | null>(null);

  useEffect(() => {
    setDraft(room ? { ...room } : null);
    setError(null);
  }, [room]);

  const saveDraft = async (nextDraft: Room) => {
      pendingDraftRef.current = nextDraft;
      if (isSavingRef.current) return;

      isSavingRef.current = true;
      while (pendingDraftRef.current) {
        const payload = pendingDraftRef.current;
        pendingDraftRef.current = null;

        setError(null);
        try {
          await onSave(payload);
        } catch (e: any) {
          setError(String(e?.message ?? e));
          pendingDraftRef.current = null;
          break;
        }
      }
      isSavingRef.current = false;
    };

  if (!room || !draft) {
    return (
      <div className="details-panel">
        <div className="details-panel-muted">Sélectionne une pièce.</div>
      </div>
    );
  }

  function set<K extends keyof Room>(k: K, v: Room[K]) {
    setDraft((prev) => {
      if (!prev) return prev;
      const nextDraft = { ...prev, [k]: v };
      void saveDraft(nextDraft);
      return nextDraft;
    });
  }

  const imgSrc = resolvePhotoUrl(draft.photoUrl);

  const rawService = String(draft.service ?? "").trim();
  const match = rawService
    ? services.find((s) => s.service.trim() === rawService) ?? null
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
                  setCropFile(f);
                  e.currentTarget.value = "";
                }}
              />
              <label className="btn btn-mini details-panel-file-button" htmlFor="room-photo-input">
                Parcourir...
              </label>
            </div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label className="label">Nom</label>
            <input
              className="input details-panel-compact-input"
              value={draft.personneNom ?? ""}
              onChange={(e) => set("personneNom", e.target.value)}
            />

            <label className="label" style={{ marginTop: 10 }}>Prénom</label>
            <input
              className="input details-panel-compact-input"
              value={draft.personnePrenom ?? ""}
              onChange={(e) => set("personnePrenom", e.target.value)}
            />

            <label className="label" style={{ marginTop: 10 }}>Téléphone</label>
            <input
              className="input details-panel-compact-input"
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
              className="select details-panel-compact-input"
              value={selectValue}
              onChange={(e) => set("service", e.target.value || null)}
            >
              <option value="">— Aucun —</option>
              {services.map((s) => (
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
                Choisis un service pour sauvegarder automatiquement.
              </div>
            )}
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label className="label">Désignation</label>
            <input
              className="input details-panel-compact-input"
              value={draft.designation ?? ""}
              onChange={(e) => set("designation", e.target.value)}
            />
          </div>
        </div>

        <div className="details-panel-row" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="label">Niveau</label>
            <input
              className="input details-panel-compact-input"
              value={draft.niveau ?? ""}
              onChange={(e) => set("niveau", e.target.value)}
            />
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label className="label">Aile</label>
            <input
              className="input details-panel-compact-input"
              value={draft.aile ?? ""}
              onChange={(e) => set("aile", e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label className="label">Surface</label>
          <input
            className="input details-panel-compact-input"
            type="number"
            value={draft.surface ?? ""}
            onChange={(e) => set("surface", e.target.value === "" ? null : Number(e.target.value))}
          />
        </div>
      </div>
      {cropFile && (
        <CropModal
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onConfirm={async (cropped) => {
            setCropFile(null);
            try {
              await onUploadPhoto(draft.id, cropped);
            } catch (err: any) {
              setError(String(err?.message ?? err));
            }
          }}
        />
      )}
    </div>
  );
}
