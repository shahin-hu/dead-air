import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Telnyx has to reach us. In order of preference:
 *
 *   1. --webhook-url that you already run. Nothing is spawned.
 *   2. A cloudflared quick tunnel, if cloudflared is on your PATH.
 *   3. Nothing. We tell you what to install and stop.
 *
 * A tunnel adds a hop, and that hop lands in the delivery lag number, not in
 * the call timeline. The call timeline comes from carrier timestamps and is
 * unaffected. The run prints the lag so you can see what the tunnel cost.
 */

export interface Tunnel {
  url: string;
  kind: 'provided' | 'cloudflared';
  close: () => void;
}

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function hasCloudflared(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn('cloudflared', ['--version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('exit', (code) => resolve(code === 0));
  });
}

function startCloudflared(port: number, timeoutMs: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      'cloudflared',
      ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('cloudflared did not produce a URL in time'));
    }, timeoutMs);

    const scan = (chunk: Buffer) => {
      const match = URL_PATTERN.exec(chunk.toString('utf8'));
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        url: match[0],
        kind: 'cloudflared',
        close: () => child.kill(),
      });
    };

    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function openTunnel(
  port: number,
  provided: string | undefined,
  timeoutMs = 20_000,
): Promise<Tunnel> {
  if (provided) {
    return { url: provided.replace(/\/$/, ''), kind: 'provided', close: () => {} };
  }
  if (await hasCloudflared()) {
    return startCloudflared(port, timeoutMs);
  }
  throw new Error(
    [
      'Telnyx needs a public URL to send webhooks to, and I could not make one.',
      '',
      'Pick one:',
      '  brew install cloudflared     (then rerun, a tunnel is made for you)',
      '  deadair call --webhook-url https://your-public-host  (bring your own)',
    ].join('\n'),
  );
}
