import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { describeProfiles, profilesPath } from '../../core/profiles.js';
import { helperFor, targetLabel, targetSchema, textResult } from './common.js';

export const sshTestConnectionSchema = { ...targetSchema };

export async function handleSshTestConnection(
  args: z.infer<z.ZodObject<typeof sshTestConnectionSchema>>
) {
  const { helper, target } = helperFor(args);
  const label = targetLabel(target);
  const result = await helper.testConnection();

  if (result.connected) {
    const lines = [`Connected to ${label}.`, `Target OS: ${result.targetOs?.toUpperCase()}`];
    if (result.suggestPasswordless) {
      lines.push(
        '',
        'This connection used a password. Run ssh_setup_passwordless to switch to key authentication, then save the target as a profile so later calls carry no credentials at all.'
      );
    }
    return textResult(lines.join('\n'));
  }

  const lines = [`Failed to connect to ${label}.`, `Error: ${result.error}`];

  if (result.authFailed) {
    lines.push(
      '',
      'The host answered but rejected the credentials. Check the username, and whether the key you expect is actually in authorized_keys on the target.'
    );
  }

  if (result.unreachable) {
    lines.push(
      '',
      'Nothing answered on that port. Either the host is unreachable, or no SSH server is listening.',
      'If the target is Windows and OpenSSH is simply not installed yet, ssh_generate_rdp_bootstrap produces a one-liner to paste into an RDP session.',
      'If the target is Linux, install and start openssh-server. On macOS, enable Remote Login in Sharing settings.'
    );
  }

  return textResult(lines.join('\n'), true);
}

export const sshClearKnownHostsSchema = {
  host: z.string().describe('Hostname or IP address to remove from known_hosts'),
  port: z
    .number()
    .optional()
    .describe('SSH port, if the entry was recorded as [host]:port for a non-standard port.'),
};

/**
 * Remove a host from known_hosts.
 *
 * Delegates to `ssh-keygen -R`, which is the only correct way to do this: entries are commonly
 * hashed (HashKnownHosts is on by default on macOS and many distributions), so a plain text
 * search finds nothing and reports success anyway. ssh-keygen also handles the [host]:port form
 * and writes a known_hosts.old backup. The manual fallback exists for hosts with no ssh-keygen
 * on PATH and matches host tokens exactly rather than by substring, so removing 10.0.0.1 no
 * longer takes 10.0.0.10 with it.
 */
