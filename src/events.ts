/**
 * Known Telnyx Voice API events, mapped to a short label and a phase.
 *
 * Phases drive both the colour in the terminal and the grouping in the
 * summary. Anything we do not recognise still shows up on the waterfall,
 * it just lands in the "other" phase.
 */

export type Phase = 'setup' | 'media' | 'pipeline' | 'teardown' | 'other';

export interface EventSpec {
  label: string;
  phase: Phase;
  /** Short note shown under the waterfall when this event is the slow one. */
  note?: string;
}

export const EVENTS: Record<string, EventSpec> = {
  'dial.requested': {
    label: 'dial sent',
    phase: 'setup',
    note: 'Our POST /v2/calls left this machine.',
  },
  'dial.accepted': {
    label: 'dial accepted',
    phase: 'setup',
    note: 'Telnyx acknowledged the dial. The call leg now exists.',
  },
  'call.initiated': {
    label: 'call.initiated',
    phase: 'setup',
    note: 'Telnyx created the call leg and started signalling out.',
  },
  // TeXML only. The Call Control API has no ringing event: an outbound call
  // goes call.initiated -> call.answered with nothing in between. Kept here so
  // a TeXML status callback lands in the right place if you feed one in.
  'call.ringing': {
    label: 'call.ringing',
    phase: 'setup',
    note: 'Post-dial delay. Time for the far carrier to start ringing the phone.',
  },
  'call.cost': {
    label: 'call.cost',
    phase: 'teardown',
    note: 'What the call actually cost. Needs call_cost_in_webhooks on the app.',
  },
  'call.answered': {
    label: 'call.answered',
    phase: 'setup',
    note: 'Somebody or something picked up.',
  },
  'call.bridged': { label: 'call.bridged', phase: 'media' },
  'streaming.started': {
    label: 'streaming.started',
    phase: 'media',
    note: 'Audio is now flowing to your websocket. Your pipeline can start.',
  },
  'streaming.stopped': { label: 'streaming.stopped', phase: 'teardown' },
  'streaming.failed': { label: 'streaming.failed', phase: 'teardown' },
  'call.playback.started': {
    label: 'playback.started',
    phase: 'media',
    note: 'First audio out. This is the moment the caller stops hearing silence.',
  },
  'call.playback.ended': { label: 'playback.ended', phase: 'media' },
  'call.speak.started': {
    label: 'speak.started',
    phase: 'media',
    note: 'First audio out. This is the moment the caller stops hearing silence.',
  },
  'call.speak.ended': { label: 'speak.ended', phase: 'media' },
  'call.recording.saved': { label: 'recording.saved', phase: 'teardown' },
  'call.hangup': { label: 'call.hangup', phase: 'teardown' },
};

/** Events that count as "the caller can now hear us", in priority order. */
export const FIRST_AUDIO_EVENTS = [
  'call.playback.started',
  'call.speak.started',
  'mark:tts.first_byte',
  'mark:first_audio',
];

export function specFor(eventType: string): EventSpec {
  const known = EVENTS[eventType];
  if (known) return known;
  if (eventType.startsWith('mark:')) {
    return { label: eventType.slice(5), phase: 'pipeline' };
  }
  return { label: eventType, phase: 'other' };
}
