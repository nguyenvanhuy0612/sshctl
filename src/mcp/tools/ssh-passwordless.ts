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
import { expandHome, profilesPath, suggestProfileName, upsertProfile } from '../../core/profiles.js';

export const sshPasswordlessSchema = {
  ...targetSchema,
  ...execSchema,
  targetOs: targetOsSchema('Target OS type. Defaults to auto-detect.'),
  keyPath: z.string().optional().describe('Local private key path (defaults to ~/.ssh/id_ed25519).'),
};

/**
 * Core deploy and verification routine for passwordless SSH authentication.
 */
export async function setupPasswordlessDeploy(
  target: ReturnType<typeof helperFor>['target'],
  targetOsOption?: 'auto' | 'windows' | 'linux' | 'mac',
  keyPath?: string,
  execOptions: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<{
  deployedTo: string;
  privateKeyPath: string;
  targetOs?: string;
}> {
  const localSshDir = path.join(os.homedir(), '.ssh');
  if (!fs.existsSync(localSshDir)) {
    fs.mkdirSync(localSshDir, { recursive: true, mode: 0o700 });
  }

  const privateKeyPath = keyPath ? expandHome(keyPath) : path.join(localSshDir, 'id_ed25519');
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
    try {
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', privateKeyPath, '-N', '', '-q'], {
        stdio: 'pipe',
      });
    } catch (err: any) {
      throw new Error(
        `Failed to generate local SSH key at ${privateKeyPath}: ${err.stderr?.toString() || err.message}`
      );
    }
  }

  const publicKeyContent = fs.readFileSync(publicKeyPath, 'utf8').trim();
  assertSafePublicKey(publicKeyContent);

  const helper = new SSHHelper({
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    privateKeyPath: target.privateKeyPath,
    passphrase: target.passphrase,
  });

  const deployedTo = await helper.withClient(async (conn) => {
    const targetOs =
      !targetOsOption || targetOsOption === 'auto' ? await helper.detectOs(conn) : targetOsOption;

    const command =
      targetOs === 'windows'
        ? buildPowerShellCommand(buildWindowsDeployScript(publicKeyContent))
        : buildUnixDeployScript(publicKeyContent);

    const res = await helper.execRaw(conn.client, command, execOptions);

    if (!res.stdout.includes(DEPLOY_MARKER)) {
      throw new Error(
        `Key deployment did not report success on ${targetOs}.\nExit code: ${res.code}\nSTDOUT:\n${res.stdout || '(empty)'}\nSTDERR:\n${res.stderr || '(empty)'}`
      );
    }

    return res.stdout.split(DEPLOY_MARKER)[1]?.trim() || '(unknown path)';
  });

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
    throw new Error(
      `Key was deployed to ${deployedTo}, but verification threw: ${err.message || String(err)}`
    );
  }

  if (!verification.connected) {
    throw new Error(
      `Key was deployed to ${deployedTo}, but key-only login failed: ${verification.error}`
    );
  }

  return {
    deployedTo,
    privateKeyPath,
    targetOs: verification.targetOs,
  };
}

/**
 * Deploy key and automatically persist profile in ~/.sshctl/profiles.json.
 */
export async function autoSetupAndSaveProfile(
  target: ReturnType<typeof helperFor>['target'],
  targetOsOption?: 'auto' | 'windows' | 'linux' | 'mac'
): Promise<{ profileName: string; privateKeyPath: string } | null> {
  if (!target.password) return null;
  const deployRes = await setupPasswordlessDeploy(target, targetOsOption);
  const profileName =
    target.profileName || suggestProfileName(target.host, target.username, deployRes.targetOs);

  upsertProfile(profileName, {
    host: target.host,
    port: target.port,
    username: target.username,
    targetOs: (deployRes.targetOs as any) ?? 'auto',
    privateKeyPath: deployRes.privateKeyPath,
    description: `Auto-configured profile for ${target.username}@${target.host}`,
  });

  return { profileName, privateKeyPath: deployRes.privateKeyPath };
}

export async function handleSshSetupPasswordless(
  args: z.infer<z.ZodObject<typeof sshPasswordlessSchema>>
) {
  try {
    const { target } = helperFor(args);
    const label = targetLabel(target);
    const execOptions = { timeoutMs: args.timeoutMs, maxOutputBytes: args.maxOutputBytes };

    const deployRes = await setupPasswordlessDeploy(target, args.targetOs, args.keyPath, execOptions);
    const profileName =
      args.profile ?? target.profileName ?? suggestProfileName(target.host, target.username, deployRes.targetOs);

    upsertProfile(profileName, {
      host: target.host,
      port: target.port,
      username: target.username,
      targetOs: (deployRes.targetOs as any) ?? 'auto',
      privateKeyPath: deployRes.privateKeyPath,
      description: `Passwordless profile for ${target.username}@${target.host}`,
    });

    return textResult(
      [
        `Passwordless SSH is configured and verified for ${label}.`,
        `Target OS: ${deployRes.targetOs}`,
        `Remote file: ${deployRes.deployedTo}`,
        `Local private key: ${deployRes.privateKeyPath}`,
        `Saved profile "${profileName}" to ${profilesPath()}.`,
      ].join('\n')
    );
  } catch (err: any) {
    return textResult(`Key deployment failed: ${err.message || String(err)}`, true);
  }
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
