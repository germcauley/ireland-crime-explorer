"use client";

import { useEffect, useRef } from "react";
import { geoMercator, geoPath, type ExtendedFeature } from "d3-geo";
import { scaleSqrt } from "d3-scale";
import { select } from "d3-selection";
import { zoom as d3Zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from "d3-zoom";

/**
 * The map surface: real coastline, proportional symbols, no shaded territories.
 *
 * Choropleth is the wrong encoding for this data. Garda station catchments are
 * not published at all, and the Division polygons in circulation describe the
 * 2011/2013 structure — shading either one asserts a boundary the source does
 * not support. Symbols locate an area without claiming where it ends.
 *
 * Ported from the design handoff's crime-map.js. Two departures: the geometry
 * is served from this app rather than a CDN at runtime, and it is trimmed to
 * Ireland and the UK, which takes the atlas from 4.2MB to 420KB.
 */

export type MapPoint = {
  id: string;
  name: string;
  shortName?: string;
  lat: number | null;
  lng: number | null;
  /** Sizes the symbol: the count for the compared-to year. */
  value: number;
  /** Colours it. null — no comparable baseline — renders grey. */
  change: number | null;
  valueLabel: string;
};

export type MapView = "national" | "dublin" | "stations";

// d3-geo has its own GeoJSON typings; ExtendedFeature is what geoPath accepts.
type Land = { ie: ExtendedFeature; gb: ExtendedFeature | null };

const INK = "#201e1d";
const CYAN = "#0088b0";
const MAGENTA = "#d6006c";
const PAPER = "#f3f2f2";
const NO_DATA = "#9b9797";

const atlasCache: Record<string, Promise<Land | null>> = {};

function loadLand(resolution: "50m" | "10m"): Promise<Land | null> {
  if (!atlasCache[resolution]) {
    atlasCache[resolution] = fetch(`/atlas/ie-gb-${resolution}.json`)
      .then((response) => response.json())
      .then((collection: { features: ExtendedFeature[] }) => ({
        ie: collection.features.find((f) => f.properties?.name === "Ireland")!,
        gb: collection.features.find((f) => f.properties?.name === "United Kingdom") ?? null,
      }))
      .catch(() => null);
  }
  return atlasCache[resolution];
}

export function CrimeMap({
  points,
  selected,
  view,
  onSelect,
  isDark,
}: {
  points: MapPoint[];
  selected: string | null;
  view: MapView;
  onSelect: (id: string) => void;
  isDark: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const land = useRef<Land | null>(null);
  const landFine = useRef<Land | null>(null);
  const transform = useRef<{ k: number; x: number; y: number } | null>(null);
  const zoomBehaviour = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const lastView = useRef<MapView | null>(null);
  const pointerDownAt = useRef<[number, number] | null>(null);
  const draw = useRef<() => void>(() => {});

  const drawNow = () => {
    const element = host.current;
    const geo = (view !== "national" && landFine.current) || land.current;
    if (!element || !geo) return;
    const w = element.clientWidth || 640;
    const h = element.clientHeight || 520;
    if (w < 40 || h < 40) return;

    let svg = svgRef.current ? select(svgRef.current) : null;
    if (!svg) {
      const created = select(element).append("svg").style("display", "block");
      svgRef.current = created.node();
      svg = created;
    }
    svg.attr("width", w).attr("height", h).selectAll("*").remove();

    // A MultiPoint, not a ring: fitExtent on a hand-wound polygon reads the
    // complement of the box and fits at world scale.
    const dublinBox = {
      type: "MultiPoint",
      coordinates: [
        [-6.55, 53.19],
        [-6.02, 53.65],
      ],
    } as const;
    const dublin = view !== "national";
    const pad = dublin ? 30 : 18;
    const projection = geoMercator().fitExtent(
      [
        [pad, pad],
        [w - pad, h - pad],
      ],
      (dublin ? dublinBox : geo.ie) as ExtendedFeature,
    );

    // Zoom is applied to the projection rather than as an SVG transform, so
    // symbols, hairlines and type keep their designed size at every scale.
    if (lastView.current !== view) {
      lastView.current = view;
      transform.current = null;
    }
    const zoomable = view === "stations";
    if (zoomable && transform.current) {
      const t = transform.current;
      const baseScale = projection.scale();
      const [bx, by] = projection.translate();
      projection.scale(baseScale * t.k).translate([bx * t.k + t.x, by * t.k + t.y]);
    }
    setupZoom(svg, zoomable, w, h);
    const path = geoPath(projection);

    const sea = isDark ? (dublin ? "#16232a" : "#141d22") : dublin ? "#d7e3e7" : "#e8eef0";
    const neighbour = isDark ? "#24211f" : "#e3e1e0";
    const neighbourCoast = isDark ? "#3a3634" : "#c9c5c5";
    const irelandFill = isDark ? "#2a2725" : dublin ? "#faf9f9" : PAPER;
    const coast = isDark ? "#8d8783" : INK;
    const halo = isDark ? "#2a2725" : PAPER;
    const labelInk = isDark ? "#f2efec" : INK;

    svg.append("rect").attr("width", w).attr("height", h).attr("fill", sea);

    const landLayer = svg.append("g");
    if (geo.gb) {
      landLayer
        .append("path")
        .attr("d", path(geo.gb) ?? "")
        .attr("fill", neighbour)
        .attr("stroke", neighbourCoast)
        .attr("stroke-width", 0.6);
    }
    landLayer
      .append("path")
      .attr("d", path(geo.ie) ?? "")
      .attr("fill", irelandFill)
      .attr("stroke", coast)
      .attr("stroke-width", 1)
      .attr("stroke-opacity", 0.75)
      .attr("stroke-linejoin", "round");

    const max = Math.max(1, ...points.map((p) => Math.abs(p.value || 0)));
    const rMax = view === "stations" ? Math.min(w, h) / 36 : Math.min(w, h) / 11;
    const size = scaleSqrt().domain([0, max]).range([2.5, rMax]);
    // In the Dublin Division view the six areas sit 1–2km apart, so symbol size
    // would encode nothing legible; they take a uniform marker instead.
    const radius = (value: number) => (view === "dublin" ? 7 : size(value));

    const colourOf = (p: MapPoint) =>
      p.change === null || p.change === undefined ? NO_DATA : p.change > 0 ? MAGENTA : CYAN;

    const nodes = points
      .filter((p) => p.lat != null && p.lng != null)
      .map((p) => {
        const xy = projection([p.lng as number, p.lat as number]) ?? [-999, -999];
        return { p, x: xy[0], y: xy[1], r: radius(Math.abs(p.value || 0)), dx: 0, dy: 0, anchor: "middle" };
      })
      .filter((n) => n.x > -60 && n.x < w + 60 && n.y > -60 && n.y < h + 60)
      .sort((a, b) => b.r - a.r);

    const cell = svg
      .append("g")
      .selectAll("g.node")
      .data(nodes)
      .join("g")
      .attr("class", "node")
      .attr("transform", (n) => `translate(${n.x},${n.y})`)
      .style("cursor", "pointer")
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", (n) => `${n.p.name}, ${n.p.valueLabel}`)
      .on("pointerdown", (event: PointerEvent) => {
        pointerDownAt.current = [event.clientX, event.clientY];
      })
      .on("click", (event: MouseEvent, n) => {
        // Swallow the click that ends a pan, so dragging never reselects.
        const from = pointerDownAt.current;
        if (from && Math.abs(event.clientX - from[0]) + Math.abs(event.clientY - from[1]) > 4) return;
        onSelect(n.p.id);
      })
      .on("keydown", (event: KeyboardEvent, n) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(n.p.id);
        }
      });

    cell.append("title").text((n) => `${n.p.name} — ${n.p.valueLabel}`);

    cell
      .append("circle")
      .attr("r", (n) => n.r)
      .attr("fill", (n) => colourOf(n.p))
      .attr("fill-opacity", (n) => (n.p.id === selected ? 0.6 : view === "stations" ? 0.2 : 0.28))
      .attr("stroke", (n) => colourOf(n.p))
      .attr("stroke-width", (n) => (n.p.id === selected ? 2 : 1));

    cell
      .filter((n) => n.p.id === selected)
      .append("circle")
      .attr("r", (n) => n.r + 5)
      .attr("fill", "none")
      .attr("stroke", coast)
      .attr("stroke-width", 0.8)
      .attr("stroke-dasharray", "2 3");

    // Label the largest areas and the selection, then drop any label whose box
    // would collide with one already placed. Once the station view is zoomed
    // the cap lifts, so zooming in is how the city-centre cluster is read.
    let labelled: typeof nodes;
    if (view === "dublin") {
      labelled = nodes;
    } else {
      const wide = w > 560;
      const cap =
        view === "stations" ? (transform.current ? nodes.length : wide ? 26 : 12) : wide ? 14 : 7;
      const candidates = nodes
        .slice()
        .sort(
          (a, b) =>
            (b.p.id === selected ? 1 : 0) - (a.p.id === selected ? 1 : 0) || b.r - a.r,
        )
        .slice(0, cap);
      const placed: { x1: number; x2: number; y1: number; y2: number }[] = [];
      labelled = [];
      candidates.forEach((n) => {
        const charWidth = view === "stations" ? 5.6 : 6.4;
        const tw = (n.p.shortName || n.p.name).length * charWidth;
        const box = {
          x1: n.x - tw / 2 - 2,
          x2: n.x + tw / 2 + 2,
          y1: n.y - n.r - 17,
          y2: n.y - n.r - 1,
        };
        const hit = placed.some(
          (b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2),
        );
        if (!hit || n.p.id === selected) {
          placed.push(box);
          labelled.push(n);
        }
      });
    }

    const labelCells = cell.filter((n) => labelled.indexOf(n) > -1);
    if (view === "dublin") {
      // Ordered by position so neighbours alternate sides, with a leader line
      // out to the offset label.
      const order = nodes.slice().sort((a, b) => a.y - b.y || a.x - b.x);
      nodes.forEach((n) => {
        const i = order.indexOf(n);
        n.dx = i % 2 === 0 ? -(n.r + 12) : n.r + 12;
        n.dy = (i % 4 < 2 ? -1 : 1) * (n.r + 8);
        n.anchor = n.dx < 0 ? "end" : "start";
      });
      labelCells
        .append("line")
        .attr("x1", (n) => (n.dx < 0 ? -n.r * 0.5 : n.r * 0.5))
        .attr("y1", (n) => n.dy * 0.4)
        .attr("x2", (n) => n.dx)
        .attr("y2", (n) => n.dy)
        .attr("stroke", coast)
        .attr("stroke-width", 0.6)
        .attr("stroke-opacity", 0.5);
    }

    labelCells
      .append("text")
      .attr("x", (n) => (view === "dublin" ? n.dx + (n.dx < 0 ? -3 : 3) : 0))
      .attr("y", (n) => (view === "dublin" ? n.dy + 4 : -n.r - 6))
      .attr("text-anchor", (n) => (view === "dublin" ? n.anchor : "middle"))
      .attr("font-family", '"Source Serif 4", Georgia, serif')
      .attr("font-size", view === "dublin" ? 14 : view === "stations" ? 12 : 13)
      .attr("fill", labelInk)
      .attr("paint-order", "stroke")
      .attr("stroke", halo)
      .attr("stroke-width", 3.5)
      .text((n) => n.p.shortName || n.p.name);
  };

  function setupZoom(
    svg: ReturnType<typeof select<SVGSVGElement, unknown>>,
    on: boolean,
    w: number,
    h: number,
  ) {
    if (!on) {
      svg.on(".zoom", null).style("cursor", null);
      return;
    }
    if (!zoomBehaviour.current) {
      zoomBehaviour.current = d3Zoom<SVGSVGElement, unknown>()
        .scaleExtent([1, 12])
        // Two fingers to zoom on touch, so a one-finger drag still scrolls the page.
        .filter((event: Event) => {
          if (event.type === "wheel") return true;
          if (event.type.startsWith("touch")) return (event as TouchEvent).touches.length > 1;
          return !(event as MouseEvent).button;
        })
        .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
          const t = event.transform;
          transform.current = t.k === 1 && !t.x && !t.y ? null : { k: t.k, x: t.x, y: t.y };
          draw.current();
        });
    }
    zoomBehaviour.current.translateExtent([
      [0, 0],
      [w, h],
    ]);
    svg.call(zoomBehaviour.current).on("dblclick.zoom", null).style("cursor", "grab");
  }

  // Assigned in an effect, not during render: the closure reads refs, and React
  // forbids touching them while rendering.
  useEffect(() => {
    draw.current = drawNow;
  });

  // The atlas resolves once per resolution; Dublin needs the finer coastline.
  useEffect(() => {
    let cancelled = false;
    loadLand("50m").then((geo) => {
      if (cancelled) return;
      land.current = geo;
      draw.current();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (view === "national") return;
    let cancelled = false;
    loadLand("10m").then((geo) => {
      if (cancelled) return;
      landFine.current = geo;
      draw.current();
    });
    return () => {
      cancelled = true;
    };
  }, [view]);

  useEffect(() => {
    draw.current();
  }, [points, selected, view, isDark]);

  // The container is laid out by CSS, so its box changes for reasons React
  // never re-renders for.
  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw.current());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      svgRef.current?.remove();
      svgRef.current = null;
    },
    [],
  );

  const zoomBy = (factor: number) => {
    const svg = svgRef.current;
    if (!svg || !zoomBehaviour.current) return;
    select(svg).call(zoomBehaviour.current.scaleBy, factor);
  };

  return (
    <div className="crime-map" ref={host}>
      {view === "stations" && (
        <div className="crime-map-controls">
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.6)}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.6)}>−</button>
          <button
            type="button"
            aria-label="Reset the view"
            className="crime-map-reset"
            onClick={() => {
              const svg = svgRef.current;
              if (!svg || !zoomBehaviour.current) return;
              select(svg).call(zoomBehaviour.current.transform, zoomIdentity);
            }}
          >
            ⤾
          </button>
        </div>
      )}
    </div>
  );
}
