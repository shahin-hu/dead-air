import type { Metrics, Point, Run, Segment } from '../timeline.js';
import { scaleTo } from './terminal.js';
import type { CallOutcome } from '../timeline.js';

/**
 * The same waterfall as a standalone SVG, sized for a social post.
 * No external fonts, no scripts, readable on a dark timeline.
 */

const W = 1000;
const PAD = 36;
const ROW = 30;
const LABEL_W = 200;
const TIME_W = 110;
const SEG_VALUE_X = 196;
const SEG_BAR_X = 212;

const INK = {
  bg: '#0d1117',
  panel: '#161b22',
  text: '#e6edf3',
  dim: '#7d8590',
  setup: '#58a6ff',
  media: '#3fb950',
  pipeline: '#d29922',
  teardown: '#484f58',
  other: '#8b949e',
};

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ms(value: number): string {
  return `${value.toLocaleString('en-US')}ms`;
}

export function renderSvg(
  run: Run,
  points: Point[],
  metrics: Metrics,
  segs: Segment[],
  outcome: CallOutcome | null = null,
): string {
  const barMax = W - PAD * 2 - LABEL_W - TIME_W;
  const scaleMax = scaleTo(points);
  const headerH = 78;
  const waterfallH = points.length * ROW + 16;
  const segH = segs.length > 0 ? segs.length * 26 + 46 : 0;
  const footerH = 58;
  const H = headerH + waterfallH + segH + footerH;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">`,
  );
  out.push(`<rect width="${W}" height="${H}" fill="${INK.bg}"/>`);

  out.push(
    `<text x="${PAD}" y="42" fill="${INK.text}" font-size="21" font-weight="700">dead-air</text>`,
  );
  out.push(
    `<text x="${PAD + 128}" y="42" fill="${INK.dim}" font-size="14">${esc(run.call.to ?? '')}</text>`,
  );
  const headline =
    metrics.answerToFirstAudio !== null
      ? `${ms(metrics.answerToFirstAudio)} of silence after answer`
      : 'call timeline';
  out.push(
    `<text x="${W - PAD}" y="42" fill="${INK.dim}" font-size="14" text-anchor="end">${esc(headline)}</text>`,
  );
  out.push(
    `<line x1="${PAD}" y1="58" x2="${W - PAD}" y2="58" stroke="${INK.panel}" stroke-width="1"/>`,
  );

  let y = headerH + 8;
  const barX = PAD + LABEL_W;
  for (const point of points) {
    const colour = (INK as Record<string, string>)[point.phase] ?? INK.other;
    const overflow = point.at > scaleMax;
    const width = overflow ? barMax : Math.max(2, Math.round((point.at / scaleMax) * barMax));
    out.push(
      `<text x="${PAD}" y="${y + 4}" fill="${INK.dim}" font-size="13">${esc(point.label)}</text>`,
    );
    out.push(
      `<rect x="${barX}" y="${y - 7}" width="${width}" height="11" rx="2" fill="${colour}" opacity="${point.kind === 'mark' ? 0.75 : 1}"/>`,
    );
    if (overflow) {
      out.push(
        `<path d="M${barX + width + 3} ${y - 7} l6 5.5 l-6 5.5 z" fill="${INK.teardown}"/>`,
      );
    }
    out.push(
      `<text x="${barX + width + (overflow ? 18 : 10)}" y="${y + 4}" fill="${INK.text}" font-size="13">${esc(ms(point.at))}</text>`,
    );
    y += ROW;
  }

  if (segs.length > 0) {
    y += 16;
    out.push(
      `<line x1="${PAD}" y1="${y - 14}" x2="${W - PAD}" y2="${y - 14}" stroke="${INK.panel}" stroke-width="1"/>`,
    );
    out.push(
      `<text x="${PAD}" y="${y + 6}" fill="${INK.text}" font-size="13" font-weight="700">Where the time went</text>`,
    );
    y += 26;
    const fixableTotal = segs.filter((s) => s.yours).reduce((sum, s) => sum + s.ms, 0) || 1;
    for (const seg of segs) {
      const share = seg.yours ? seg.ms / fixableTotal : 0;
      const width = seg.yours ? Math.max(2, Math.round(share * (barMax * 0.6))) : 0;
      out.push(
        `<text x="${PAD}" y="${y + 4}" fill="${INK.dim}" font-size="13">${esc(seg.name)}</text>`,
      );
      out.push(
        `<text x="${PAD + SEG_VALUE_X}" y="${y + 4}" fill="${INK.text}" font-size="13" text-anchor="end">${esc(ms(seg.ms))}</text>`,
      );
      if (seg.yours) {
        out.push(
          `<rect x="${PAD + SEG_BAR_X}" y="${y - 7}" width="${width}" height="11" rx="2" fill="${INK.media}"/>`,
        );
        out.push(
          `<text x="${PAD + SEG_BAR_X + 10 + width}" y="${y + 4}" fill="${INK.dim}" font-size="12">${Math.round(share * 100)}%</text>`,
        );
      } else {
        out.push(
          `<text x="${PAD + SEG_BAR_X}" y="${y + 4}" fill="${INK.teardown}" font-size="12">${esc(seg.why ?? "")}</text>`,
        );
      }
      y += 26;
    }
  }

  const mosBits = (outcome?.quality ?? [])
    .filter((q) => q.mos !== null)
    .map((q) => `${q.direction} MOS ${q.mos?.toFixed(2)}`)
    .join(' / ');
  const footer = [
    metrics.postDialDelay !== null ? `post-dial ${ms(metrics.postDialDelay)}` : null,
    mosBits || null,
    metrics.medianDeliveryLag !== null ? `webhook lag ${ms(metrics.medianDeliveryLag)}` : null,
    `clock skew ${ms(run.skewMs)} ±${ms(run.skewUncertaintyMs)}`,
  ]
    .filter((part): part is string => part !== null)
    .join('   ·   ');
  out.push(
    `<line x1="${PAD}" y1="${H - 42}" x2="${W - PAD}" y2="${H - 42}" stroke="${INK.panel}" stroke-width="1"/>`,
  );
  out.push(
    `<text x="${PAD}" y="${H - 20}" fill="${INK.dim}" font-size="12">${esc(footer)}</text>`,
  );
  out.push(
    `<text x="${W - PAD}" y="${H - 20}" fill="${INK.teardown}" font-size="12" text-anchor="end">npx dead-air</text>`,
  );
  out.push('</svg>');
  return out.join('\n');
}