export async function handleSshClearKnownHosts(
  args: z.infer<z.ZodObject<typeof sshClearKnownHostsSchema>>
) {
  const knownHostsPath = path.join(os.homedir(), '.ssh', 'known_hosts');
  if (!fs.existsSync(knownHostsPath)) {
    return textResult(`No known_hosts file at ${knownHostsPath}; nothing to clear.`);
  }

  const targets = [args.host];
  if (args.port && args.port !== 22) targets.push(`[${args.host}]:${args.port}`);

  try {
    const output = targets
      .map((t) =>
        execFileSync('ssh-keygen', ['-R', t, '-f', knownHostsPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        })
      )
      .join('')
      .trim();

    return textResult(
      [
        `Cleared ${targets.join(' and ')} from ${knownHostsPath} using ssh-keygen -R.`,
        `A backup was written to ${knownHostsPath}.old.`,
        output ? `\nssh-keygen output:\n${output}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  } catch (err: any) {
    const stderr = (err.stderr || '').toString().trim();

    // ssh-keygen exits non-zero when the host simply is not present. That is not a failure.
    if (/not found in/i.test(stderr)) {
      return textResult(`${args.host} was not present in ${knownHostsPath}; nothing to remove.`);
    }
    if (err.code !== 'ENOENT') {
      return textResult(`ssh-keygen -R failed: ${stderr || err.message}`, true);
    }
    return manualClear(knownHostsPath, targets);
  }
}

/** Exact-token fallback for systems without ssh-keygen. Cannot match hashed entries. */
function manualClear(knownHostsPath: string, targets: string[]) {
  const content = fs.readFileSync(knownHostsPath, 'utf8');
  const lines = content.split('\n');
  const wanted = new Set(targets);
  let hashedSeen = 0;

  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return true;
    const hostField = trimmed.split(/\s+/)[0];
    if (hostField.startsWith('|1|')) {
      hashedSeen += 1;
      return true;
    }
    return !hostField.split(',').some((token) => wanted.has(token));
  });

  const removed = lines.length - kept.length;
  fs.writeFileSync(`${knownHostsPath}.old`, content, { mode: 0o600 });
  fs.writeFileSync(knownHostsPath, kept.join('\n'), { mode: 0o600 });

  const notes = [
    `ssh-keygen is not on PATH, so ${knownHostsPath} was edited directly.`,
    `Removed ${removed} entr${removed === 1 ? 'y' : 'ies'} matching ${targets.join(' or ')} exactly.`,
    `Previous contents saved to ${knownHostsPath}.old.`,
  ];
  if (hashedSeen > 0) {
    notes.push(
      `Warning: ${hashedSeen} entries in this file are hashed and cannot be matched by hostname without ssh-keygen. If the host key error persists, one of them is the culprit.`
    );
  }
  return textResult(notes.join('\n'));
}

export const sshListProfilesSchema = {};

export async function handleSshListProfiles() {
  let profiles: ReturnType<typeof describeProfiles>;
  try {
    profiles = describeProfiles();
  } catch (err: any) {
    return textResult(`Could not read ${profilesPath()}: ${err.message}`, true);
  }

  if (profiles.length === 0) {
    return textResult(
      [
        `No profiles defined. Create ${profilesPath()} with mode 600:`,
        '',
        JSON.stringify(
          {
            'win-qa-01': {
              host: '10.0.0.5',
              username: 'qauser',
              privateKeyPath: '~/.ssh/id_ed25519',
              targetOs: 'windows',
              description: 'QA Windows box',
            },
            'build-linux': {
              host: 'build.internal',
              username: 'huy',
              password: 'env:BUILD_HOST_PASSWORD',
              targetOs: 'linux',
            },
          },
          null,
          2
        ),
        '',
        'A value of the form "env:NAME" is read from the MCP server process environment at call time, so the secret does not have to sit in the file.',
        'Once a profile exists, pass profile: "win-qa-01" instead of host, username and password.',
      ].join('\n')
    );
  }

  const rows = profiles.map((p) => {
    const auth = [p.hasPrivateKey ? 'key' : null, p.hasPassword ? 'password' : null]
      .filter(Boolean)
      .join(' + ') || 'ssh-agent or default key';
    return `- ${p.name}: ${p.username}@${p.host}:${p.port} os=${p.targetOs} auth=${auth}${p.description ? ` // ${p.description}` : ''}`;
  });

  return textResult([`Profiles from ${profilesPath()}:`, '', ...rows].join('\n'));
}

export function getRdpBootstrapOneLiner(): string {
  return `$t=$env:TEMP; iwr https://github.com/PowerShell/Win32-OpenSSH/releases/latest/download/OpenSSH-Win64.zip -Out $t\\s.zip; Expand-Archive $t\\s.zip $t -Force; $d=ls $t -d|?{$_.Name-like'OpenSSH*'}|select -f 1; cp $d.FullName C:\\ -r -Force; if($d.Name-ne'OpenSSH-Win64'){ren C:\\$($d.Name) OpenSSH-Win64}; powershell -ep Bypass -NonI -File C:\\OpenSSH-Win64\\install-sshd.ps1; Set-Service sshd,ssh-agent -StartupType Automatic; Start-Service ssh-agent,sshd; netsh advfirewall firewall add rule name=sshd protocol=TCP dir=in localport=22 action=allow|Out-Null; $f='C:\\ProgramData\\ssh\\administrators_authorized_keys'; if(!(Test-Path $f)){ni $f -Force}; icacls $f /inheritance:r /grant 'SYSTEM:(F)' /grant 'Administrators:(F)'|Out-Null`;
}
