import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function PdfCanvas(props: {
  pdfUrl: string;
  scale: number;
  page?: number; // défaut 1
  onPageCount?: (n: number) => void;
  onSize?: (w: number, h: number) => void;
}) {
  const pageNumber = props.page ?? 1;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderSeqRef = useRef(0);

  const [error, setError] = useState<string | null>(null);
  const [docTick, setDocTick] = useState(0);

  // Load document
  useEffect(() => {
    let disposed = false;

    async function load() {
      setError(null);

      try {
        renderTaskRef.current?.cancel();
      } catch {}
      renderTaskRef.current = null;

      try {
        pageRef.current?.cleanup();
      } catch {}
      pageRef.current = null;

      const oldDoc = docRef.current;
      docRef.current = null;
      if (oldDoc) {
        try {
          await oldDoc.destroy();
        } catch {}
      }

      try {
        const loadingTask = pdfjsLib.getDocument({ url: props.pdfUrl });
        const doc = await loadingTask.promise;

        if (disposed) {
          try {
            await doc.destroy();
          } catch {}
          return;
        }

        docRef.current = doc;
        props.onPageCount?.(doc.numPages || 1);
        setDocTick((x) => x + 1);
      } catch (e: any) {
        if (!disposed) setError(e?.message ? String(e.message) : "Erreur chargement PDF");
      }
    }

    load();

    return () => {
      disposed = true;

      try {
        renderTaskRef.current?.cancel();
      } catch {}
      renderTaskRef.current = null;

      try {
        pageRef.current?.cleanup();
      } catch {}
      pageRef.current = null;

      const d = docRef.current;
      docRef.current = null;
      if (d) {
        try {
          d.destroy();
        } catch {}
      }
    };
  }, [props.pdfUrl]);

  // Render page
  useEffect(() => {
    let disposed = false;

    async function render() {
      setError(null);

      const doc = docRef.current;
      const canvas = canvasRef.current;
      if (!doc || !canvas) return;

      try {
        renderTaskRef.current?.cancel();
      } catch {}
      renderTaskRef.current = null;

      const seq = ++renderSeqRef.current;

      try {
        const page = await doc.getPage(pageNumber);
        if (disposed || seq !== renderSeqRef.current) {
          try {
            page.cleanup();
          } catch {}
          return;
        }

        pageRef.current = page;

        const viewport = page.getViewport({ scale: props.scale });
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return;

        const vw = Math.max(1, Math.ceil(viewport.width));
        const vh = Math.max(1, Math.ceil(viewport.height));

        canvas.width = vw;
        canvas.height = vh;
        canvas.style.width = `${vw}px`;
        canvas.style.height = `${vh}px`;
        canvas.style.display = "block";

        const emitSize = () => {
          const r = canvas.getBoundingClientRect();
          props.onSize?.(Math.round(r.width), Math.round(r.height));
        };

        requestAnimationFrame(emitSize);

        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;

        await task.promise;

        if (disposed || seq !== renderSeqRef.current) return;

        requestAnimationFrame(emitSize);
      } catch (e: any) {
        const name = String(e?.name ?? "");
        const msg = String(e?.message ?? e ?? "");
        const isCancelled =
          name === "RenderingCancelledException" || msg.toLowerCase().includes("rendering cancelled");
        if (isCancelled) return;
        if (!disposed) setError(msg);
      }
    }

    render();

    return () => {
      disposed = true;
      try {
        renderTaskRef.current?.cancel();
      } catch {}
      renderTaskRef.current = null;
    };
  }, [props.scale, pageNumber, props.pdfUrl, docTick]);

  return (
    <div style={{ position: "relative" }}>
      <canvas ref={canvasRef} />
      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(255,255,255,0.92)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 12,
            fontFamily: "monospace",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
