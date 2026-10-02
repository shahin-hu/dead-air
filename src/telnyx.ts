/**
 * The only three Telnyx calls we need. No SDK, no dependencies.
 */

const API = 'https://api.telnyx.com/v2';

export interface DialOptions {
  apiKey: string;
  connectionId: string;
  to: string;
  from: string;
  webhookUrl: string;
  /** Seconds to keep ringing before giving up. */
  timeoutSecs: number;
}

export interface DialResult {
  callControlId: string;
  callLegId: string;
  callSessionId: string;
  sentAt: number;
  respondedAt: number;
}

async function request(
  apiKey: string,
  path: string,
  body: unknown,
): Promise<{ data: Record<string, unknown>; sentAt: number; respondedAt: number }> {
  const sentAt = Date.now();
  const res = await fetch(API + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const respondedAt = Date.now();
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Telnyx ${res.status} on ${path}: ${text.slice(0, 400)}`);
  }
  let parsed: { data?: Record<string, unknown> } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Telnyx returned non-JSON on ${path}: ${text.slice(0, 200)}`);
  }
  return { data: parsed.data ?? {}, sentAt, respondedAt };
}

export async function dial(opts: DialOptions): Promise<DialResult> {
  const { data, sentAt, respondedAt } = await request(opts.apiKey, '/calls', {
    connection_id: opts.connectionId,
    to: opts.to,
    from: opts.from,
    // Per-call webhook override. This is what lets the tool run without
    // touching the Call Control App config.
    webhook_url: opts.webhookUrl,
    webhook_url_method: 'POST',
    timeout_secs: opts.timeoutSecs,
  });
  return {
    callControlId: String(data['call_control_id'] ?? ''),
    callLegId: String(data['call_leg_id'] ?? ''),
    callSessionId: String(data['call_session_id'] ?? ''),
    sentAt,
    respondedAt,
  };
}

export async function speak(
  apiKey: string,
  callControlId: string,
  payload: string,
  voice: string,
): Promise<void> {
  const id = encodeURIComponent(callControlId);
  await request(apiKey, `/calls/${id}/actions/speak`, {
    payload,
    voice,
    language: 'en-US',
  });
}

export async function hangup(apiKey: string, callControlId: string): Promise<void> {
  const id = encodeURIComponent(callControlId);
  try {
    await request(apiKey, `/calls/${id}/actions/hangup`, {});
  } catch {
    // The call may already be gone. That is not a failure of the run.
  }
}
