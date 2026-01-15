import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Room } from "../types";

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

function CropModal(props: {
  file: File;
  onCancel: () => void;
  onConfirm: (croppedFile: File) => void;
}) {
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
    borderRadius: 14,
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
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 99999,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
      onMouseDown={() => props.onCancel()}
    >
      <div
        style={{
          width: "min(860px, 96vw)",
          background: "rgba(255,255,255,0.96)",
          borderRadius: 18,
          border: "1px solid rgba(0,0,0,0.12)",
          boxShadow: "0 24px 60px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "12px 14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid rgba(0,0,0,0.10)",
          }}
        >
          <div style={{ fontWeight: 900 }}>Recadrer la photo</div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <label style={{ fontSize: 12, opacity: 0.8, fontWeight: 700 }}>Ratio</label>
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
                padding: "10px 12px",
                borderRadius: 14,
                border: "1px solid rgba(0,0,0,0.14)",
                background: "white",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Annuler
            </button>
            <button
              onClick={confirmCrop}
              disabled={!img}
              style={{
                padding: "10px 12px",
                borderRadius: 14,
                border: "1px solid rgba(0,0,0,0.14)",
                background: !img ? "rgba(0,0,0,0.08)" : "rgba(17,24,39,0.92)",
                color: !img ? "rgba(0,0,0,0.45)" : "white",
                fontWeight: 900,
                cursor: !img ? "not-allowed" : "pointer",
              }}
            >
              Utiliser ce recadrage
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: 14, display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "center" }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Déplacer : <b>drag</b> • Zoom : <b>molette</b> ou slider
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>Zoom</span>
              <input
                type="range"
                min={0.4}
                max={4}
                step={0.02}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                style={{ width: 220 }}
              />
              <span style={{ fontSize: 12, opacity: 0.75, width: 52, textAlign: "right" }}>
                x{zoom.toFixed(2)}
              </span>
            </div>
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
                alt="to crop"
                draggable={false}
                style={{
                  position: "absolute",
                  left: pos.x,
                  top: pos.y,
                  width: img ? img.width * zoom : "auto",
                  height: img ? img.height * zoom : "auto",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
              />
            )}

            {/* Crop box */}
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: cropDims.w,
                height: cropDims.h,
                transform: "translate(-50%, -50%)",
                borderRadius: 14,
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
                outline: "2px solid rgba(255,255,255,0.9)",
                pointerEvents: "none",
              }}
            />

            {/* Crosshair */}
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: 22,
                height: 22,
                transform: "translate(-50%, -50%)",
                border: "2px solid rgba(255,255,255,0.9)",
                borderRadius: 999,
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

export function RoomDetailsPanel(props: {
  room: Room | null;
  onSave: (room: Room) => Promise<void>;
  onUploadPhoto: (roomId: string, file: File) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Room | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);

  useEffect(() => {
    setDraft(props.room ? { ...props.room } : null);
    setError(null);
  }, [props.room]);

  const hasRoom = useMemo(() => !!props.room && !!draft, [props.room, draft]);

  async function save() {
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
  }

  if (!props.room || !draft) {
    return (
      <div style={{ padding: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Détails</div>
        <div>Sélectionne une pièce.</div>
      </div>
    );
  }

  function set<K extends keyof Room>(k: K, v: Room[K]) {
    setDraft((prev) => (prev ? { ...prev, [k]: v } : prev));
  }

  const imgSrc = resolvePhotoUrl(draft.photoUrl);

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>{draft.numero}</div>
        <button disabled={!hasRoom || saving} onClick={save}>
          {saving ? "Sauvegarde..." : "Enregistrer"}
        </button>
      </div>

      {error && (
        <div style={{ background: "#ffe5e5", padding: 8, border: "1px solid #ffb3b3" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div
          style={{
            width: 140,
            height: 140,
            borderRadius: 12,
            border: "1px solid rgba(0,0,0,0.15)",
            background:
              "linear-gradient(45deg, rgba(0,0,0,0.04) 25%, transparent 25%, transparent 50%, rgba(0,0,0,0.04) 50%, rgba(0,0,0,0.04) 75%, transparent 75%, transparent)",
            backgroundSize: "16px 16px",
            display: "grid",
            placeItems: "center",
            overflow: "hidden",
          }}
        >
          {imgSrc ? (
            <img src={imgSrc} alt="photo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          ) : (
            <span style={{ opacity: 0.6, fontSize: 12 }}>Pas de photo</span>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setError(null);
              setCropFile(f);
              e.currentTarget.value = "";
            }}
          />
          <div style={{ fontSize: 12, opacity: 0.7 }}>Recadrage avant upload (modale)</div>
        </div>
      </div>

      <hr />

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Niveau
        <input value={draft.niveau ?? ""} onChange={(e) => set("niveau", e.target.value)} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Aile
        <input value={draft.aile ?? ""} onChange={(e) => set("aile", e.target.value)} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Désignation
        <input value={draft.designation ?? ""} onChange={(e) => set("designation", e.target.value)} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Service
        <input value={draft.service ?? ""} onChange={(e) => set("service", e.target.value)} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Surface
        <input
          type="number"
          value={draft.surface ?? ""}
          onChange={(e) => set("surface", e.target.value === "" ? null : Number(e.target.value))}
        />
      </label>

      <hr />

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Nom de la personne
        <input value={draft.personneNom ?? ""} onChange={(e) => set("personneNom", e.target.value)} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Téléphone
        <input value={draft.personneTel ?? ""} onChange={(e) => set("personneTel", e.target.value)} />
      </label>

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
}
