import { z } from 'zod';
import { SSHHelper } from '../../core/ssh-client.js';
import { ResolvedTarget, TargetArgs, resolveTarget } from '../../core/profiles.js';

/**
 * Connection fields shared by every tool.
 *
 * None of these carry a zod `.default()`. A default would win over a value coming from a named
 * profile, so `port` and `targetOs` are resolved in resolveTarget() instead.
 */
export const targetSchema = {
  profile: z
    .string()
    .optional()
    .describe(
      'Name of a saved profile from ~/.sshctl/profiles.json. Supplies host, username and credentials so they do not have to be passed on every call. Run ssh_list_profiles to see what is available.'
    ),
  host: z.string().optional().describe('Target hostname or IP. Required unless profile supplies it.'),
  port: z.number().optional().describe('SSH port (default 22).'),
  username: z.string().optional().describe('SSH username. Required unless profile supplies it.'),
  password: z
    .string()
    .optional()
    .describe(
      'SSH password. Prefer a profile or an SSH key: a password passed here is recorded in the conversation transcript.'
    ),
  privateKeyPath: z.string().optional().describe('Path to a private key file.'),
  passphrase: z
    .string()
    .optional()
    .describe('Passphrase for the private key. Prefer loading the key into ssh-agent instead.'),
};

/** Exec tuning shared by the tools that run remote commands. */
export const execSchema = {
  timeoutMs: z
    .number()
    .optional()
    .describe('Abort the remote command after this many milliseconds (default 60000).'),
  maxOutputBytes: z
    .number()
    .optional()
    .describe('Cap captured stdout and stderr at this many bytes (default 32000).'),
  maxLines: z
    .number()
    .optional()
    .describe('Cap output lines (default 200). Uses smart head/tail preview if exceeded.'),
  tail: z
    .number()
    .optional()
    .describe('Return only the last N lines of output (useful for logs/builds).'),
  head: z
    .number()
    .optional()
    .describe('Return only the first N lines of output.'),
  compact: z
    .boolean()
    .optional()
    .default(true)
    .describe('Collapse redundant empty lines and trim trailing whitespace (default true).'),
};

export function targetOsSchema(description: string) {
  return z.enum(['auto', 'windows', 'linux', 'mac']).optional().describe(description);
}

/** Resolve profile plus explicit arguments into a helper and the concrete target. */
export function helperFor(args: TargetArgs): { helper: SSHHelper; target: ResolvedTarget } {
  const target = resolveTarget(args);
  const helper = new SSHHelper({
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    privateKeyPath: target.privateKeyPath,
    passphrase: target.passphrase,
  });
  return { helper, target };
}

/** How the target is named in messages: the profile if there is one, otherwise user@host. */
export function targetLabel(target: ResolvedTarget): string {
  const base = `${target.username}@${target.host}:${target.port}`;
  return target.profileName ? `${target.profileName} (${base})` : base;
}

export function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}
