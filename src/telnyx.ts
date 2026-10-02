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

/**
 * The per-call `webhook_url` only redirects *subsequent* webhooks, which is
 * exactly what the API reference says if you read it twice. `call.initiated` is
 * not subsequent: it goes to whatever the Call Control App is configured with.
 *
 * So without pointing the app at the receiver too, the first event you ever see
 * is `call.answered`, there is no anchor for the clock offset, and the API round
 * trip cannot be separated from call setup.
 */
export async function getApp(
  apiKey: string,
  id: string,
): Promise<{ name: string; webhookUrl: string | null }> {
  const res = await fetch(`${API}/call_control_applications/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Could not read Call Control App ${id}: ${res.status}`);
  const parsed = (await res.json()) as { data?: Record<string, unknown> };
  return {
    name: String(parsed.data?.['application_name'] ?? ''),
    webhookUrl: (parsed.data?.['webhook_event_url'] as string | null) ?? null,
  };
}

export async function setAppWebhook(
  apiKey: string,
  id: string,
  name: string,
  webhookUrl: string | null,
): Promise<void> {
  const res = await fetch(`${API}/call_control_applications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    // application_name is required on PATCH even when it is not changing.
    body: JSON.stringify({ application_name: name, webhook_event_url: webhookUrl }),
  });
  if (!res.ok) {
    throw new Error(`Could not update Call Control App ${id}: ${res.status} ${await res.text()}`);
  }
}
