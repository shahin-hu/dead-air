import type { Point } from '../timeline.js';

/**
 * A real call spends most of its wall clock waiting for a human to pick up.
 * Plotted linearly that one gap eats the axis and every number worth reading
 * collapses into the first few pixels.
 *
 * So the axis is piecewise: ordinary gaps keep their true width, and any gap
 * that is both long in absolute terms and dominant in relative terms is
 * compressed to a fixed stub and marked with a break. The compression is drawn,
 * never silent, and the printed times are always the real ones.
 */

export interface AxisBreak {
  /** Time the compressed gap starts at. */
  from: number;
  to: number;
  ms: number;
  /** Position of the break on the 0..1 axis. */
  pos: number;
}

export interface Axis {
  /** Maps a time in ms to a 0..1 position along the drawn axis. */
  pos: (at: number) => number;
  breaks: AxisBreak[];
}

const MIN_GAP_MS = 2_000;
const GAP_SHARE = 0.25;
/** A compressed gap is drawn this wide, relative to everything kept at scale. */
const STUB_SHARE = 0.07;

export function buildAxis(points: Point[]): Axis {
  const times = [...new Set(points.map((p) => p.at))].sort((a, b) => a - b);
  const first = times[0];
  const last = times[times.length - 1];
  if (first === undefined || last === undefined || last === first) {
    return { pos: () => 0, breaks: [] };
  }
  const span = last - first;

  const segments = times.slice(1).map((to, i) => {
    const from = times[i] as number;
    const ms = to - from;
    return { from, to, ms, compress: ms > MIN_GAP_MS && ms / span > GAP_SHARE };
  });

  const keptTotal = segments.filter((s) => !s.compress).reduce((sum, s) => sum + s.ms, 0);
  const compressed = segments.filter((s) => s.compress);
  // Nothing kept at scale means compressing would hide everything. Stay linear.
  if (compressed.length === 0 || keptTotal === 0) {
    return { pos: (at) => (at - first) / span, breaks: [] };
  }

  const stub = keptTotal * STUB_SHARE;
  const total = keptTotal + stub * compressed.length;

  // Walk the segments once, recording where each real time lands.
  const marks = new Map<number, number>();
  const breaks: AxisBreak[] = [];
  let drawn = 0;
  marks.set(first, 0);
  for (const seg of segments) {
    if (seg.compress) {
      breaks.push({ from: seg.from, to: seg.to, ms: seg.ms, pos: (drawn + stub / 2) / total });
      drawn += stub;
    } else {
      drawn += seg.ms;
    }
    marks.set(seg.to, drawn / total);
  }

  const pos = (at: number): number => {
    const exact = marks.get(at);
    if (exact !== undefined) return exact;
    // A time between two marks, such as a derived segment boundary.
    if (at <= first) return 0;
    if (at >= last) return 1;
    let acc = 0;
    for (const seg of segments) {
      if (at <= seg.to) {
        if (seg.compress) return (acc + stub / 2) / total;
        return (acc + (at - seg.from)) / total;
      }
      acc += seg.compress ? stub : seg.ms;
    }
    return 1;
  };

  return { pos, breaks };
}
