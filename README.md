# dead-air

Measure the silence in your voice AI phone calls.

Every voice AI latency benchmark measures the same three things: speech to text,
the model, and text to speech. None of them measure the phone call. So teams tune
a 900ms pipeline down to 600ms and the caller still waits, because a third of the
wait was never in the pipeline.

`dead-air` puts the carrier events and your own pipeline stages on one timeline,
so you can see which part you are actually paying for.

On a real call from a US number to a Dutch mobile, with **no AI in the path at
all**, the caller waited **640ms** after picking up before hearing a single
syllable. That is most of a sub-second budget, spent before a model is asked
anything.

Zero dependencies. One command.

```
npx dead-air demo
```

```
  dead-air +31201234567 2026-10-02T10:53:18.249Z

  dial sent          ├─        0ms
  dial accepted      ├─      118ms
  call.initiated     ├─      121ms
  call.answered      ├─────────────────────────────────    3,910ms  ← setup and ring, not separable here
  streaming.started  ├──────────────────────────────────    4,024ms
  stt.first_partial  ├───────────────────────────────────────    4,610ms ·
  llm.done           ├────────────────────────────────────────────    5,180ms ·
  speak.started      ├──────────────────────────────────────────────    5,402ms  ← caller hears you
  call.hangup        ├──────────────────────────────────────────────»    9,980ms

  Where the time went
    api round trip      121ms    8%  ██
    setup and ring    3,789ms     —    not latency, a person picking up
    media path          114ms    7%  ██
    your pipeline     1,378ms   85%  ████████████████████████

  Answer to first audio   1,492ms
  Call duration           9,980ms
  Webhook delivery lag    44ms median
  Clock skew              -12ms ±59ms

  Line quality from call_quality_stats on the hangup webhook
    inbound         MOS 4.21   loss 1.43%   jitter var 2.74   491 pkts
    outbound        MOS 4.48   loss 0.20%   503 pkts
    ended           normal_clearing · caller · 200

  No ringing event, so signalling and ring time cannot be told apart.
  The Call Control API does not emit one. TeXML status callbacks do.

  First audio out. This is the moment the caller stops hearing silence.
```

## Measure a real call

You need a Telnyx API key, a Call Control App, and a number on your account.

```bash
export TELNYX_API_KEY=KEY...
export TELNYX_CONNECTION_ID=2345678901234567890

npx dead-air call \
  --to +31201234567 \
  --from +31208080808 \
  --say "testing one two three" \
  --svg call.svg
```

Telnyx needs a public URL to deliver webhooks to. If `cloudflared` is on your
PATH, one is made for you and torn down at the end. Otherwise pass
`--webhook-url https://your-host` and point it at the local port yourself.

The run is saved to `runs/last.json`. Re-render it any time with
`npx dead-air replay runs/last.json`.

## Put your own pipeline on the timeline

Carrier events tell you when the call connected. They cannot tell you why the
caller waited. Your stages can. While a call is live, POST to the local
receiver:

```bash
curl -s localhost:8787/mark \
  -H 'content-type: application/json' \
  -d '{"label":"stt.first_partial"}'
```

Three lines in your agent is usually enough:

```js
const mark = (label) =>
  fetch('http://localhost:8787/mark', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  }).catch(() => {});

mark('stt.first_partial');
mark('llm.done');
mark('tts.first_byte');
```

Label anything you like. Labels called `tts.first_byte` or `first_audio` are
treated as the moment the caller stops hearing silence, same as the carrier's
own playback events.

## What it measures, and what it does not

Worth reading before you quote a number from this tool at anyone.

**Measured from carrier timestamps.** Every Telnyx webhook carries `occurred_at`.
Deltas between two of those are solid, because the clock offset cancels: post-dial
delay, ring duration, answer to first audio, call duration.

Post-dial delay here is `call.initiated` to `call.ringing`, not your dial to
ringing. Measuring from your own dial folds in the API round trip and your TLS
handshake, which is how people end up blaming a carrier for their own network.
The API round trip is shown as its own row instead.

**Measured on your clock.** Your `/mark` calls, and the dial request itself.

**Estimated once, then carried through.** The two clocks are not the same clock.
`call.initiated` happens while Telnyx is handling your `POST /v2/calls`, so the
midpoint of that HTTP round trip is the best available guess at the same instant
on your side. The offset is printed as `clock skew` with an error bar of half the
round trip. If that error bar is wider than the number you care about, you do not
have that number. The tool says so rather than rounding the doubt away.

