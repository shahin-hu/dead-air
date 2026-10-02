#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { maskKey, required, setting } from './config.js';
import { renderSvg } from './render/svg.js';
import { fail, note, renderWaterfall } from './render/terminal.js';
import { startReceiver } from './server.js';
import { dial, hangup, speak } from './telnyx.js';
import { openTunnel } from './tunnel.js';
import {
  buildPoints,
  computeMetrics,
  estimateSkew,
  segments,
  type RawEvent,
  type Run,
} from './timeline.js';

const HELP = `
dead-air  ·  measure the silence in your voice AI phone calls

  npx dead-air demo                       see the output, no account needed
  npx dead-air call --to +31201234567     place a real call and measure it
  npx dead-air replay runs/last.json      re-render a saved run

Options for "call"
  --to <e164>             number to call                      (required)
  --from <e164>           caller ID, a number on your account (required)
  --connection-id <id>    Call Control App id    (or TELNYX_CONNECTION_ID)
  --api-key <key>         Telnyx API key         (or TELNYX_API_KEY)
  --webhook-url <url>     your own public URL. Otherwise cloudflared is used.
  --port <n>              local webhook port                  (default 8787)
  --say "<text>"          speak this on answer, to mark first audio out
  --wait <secs>           hang up this long after answer       (default 8)
  --ring-timeout <secs>   give up if nobody answers            (default 30)
  --svg <path>            also write the waterfall as an SVG
  --json <path>           also write the raw run               (default runs/)

Marking your own pipeline
  While a call is live, POST to the local receiver:
    curl -s localhost:8787/mark -d '{"label":"llm.done"}' -H 'content-type: application/json'
  Those land on the same waterfall as the carrier events. That is the point.
`;

interface Flags {
  to?: string;
  from?: string;
  'connection-id'?: string;
  'api-key'?: string;
  'webhook-url'?: string;
  port?: string;
  say?: string;
  wait?: string;
  'ring-timeout'?: string;
  svg?: string;
  json?: string;
  help?: boolean;
}

function writeOut(run: Run, jsonPath: string | undefined): string {
  const points = buildPoints(run);
  const metrics = computeMetrics(points);
  const segs = segments(points);
  process.stdout.write(renderWaterfall(run, points, metrics, segs));

  const target = jsonPath ?? 'runs/last.json';
  try {
    mkdirSync(target.replace(/\/[^/]+$/, '') || '.', { recursive: true });
    writeFileSync(target, JSON.stringify({ run, points, metrics, segments: segs }, null, 2));
    note(`raw run written to ${target}`);
  } catch (err) {
    note(`could not write ${target}: ${(err as Error).message}`);
  }
  return target;
}

function maybeSvg(run: Run, path: string | undefined): void {
  if (!path) return;
  const points = buildPoints(run);
  writeFileSync(path, renderSvg(run, points, computeMetrics(points), segments(points)));
  note(`svg written to ${path}`);
}

/** A believable run, so the output can be seen and tested without spending money. */
function demoRun(): Run {
  const t0 = Date.now();
  const skew = -12;
  const at = (offset: number) => new Date(t0 + offset + skew).toISOString();
  const events: RawEvent[] = [
    { kind: 'local', eventType: 'dial.requested', receivedAt: t0 },
    { kind: 'local', eventType: 'dial.accepted', receivedAt: t0 + 118 },
    { kind: 'webhook', eventType: 'call.initiated', occurredAt: at(121), receivedAt: t0 + 164 },
    { kind: 'webhook', eventType: 'call.ringing', occurredAt: at(462), receivedAt: t0 + 509 },
    { kind: 'webhook', eventType: 'call.answered', occurredAt: at(3910), receivedAt: t0 + 3952 },
    { kind: 'webhook', eventType: 'streaming.started', occurredAt: at(4024), receivedAt: t0 + 4071 },
    { kind: 'mark', eventType: 'mark:stt.first_partial', receivedAt: t0 + 4610 },
    { kind: 'mark', eventType: 'mark:llm.done', receivedAt: t0 + 5180 },
    { kind: 'webhook', eventType: 'call.speak.started', occurredAt: at(5402), receivedAt: t0 + 5449 },
    { kind: 'webhook', eventType: 'call.hangup', occurredAt: at(9980), receivedAt: t0 + 10024 },
  ];
  return {
    startedAt: new Date(t0).toISOString(),
    t0,
    dialSentAt: t0,
    dialRespondedAt: t0 + 118,
    skewMs: skew,
    skewUncertaintyMs: 59,
    call: { to: '+31201234567', from: '+31208080808', callControlId: 'demo' },
    events,
    meta: { demo: true },
  };
}

