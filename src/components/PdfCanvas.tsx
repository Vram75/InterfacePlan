import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";

// ✅ Vite: worker as URL string
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

type Props = {
  pdfUrl: string;
  page: number; // 1-based
  scale: number;
  onPageCount?: (n: number) => void;
  onSize?: (w: number, h: number) => void;
};

export function PdfCanvas({ pdfUrl, page, scale, onPageCount, onSize }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  // ✅ keep latest callbacks without triggering effects
  const onPageCountRef = useRef<Props["onPageCount"]>(onPageCount);
  const onSizeRef = useRef<Props["onSize"]>(onSize);
  useEffect(() => {
    onPageCountRef.current = onPageCount;
    onSizeRef.current = onSize;
  }, [onPageCount, onSize]);

  // ✅ avoid spamming onSize
  const lastSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(1);

  // Load PDF once per url
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        renderTaskRef.current?.cancel?.();
        renderTaskRef.current = null;

        const loadingTask = pdfjsLib.getDocument({ url: pdfUrl });
        const doc = await loadingTask.promise;

        if (cancelled) {
          try {
            await doc.destroy();
          } catch {}
          return;
        }

        setPdf(doc);
        setNumPages(doc.numPages);
        onPageCountRef.current?.(doc.numPages);
      } catch (e) {
        console.error("PdfCanvas: failed to load pdf", e);
        setPdf(null);
        setNumPages(1);
        onPageCountRef.current?.(1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  const safePage = useMemo(() => {
    const p = Math.floor(page || 1);
    return Math.max(1, Math.min(p, Math.max(1, numPages)));
  }, [page, numPages]);

  // Render current page
  useEffect(() => {
    if (!pdf) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    (async () => {
      try {
        // Cancel previous render if any
        renderTaskRef.current?.cancel?.();
        renderTaskRef.current = null;

        const pdfPage = await pdf.getPage(safePage);
        const viewport = pdfPage.getViewport({ scale: scale || 1 });

        const w = Math.max(1, Math.floor(viewport.width));
        const h = Math.max(1, Math.floor(viewport.height));

        // ✅ only update canvas & onSize if dimensions changed
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;

        const last = lastSizeRef.current;
        if (last.w !== w || last.h !== h) {
          lastSizeRef.current = { w, h };
          onSizeRef.current?.(w, h);
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const task = pdfPage.render({ canvas, canvasContext: ctx, viewport });
        renderTaskRef.current = task;

        await task.promise;

        if (cancelled) return;
      } catch (e: any) {
        if (e?.name === "RenderingCancelledException") return;
        console.error("PdfCanvas: render error", e);
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel?.();
      renderTaskRef.current = null;
    };
  }, [pdf, safePage, scale]);

  return <canvas ref={canvasRef} />;
}
