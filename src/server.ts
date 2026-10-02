import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { RawEvent } from './timeline.js';

/**
 * Catches two things:
 *
 *   POST /        Telnyx webhooks. We stamp the arrival time ourselves.
 *   POST /mark    Your own pipeline stages, so STT, LLM and TTS land on the
 *                 same waterfall as the call. Body: {"label": "llm.done"}
 *
 * The mark endpoint is the point of the whole tool. Carrier events alone
 * tell you when the call connected. They cannot tell you why the caller
 * waited. Your markers can.
 */

export interface Receiver {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error('Request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function startReceiver(
  port: number,
  onEvent: (event: RawEvent) => void,
): Promise<Receiver> {
  const server = createServer((req, res) => {
    const receivedAt = Date.now();
    const url = req.url ?? '/';

    if (req.method === 'GET' && url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    void readBody(req)
      .then((body) => {
        // Answer Telnyx immediately. A slow webhook reply shows up as
        // delivery lag on the next event and poisons the measurement.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          return;
        }

        if (url.startsWith('/mark')) {
          const label = String(parsed['label'] ?? 'mark');
          onEvent({
            kind: 'mark',
            eventType: `mark:${label}`,
            receivedAt,
            payload: parsed,
          });
          return;
        }

        const data = parsed['data'] as Record<string, unknown> | undefined;
        if (!data || typeof data['event_type'] !== 'string') return;
        const occurredAt = data['occurred_at'];
        const event: RawEvent = {
          kind: 'webhook',
          eventType: data['event_type'],
          receivedAt,
          payload: data['payload'],
        };
        if (typeof occurredAt === 'string') event.occurredAt = occurredAt;
        onEvent(event);
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(400).end();
      });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
