"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Expand,
  LocateFixed,
  Minus,
  Plus,
  X,
} from "lucide-react";
import styles from "./capacity-distance-map.module.css";
type Point = [number, number];
type XY = { x: number; y: number };
export type RouteGeometry = {
  station: Point;
  path: Point[];
  method?: "amazon_gps" | "amazon_gps_roads" | "scan_roads";
  stops: Array<{ point: Point; firstScanAt: string; scanCount: number }>;
};
const TILE = 256,
  MIN_ZOOM = 4,
  MAX_ZOOM = 18;
function world(p: Point, z: number): XY {
  const scale = TILE * 2 ** z,
    s = Math.sin((Math.max(-85, Math.min(85, p[0])) * Math.PI) / 180);
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
const time = (value: string) =>
  new Date(value).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
  });
export function CapacityDistanceMap({ geometry }: { geometry: RouteGeometry }) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    expandButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      expandButton.current?.focus();
    };
  }, [expanded]);
  return (
    <>
      <div hidden={expanded}>
        <RouteCanvas
          geometry={geometry}
          onExpand={() => setExpanded(true)}
          expandButton={expandButton}
        />
      </div>
      {expanded ? (
        <dialog
          className={styles.mapDialog}
          ref={dialog}
          onCancel={() => setExpanded(false)}
          aria-label="Expanded delivery route"
        >
          <RouteCanvas
            geometry={geometry}
            expanded
            onExpand={() => setExpanded(false)}
          />
        </dialog>
      ) : null}
    </>
  );
}
function RouteCanvas({
  geometry,
  expanded = false,
  onExpand,
  expandButton,
}: {
  geometry: RouteGeometry;
  expanded?: boolean;
  onExpand: () => void;
  expandButton?: React.RefObject<HTMLButtonElement>;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 460 });
  useEffect(() => {
    if (!wrap.current) return;
    const measure = () =>
      setSize({
        width: Math.max(240, wrap.current!.clientWidth),
        height: expanded
          ? Math.max(260, window.innerHeight - 245)
          : wrap.current!.clientWidth < 520
            ? 350
            : 460,
      });
    const observer = new ResizeObserver(measure);
    observer.observe(wrap.current);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [expanded]);
  const W = size.width,
    H = size.height;
  const [camera, setCamera] = useState<{ zoom: number; center: XY } | null>(
      null,
    ),
    [selected, setSelected] = useState<number | null>(null);
  const fit = useMemo(() => {
    const points = [geometry.station, ...geometry.path];
    let zoom = MIN_ZOOM;
    for (let z = 17; z >= MIN_ZOOM; z--) {
      const b = bounds(points, z);
      if (b.maxX - b.minX < W - 88 && b.maxY - b.minY < H - 88) {
        zoom = z;
        break;
      }
    }
    const b = bounds(points, zoom);
    return {
      zoom,
      center: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
    };
  }, [geometry, W, H]);
  const { zoom, center } = camera ?? fit,
    left = center.x - W / 2,
    top = center.y - H / 2;
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
  function choose(index: number) {
    const bounded = Math.max(0, Math.min(geometry.stops.length - 1, index));
    if (!geometry.stops[bounded]) return;
    setSelected(bounded);
    const z = Math.max(zoom, 14);
    setCamera({ zoom: z, center: world(geometry.stops[bounded].point, z) });
  }
  const pointers = useRef(new Map<number, XY>()),
    gesture = useRef<{
      center: XY;
      zoom: number;
      mid: XY;
      distance: number;
    } | null>(null);
  function beginGesture() {
    const p = [...pointers.current.values()];
    if (!p.length) {
      gesture.current = null;
      return;
    }
    const mid =
      p.length > 1
        ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }
        : p[0];
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
  const tiles = [];
  for (let x = Math.floor(left / TILE); x <= Math.floor((left + W) / TILE); x++)
    for (let y = Math.floor(top / TILE); y <= Math.floor((top + H) / TILE); y++)
      if (y >= 0 && y < 2 ** zoom)
        tiles.push({
          x,
          y,
          url: `https://tile.openstreetmap.org/${zoom}/${(x + 2 ** zoom) % 2 ** zoom}/${y}.png`,
        });
  const station = screen(geometry.station),
    stop = selected === null ? null : geometry.stops[selected];
  const polyline = geometry.path
    .map((p) => {
      const v = screen(p);
      return `${v.x},${v.y}`;
    })
    .join(" ");
  return (
    <div className={styles.mapWrap} ref={wrap}>
      <header className={styles.mapHeading}>
        <div>
          <strong>Recorded route</strong>
          <span>
            {geometry.stops.length} recorded stops · station to station
          </span>
        </div>
        <button
          ref={expandButton}
          type="button"
          onClick={onExpand}
          aria-label={expanded ? "Close expanded map" : "Expand map"}
          title={expanded ? "Close map" : "Expand map"}
        >
          {expanded ? <X /> : <Expand />}
        </button>
      </header>
      <div className={styles.mapViewport}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className={styles.map}
          tabIndex={0}
          aria-label="Delivery route. Drag or use arrow keys to pan, plus and minus to zoom, zero to fit the route."
          onKeyDown={(e) => {
            if (
              [
                "+",
                "=",
                "-",
                "0",
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
              ].includes(e.key)
            ) {
              e.preventDefault();
              if (e.key === "+" || e.key === "=") zoomBy(1);
              else if (e.key === "-") zoomBy(-1);
              else if (e.key === "0") setCamera(null);
              else
                setCamera({
                  zoom,
                  center: {
                    x:
                      center.x +
                      (e.key === "ArrowRight"
                        ? 80
                        : e.key === "ArrowLeft"
                          ? -80
                          : 0),
                    y:
                      center.y +
                      (e.key === "ArrowDown"
                        ? 80
                        : e.key === "ArrowUp"
                          ? -80
                          : 0),
                  },
                });
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
            const p = [...pointers.current.values()],
              g = gesture.current,
              mid =
                p.length > 1
                  ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }
                  : p[0];
            const delta =
              p.length > 1 && g.distance > 0
                ? Math.round(
                    Math.log2(
                      Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) / g.distance,
                    ),
                  )
                : 0;
            const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, g.zoom + delta)),
              factor = 2 ** (z - g.zoom);
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
          <title>Station departure, recorded stops and return</title>
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
          <polyline
            points={polyline}
            fill="none"
            stroke="#fff"
            strokeWidth="8"
            strokeLinejoin="round"
          />
          <polyline
            points={polyline}
            fill="none"
            stroke="#be365f"
            strokeWidth="4"
            strokeLinejoin="round"
          />
          {geometry.stops.map((item, index) => {
            const p = screen(item.point);
            return (
              <g
                key={index}
                role="button"
                tabIndex={0}
                aria-pressed={selected === index}
                aria-label={`Stop ${index + 1}, ${time(item.firstScanAt)}, ${item.scanCount} scans`}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={() => choose(index)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    choose(index);
                  }
                }}
              >
                <circle cx={p.x} cy={p.y} r={22} fill="transparent" />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={selected === index ? 18 : 14}
                  fill={selected === index ? "#192a42" : "#fff"}
                  stroke="#be365f"
                  strokeWidth="2"
                />
                <text
                  x={p.x}
                  y={p.y + 4}
                  textAnchor="middle"
                  fontSize="12"
                  fontWeight="700"
                  fill={selected === index ? "#fff" : "#98254a"}
                >
                  {index + 1}
                </text>
              </g>
            );
          })}
          <circle
            cx={station.x}
            cy={station.y}
            r="18"
            fill="#192a42"
            stroke="#fff"
            strokeWidth="3"
          />
          <text
            x={station.x}
            y={station.y + 5}
            fill="#fff"
            textAnchor="middle"
            fontWeight="700"
            fontSize="14"
          >
            S
          </text>
        </svg>
        <div className={styles.mapZoom} aria-label="Map controls">
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom === MAX_ZOOM}
            onClick={() => zoomBy(1)}
          >
            <Plus />
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom === MIN_ZOOM}
            onClick={() => zoomBy(-1)}
          >
            <Minus />
          </button>
          <button
            type="button"
            aria-label="Fit whole route"
            title="Fit whole route"
            onClick={() => {
              setCamera(null);
              setSelected(null);
            }}
          >
            <LocateFixed />
          </button>
        </div>
        <span className={styles.mapGestureHint}>
          Drag to move · pinch or + / − to zoom
        </span>
      </div>
      <div className={styles.stopNavigation} aria-live="polite">
        <button
          type="button"
          aria-label="Previous stop"
          disabled={selected === null || selected === 0}
          onClick={() => choose(selected! - 1)}
        >
          <ArrowLeft />
        </button>
        <div>
          <strong>
            {stop
              ? `Stop ${selected! + 1} of ${geometry.stops.length}`
              : "Explore stops"}
          </strong>
          <span>
            {stop
              ? `${time(stop.firstScanAt)} · ${stop.scanCount} scan${stop.scanCount === 1 ? "" : "s"}`
              : "Tap a number, or start with stop 1"}
          </span>
        </div>
        <button
          type="button"
          aria-label={selected === null ? "Show first stop" : "Next stop"}
          disabled={
            !geometry.stops.length || selected === geometry.stops.length - 1
          }
          onClick={() => choose(selected === null ? 0 : selected + 1)}
        >
          <ArrowRight />
        </button>
      </div>
      <div className={styles.mapFooter}>
        <span>
          <b>S</b> Station · start &amp; return
        </span>
        <span>
          {geometry.method === "amazon_gps"
            ? "Amazon GPS history"
            : geometry.method === "amazon_gps_roads"
              ? "Amazon GPS + road connections"
              : "Roads between Amazon scans"}
        </span>
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap
        </a>
        {geometry.method !== "amazon_gps" ? (
          <a
            href="https://www.mapbox.com/about/maps"
            target="_blank"
            rel="noreferrer"
          >
            © Mapbox
          </a>
        ) : null}
      </div>
    </div>
  );
}