**Read from the hangup webhook.** Telnyx puts `call_quality_stats` on
`call.hangup`, aggregated from CHANNEL_HANGUP_COMPLETE: MOS, jitter variance and
packet counts, per direction. Nothing extra to enable and no second API call.
Packet loss is derived, because what you get is `skip_packet_count` against
`packet_count`, not a percentage.

I did not know this was there until I went looking in the OpenAPI spec. If you
are already taking Telnyx webhooks, you have had MOS on every call this whole
time.

**Not measured.** Anything that needs the RTP stream itself: quality second by
second rather than one number at the end, one-way audio detection, or the
waveform. This tool reads signalling and events, not packets. For those you want
`sngrep`, Homer or VoIPmonitor, and a capture.

**Ring time is reported separately and excluded from the percentages.** It is
usually the biggest number on the call and it is not a latency problem. It is a
person reaching for a phone. Averaging it into "call latency" is how teams end up
optimising the wrong thing.

**Webhook delivery lag is not call latency.** It is how long the event took to
reach your machine, tunnel included. It does not affect the call timeline, which
comes from carrier timestamps. It is printed so you can see what your tunnel
costs you if you are reacting to webhooks in real time.

## Why there is no webhook signature check

Telnyx signs webhooks with `telnyx-signature-ed25519`, and anything that acts on
a webhook should verify it. This tool does not act on webhooks, it timestamps
them, and it listens on a throwaway tunnel for the length of one call.

The real reason is that verification would sit on the response path, and a slow
reply turns into a Telnyx retry, which would show up as a duplicate event on your
timeline. The handler answers 200 first and does everything else afterwards.

If you point it at a long lived public URL instead of a per-run tunnel, that
tradeoff stops being free. Anyone who can reach the port can post events into
your run. Use a fresh tunnel per run, which is the default.

## Post-dial delay, and why you probably cannot see it

Post-dial delay is the gap between your carrier sending the INVITE and the far
network starting to ring the phone. It is the number that tells you whether a
slow connect is the network or the callee.

**The Call Control API does not emit a ringing event.** An outbound call goes
`call.initiated`, then `call.answered`, with nothing in between. So signalling
time and the seconds a human spent reaching for their phone arrive as one
number, and nothing can separate them. I checked the OpenAPI spec rather than
the docs: the only `ringing` callbacks Telnyx defines are TeXML ones.

This tool does not guess at the split. It reports `setup and ring` as a single
block and leaves it out of the percentages, the same way ring time is left out.

If you need the split, drive the call with TeXML and point its status callbacks
here. `initiated`, `ringing`, `answered` and `completed` all arrive there, and
the waterfall splits automatically when a ringing event shows up.

## Flags

```
--to <e164>             number to call                      (required)
--from <e164>           caller ID, a number on your account (required)
--connection-id <id>    Call Control App id    (or TELNYX_CONNECTION_ID)
--api-key <key>         Telnyx API key         (or TELNYX_API_KEY)
--webhook-url <url>     your own public URL, instead of cloudflared
--port <n>              local webhook port                  (default 8787)
--say "<text>"          speak this on answer, to mark first audio out
--wait <secs>           hang up this long after answer       (default 8)
--ring-timeout <secs>   give up if nobody answers            (default 30)
--svg <path>            write the waterfall as an SVG
--json <path>           write the raw run      (default runs/last.json)
```

Config is read from flags first, then the environment, then a `.env` file in the
working directory. The key is never written to disk and never printed in full.

## Other carriers

The timeline model is carrier agnostic. Only `src/telnyx.ts` knows about Telnyx,
and it is about 80 lines of `fetch`. A provider that emits call progress events
with timestamps can be added behind the same interface. Pull requests welcome.

## Why I built this

I am a forward deployed engineer at Telnyx. I spend my week on calls with teams
building voice agents, and the same conversation keeps happening: they have tuned
their pipeline hard, the demo still feels slow, and nobody has looked at the
phone call underneath it. The tools that can look at it are carrier tools. They
need packet capture and they assume you already speak SIP.

This is the small version of that, for people who have an API key and a problem.

MIT.
