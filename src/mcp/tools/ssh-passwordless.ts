import { z } from 'zod';
import { SSHHelper } from '../../core/ssh-client.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { buildPowerShellCommand, assertSafePublicKey } from '../../core/ps.js';
import {
  DEPLOY_MARKER,
  REMOVE_MARKER,
  buildUnixDeployScript,
  buildUnixRemoveScript,
  buildWindowsDeployScript,
  buildWindowsRemoveScript,
} from '../../core/key-scripts.js';
import { execSchema, helperFor, targetLabel, targetOsSchema, targetSchema, textResult } from './common.js';
import { expandHome } from '../../core/profiles.js';

export const sshPasswordlessSchema = {
  ...targetSchema,
  ...execSchema,
  targetOs: targetOsSchema('Target OS type. Defaults to auto-detect.'),
  keyPath: z.string().optional().describe('Local private key path (defaults to ~/.ssh/id_ed25519).'),
};

export async function handleSshSetupPasswordless(
  args: z.infer<z.ZodObject<typeof sshPasswordlessSchema>>
) {
  const localSshDir = path.join(os.homedir(), '.ssh');
  if (!fs.existsSync(localSshDir)) {
    fs.mkdirSync(localSshDir, { recursive: true, mode: 0o700 });
  }

  const privateKeyPath = args.keyPath
    ? expandHome(args.keyPath)
    : path.join(localSshDir, 'id_ed25519');
  const publicKeyPath = `${privateKeyPath}.pub`;

  // 1. Generate an ed25519 key pair locally if one is not already there.
  if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
    try {
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', privateKeyPath, '-N', '', '-q'], {
        stdio: 'pipe',
      });
    } catch (err: any) {
      return textResult(
        `Failed to generate local SSH key at ${privateKeyPath}: ${err.stderr?.toString() || err.message}`,
        true
      );
    }
  }

  const publicKeyContent = fs.readFileSync(publicKeyPath, 'utf8').trim();
  // The key is interpolated into a remote script. psSingleQuote/shSingleQuote handle quoting,
  // and this rejects anything that is not shaped like a key at all.
  assertSafePublicKey(publicKeyContent);

  const { helper, target } = helperFor(args);
  const label = targetLabel(target);
  const execOptions = { timeoutMs: args.timeoutMs, maxOutputBytes: args.maxOutputBytes };

  let deployedTo: string;
  try {
    deployedTo = await helper.withClient(async (conn) => {
      const targetOs =
        !args.targetOs || args.targetOs === 'auto' ? await helper.detectOs(conn) : args.targetOs;

      const command =
        targetOs === 'windows'
          ? buildPowerShellCommand(buildWindowsDeployScript(publicKeyContent))
          : buildUnixDeployScript(publicKeyContent);

      const res = await helper.execRaw(conn.client, command, execOptions);

      // The marker is the only reliable success signal. The old code checked the exit code
      // first, which stayed 0 even when the ACL step had been commented out by string mangling.
      if (!res.stdout.includes(DEPLOY_MARKER)) {
        throw new Error(
          `Key deployment did not report success on ${targetOs}.\nExit code: ${res.code}\nSTDOUT:\n${res.stdout || '(empty)'}\nSTDERR:\n${res.stderr || '(empty)'}`
        );
      }

      return res.stdout.split(DEPLOY_MARKER)[1]?.trim() || '(unknown path)';
    });
  } catch (err: any) {
    return textResult(`Key deployment failed for ${label}.\n${err.message || String(err)}`, true);
  }

  // 2. Verify that this specific key can log in on its own.
  //    ssh-agent is disabled for the check so an unrelated agent key cannot make it pass.
  const keyHelper = new SSHHelper({
    host: target.host,
    port: target.port,
    username: target.username,
    privateKeyPath,
    passphrase: target.passphrase,
    useAgent: false,
  });

  let verification: Awaited<ReturnType<SSHHelper['testConnection']>>;
  try {
    verification = await keyHelper.testConnection();
  } catch (err: any) {
    return textResult(
      `Key was deployed to ${deployedTo} on ${label}, but the verification connection threw: ${err.message || String(err)}`,
      true
    );
  }

  if (!verification.connected) {
    return textResult(
      [
        `Key was deployed to ${deployedTo} on ${label}, but key-only login failed.`,
        `Error: ${verification.error}`,
        '',
        'Things worth checking on the target:',
        '- sshd_config has PubkeyAuthentication yes and no AllowUsers rule excluding this account.',
        '- On Windows, the Match Group administrators block in sshd_config points at the same file the key was written to.',
        '- The private key used locally matches the deployed public key.',
      ].join('\n'),
      true
    );
  }

  return textResult(
    [
      `Passwordless SSH is configured and verified for ${label}.`,
      `Target OS: ${verification.targetOs}`,
      `Remote file: ${deployedTo}`,
      `Local private key: ${privateKeyPath}`,
      '',
      'Next: save this target as a profile so future calls do not need a password argument. See ssh_list_profiles.',
    ].join('\n')
  );
}

