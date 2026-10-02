import type { CallOutcome, Metrics, Point, Run, Segment } from '../timeline.js';
import { buildAxis } from './axis.js';

const useColor =
  process.stdout.isTTY === true && !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb';

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  grey: '\u001b[90m',
};

function paint(text: string, ...codes: string[]): string {
  if (!useColor) return text;
  return codes.join('') + text + C.reset;
}

const PHASE_COLOR: Record<string, string> = {
  setup: C.cyan,
  media: C.green,
  pipeline: C.yellow,
  teardown: C.grey,
  other: '',
};

function ms(value: number): string {
  return `${value.toLocaleString('en-US')}ms`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Everything after the caller hears us is off-scale, not interesting. */
export function scaleTo(points: Point[]): number {
  const inScope = points.filter((p) => p.phase !== 'teardown').map((p) => p.at);
  return Math.max(1, ...(inScope.length > 0 ? inScope : points.map((p) => p.at)));
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

export function renderWaterfall(
  run: Run,
  points: Point[],
  metrics: Metrics,
  segs: Segment[],
  outcome: CallOutcome | null,
): string {
  const lines: string[] = [];
  const barWidth = Math.max(20, Math.min(46, (process.stdout.columns ?? 100) - 54));
  // Scale to the moment the caller hears us, not to hangup. Call duration is
  // arbitrary and would squash every number worth reading into the first inch.
  const axis = buildAxis(points);
  const labelWidth = Math.max(16, ...points.map((p) => p.label.length)) + 2;

  const to = run.call.to ?? 'unknown';
  lines.push('');
  lines.push(
    `  ${paint('dead-air', C.bold)} ${paint(to, C.dim)} ${paint(new Date(run.t0).toISOString(), C.dim)}`,
  );
  lines.push('');

  let highlighted: string | undefined;
  for (const point of points) {
    const filled = Math.max(1, Math.round(axis.pos(point.at) * barWidth));
    // Mark where the axis was compressed, inside every bar that spans it, so a
    // long bar never reads as a long wait.
    const cells = Array.from({ length: filled }, () => '─');
    for (const brk of axis.breaks) {
      const index = Math.round(brk.pos * barWidth);
      if (index < filled) cells[index] = '╳';
    }
    const bar = paint(cells.join(''), PHASE_COLOR[point.phase] ?? '');
    const marker = point.kind === 'mark' ? paint(' ·', C.yellow) : '';
    let suffix = '';
    if (point.eventType === 'call.ringing') suffix = paint('  ← post-dial delay', C.dim);
    if (point.eventType === 'call.answered' && metrics.postDialDelay === null)
      suffix = paint('  ← setup and ring, not separable here', C.dim);
    if (metrics.firstAudioAt !== null && point.at === metrics.firstAudioAt && !suffix) {
      suffix = paint('  ← caller hears you', C.dim);
      highlighted = point.note;
    }
    lines.push(`  ${pad(point.label, labelWidth)}├${bar} ${padLeft(ms(point.at), 10)}${marker}${suffix}`);
  }

  for (const brk of axis.breaks) {
    lines.push(
      paint(
        `  ${' '.repeat(labelWidth)}╳ = ${ms(brk.ms)} of waiting, not drawn to scale`,
        C.dim,
      ),
    );
  }

  lines.push('');
  if (segs.length > 0) {
    const fixable = segs.filter((s) => s.yours);
    const fixableTotal = fixable.reduce((sum, s) => sum + s.ms, 0) || 1;
    lines.push(`  ${paint('Where the time went', C.bold)}`);
    for (const seg of segs) {
      const share = seg.yours ? seg.ms / fixableTotal : 0;
      const blocks = seg.yours ? '█'.repeat(Math.max(1, Math.round(share * 28))) : '';
      const pct = seg.yours ? padLeft(`${Math.round(share * 100)}%`, 4) : padLeft('—', 4);
      const note = seg.yours ? '' : paint(`  ${seg.why ?? ''}`, C.dim);
      lines.push(
        `    ${pad(seg.name, 16)}${padLeft(ms(seg.ms), 9)}  ${pct}  ${paint(blocks, C.green)}${note}`,
      );
    }
    lines.push('');
  }

  const rows: Array<[string, string | null]> = [
    ['Post-dial delay', metrics.postDialDelay === null ? null : ms(metrics.postDialDelay)],
    [
      'Answer to first audio',
      metrics.answerToFirstAudio === null ? null : ms(metrics.answerToFirstAudio),
    ],
    ['Call duration', metrics.totalDuration === null ? null : ms(metrics.totalDuration)],
    [
      'Webhook delivery lag',
      metrics.medianDeliveryLag === null ? null : `${ms(metrics.medianDeliveryLag)} median`,
    ],
    ['Clock skew', `${ms(run.skewMs)} ±${ms(run.skewUncertaintyMs)}`],
  ];
  for (const [name, value] of rows) {
    if (value === null) continue;
    lines.push(`  ${pad(name, 24)}${paint(value, C.bold)}`);
  }

  if (outcome && (outcome.quality.length > 0 || outcome.hangupCause)) {
    lines.push('');
    lines.push(`  ${paint('Line quality', C.bold)} ${paint('from call_quality_stats on the hangup webhook', C.dim)}`);
    for (const q of outcome.quality) {
      const bits = [
        q.mos !== null ? `MOS ${q.mos.toFixed(2)}` : null,
        q.lossPct !== null ? `loss ${q.lossPct.toFixed(2)}%` : null,
        q.jitterMaxVariance !== null ? `jitter var ${q.jitterMaxVariance}` : null,
        q.packetCount !== null ? `${q.packetCount.toLocaleString('en-US')} pkts` : null,
      ].filter((bit): bit is string => bit !== null);
      if (bits.length === 0) continue;
      // 3.6 is the usual line where people start complaining.
      const tone = q.mos !== null && q.mos < 3.6 ? C.yellow : C.green;
      lines.push(`    ${pad(q.direction, 16)}${paint(bits.join('   '), tone)}`);
    }
    if (outcome.cost && outcome.cost.totalCost !== null) {
      const { totalCost, currency, billedDurationSecs, parts } = outcome.cost;
      const breakdown = parts.map((p) => `${p.part} ${p.cost}`).join(' + ');
      const billed = billedDurationSecs !== null ? ` over ${billedDurationSecs}s` : '';
      lines.push(
        `    ${pad('cost', 16)}${paint(`${totalCost.toFixed(4)} ${currency}`, C.bold)}${paint(`${billed}${breakdown ? `   ${breakdown}` : ''}`, C.dim)}`,
      );
    }
    if (outcome.hangupCause) {
      const cause = [outcome.hangupCause, outcome.hangupSource, outcome.sipHangupCause]
        .filter((part): part is string => part !== null && part !== 'unspecified')
        .join(' · ');
      lines.push(`    ${pad('ended', 16)}${paint(cause, C.dim)}`);
    }
  }

  if (metrics.postDialDelay === null) {
    lines.push('');
    lines.push(
      paint(
        '  No ringing event, so signalling and ring time cannot be told apart.\n  The Call Control API does not emit one. TeXML status callbacks do.',
        C.dim,
      ),
    );
  }
  if (points.every((p) => p.kind !== 'mark')) {
    lines.push('');
    lines.push(
      paint(
        '  No pipeline markers. Everything above is the phone network only.\n  POST your own stages to /mark to see the rest. See README.',
        C.dim,
      ),
    );
  }
  if (highlighted) {
    lines.push('');
    lines.push(paint(`  ${highlighted}`, C.dim));
  }
  lines.push('');
  return lines.join('\n');
}

export function note(text: string): void {
  process.stderr.write(`${paint('·', C.grey)} ${text}\n`);
}

export function fail(text: string): void {
  process.stderr.write(`${paint('✗', C.red)} ${text}\n`);
}
