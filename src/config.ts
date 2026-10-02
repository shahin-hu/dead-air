import { readFileSync } from 'node:fs';

/**
 * Config comes from flags first, then the environment, then a .env file in
 * the working directory. We never write the key anywhere.
 */

function loadDotEnv(): Record<string, string> {
  try {
    const raw = readFileSync('.env', 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

const dotEnv = loadDotEnv();

export function setting(flag: string | undefined, envName: string): string | undefined {
  return flag ?? process.env[envName] ?? dotEnv[envName];
}

export function required(
  flag: string | undefined,
  envName: string,
  humanName: string,
): string {
  const value = setting(flag, envName);
  if (!value) {
    throw new Error(
      `Missing ${humanName}. Pass it as a flag or set ${envName} in your environment or .env file.`,
    );
  }
  return value;
}

/** Never print a key. Show enough to confirm which one is loaded. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
