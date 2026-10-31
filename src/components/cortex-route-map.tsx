"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  LocateFixed,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
} from "lucide-react";
import type { CortexGpsPoint, CortexStop } from "@/lib/ops-pulse/cortex-data";
import {
  formatIstClock,
  isValidGeo,
  pointAtTime,
  trailSegments,
  trailUpTo,
  type Point,
  type TimedPoint,
} from "@/lib/ops-pulse/cortex-geo";
import styles from "./cortex-workspace.module.css";

type XY = { x: number; y: number };

const TILE = 256;
const MIN_ZOOM = 4;
const MAX_ZOOM = 18;
const SPEEDS = [1, 10, 30, 60] as const;

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

function toTimed(points: CortexGpsPoint[]): TimedPoint[] {
  return points
    .filter((p) => isValidGeo(p.lat, p.lng) && Number.isFinite(p.time))
    .map((p) => ({ point: [p.lat, p.lng] as Point, time: p.time }))
    .sort((a, b) => a.time - b.time);
}

function stopReachedAt(stop: CortexStop): number | null {
  const times = stop.tasks
    .map((t) => t.actualExecutionTime)
    .filter((t): t is number => t != null && Number.isFinite(t));
  if (!times.length) return null;
  return Math.min(...times);
}

export function CortexRouteMap({
  plannedPath,
  actualPath,
  gpsTrail,
  gpsTrailError,
  stops,
  movementStart,
  movementEnd,
}: {
  plannedPath: Point[];
  actualPath: Point[];
  gpsTrail: CortexGpsPoint[];
  gpsTrailError: string | null;
  stops: CortexStop[];
  movementStart: number | null;
  movementEnd: number | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 420 });
  const [camera, setCamera] = useState<{ zoom: number; center: XY } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(30);
  const [playhead, setPlayhead] = useState<number | null>(null);

  const trace = useMemo(() => toTimed(gpsTrail), [gpsTrail]);
  const startMs = movementStart ?? trace[0]?.time ?? null;
  const endMs = movementEnd ?? trace.at(-1)?.time ?? null;

  useEffect(() => {
    setPlaying(false);
    setPlayhead(startMs);
    setSelected(null);
    setCamera(null);
  }, [startMs, gpsTrail]);

  useEffect(() => {
    if (!playing || startMs == null || endMs == null || !trace.length) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setPlayhead((current) => {
        const from = current ?? startMs;
        const next = from + dt * speed;
        if (next >= endMs) {
          setPlaying(false);
          return endMs;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, startMs, endMs, trace.length]);

  const geoStops = useMemo(
    () =>
      stops
        .map((stop, index) => ({ stop, index, reachedAt: stopReachedAt(stop) }))
        .filter(({ stop }) => isValidGeo(stop.lat, stop.lng)) as Array<{
        stop: CortexStop & { lat: number; lng: number };
        index: number;
        reachedAt: number | null;
      }>,
    [stops],
  );

  const planned = useMemo(
    () => plannedPath.filter(([lat, lng]) => isValidGeo(lat, lng)),
    [plannedPath],
  );
  const scanPath = useMemo(
    () => actualPath.filter(([lat, lng]) => isValidGeo(lat, lng)),
    [actualPath],
  );

  const activeTrail = useMemo(() => {
    if (!trace.length) return [] as TimedPoint[];
    if (playhead == null) return trace;
    return trailUpTo(trace, playhead);
  }, [trace, playhead]);

  const gpsSegments = useMemo(() => trailSegments(activeTrail), [activeTrail]);
  const fullGpsSegments = useMemo(() => trailSegments(trace), [trace]);

  const driverPoint = useMemo(() => {
    if (!trace.length || playhead == null) return null;
    return pointAtTime(trace, playhead);
  }, [trace, playhead]);

  const fitPoints = useMemo(() => {
    const pts: Point[] = [
      ...planned,
      ...scanPath,
      ...trace.map((p) => p.point),
      ...geoStops.map(({ stop }) => [stop.lat, stop.lng] as Point),
    ];
    return pts;
  }, [planned, scanPath, trace, geoStops]);

  useEffect(() => {
    if (!wrap.current) return;
    const measure = () =>
      setSize({
        width: Math.max(240, wrap.current!.clientWidth),
        height: Math.max(300, Math.min(540, wrap.current!.clientWidth * 0.75)),
      });
    const observer = new ResizeObserver(measure);
    observer.observe(wrap.current);
    measure();
    return () => observer.disconnect();
  }, []);

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

  const duration = startMs != null && endMs != null ? Math.max(1, endMs - startMs) : 0;
  const progress =
    startMs != null && playhead != null && duration
      ? Math.max(0, Math.min(1, (playhead - startMs) / duration))
      : 0;

  const activeStop = useMemo(() => {
    if (playhead == null) return null;
    let best: (typeof geoStops)[number] | null = null;
    for (const item of geoStops) {
      if (item.reachedAt == null || item.reachedAt > playhead) continue;
      if (!best || (item.reachedAt >= (best.reachedAt || 0))) best = item;
    }
    return best;
  }, [geoStops, playhead]);

  if (!fitPoints.length) {
    return (
      <div className={styles.mapEmpty} role="status">
        <strong>No map coordinates</strong>
        <span>
          {gpsTrailError ||
            "This itinerary has no GPS trail or stop locations to plot."}
        </span>
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

  const selectedStop =
    selected == null
      ? activeStop?.stop || null
      : geoStops.find((g) => g.index === selected)?.stop || null;

  const drawSegments = (segments: Point[][], className: "planned" | "gps" | "ghost") =>
    segments.map((segment, i) => {
      if (segment.length < 2) return null;
      const points = polylinePoints(segment, screen);
      if (className === "planned") {
        return (
          <g key={`planned-${i}`}>
            <polyline points={points} fill="none" stroke="#fff" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
            <polyline
              points={points}
              fill="none"
              stroke="#64748b"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray="6 5"
              opacity={0.9}
            />
          </g>
        );
      }
      if (className === "ghost") {
        return (
          <polyline
            key={`ghost-${i}`}
            points={points}
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.35}
          />
        );
      }
      return (
        <g key={`gps-${i}`}>
          <polyline points={points} fill="none" stroke="#fff" strokeWidth="8" strokeLinejoin="round" strokeLinecap="round" />
          <polyline
            points={points}
            fill="none"
            stroke="#0f766e"
            strokeWidth="4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </g>
      );
    });

  return (
    <div className={styles.mapWrap} ref={wrap}>
      <div className={styles.mapToolbar} aria-label="Map controls">
        <div className={styles.mapLegend}>
          <span className={styles.legendPlanned}>Planned stops</span>
          <span className={styles.legendActual}>GPS trail</span>
          <span>
            {trace.length
              ? `${trace.length.toLocaleString("en-IN")} GPS points`
              : "Scan locations only"}
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

      {gpsTrailError && !trace.length ? (
        <div className={styles.mapNotice} role="status">
          {gpsTrailError} Showing planned / scan locations instead.
        </div>
      ) : null}

      <div className={styles.mapViewport}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className={styles.mapCanvas}
          tabIndex={0}
          aria-label="Route map with GPS trail playback. Drag to pan, plus and minus to zoom."
          onKeyDown={(e) => {
            if (["+", "=", "-", "0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key)) {
              e.preventDefault();
              if (e.key === " ") setPlaying((p) => !p);
              else if (e.key === "+" || e.key === "=") zoomBy(1);
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
          <title>GPS trail, planned stops and driver playback</title>
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

          {/* Full GPS as faint ghost so the remaining day path is visible while playing */}
          {playing || (playhead != null && startMs != null && playhead > startMs)
            ? drawSegments(fullGpsSegments, "ghost")
            : null}

          {planned.length > 1 ? drawSegments([planned], "planned") : null}

          {/* Prefer dense GPS road trail; fall back to scan-to-scan if trail missing */}
          {gpsSegments.length
            ? drawSegments(gpsSegments, "gps")
            : scanPath.length > 1
              ? drawSegments([scanPath], "gps")
              : null}

          {geoStops.map(({ stop, index, reachedAt }) => {
            const p = screen([stop.lat, stop.lng]);
            const active = selected === index || activeStop?.index === index;
            const visited = playhead != null && reachedAt != null && reachedAt <= playhead;
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
                  if (reachedAt != null) {
                    setPlaying(false);
                    setPlayhead(reachedAt);
                  }
                  const z = Math.max(zoom, 14);
                  setCamera({ zoom: z, center: world([stop.lat, stop.lng], z) });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(index);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <circle cx={p.x} cy={p.y} r={active ? 11 : 9} fill="#fff" />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={active ? 8 : 6.5}
                  fill={active ? "#1d4ed8" : visited ? "#0f766e" : "#172033"}
                />
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

          {driverPoint ? (
            <g aria-label="Driver position">
              <circle
                cx={screen(driverPoint).x}
                cy={screen(driverPoint).y}
                r={14}
                fill="rgba(15, 118, 110, 0.2)"
              />
              <circle
                cx={screen(driverPoint).x}
                cy={screen(driverPoint).y}
                r={8}
                fill="#0f766e"
                stroke="#fff"
                strokeWidth={2.5}
              />
            </g>
          ) : null}
        </svg>
      </div>

      {trace.length && startMs != null && endMs != null ? (
        <div className={styles.playback} aria-label="Driver movement playback">
          <div className={styles.playbackControls}>
            <button
              type="button"
              className={styles.playbackPlay}
              onClick={() => {
                if (playhead != null && playhead >= endMs) setPlayhead(startMs);
                setPlaying((p) => !p);
              }}
              aria-label={playing ? "Pause playback" : "Play driver movement"}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setPlayhead(startMs);
              }}
              aria-label="Restart playback"
              title="Restart"
            >
              <RotateCcw size={14} />
            </button>
            <div className={styles.playbackTimes}>
              <strong>{formatIstClock(playhead ?? startMs)}</strong>
              <span>
                {formatIstClock(startMs)} – {formatIstClock(endMs)}
              </span>
            </div>
            <div className={styles.speedGroup} role="group" aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={speed === s ? styles.speedActive : undefined}
                  aria-pressed={speed === s}
                  onClick={() => setSpeed(s)}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
          <label className={styles.scrubber}>
            <span className={styles.srOnly}>Playback position</span>
            <input
              type="range"
              min={startMs}
              max={endMs}
              step={1000}
              value={playhead ?? startMs}
              onChange={(e) => {
                setPlaying(false);
                setPlayhead(Number(e.target.value));
              }}
            />
            <span className={styles.scrubberTrack}>
              <span style={{ width: `${progress * 100}%` }} />
            </span>
          </label>
        </div>
      ) : (
        <p className={styles.mapHint}>
          GPS trail unavailable — map shows planned stops
          {scanPath.length ? " and scan locations" : ""}.
        </p>
      )}

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
            {stopReachedAt(selectedStop)
              ? ` · ${formatIstClock(stopReachedAt(selectedStop)!)}`
              : ""}
          </span>
        </div>
      ) : (
        <p className={styles.mapHint}>
          Play the GPS trail to follow the driver, or select a stop marker.
        </p>
      )}

      <p className={styles.mapCredit}>
        Map tiles ©{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap
        </a>
        {" · "}
        GPS trail from Amazon Driver Trace
      </p>
    </div>
  );
}
