import { useEffect, useRef, useState } from "react";

type Position = { x: number; y: number };

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
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
  collapsible?: boolean;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<Position>(() => readStoredPosition(props.storageKey, props.defaultPosition));
  const [collapsed, setCollapsed] = useState(false);
  const [z, setZ] = useState(1000);
  const dragRef = useRef<{ pointerId: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const captureHandleRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    writeStoredPosition(props.storageKey, pos);
  }, [props.storageKey, pos]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const headerHandle = root.querySelector(".card-header") as HTMLElement | null;
    const customHandles = Array.from(root.querySelectorAll("[data-drag-handle]")) as HTMLElement[];
    const handles = ([headerHandle, ...customHandles].filter(Boolean) as HTMLElement[]);
    const dragHandles = handles.length ? handles : [root];

    const isInteractiveTarget = (target: HTMLElement | null) =>
      Boolean(target?.closest("button, input, select, textarea, a, [role='button'], label"));

    const onPointerDown = (e: PointerEvent, handle: HTMLElement, allowChildTargets: boolean) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (isInteractiveTarget(target)) return;
      if (!allowChildTargets && target !== handle) return;
      handle.setPointerCapture(e.pointerId);
      captureHandleRef.current = handle;
      dragRef.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    };

    const onDoubleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (isInteractiveTarget(target)) return;
      setCollapsed((prev) => !prev);
    };

    const handleBindings = dragHandles.map((handle) => {
      const allowChildTargets = true;
      const onHandlePointerDown = (e: PointerEvent) => onPointerDown(e, handle, allowChildTargets);
      handle.style.cursor = "grab";
      handle.addEventListener("pointerdown", onHandlePointerDown);
      if (props.collapsible !== false && handle === headerHandle) {
        handle.addEventListener("dblclick", onDoubleClick);
      }
      return { handle, onHandlePointerDown };
    });
    return () => {
      handleBindings.forEach(({ handle, onHandlePointerDown }) => {
        handle.style.cursor = "";
        handle.removeEventListener("pointerdown", onHandlePointerDown);
        if (props.collapsible !== false && handle === headerHandle) {
          handle.removeEventListener("dblclick", onDoubleClick);
        }
      });
    };
  }, [pos.x, pos.y, props.collapsible]);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (e.pointerId !== d.pointerId) return;

      const w = rootRef.current?.offsetWidth ?? props.width;
      const nextX = d.ox + (e.clientX - d.sx);
      const nextY = d.oy + (e.clientY - d.sy);

      setPos({
        x: clamp(nextX, 6 - w + 120, window.innerWidth - 120),
        y: clamp(nextY, 6, window.innerHeight - 50),
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
      {props.children}
    </div>
  );
}
