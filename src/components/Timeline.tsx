/**
 * Timeline: photos per month as bars, brush snaps to whole years/months
 * Dragging brush updates shared selection live; average view follows it
 *
 * React renders bars and labels; D3 provides scales, time intervals and brush interaction
 */
import * as d3 from "d3";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useStore } from "../store";

const HEIGHT = 120; // height of bar chart, including axis and labels
const M = { top: 10, right: 16, bottom: 26, left: 36 }; // margins for axis and labels

interface Bin {
  start: Date;
  end: Date;
  count: number;
}

interface Hover {
  x: number; // pixel position of mouse
  bin: Bin; // hovered month/week bin
}

/** Get SVG path to draw bar for a bin on the chart
 *  Rounded top corners, square at the baseline */
function drawBarSVG(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): string {
  r = Math.max(0, Math.min(r, h));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function Timeline() {
  /* Shared global state */
  const photos = useStore((s) => s.photos); // all photos sorted by time
  const range = useStore((s) => s.range); // current selection [startMs, endMs), (null = all)
  const snap = useStore((s) => s.snap); // what the brush snaps to (year, month, week)
  const setRange = useStore((s) => s.setRange);

  /* Refs */
  const wrapRef = useRef<HTMLDivElement>(null); // chart container for measuring width

  const brushRef = useRef<SVGGElement>(null); // D3 brush group
  const brushBehavior = useRef<d3.BrushBehavior<unknown> | null>(null);
  const brushing = useRef(false);

  /* Local state */
  const [width, setWidth] = useState(0); // chart container width, updated on resize
  const [hover, setHover] = useState<Hover | null>(null); // hovered pos & bin for tooltip

  // Measure container's width whenever it resizes so the chart always fills available width
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);

    // Disconnect observer on unmount
    return () => ro.disconnect();
  }, []);

  /*
   * Get timeline data from the photo list
   * Returns monthly and yearly image count bins over the time range spanning the data
   */
  const model = useMemo(() => {
    if (!photos.length) return null;

    // Get first and last year boundaries (Jan 1 of first year, Jan 1 of year after last year)
    const t0 = d3.timeYear.floor(new Date(photos[0].time));
    const t1 = d3.timeYear.offset(
      d3.timeYear.floor(new Date(photos[photos.length - 1].time)),
      1,
    );

    // Count photos per time interval (week/month/year)
    // Resulting maps: Map { monthStartMs -> count }
    // Keys: month/year start date in ms, values: photo counts
    const byWeek = d3.rollup(
      photos,
      (v) => v.length,
      (p) => +d3.timeWeek.floor(new Date(p.time)),
    );
    const byMonth = d3.rollup(
      photos,
      (v) => v.length,
      (p) => +d3.timeMonth.floor(new Date(p.time)),
    );
    const byYear = d3.rollup(
      photos,
      (v) => v.length,
      (p) => +d3.timeYear.floor(new Date(p.time)),
    );

    // Create image count bins for each time interval
    // Gets arrays of {start, end, count} Bin objects
    const weeks: Bin[] = d3.timeWeek.range(t0, t1).map((week) => ({
      start: week,
      end: d3.timeWeek.offset(week, 1),
      count: byWeek.get(+week) ?? 0,
    }));
    const months: Bin[] = d3.timeMonth.range(t0, t1).map((month) => ({
      start: month,
      end: d3.timeMonth.offset(month, 1),
      count: byMonth.get(+month) ?? 0,
    }));
    const years: Bin[] = d3.timeYear.range(t0, t1).map((year) => ({
      start: year,
      end: d3.timeYear.offset(year, 1),
      count: byYear.get(+year) ?? 0,
    }));
    return {
      t0, // start of timeline
      t1, // end
      weeks, // week bins for week bars
      months, // month bins for bars (default)
      years, // year bins for buttons and labels/dividers
      max:
        snap === "week"
          ? (d3.max(weeks, (b) => b.count) ?? 1)
          : (d3.max(months, (b) => b.count) ?? 1), // tallest bar -> top of the y axis
    };
  }, [photos, snap]);

  /*
   * D3 scale functions for converting data values to pixel positions
   * xScale(date) -> horizontal pixel; xScale.invert(pixel) -> date (used by the brush/hover)
   * yScale(count) -> vertical pixel
   */

  // Converts time to pixel position along x axis
  const xScale = useMemo(
    () =>
      model
        ? d3
            .scaleTime()
            .domain([model.t0, model.t1]) // input: time span
            .range([M.left, Math.max(M.left + 1, width - M.right)]) // output: plot's left..right edge
        : null,
    [model, width],
  );
  // Converts count to pixel position along y axis
  const yScale = useMemo(
    () =>
      model
        ? d3
            .scaleLinear()
            .domain([0, model.max]) // input: 0..tallest bar
            .nice() // round to nice round number (e.g. 37 -> 40)
            .range([HEIGHT - M.bottom, M.top]) // output: bottom..top of plot
        : null,
    [model],
  );

  /*
   * D3 brush, snapping to the chosen interval
   * Runs after React has rendered the empty <g ref={brushRef}>
   * D3 adds invisible overlay rect (catches mouse drags), visible selection rect, and resize handles
   */
  useEffect(() => {
    const node = brushRef.current;
    if (!model || !xScale || !node || width <= 0) return;

    // Create brush interaction: update selection in store when user drags
    const g = d3.select<SVGGElement, unknown>(node);
    const interval =
      snap === "year"
        ? d3.timeYear
        : snap === "month"
          ? d3.timeMonth
          : d3.timeWeek;
    const brush = d3
      .brushX<unknown>() // horizontal-only brush
      .extent([
        // set the plot area you can brush in
        [M.left, M.top],
        [width - M.right, HEIGHT - M.bottom],
      ])
      // Called on drag start, every mouse move during drag, and release
      .on("start brush end", (ev: d3.D3BrushEvent<unknown>) => {
        if (!ev.sourceEvent) return; // ignore programmatic moves
        brushing.current = ev.type !== "end";

        // Selection in PIXELS [left, right]; null if the user clicked without dragging (which clears brush)
        const sel = ev.selection as [number, number] | null;
        if (!sel) {
          setRange(null); // clear range -> select all
          return;
        }

        // Invert pixel positions to dates
        const a = xScale.invert(sel[0]);
        const b = xScale.invert(sel[1]);

        // Snap to nearest whole interval
        let start =
          +interval.ceil(a) - +a < +a - +interval.floor(a) // calculate which is closer (floor vs ceil)
            ? interval.ceil(a)
            : interval.floor(a);
        let end =
          +interval.ceil(b) - +b < +b - +interval.floor(b)
            ? interval.ceil(b)
            : interval.floor(b);
        // TODO: bug where it goes to the next interval
        //if (+end <= +start) end = interval.offset(start, 1); // tiny drag selection -> ensure at least one whole interval

        // Clamp to data range
        start = new Date(Math.max(+start, +model.t0));
        end = new Date(Math.min(+end, +model.t1));

        // Update store
        setRange([+start, +end]);

        // On drag release, move visible rectangle to snapped edges
        if (ev.type === "end") g.call(brush.move, [xScale(start), xScale(end)]);
      });

    // Render brush and move it to current selection
    g.call(brush); // d3 create brush's elements inside <g>
    brushBehavior.current = brush;

    // Show current selection
    const r = useStore.getState().range;
    g.call(brush.move, r ? [xScale(r[0]), xScale(r[1])] : null);

    // Cleanup: remove brush and event handlers on unmount/dependency change
    return () => {
      brush.on("start brush end", null);
      g.selectAll("*").remove();
      g.on(".brush", null);
      brushBehavior.current = null;
    };
  }, [model, xScale, width, snap, setRange]);

  // Keep brush in sync when the range changes from elsewhere (year buttons, keys)
  useEffect(() => {
    const node = brushRef.current;
    const brush = brushBehavior.current;
    if (!node || !brush || !xScale || brushing.current) return;

    // Get current and target brush selections in pixels
    const cur = d3.brushSelection(node) as [number, number] | null; // where the brush is now (px)
    const target: [number, number] | null = range // where it should be (px)
      ? [xScale(range[0]), xScale(range[1])]
      : null;

    // Return if no current and target selections or they're within 0.5px of each other (avoids infinite loop)
    if (!cur && !target) return;
    if (
      cur &&
      target &&
      Math.abs(cur[0] - target[0]) < 0.5 &&
      Math.abs(cur[1] - target[1]) < 0.5
    )
      return;
    d3.select<SVGGElement, unknown>(node).call(brush.move, target);
  }, [range, xScale]);

  // Return early if no data or scales yet (still render container so ResizeObserver has something to measure)
  if (!model || !xScale || !yScale)
    return <div ref={wrapRef} className="timeline" />;

  /* Event handlers and helpers (recreated each render) */

  // Helper to check if a bin is fully within current selection range
  const inRange = (b: Bin) =>
    !range || (+b.start >= range[0] && +b.end <= range[1]);

  // Helper to select a year, optionally extend current selection
  const selectYear = (yr: Bin, extend: boolean) => {
    if (extend && range)
      setRange([Math.min(range[0], +yr.start), Math.max(range[1], +yr.end)]);
    else setRange([+yr.start, +yr.end]);
  };

  // Handle keyboard events: Esc = clear selection, ←/→ = step by one interval
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return setRange(null);
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const interval =
      snap === "year"
        ? d3.timeYear
        : snap === "month"
          ? d3.timeMonth
          : d3.timeWeek;
    const step = e.key === "ArrowLeft" ? -1 : 1;
    const [start, end] = range ?? [+model.t0, +interval.offset(model.t0, 1)];
    const newStart = interval.offset(new Date(start), step);
    const newEnd = interval.offset(new Date(end), step);
    if (+newStart < +model.t0 || +newEnd > +model.t1) return;
    setRange([+newStart, +newEnd]);
  };

  /**
   * Tooltip: find the month under the mouse
   * Listens on the whole <svg> to avoid getting blocked by brush's invisible overlay
   * Pointer events from the overlay bubble up to the <svg>
   */
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left; // mouse x relative to the chart
    const t = xScale.invert(px); // ... as a date
    const bin = model.months.find((b) => t >= b.start && t < b.end);
    setHover(
      bin && px >= M.left && px <= width - M.right ? { x: px, bin } : null,
    );
  };

  const formatMonth = d3.timeFormat("%B %Y"); // e.g. "March 2023"
  const total = photos.length;

  return (
    <div className="flex flex-col gap-2 pt-2.5">
      {/* Year filter buttons */}
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label="Select a year"
      >
        <button
          className={`chip ${range ? "" : "active"}`}
          onClick={() => setRange(null)}
        >
          All <span className="chip-count">{total}</span>
        </button>
        {model.years.map((year) => (
          <button
            key={+year.start}
            className={`chip ${range && inRange(year) ? "active" : ""}`}
            disabled={year.count === 0}
            onClick={(e) => selectYear(year, e.shiftKey)}
            title="Click to select · Shift-click to extend"
          >
            {year.start.getFullYear()}{" "}
            <span className="chip-count">{year.count}</span>
          </button>
        ))}
        <span className="ml-auto text-muted text-xs tabular-nums">
          Drag on the timeline to select time period · ←/→ to step · Esc for all
        </span>
      </div>

      {/* Timeline chart of number of photos over time */}
      {/* tabIndex makes container focusable so it can receive key presses */}
      <div
        ref={wrapRef}
        className="relative w-full rounded-sm outline-none"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label="Timeline of photos per month"
      >
        {/* SVG paints later elements on top
         * Order: baseline, year dividers + labels, gridlines, bars, brush on top */}
        <svg
          width={width}
          height={HEIGHT}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* recessive grid: one baseline + year dividers */}
          <line
            className="axis-line"
            x1={M.left}
            x2={width - M.right}
            y1={yScale(0)}
            y2={yScale(0)}
          />
          {/* For each year: vertical divider at its start, label centered under its span */}
          {model.years.map((yr) => (
            <g key={+yr.start}>
              <line
                className="year-divider"
                x1={xScale(yr.start)}
                x2={xScale(yr.start)}
                y1={M.top}
                y2={HEIGHT - M.bottom + 4}
              />
              <text
                className="axis-label"
                x={(xScale(yr.start) + xScale(yr.end)) / 2}
                y={HEIGHT - 8}
                textAnchor="middle"
              >
                {yr.start.getFullYear()}
              </text>
            </g>
          ))}
          {/* Y axis: ~3 "nice" tick values from the scale; faint gridline + label for each */}
          {yScale
            .ticks(3)
            .filter((t) => t > 0 && Number.isInteger(t))
            .map((t) => (
              <g key={t}>
                <line
                  className="grid-line"
                  x1={M.left}
                  x2={width - M.right}
                  y1={yScale(t)}
                  y2={yScale(t)}
                />
                <text
                  className="axis-label"
                  x={M.left - 6}
                  y={yScale(t)}
                  dy="0.32em"
                  textAnchor="end"
                >
                  {t}
                </text>
              </g>
            ))}

          {/* Bars for each month/week - colored by whether it's selected, highlighted when hovered */}
          {snap === "week"
            ? model.weeks.map((b) => {
                if (!b.count) return null;
                const x0 = xScale(b.start) + 1;
                const w = Math.max(1, xScale(b.end) - xScale(b.start) - 2); // 2px gap between bars
                const top = yScale(b.count);
                return (
                  <path
                    key={+b.start}
                    className={`bar ${inRange(b) ? "bar-on" : "bar-off"} ${
                      hover?.bin === b ? "bar-hover" : ""
                    }`}
                    d={drawBarSVG(
                      x0,
                      top,
                      w,
                      yScale(0) - top,
                      Math.min(4, w / 2),
                    )}
                  />
                );
              })
            : model.months.map((b) => {
                if (!b.count) return null;
                const x0 = xScale(b.start) + 1;
                const w = Math.max(1, xScale(b.end) - xScale(b.start) - 1); // 1px gap between bars
                const top = yScale(b.count);
                return (
                  <path
                    key={+b.start}
                    className={`bar ${inRange(b) ? "bar-on" : "bar-off"} ${
                      hover?.bin === b ? "bar-hover" : ""
                    }`}
                    d={drawBarSVG(
                      x0,
                      top,
                      w,
                      yScale(0) - top,
                      Math.min(4, w / 2),
                    )}
                  />
                );
              })}
          {/* Empty group handed to D3: brush effect fills it. Brush on top of everything to receive mouse. */}
          <g ref={brushRef} className="brush" />
        </svg>

        {/* Tooltip for hovered month */}
        {hover && (
          <div className="tooltip" style={{ left: hover.x }}>
            <strong>{formatMonth(hover.bin.start)}</strong>
            <span>
              {hover.bin.count} photo{hover.bin.count === 1 ? "" : "s"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