export const sshRemovePasswordlessSchema = {
  ...targetSchema,
  ...execSchema,
  targetOs: targetOsSchema('Target OS type. Defaults to auto-detect.'),
  keyPathToRemove: z
    .string()
    .optional()
    .describe('Local public key file whose entry should be removed (defaults to ~/.ssh/id_ed25519.pub).'),
  removeAllKeys: z
    .boolean()
    .optional()
    .default(false)
    .describe('Destructive: clear every authorized key on the target instead of one specific key.'),
};

export async function handleSshRemovePasswordless(
  args: z.infer<z.ZodObject<typeof sshRemovePasswordlessSchema>>
) {
  let pubKeyContent = '';

  if (!args.removeAllKeys) {
    let pubPath = args.keyPathToRemove
      ? expandHome(args.keyPathToRemove)
      : path.join(os.homedir(), '.ssh', 'id_ed25519.pub');
    if (!fs.existsSync(pubPath)) {
      pubPath = path.join(os.homedir(), '.ssh', 'id_rsa.pub');
    }
    if (!fs.existsSync(pubPath)) {
      return textResult(
        `No public key found to remove. Pass keyPathToRemove, or removeAllKeys: true to clear every key.`,
        true
      );
    }
    pubKeyContent = fs.readFileSync(pubPath, 'utf8').trim();
    assertSafePublicKey(pubKeyContent);
  }

  const { helper, target } = helperFor(args);
  const label = targetLabel(target);
  const execOptions = { timeoutMs: args.timeoutMs, maxOutputBytes: args.maxOutputBytes };

  try {
    const detail = await helper.withClient(async (conn) => {
      const targetOs =
        !args.targetOs || args.targetOs === 'auto' ? await helper.detectOs(conn) : args.targetOs;

      const command =
        targetOs === 'windows'
          ? buildPowerShellCommand(buildWindowsRemoveScript(pubKeyContent, args.removeAllKeys))
          : buildUnixRemoveScript(pubKeyContent, args.removeAllKeys);

      const res = await helper.execRaw(conn.client, command, execOptions);

      if (!res.stdout.includes(REMOVE_MARKER)) {
        throw new Error(
          `Key removal did not report success on ${targetOs}.\nExit code: ${res.code}\nSTDOUT:\n${res.stdout || '(empty)'}\nSTDERR:\n${res.stderr || '(empty)'}`
        );
      }

      return res.stdout.split(REMOVE_MARKER)[1]?.trim() || '(no detail)';
    });

    return textResult(
      [
        args.removeAllKeys
          ? `Cleared ALL authorized keys on ${label}.`
          : `Removed the public key entry on ${label}. Passwordless login with that key is revoked.`,
        detail,
        'A .sshctl.bak copy of each file was left next to it in case this needs undoing.',
      ].join('\n')
    );
  } catch (err: any) {
    return textResult(`Key removal failed for ${label}.\n${err.message || String(err)}`, true);
  }
}
