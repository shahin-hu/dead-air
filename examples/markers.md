# Marking your pipeline

`dead-air` can only draw what it is told about. Carrier webhooks give it the call.
Your markers give it everything that happens between the caller speaking and the
caller hearing a reply.

## The contract

While a call is live, POST to the local receiver:

```
POST http://localhost:8787/mark
Content-Type: application/json

{"label": "llm.first_token"}
```

The label becomes a row on the waterfall, stamped at the moment the request
arrived. Keep the POST fire and forget so it never adds latency to the thing you
are measuring.

## Labels that mean something to the tool

| Label                                | Treated as |
| ------------------------------------ | ---------- |
| `tts.first_byte` or `first_audio`    | The caller stops hearing silence. Used for "answer to first audio". |
| `stt.first_partial`                  | Audio reached your pipeline. Used as the start of "your pipeline". |
| anything else                        | A plain row on the timeline. |

## Node

```js
const MARK = process.env.DEADAIR_MARK_URL ?? 'http://localhost:8787/mark';

export const mark = (label) =>
  void fetch(MARK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  }).catch(() => {});
```

```js
socket.on('media', () => mark('stt.first_partial'));
const reply = await llm(transcript);
mark('llm.done');
await speak(reply);
mark('tts.first_byte');
```

## Python

```python
import json, urllib.request, threading

MARK = "http://localhost:8787/mark"

def mark(label: str) -> None:
    def send() -> None:
        try:
            req = urllib.request.Request(
                MARK,
                data=json.dumps({"label": label}).encode(),
                headers={"content-type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=1)
        except Exception:
            pass
    threading.Thread(target=send, daemon=True).start()
```

## Shell, for a quick one off

```bash
curl -s localhost:8787/mark -H 'content-type: application/json' -d '{"label":"llm.done"}'
```
