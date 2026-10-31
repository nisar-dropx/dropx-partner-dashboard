"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LocateFixed, Minus, Plus } from "lucide-react";
import type { CortexStop } from "@/lib/ops-pulse/cortex-data";
import { isValidGeo } from "@/lib/ops-pulse/cortex-geo";
import styles from "./cortex-workspace.module.css";

type Point = [number, number];
type XY = { x: number; y: number };

const TILE = 256;
const MIN_ZOOM = 4;
const MAX_ZOOM = 18;

export { isValidGeo };

function world(p: Point, z: number): XY {
  const scale = TILE * 2 ** z;
  const s = Math.sin((Math.max(-85, Math.min(85, p[0])) * Math.PI) / 180);
  return {
    x: ((p[1] + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

function bounds(points: Point[], z: number) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of points) {
    const v = world(p, z);
    minX = Math.min(minX, v.x);
    maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  return { minX, maxX, minY, maxY };
}

function polylinePoints(path: Point[], screen: (p: Point) => XY) {
  return path
    .map((p) => {
      const v = screen(p);
      return `${v.x},${v.y}`;
    })
    .join(" ");
}

export function CortexRouteMap({
  plannedPath,
  actualPath,
  stops,
}: {
  plannedPath: Point[];
  actualPath: Point[];
  stops: CortexStop[];
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 420 });
  const [camera, setCamera] = useState<{ zoom: number; center: XY } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const geoStops = useMemo(
    () =>
      stops
        .map((stop, index) => ({ stop, index }))
        .filter(({ stop }) => isValidGeo(stop.lat, stop.lng)) as Array<{
        stop: CortexStop & { lat: number; lng: number };
        index: number;
      }>,
    [stops],
  );

  const planned = useMemo(
    () => plannedPath.filter(([lat, lng]) => isValidGeo(lat, lng)),
    [plannedPath],
  );
  const actual = useMemo(
    () => actualPath.filter(([lat, lng]) => isValidGeo(lat, lng)),
    [actualPath],
  );

  const fitPoints = useMemo(() => {
    const pts: Point[] = [...planned, ...actual, ...geoStops.map(({ stop }) => [stop.lat, stop.lng] as Point)];
    return pts;
  }, [planned, actual, geoStops]);

  useEffect(() => {
    if (!wrap.current) return;
    const measure = () =>
      setSize({
        width: Math.max(240, wrap.current!.clientWidth),
        height: Math.max(280, Math.min(520, wrap.current!.clientWidth * 0.72)),
      });
    const observer = new ResizeObserver(measure);
    observer.observe(wrap.current);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setCamera(null);
    setSelected(null);
  }, [plannedPath, actualPath, stops]);

  const W = size.width;
  const H = size.height;

  const fit = useMemo(() => {
    if (!fitPoints.length) {
      return { zoom: 11, center: world([20.5937, 78.9629], 11) };
    }
    let zoom = MIN_ZOOM;
    for (let z = 16; z >= MIN_ZOOM; z--) {
      const b = bounds(fitPoints, z);
      if (b.maxX - b.minX < W - 72 && b.maxY - b.minY < H - 72) {
        zoom = z;
        break;
      }
    }
    const b = bounds(fitPoints, zoom);
    return {
      zoom,
      center: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
    };
  }, [fitPoints, W, H]);

  const { zoom, center } = camera ?? fit;
  const left = center.x - W / 2;
  const top = center.y - H / 2;
  const screen = (p: Point) => {
    const v = world(p, zoom);
    return { x: v.x - left, y: v.y - top };
  };

  function zoomBy(delta: number, anchor: XY = { x: W / 2, y: H / 2 }) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + delta));
    const factor = 2 ** (next - zoom);
    setCamera({
      zoom: next,
      center: {
        x: (left + anchor.x) * factor - anchor.x + W / 2,
        y: (top + anchor.y) * factor - anchor.y + H / 2,
      },
    });
  }

  const pointers = useRef(new Map<number, XY>());
  const gesture = useRef<{ center: XY; zoom: number; mid: XY; distance: number } | null>(null);

  function beginGesture() {
    const p = [...pointers.current.values()];
    if (!p.length) {
      gesture.current = null;
      return;
    }
    const mid = p.length > 1 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : p[0];
    gesture.current = {
      center,
      zoom,
      mid,
      distance: p.length > 1 ? Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) : 0,
    };
  }

  const location = (event: React.PointerEvent<SVGSVGElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - r.left) * W) / r.width,
      y: ((event.clientY - r.top) * H) / r.height,
    };
  };

  const finish = (event: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    beginGesture();
  };

  if (!fitPoints.length) {
    return (
      <div className={styles.mapEmpty} role="status">
        <strong>No map coordinates</strong>
        <span>This itinerary has no planned or scan locations to plot.</span>
      </div>
    );
  }

  const tiles = [];
  for (let x = Math.floor(left / TILE); x <= Math.floor((left + W) / TILE); x++) {
    for (let y = Math.floor(top / TILE); y <= Math.floor((top + H) / TILE); y++) {
      if (y >= 0 && y < 2 ** zoom) {
        tiles.push({
          x,
          y,
          url: `https://tile.openstreetmap.org/${zoom}/${(x + 2 ** zoom) % 2 ** zoom}/${y}.png`,
        });
      }
    }
  }

  const selectedStop = selected == null ? null : geoStops.find((g) => g.index === selected)?.stop || null;

  return (
    <div className={styles.mapWrap} ref={wrap}>
      <div className={styles.mapToolbar} aria-label="Map controls">
        <div className={styles.mapLegend}>
          <span className={styles.legendPlanned}>Planned</span>
          <span className={styles.legendActual}>Actual scans</span>
          <span>
            {geoStops.length} stop{geoStops.length === 1 ? "" : "s"} with location
          </span>
        </div>
        <div className={styles.mapButtons}>
          <button type="button" onClick={() => zoomBy(1)} aria-label="Zoom in" title="Zoom in">
            <Plus size={14} />
          </button>
          <button type="button" onClick={() => zoomBy(-1)} aria-label="Zoom out" title="Zoom out">
            <Minus size={14} />
          </button>
          <button type="button" onClick={() => setCamera(null)} aria-label="Fit route" title="Fit route">
            <LocateFixed size={14} />
          </button>
        </div>
      </div>
      <div className={styles.mapViewport}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className={styles.mapCanvas}
          tabIndex={0}
          aria-label="Route map. Drag to pan, plus and minus to zoom, zero to fit."
          onKeyDown={(e) => {
            if (["+", "=", "-", "0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
              e.preventDefault();
              if (e.key === "+" || e.key === "=") zoomBy(1);
              else if (e.key === "-") zoomBy(-1);
              else if (e.key === "0") setCamera(null);
              else {
                setCamera({
                  zoom,
                  center: {
                    x: center.x + (e.key === "ArrowRight" ? 80 : e.key === "ArrowLeft" ? -80 : 0),
                    y: center.y + (e.key === "ArrowDown" ? 80 : e.key === "ArrowUp" ? -80 : 0),
                  },
                });
              }
            }
          }}
          onDoubleClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            zoomBy(1, {
              x: ((e.clientX - r.left) * W) / r.width,
              y: ((e.clientY - r.top) * H) / r.height,
            });
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            pointers.current.set(e.pointerId, location(e));
            beginGesture();
          }}
          onPointerMove={(e) => {
            if (!pointers.current.has(e.pointerId) || !gesture.current) return;
            pointers.current.set(e.pointerId, location(e));
            const p = [...pointers.current.values()];
            const g = gesture.current;
            const mid = p.length > 1 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : p[0];
            const delta =
              p.length > 1 && g.distance > 0
                ? Math.round(Math.log2(Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) / g.distance))
                : 0;
            const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, g.zoom + delta));
            const factor = 2 ** (z - g.zoom);
            setCamera({
              zoom: z,
              center: {
                x: (g.center.x - W / 2 + g.mid.x) * factor - mid.x + W / 2,
                y: (g.center.y - H / 2 + g.mid.y) * factor - mid.y + H / 2,
              },
            });
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
        >
          <title>Planned stops and actual scan path</title>
          {tiles.map((tile) => (
            <image
              key={`${zoom}/${tile.x}/${tile.y}`}
              href={tile.url}
              x={tile.x * TILE - left}
              y={tile.y * TILE - top}
              width={TILE}
              height={TILE}
            />
          ))}
          {planned.length > 1 ? (
            <>
              <polyline
                points={polylinePoints(planned, screen)}
                fill="none"
                stroke="#fff"
                strokeWidth="7"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <polyline
                points={polylinePoints(planned, screen)}
                fill="none"
                stroke="#334155"
                strokeWidth="3.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray="7 6"
              />
            </>
          ) : null}
          {actual.length > 1 ? (
            <>
              <polyline
                points={polylinePoints(actual, screen)}
                fill="none"
                stroke="#fff"
                strokeWidth="7"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <polyline
                points={polylinePoints(actual, screen)}
                fill="none"
                stroke="#0f766e"
                strokeWidth="3.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </>
          ) : null}
          {geoStops.map(({ stop, index }) => {
            const p = screen([stop.lat, stop.lng]);
            const active = selected === index;
            return (
              <g
                key={`${stop.sequence}-${index}`}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                aria-label={`Stop ${stop.sequence}${stop.address ? `, ${stop.address}` : ""}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setSelected(index);
                  const z = Math.max(zoom, 14);
                  setCamera({ zoom: z, center: world([stop.lat, stop.lng], z) });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(index);
                    const z = Math.max(zoom, 14);
                    setCamera({ zoom: z, center: world([stop.lat, stop.lng], z) });
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <circle cx={p.x} cy={p.y} r={active ? 11 : 9} fill="#fff" />
                <circle cx={p.x} cy={p.y} r={active ? 8 : 6.5} fill={active ? "#1d4ed8" : "#172033"} />
                <text
                  x={p.x}
                  y={p.y + 3.5}
                  textAnchor="middle"
                  fill="#fff"
                  fontSize="8"
                  fontWeight="700"
                  style={{ pointerEvents: "none" }}
                >
                  {stop.sequence || index + 1}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {selectedStop ? (
        <div className={styles.mapStopCard}>
          <strong>
            Stop {selectedStop.sequence}
            {selectedStop.type ? ` · ${selectedStop.type}` : ""}
          </strong>
          <span>
            {selectedStop.address}
            {selectedStop.city ? `, ${selectedStop.city}` : ""}
          </span>
          <span>
            {selectedStop.tasks.length} task{selectedStop.tasks.length === 1 ? "" : "s"}
          </span>
        </div>
      ) : (
        <p className={styles.mapHint}>
          Drag to pan · scroll/zoom controls · select a stop marker for address
        </p>
      )}
      <p className={styles.mapCredit}>
        Map tiles ©{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap
        </a>
      </p>
    </div>
  );
}
