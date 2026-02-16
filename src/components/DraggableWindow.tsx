import { useEffect, useRef, useState } from "react";

type Position = { x: number; y: number };

const MIN_VISIBLE_GRAB_AREA = 32;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function getViewportBounds(zoom = 1) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    width: window.innerWidth / safeZoom,
    height: window.innerHeight / safeZoom,
  };
}

function clampPositionToViewport(pos: Position, width: number, zoom = 1): Position {
  const viewport = getViewportBounds(zoom);
  const minX = 6 - width + MIN_VISIBLE_GRAB_AREA;
  const maxX = viewport.width - MIN_VISIBLE_GRAB_AREA;
  const minY = 6;
  const maxY = viewport.height - 50;

  return {
    x: clamp(pos.x, minX, maxX),
    y: clamp(pos.y, minY, maxY),
  };
}


function readZoomFromNode(node: HTMLElement | null): number {
  if (!node) return 1;
  const zoomNode = node.closest(".ui-zoom") as HTMLElement | null;
  if (!zoomNode) return 1;
  const raw = window.getComputedStyle(zoomNode).zoom;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}
function readStoredPosition(key: string, fallback: Position): Position {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Position>;
    if (typeof parsed?.x !== "number" || typeof parsed?.y !== "number") return fallback;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return fallback;
  }
}

function writeStoredPosition(key: string, value: Position) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function DraggableWindow(props: {
  storageKey: string;
  defaultPosition: Position;
  width: number;
  title: string;
  collapsible?: boolean;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<Position>(() => readStoredPosition(props.storageKey, props.defaultPosition));
  const [collapsed, setCollapsed] = useState(false);
  const [z, setZ] = useState(1000);
  const dragRef = useRef<{
    pointerId: number;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);
  const captureHandleRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    writeStoredPosition(props.storageKey, pos);
  }, [props.storageKey, pos]);

  useEffect(() => {
    const width = rootRef.current?.offsetWidth ?? props.width;
    setPos((prev) => {
      const next = clampPositionToViewport(prev, width, readZoomFromNode(rootRef.current));
      if (next.x === prev.x && next.y === prev.y) return prev;
      return next;
    });
  }, [props.width]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const headerHandle = root.querySelector(".floating-panel-header") as HTMLElement | null;
    if (!headerHandle) return;

    const isInteractiveTarget = (target: HTMLElement | null) =>
      Boolean(target?.closest("button, input, select, textarea, a, [role='button'], label"));

    const onPointerDown = (e: PointerEvent, handle: HTMLElement, allowChildTargets: boolean) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (isInteractiveTarget(target)) return;
      if (!allowChildTargets && target !== handle) return;
      handle.setPointerCapture(e.pointerId);
      captureHandleRef.current = handle;
      dragRef.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
    };

    const onDoubleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (isInteractiveTarget(target)) return;
      setCollapsed((prev) => !prev);
    };

    const onHandlePointerDown = (e: PointerEvent) => onPointerDown(e, headerHandle, true);
    headerHandle.style.cursor = "grab";
    headerHandle.addEventListener("pointerdown", onHandlePointerDown);
    if (props.collapsible !== false) {
      headerHandle.addEventListener("dblclick", onDoubleClick);
    }

    return () => {
      headerHandle.style.cursor = "";
      headerHandle.removeEventListener("pointerdown", onHandlePointerDown);
      if (props.collapsible !== false) {
        headerHandle.removeEventListener("dblclick", onDoubleClick);
      }
    };
  }, [pos.x, pos.y, props.collapsible]);

  useEffect(() => {
    const clampCurrentPosition = () => {
      const width = rootRef.current?.offsetWidth ?? props.width;
      setPos((prev) => {
        const next = clampPositionToViewport(prev, width, readZoomFromNode(rootRef.current));
        if (next.x === prev.x && next.y === prev.y) return prev;
        return next;
      });
    };

    window.addEventListener("resize", clampCurrentPosition);

    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (e.pointerId !== d.pointerId) return;

      const zoom = readZoomFromNode(rootRef.current);
      const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      const movedEnough = Math.hypot(dx, dy) >= 4;

      if (!d.moved && !movedEnough) return;
      if (!d.moved) d.moved = true;

      const w = rootRef.current?.offsetWidth ?? props.width;
      const nextX = d.ox + dx / safeZoom;
      const nextY = d.oy + dy / safeZoom;

      const viewport = getViewportBounds(zoom);

      setPos({
        x: clamp(nextX, 6 - w + MIN_VISIBLE_GRAB_AREA, viewport.width - MIN_VISIBLE_GRAB_AREA),
        y: clamp(nextY, 6, viewport.height - 50),
      });
    };

    const endDrag = (pointerId: number) => {
      if (captureHandleRef.current?.hasPointerCapture(pointerId)) {
        captureHandleRef.current.releasePointerCapture(pointerId);
      }
      captureHandleRef.current = null;
      dragRef.current = null;
    };

    const onPointerUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      endDrag(e.pointerId);
    };

    const onPointerCancel = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      endDrag(e.pointerId);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      window.removeEventListener("resize", clampCurrentPosition);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [props.width]);

  return (
    <div
      ref={rootRef}
      className={`floating-card-window${collapsed && props.collapsible !== false ? " is-collapsed" : ""}`}
      style={{ left: pos.x, top: pos.y, width: props.width, zIndex: z }}
      onMouseDown={() => setZ((prev) => prev + 1)}
    >
      <div className="floating-panel-shell">
        <div className="card-header floating-panel-header" title="Glisser pour déplacer • Double-clic pour replier/déplier">
          <div className="card-title">{props.title}</div>
          {props.collapsible !== false && (
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => setCollapsed((prev) => !prev)}
              onPointerDown={(e) => e.stopPropagation()}
              title={collapsed ? "Déplier" : "Replier"}
              aria-label={collapsed ? "Déplier" : "Replier"}
            >
              {collapsed ? "▾" : "▴"}
            </button>
          )}
        </div>
        <div className="floating-panel-content">{props.children}</div>
      </div>
    </div>
  );
}
