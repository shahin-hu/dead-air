import { FIRST_AUDIO_EVENTS, specFor, type Phase } from './events.js';

/**
 * Two clocks are in play.
 *
 *   - Our clock. We timestamp the dial request and every webhook we receive.
 *   - Telnyx's clock. Every webhook carries `occurred_at` from their side.
 *
 * Deltas within one clock are trustworthy. Mixing the two is not, unless we
 * know the offset. We estimate it once, from the dial request:
 *
 *   `call.initiated` happens while Telnyx is handling our POST /v2/calls.
 *   The midpoint of that HTTP round trip is our best guess at the same
 *   instant on our clock, give or take half the round trip.
 *
 * Everything below is reported on our clock, relative to the dial. The
 * uncertainty is carried through and printed, because a 180ms number with
 * 200ms of error bar is not a number.
 */

export interface RawEvent {
  kind: 'webhook' | 'mark' | 'local';
  eventType: string;
  /** ISO 8601 from the carrier. Webhooks only. */
  occurredAt?: string;
  /** Epoch ms on our clock, when we saw it. */
  receivedAt: number;
  payload?: unknown;
}

export interface CallIds {
  callControlId?: string;
  callLegId?: string;
  callSessionId?: string;
  to?: string;
  from?: string;
}

export interface Run {
  startedAt: string;
  /** Epoch ms on our clock. Everything is measured from here. */
  t0: number;
  dialSentAt: number;
  dialRespondedAt: number;
  skewMs: number;
  skewUncertaintyMs: number;
  call: CallIds;
  events: RawEvent[];
  meta: Record<string, unknown>;
}

export interface Point {
  eventType: string;
  label: string;
  phase: Phase;
  note?: string;
  /** Ms since dial, on our clock. */
  at: number;
  /** Ms between the carrier stamping the event and us receiving it. */
  deliveryLag?: number;
  kind: RawEvent['kind'];
}

export interface Metrics {
  /** Dial sent until the far side starts ringing. Null if ringing is off. */
  postDialDelay: number | null;
  /** Ringing until answer. Human or machine reaction time, not ours. */
  ringDuration: number | null;
  timeToAnswer: number | null;
  /** Answer until the caller hears the first byte of our audio. */
  answerToFirstAudio: number | null;
  firstAudioAt: number | null;
  totalDuration: number | null;
  /** How much of the budget is the phone network, excluding ring time. */
  networkMs: number | null;
  /** How much is your own pipeline, from first audio in to first audio out. */
  pipelineMs: number | null;
  medianDeliveryLag: number | null;
}

function toLocal(ev: RawEvent, skewMs: number): number {
  if (ev.occurredAt) {
    const carrier = Date.parse(ev.occurredAt);
    if (!Number.isNaN(carrier)) return carrier - skewMs;
  }
  return ev.receivedAt;
}

export function estimateSkew(
  initiatedOccurredAt: string | undefined,
  dialSentAt: number,
  dialRespondedAt: number,
): { skewMs: number; skewUncertaintyMs: number } {
  const uncertainty = Math.round((dialRespondedAt - dialSentAt) / 2);
  if (!initiatedOccurredAt) return { skewMs: 0, skewUncertaintyMs: uncertainty };
  const carrier = Date.parse(initiatedOccurredAt);
  if (Number.isNaN(carrier)) return { skewMs: 0, skewUncertaintyMs: uncertainty };
  const midpoint = dialSentAt + (dialRespondedAt - dialSentAt) / 2;
  return { skewMs: Math.round(carrier - midpoint), skewUncertaintyMs: uncertainty };
}

export function buildPoints(run: Run): Point[] {
  const points = run.events.map((ev): Point => {
    const spec = specFor(ev.eventType);
    const localTime = toLocal(ev, run.skewMs);
    const point: Point = {
      eventType: ev.eventType,
      label: spec.label,
      phase: spec.phase,
      at: Math.round(localTime - run.t0),
      kind: ev.kind,
    };
    if (spec.note) point.note = spec.note;
    if (ev.occurredAt) {
      const lag = Math.round(ev.receivedAt - localTime);
      // A negative lag means our skew estimate drifted. Clamp, do not lie.
      point.deliveryLag = Math.max(0, lag);
    }
    return point;
  });
  return points.sort((a, b) => a.at - b.at);
}

