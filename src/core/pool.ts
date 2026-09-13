/**
 * Connection pool.
 *
 * Every tool used to open a fresh TCP + SSH handshake, run one command, and disconnect.
 * A single ssh_exec cost three round trips (handshake, OS probe, command), and an agent
 * running twenty commands against one host paid for twenty handshakes. Connections are now
 * keyed by target and reused until they go idle.
 *
 * The pool also caches per-connection facts that used to be re-probed every call: the
 * detected OS and the remote home directory.
 */

import { Client, ConnectConfig } from 'ssh2';

export type TargetOs = 'windows' | 'linux' | 'mac';

const IDLE_TIMEOUT_MS = Number(process.env.MCP_SSH_IDLE_TIMEOUT_MS ?? 60_000);

export interface PooledConnection {
  client: Client;
  /** Set by the first OS probe on this connection, reused afterwards. */
  detectedOs?: TargetOs;
  /** Set by the first sftp.realpath('.') on this connection, reused afterwards. */
  homeDir?: string;
}

interface Entry extends PooledConnection {
  key: string;
  leases: number;
  broken: boolean;
  idleTimer?: NodeJS.Timeout;
  /** True once this entry has been handed out at least twice, i.e. it is a reused socket. */
  reused: boolean;
}

const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();

/**
 * Pool key. Auth material is part of the key so switching from password to key auth, or
 * to a different key, produces a new connection instead of silently reusing the old one.
 */
export function poolKey(config: ConnectConfig, authTag: string): string {
  return `${config.username}@${config.host}:${config.port ?? 22}#${authTag}`;
}

function evict(entry: Entry): void {
  entry.broken = true;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  try {
    entry.client.end();
  } catch {
    // Already closed.
  }
}

function scheduleIdleClose(entry: Entry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.leases === 0) evict(entry);
  }, IDLE_TIMEOUT_MS);
  // Do not hold the event loop open purely for a pooled socket.
  entry.idleTimer.unref?.();
}

async function open(key: string, config: ConnectConfig): Promise<Entry> {
  const client = new Client();
  const entry: Entry = { key, client, leases: 0, broken: false, reused: false };

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const onReady = () => {
      settled = true;
      resolve();
    };
    const onEarlyError = (err: Error) => {
      if (settled) return;
      settled = true;
      evict(entry);
      reject(err);
    };

    client.once('ready', onReady);
    client.once('error', onEarlyError);

    try {
      client.connect(config);
    } catch (err) {
      onEarlyError(err as Error);
    }
  });

  // Each in-flight exec attaches its own error and close listeners to detect a mid-command
  // drop. A pooled connection can carry several at once, which would otherwise trip Node's
  // default 10-listener warning.
  client.setMaxListeners(0);

  // From here on, any error or close means the socket is unusable. Mark it so the next
  // acquire opens a fresh one instead of handing out a dead client.
  client.on('error', () => evict(entry));
  client.on('close', () => evict(entry));
  client.on('end', () => evict(entry));

  entries.set(key, entry);
  return entry;
}

async function acquire(key: string, config: ConnectConfig): Promise<Entry> {
  const existing = entries.get(key);
  if (existing && !existing.broken) {
    existing.leases += 1;
    existing.reused = true;
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    return existing;
  }

  // Collapse concurrent first-connects for the same target onto one handshake.
  let inflight = pending.get(key);
  if (!inflight) {
    inflight = open(key, config).finally(() => pending.delete(key));
    pending.set(key, inflight);
  }

  const entry = await inflight;
  entry.leases += 1;
  return entry;
}

function release(entry: Entry): void {
  entry.leases = Math.max(0, entry.leases - 1);
  if (entry.broken) return;
  if (entry.leases === 0) scheduleIdleClose(entry);
}

/**
 * Raised when a channel could not be opened on a pooled connection, which means the remote
 * command never started. This is the only failure a retry may safely repeat.
 *
 * Anything that fails after the command is already running must not be retried: the command may
 * well have completed on the remote side and only the reply was lost, so re-running it would
 * execute a non-idempotent operation twice.
 */
export class ChannelOpenError extends Error {
  constructor(cause: Error) {
    super(`Could not open a channel on the pooled SSH connection: ${cause.message}`);
    this.name = 'ChannelOpenError';
  }
}

/**
 * Run an operation against a pooled connection. If a reused connection turns out to be dead at
 * the moment the channel is opened, the operation is retried once on a fresh connection: a
 * socket a firewall reaped while idle should not surface to the agent as a command failure.
 */
export async function withConnection<T>(
  config: ConnectConfig,
  authTag: string,
  fn: (conn: PooledConnection) => Promise<T>
): Promise<T> {
  const key = poolKey(config, authTag);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const entry = await acquire(key, config);
    const wasReused = entry.reused;
    try {
      return await fn(entry);
    } catch (err) {
      if (attempt === 0 && wasReused && err instanceof ChannelOpenError) {
        evict(entry);
        continue;
      }
      throw err;
    } finally {
      release(entry);
    }
  }

  throw new Error('Unreachable: connection retry loop exhausted.');
}

/** Close every pooled connection. Used on shutdown and by tests. */
export function closeAll(): void {
  for (const entry of [...entries.values()]) evict(entry);
}

export function poolStats(): { open: number; keys: string[] } {
  return { open: entries.size, keys: [...entries.keys()] };
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    closeAll();
    process.exit(0);
  });
}
process.once('exit', closeAll);
