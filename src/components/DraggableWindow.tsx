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
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<Position>(() => readStoredPosition(props.storageKey, props.defaultPosition));
  const [collapsed, setCollapsed] = useState(false);
  const [z, setZ] = useState(1000);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    writeStoredPosition(props.storageKey, pos);
  }, [props.storageKey, pos]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handle = root.querySelector(".card-header") as HTMLElement | null;
    if (!handle) return;

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, input, select, textarea, a, [role='button']")) return;
      dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    };

    const onDoubleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, input, select, textarea, a, [role='button']")) return;
      setCollapsed((prev) => !prev);
    };

    handle.style.cursor = "grab";
    handle.addEventListener("mousedown", onMouseDown);
    handle.addEventListener("dblclick", onDoubleClick);
    return () => {
      handle.style.cursor = "";
      handle.removeEventListener("mousedown", onMouseDown);
      handle.removeEventListener("dblclick", onDoubleClick);
    };
  }, [pos.x, pos.y]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;

      const w = rootRef.current?.offsetWidth ?? props.width;
      const nextX = d.ox + (e.clientX - d.sx);
      const nextY = d.oy + (e.clientY - d.sy);

      setPos({
        x: clamp(nextX, 6 - w + 120, window.innerWidth - 120),
        y: clamp(nextY, 6, window.innerHeight - 50),
      });
    };

    const onMouseUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [props.width]);

  return (
    <div
      ref={rootRef}
      className={`floating-card-window${collapsed ? " is-collapsed" : ""}`}
      style={{ left: pos.x, top: pos.y, width: props.width, zIndex: z }}
      onMouseDown={() => setZ((prev) => prev + 1)}
    >
      {props.children}
    </div>
  );
}
