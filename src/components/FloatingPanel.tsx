import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type FloatingRect = { x: number; y: number; w: number; h: number };

type Props = {
  title: string;

  rect: FloatingRect;
  onRectChange: (next: FloatingRect) => void;

  onDock: () => void;

  collapsed: boolean;
  onToggleCollapsed: () => void;

  children: React.ReactNode;
};

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function nearlyEqual(a: number, b: number, eps = 0.5) {
  return Math.abs(a - b) <= eps;
}

function clampRectToViewport(
  rect: FloatingRect,
  opts: {
    headerH: number;
    margin: number;
    minVisibleHeader: number;
    minW: number;
    minH: number;
    collapsed: boolean;
  }
): FloatingRect {
  const vw = Math.max(1, window.innerWidth || 1);
  const vh = Math.max(1, window.innerHeight || 1);

  const { headerH, margin, minVisibleHeader, minW, minH, collapsed } = opts;

  // clamp sizes
  const maxW = Math.max(minW, vw - margin * 2);
  const maxHExpanded = Math.max(minH, vh - margin * 2);

  const w = clamp(rect.w, minW, maxW);
  const hStored = clamp(rect.h, minH, maxHExpanded);

  // clamp position (keep header reachable)
  const minX = -w + minVisibleHeader + margin;
  const maxX = vw - minVisibleHeader - margin;

  const minY = margin;
  const maxY = vh - headerH - margin;

  const x = clamp(rect.x, minX, maxX);
  const y = clamp(rect.y, minY, maxY);

  // If collapsed, visual height is header only, but we keep stored h clamped for when expanded.
  // We still clamp y to keep header visible.
  void collapsed;

  return { x, y, w, h: hStored };
}

type DragState =
  | null
  | { kind: "move"; sx: number; sy: number; ox: number; oy: number }
  | { kind: "resize"; sx: number; sy: number; ow: number; oh: number };

export function FloatingPanel({
  title,
  rect,
  onRectChange,
  onDock,
  collapsed,
  onToggleCollapsed,
  children,
}: Props) {
  const [z, setZ] = useState(99990);

  // tweakables
  const headerH = 46;
  const margin = 8;
  const minVisibleHeader = 140;
  const minW = 320;
  const minH = 220;

  const dragRef = useRef<DragState>(null);

  const bringToFront = () => setZ((prev) => Math.max(prev + 1, 99990));

  // Clamp on mount + viewport resize + collapsed change
  useEffect(() => {
    const applyClamp = () => {
      const next = clampRectToViewport(rect, {
        headerH,
        margin,
        minVisibleHeader,
        minW,
        minH,
        collapsed,
      });

      const changed =
        !nearlyEqual(next.x, rect.x) ||
        !nearlyEqual(next.y, rect.y) ||
        !nearlyEqual(next.w, rect.w) ||
        !nearlyEqual(next.h, rect.h);

      if (changed) onRectChange(next);
    };

    applyClamp();
    window.addEventListener("resize", applyClamp);
    return () => window.removeEventListener("resize", applyClamp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, rect.x, rect.y, rect.w, rect.h]);

  // Drag + Resize handling
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;

      if (d.kind === "move") {
        const raw: FloatingRect = {
          ...rect,
          x: d.ox + (e.clientX - d.sx),
          y: d.oy + (e.clientY - d.sy),
        };

        const next = clampRectToViewport(raw, {
          headerH,
          margin,
          minVisibleHeader,
          minW,
          minH,
          collapsed,
        });

        onRectChange(next);
        return;
      }

      if (d.kind === "resize") {
        // resize from bottom-right: keep x/y fixed, change w/h
        const raw: FloatingRect = {
          ...rect,
          w: d.ow + (e.clientX - d.sx),
          h: d.oh + (e.clientY - d.sy),
        };

        const next = clampRectToViewport(raw, {
          headerH,
          margin,
          minVisibleHeader,
          minW,
          minH,
          collapsed,
        });

        // Keep x/y from current rect (clamp may adjust x/y a bit if needed)
        onRectChange(next);
      }
    };

    const onUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, collapsed, onRectChange]);

  const displayH = collapsed ? headerH : rect.h;

  const node = (
    <div
      style={{
        position: "fixed",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: displayH,
        zIndex: z,
        borderRadius: 18,
        border: "1px solid rgba(20, 32, 50, 0.14)",
        background: "rgba(255,255,255,0.96)",
        boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        backdropFilter: "blur(10px)",
      }}
      onMouseDown={bringToFront}
    >
      {/* Header (drag to move) */}
      <div
        style={{
          height: headerH,
          padding: "0 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: collapsed ? "none" : "1px solid rgba(20, 32, 50, 0.10)",
          cursor: "grab",
          userSelect: "none",
          background: "rgba(255,255,255,0.55)",
        }}
        onMouseDown={(e) => {
          bringToFront();
          dragRef.current = { kind: "move", sx: e.clientX, sy: e.clientY, ox: rect.x, oy: rect.y };
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onToggleCollapsed();
        }}
        title="Drag pour déplacer • Double-clic pour replier/déplier"
      >
        <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: "-0.01em" }}>
          {title} {collapsed ? "— replié" : ""}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            className="btn btn-mini"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onToggleCollapsed}
            title={collapsed ? "Déplier" : "Replier"}
            style={{ padding: "8px 10px" }}
          >
            {collapsed ? "▾" : "▴"}
          </button>

          <button
            className="btn btn-mini"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onDock}
            title="Raccrocher (dock)"
            style={{ padding: "8px 10px" }}
          >
            ↘ Dock
          </button>
        </div>
      </div>

      {/* Body */}
      {!collapsed && (
        <div style={{ padding: 14, overflow: "auto", flex: 1 }} onMouseDown={bringToFront}>
          {children}
        </div>
      )}

      {/* Resize handle (bottom-right) */}
      {!collapsed && (
        <div
          onMouseDown={(e) => {
            // prevent initiating move or clicks behind
            e.preventDefault();
            e.stopPropagation();
            bringToFront();
            dragRef.current = { kind: "resize", sx: e.clientX, sy: e.clientY, ow: rect.w, oh: rect.h };
          }}
          title="Redimensionner"
          style={{
            position: "absolute",
            right: 6,
            bottom: 6,
            width: 16,
            height: 16,
            cursor: "nwse-resize",
            borderRadius: 6,
            background: "rgba(17,24,39,0.08)",
            border: "1px solid rgba(17,24,39,0.10)",
          }}
        >
          {/* little corner glyph */}
          <svg width="16" height="16" viewBox="0 0 16 16" style={{ display: "block" }}>
            <path
              d="M6 15L15 6"
              stroke="rgba(17,24,39,0.35)"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <path
              d="M9 15L15 9"
              stroke="rgba(17,24,39,0.25)"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <path
              d="M12 15L15 12"
              stroke="rgba(17,24,39,0.18)"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </div>
      )}
    </div>
  );

  return createPortal(node, document.body);
}