async function runCall(flags: Flags): Promise<number> {
  const apiKey = required(flags['api-key'], 'TELNYX_API_KEY', 'Telnyx API key');
  const connectionId = required(
    flags['connection-id'],
    'TELNYX_CONNECTION_ID',
    'Call Control App id',
  );
  const to = required(flags.to, 'DEADAIR_TO', 'destination number (--to)');
  const from = required(flags.from, 'DEADAIR_FROM', 'caller ID (--from)');
  const port = Number(setting(flags.port, 'DEADAIR_PORT') ?? 8787);
  const waitSecs = Number(flags.wait ?? 8);
  const ringTimeout = Number(flags['ring-timeout'] ?? 30);

  note(`key ${maskKey(apiKey)}  app ${connectionId}`);

  const events: RawEvent[] = [];
  let callControlId = '';
  let answered = false;
  let finished: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });

  const receiver = await startReceiver(port, (event) => {
    events.push(event);
    note(`${event.eventType}`);

    if (event.eventType === 'call.answered' && !answered) {
      answered = true;
      if (flags.say && callControlId) {
        void speak(apiKey, callControlId, flags.say, 'female').catch((err) =>
          note(`speak failed: ${(err as Error).message}`),
        );
      }
      setTimeout(() => {
        if (callControlId) void hangup(apiKey, callControlId);
      }, waitSecs * 1000);
    }
    if (event.eventType === 'call.hangup') {
      setTimeout(finished, 400);
    }
  });
  note(`listening on :${receiver.port}`);

  const tunnel = await openTunnel(receiver.port, flags['webhook-url']);
  note(`webhooks to ${tunnel.url} (${tunnel.kind})`);

  let run: Run;
  try {
    const result = await dial({
      apiKey,
      connectionId,
      to,
      from,
      webhookUrl: tunnel.url,
      timeoutSecs: ringTimeout,
    });
    callControlId = result.callControlId;
    events.unshift(
      { kind: 'local', eventType: 'dial.requested', receivedAt: result.sentAt },
      { kind: 'local', eventType: 'dial.accepted', receivedAt: result.respondedAt },
    );
    note(`dialing ${to}, leg ${result.callLegId.slice(0, 8)}`);

    const hardStop = setTimeout(finished, (ringTimeout + waitSecs + 20) * 1000);
    await done;
    clearTimeout(hardStop);

    const initiated = events.find((e) => e.eventType === 'call.initiated');
    const skew = estimateSkew(initiated?.occurredAt, result.sentAt, result.respondedAt);
    run = {
      startedAt: new Date(result.sentAt).toISOString(),
      t0: result.sentAt,
      dialSentAt: result.sentAt,
      dialRespondedAt: result.respondedAt,
      skewMs: skew.skewMs,
      skewUncertaintyMs: skew.skewUncertaintyMs,
      call: {
        to,
        from,
        callControlId: result.callControlId,
        callLegId: result.callLegId,
        callSessionId: result.callSessionId,
      },
      events,
      meta: { tunnel: tunnel.kind, connectionId },
    };
  } finally {
    if (callControlId) await hangup(apiKey, callControlId);
    tunnel.close();
    await receiver.close();
  }

  if (!events.some((e) => e.kind === 'webhook')) {
    fail('No webhooks arrived. Telnyx could not reach the tunnel, so there is nothing to show.');
    return 1;
  }

  writeOut(run, flags.json);
  maybeSvg(run, flags.svg);
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      from: { type: 'string' },
      'connection-id': { type: 'string' },
      'api-key': { type: 'string' },
      'webhook-url': { type: 'string' },
      port: { type: 'string' },
      say: { type: 'string' },
      wait: { type: 'string' },
      'ring-timeout': { type: 'string' },
      svg: { type: 'string' },
      json: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const flags = values as Flags;
  const command = positionals[0] ?? 'help';

  if (flags.help || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === 'demo') {
    const run = demoRun();
    writeOut(run, flags.json ?? 'runs/demo.json');
    maybeSvg(run, flags.svg);
    return 0;
  }

  if (command === 'replay') {
    const path = positionals[1];
    if (!path) {
      fail('replay needs a path, for example: deadair replay runs/last.json');
      return 1;
    }
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { run: Run };
    writeOut(saved.run, undefined);
    maybeSvg(saved.run, flags.svg);
    return 0;
  }

  if (command === 'call') return runCall(flags);

  fail(`Unknown command "${command}".`);
  process.stdout.write(HELP);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    fail(err.message);
    process.exit(1);
  });
