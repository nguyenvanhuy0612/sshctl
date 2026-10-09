/**
 * Named connection profiles.
 *
 * Without this, every tool call carries host + username + password as arguments, which
 * means the password travels through the MCP JSON-RPC message, lands in the model's
 * context, and is written to the client's session transcript. A profile keeps the secret
 * on disk (or in the environment) and lets the agent refer to a target by name.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface Profile {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  targetOs?: 'auto' | 'windows' | 'linux' | 'mac';
  description?: string;
}

export interface ResolvedTarget {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  targetOs: 'auto' | 'windows' | 'linux' | 'mac';
  profileName?: string;
}

/** Arguments any connection-taking tool accepts. All optional so a profile can supply them. */
export interface TargetArgs {
  profile?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  targetOs?: 'auto' | 'windows' | 'linux' | 'mac';
}

export function profilesPath(): string {
  const envPath = process.env.SSHCTL_PROFILES || process.env.MCP_SSH_PROFILES;
  if (envPath) {
    return expandHome(envPath);
  }
  return path.join(os.homedir(), '.sshctl', 'profiles.json');
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const parts = p.slice(2).split(/[/\\]+/).filter(Boolean);
    return path.join(os.homedir(), ...parts);
  }
  return p;
}

/**
 * Indirect a secret through the environment. A profile value of "env:VAR_NAME" is read
 * from process.env at call time so the secret never has to sit in the JSON file.
 */
export function derefSecret(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith('env:')) return value;
  const varName = value.slice(4);
  const fromEnv = process.env[varName];
  if (fromEnv === undefined) {
    throw new Error(
      `Profile ${label} references environment variable ${varName}, which is not set in the MCP server process.`
    );
  }
  return fromEnv;
}

export function loadProfiles(): Record<string, Profile> {
  const file = profilesPath();
  if (!fs.existsSync(file)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err: any) {
    throw new Error(`Failed to parse ${file}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object of profileName -> settings.`);
  }

  warnIfWorldReadable(file);
  return parsed as Record<string, Profile>;
}

/** Profiles hold credentials; a group- or world-readable file is worth complaining about. */
function warnIfWorldReadable(file: string): void {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) {
      console.error(
        `sshctl: warning: ${file} has mode ${mode.toString(8)}; it holds credentials. Run: chmod 600 "${file}"`
      );
    }
  } catch {
    // Permission probing is advisory only.
  }
}

/**
 * Merge a named profile with explicit arguments. Explicit arguments win, so a profile can
 * supply the host and key while a single call overrides the username.
 * Automatically matches an existing profile if host is given without a profile name.
 */
export function resolveTarget(args: TargetArgs): ResolvedTarget {
  let base: Profile | undefined;
  let matchedProfileName = args.profile;

  if (args.profile) {
    const profiles = loadProfiles();
    base = profiles[args.profile];
    if (!base) {
      const known = Object.keys(profiles);
      throw new Error(
        known.length
          ? `Unknown profile "${args.profile}". Known profiles: ${known.join(', ')}.`
          : `Unknown profile "${args.profile}". No profiles are defined in ${profilesPath()}.`
      );
    }
  } else if (args.host) {
    const profiles = loadProfiles();
    const exactMatch = Object.entries(profiles).find(
      ([_, p]) => p.host === args.host && (!args.username || p.username === args.username)
    );
    if (exactMatch) {
      matchedProfileName = exactMatch[0];
      base = exactMatch[1];
    }
  }

  const label = matchedProfileName ?? '<inline>';
  const host = args.host ?? base?.host;
  const username = args.username ?? base?.username;

  if (!host) {
    throw new Error('No host given. Pass "host" directly or a "profile" that defines one.');
  }
  if (!username) {
    throw new Error('No username given. Pass "username" directly or a "profile" that defines one.');
  }

  const privateKeyPath = args.privateKeyPath ?? base?.privateKeyPath;
  const resolvedKeyPath = privateKeyPath ? expandHome(privateKeyPath) : undefined;

  // Auto-heal file permissions on Unix if private key is accessible
  if (resolvedKeyPath && process.platform !== 'win32' && fs.existsSync(resolvedKeyPath)) {
    try {
      const stat = fs.statSync(resolvedKeyPath);
      if ((stat.mode & 0o077) !== 0) {
        fs.chmodSync(resolvedKeyPath, 0o600);
      }
    } catch {
      // Permission fix is best-effort
    }
  }

  return {
    host,
    username,
    port: args.port ?? base?.port ?? 22,
    password: derefSecret(args.password ?? base?.password, label),
    privateKeyPath: resolvedKeyPath,
    passphrase: derefSecret(args.passphrase ?? base?.passphrase, label),
    targetOs: args.targetOs ?? base?.targetOs ?? 'auto',
    profileName: matchedProfileName,
  };
}

/**
 * Persist or update a profile in profiles.json with mode 0600.
 */
export function upsertProfile(name: string, profile: Profile): void {
  const file = profilesPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  let current: Record<string, Profile> = {};
  if (fs.existsSync(file)) {
    try {
      current = loadProfiles();
    } catch {
      current = {};
    }
  }
  current[name] = profile;
  fs.writeFileSync(file, JSON.stringify(current, null, 2), { mode: 0o600 });
}

/**
 * Generate a concise profile name matching standard conventions (e.g. win46, host46).
 */
export function suggestProfileName(host: string, username: string, targetOs?: string): string {
  const lastOctet = host.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '') || host.replace(/[^a-zA-Z0-9]/g, '-');
  const prefix = targetOs === 'windows' ? 'win' : targetOs === 'mac' ? 'mac' : 'host';
  const candidate = `${prefix}${lastOctet}`;

  let current: Record<string, Profile> = {};
  try {
    current = loadProfiles();
  } catch {
    current = {};
  }
  if (current[candidate] && current[candidate].host !== host) {
    return `${prefix}-${host.replace(/\./g, '-')}`;
  }
  return candidate;
}

/** Profile summaries for the agent, with every secret field reduced to a boolean. */
export function describeProfiles(): Array<{
  name: string;
  host: string;
  port: number;
  username: string;
  targetOs: string;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  description?: string;
}> {
  const profiles = loadProfiles();
  return Object.entries(profiles).map(([name, p]) => ({
    name,
    host: p.host,
    port: p.port ?? 22,
    username: p.username,
    targetOs: p.targetOs ?? 'auto',
    hasPassword: Boolean(p.password),
    hasPrivateKey: Boolean(p.privateKeyPath),
    description: p.description,
  }));
}
