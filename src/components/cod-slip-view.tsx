"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { PdfSlipError, renderPdfPages } from "@/lib/ops-pulse/pdf-slip";

type PdfState =
  | { kind: "loading" }
  | { kind: "ready"; urls: string[]; totalPages: number }
  | { kind: "error"; message: string };

/** Pages of a PDF slip drawn as images, so a PDF sits where a photo would. */
export function PdfSlipPages({
  source,
  alt,
  style,
  maxPages = 1,
  width = 1400,
  lazy = false
}: {
  /** A URL to fetch, or the picked file itself. */
  source: string | Blob;
  alt: string;
  style?: CSSProperties;
  maxPages?: number;
  /** Render width in pixels; keep it small for thumbnails. */
  width?: number;
  /** Wait until the placeholder scrolls into view before fetching. */
  lazy?: boolean;
}) {
  const [state, setState] = useState<PdfState>({ kind: "loading" });
  const [visible, setVisible] = useState(!lazy);
  const placeholder = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (visible) return;
    const node = placeholder.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let urls: string[] = [];
    setState({ kind: "loading" });
    (async () => {
      try {
        let data: ArrayBuffer;
        if (typeof source === "string") {
          const response = await fetch(source);
          if (!response.ok) throw new PdfSlipError("The slip could not be loaded.");
          data = await response.arrayBuffer();
        } else {
          data = await source.arrayBuffer();
        }
        const rendered = await renderPdfPages(data, { maxPages, width });
        if (cancelled) return;
        urls = rendered.pages.map((page) => URL.createObjectURL(page.blob));
        setState({ kind: "ready", urls, totalPages: rendered.totalPages });
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: error instanceof PdfSlipError ? error.message : "The PDF preview could not be shown."
        });
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [source, maxPages, width, visible]);

  if (state.kind !== "ready") {
    return (
      <span
        ref={placeholder}
        title={state.kind === "error" ? state.message : undefined}
        style={{
          ...style,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
          fontSize: 11,
          fontWeight: 600,
          color: "#64748b",
          background: "#f6f6f6"
        }}
      >
        {state.kind === "loading" ? "PDF…" : "PDF"}
      </span>
    );
  }

  const images = state.urls.map((url, index) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={url}
      alt={state.urls.length > 1 ? `${alt} (page ${index + 1})` : alt}
      src={url}
      style={state.urls.length > 1 ? { ...style, maxHeight: undefined } : style}
    />
  ));
  if (maxPages === 1) return images[0];

  return (
    <div style={{ display: "grid", gap: 8, maxHeight: style?.maxHeight, overflowY: "auto" }}>
      {images}
      {state.totalPages > state.urls.length ? (
        <span className="subtle">
          Showing the first {state.urls.length} of {state.totalPages} pages. Open the slip to see the rest.
        </span>
      ) : null}
    </div>
  );
}

/** A stored deposit slip: a photo as it is, a PDF as images of its pages. */
export function CodSlipView({
  url,
  pdf,
  alt,
  style,
  maxPages,
  width,
  lazy
}: {
  url: string;
  pdf: boolean;
  alt: string;
  style?: CSSProperties;
  maxPages?: number;
  width?: number;
  lazy?: boolean;
}) {
  if (pdf) return <PdfSlipPages source={url} alt={alt} style={style} maxPages={maxPages} width={width} lazy={lazy} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt={alt} src={url} style={style} />;
}