function firstAt(points: Point[], types: string[]): number | null {
  for (const type of types) {
    const hit = points.find((p) => p.eventType === type);
    if (hit) return hit.at;
  }
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return null;
  return Math.round((lo + hi) / 2);
}

export function computeMetrics(points: Point[]): Metrics {
  const initiated = firstAt(points, ['call.initiated']);
  const ringing = firstAt(points, ['call.ringing']);
  const answered = firstAt(points, ['call.answered']);
  const firstAudio = firstAt(points, FIRST_AUDIO_EVENTS);
  const firstAudioIn = firstAt(points, ['streaming.started', 'mark:stt.first_partial']);
  const hangup = firstAt(points, ['call.hangup']);

  const lags = points
    .map((p) => p.deliveryLag)
    .filter((lag): lag is number => typeof lag === 'number');

  // Post-dial delay is initiated to ringing, not dial to ringing. Both ends are
  // carrier timestamps, so the clock offset cancels and the number is exact.
  // Measuring it from our own dial would fold in the API round trip and the
  // skew error, which is how you end up blaming a carrier for your own TLS
  // handshake.
  const postDialDelay =
    initiated !== null && ringing !== null && ringing >= initiated ? ringing - initiated : null;

  // Ring time is excluded from any share-of-budget maths. It is a person
  // reaching for a phone, not something anyone can engineer away.
  const pipelineMs =
    firstAudioIn !== null && firstAudio !== null && firstAudio >= firstAudioIn
      ? firstAudio - firstAudioIn
      : null;

  return {
    postDialDelay,
    ringDuration: ringing !== null && answered !== null ? answered - ringing : null,
    timeToAnswer: answered,
    answerToFirstAudio:
      answered !== null && firstAudio !== null ? firstAudio - answered : null,
    firstAudioAt: firstAudio,
    totalDuration: hangup,
    networkMs: postDialDelay,
    pipelineMs,
    medianDeliveryLag: median(lags),
  };
}

export interface Segment {
  name: string;
  from: string;
  to: string;
  ms: number;
  /** False for ring time: nobody can engineer that away. */
  yours: boolean;
}

/**
 * Splits dial-to-first-audio into the parts people can act on.
 *
 * Ring time is kept separate and flagged. It is the single biggest number on
 * most calls and it is not a latency problem, it is a human reaching for a
 * phone. Averaging it into "call latency" is how teams end up optimising the
 * wrong thing.
 */
export function segments(points: Point[]): Segment[] {
  const at = (types: string[]) => firstAt(points, types);
  const initiated = at(['call.initiated']);
  const ringing = at(['call.ringing']);
  const answered = at(['call.answered']);
  const audioIn = at(['streaming.started', 'mark:stt.first_partial', 'call.bridged']);
  const firstAudio = at(FIRST_AUDIO_EVENTS);

  const out: Segment[] = [];
  const push = (
    name: string,
    from: string,
    to: string,
    a: number | null,
    b: number | null,
    yours: boolean,
  ) => {
    if (a === null || b === null || b < a) return;
    out.push({ name, from, to, ms: b - a, yours });
  };

  push('api round trip', 'dial', 'initiated', 0, initiated, true);
  push('post-dial delay', 'initiated', 'ringing', initiated, ringing, true);
  push('ring', 'ringing', 'answered', ringing, answered, false);
  push('media path', 'answered', 'audio in', answered, audioIn, true);
  push('your pipeline', 'audio in', 'audio out', audioIn, firstAudio, true);

  // Without a streaming leg there is no honest boundary between the media path
  // and the pipeline. Report the whole post-answer block rather than invent one.
  if (audioIn === null && answered !== null && firstAudio !== null) {
    push('answer to audio', 'answered', 'audio out', answered, firstAudio, true);
  }
  return out;
}
