import { z } from 'zod';
import {
  diagnoseSshError,
  execSchema,
  helperFor,
  targetLabel,
  targetOsSchema,
  targetSchema,
  textResult,
} from './common.js';
import { ExecResult } from '../../core/ssh-client.js';
import { formatOutputText } from '../../core/ps.js';
import { clearKnownHost } from './ssh-connect.js';
import { autoSetupAndSaveProfile } from './ssh-passwordless.js';

export const sshExecSchema = {
  ...targetSchema,
  ...execSchema,
  command: z.string().describe('Command or script body to execute remotely'),
  targetOs: targetOsSchema('Target OS. Defaults to auto-detect, cached per connection.'),
  desktop: z
    .boolean()
    .optional()
    .default(false)
    .describe('Windows only: launch the process in the active GUI user session (Session 1).'),
  stdin: z
    .string()
    .optional()
    .describe('Text written to the command stdin before EOF. Use for commands that expect input.'),
};

export async function handleSshExec(args: z.infer<z.ZodObject<typeof sshExecSchema>>) {
  let label = args.profile ?? args.host ?? 'target';
  let autoNotice = '';

  try {
    let { helper, target } = helperFor(args);
    label = targetLabel(target);

    // Auto-provision if password is provided and target does not yet have a verified private key profile
    if (target.password && (!target.profileName || !target.privateKeyPath)) {
      try {
        const deployRes = await autoSetupAndSaveProfile(target, args.targetOs);
        if (deployRes) {
          autoNotice = `Automatically configured passwordless key and saved profile "${deployRes.profileName}"`;
          const reResolved = helperFor({ profile: deployRes.profileName, ...args });
          helper = reResolved.helper;
          target = reResolved.target;
          label = targetLabel(target);
        }
      } catch {
        // Fall back to direct execution with password if auto-provision fails
      }
    }

    const startMs = Date.now();
    let result: ExecResult;

    const runExec = () =>
      helper.execSmart(args.command, {
        targetOs: args.targetOs ?? target.targetOs,
        desktop: args.desktop,
        timeoutMs: args.timeoutMs,
        maxOutputBytes: args.maxOutputBytes,
        stdin: args.stdin,
      });

    try {
      result = await runExec();
    } catch (execErr: any) {
      const errMsg = execErr?.message || String(execErr);

      // Auto-heal: Host key mismatch after snapshot revert or reimage
      if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(errMsg)) {
        clearKnownHost(target.host, target.port);
        result = await runExec();
      }
      // Auto-heal: Key wiped after snapshot revert, but password is available to redeploy
      else if (
        target.password &&
        /All configured authentication methods failed|Permission denied/i.test(errMsg)
      ) {
        const deployRes = await autoSetupAndSaveProfile(target, args.targetOs);
        if (deployRes) {
          autoNotice = `Re-deployed passwordless key after snapshot revert and updated profile "${deployRes.profileName}"`;
          const reResolved = helperFor({ profile: deployRes.profileName, ...args });
          helper = reResolved.helper;
          target = reResolved.target;
          label = targetLabel(target);
          result = await runExec();
        } else {
          throw execErr;
        }
      } else {
        throw execErr;
      }
    }

    const durationMs = Date.now() - startMs;

    const formattedStdout = formatOutputText(result.stdout, {
      maxLines: args.maxLines,
      head: args.head,
      tail: args.tail,
      compact: args.compact,
    });

    const formattedStderr = formatOutputText(result.stderr, {
      maxLines: args.maxLines,
      head: args.head,
      tail: args.tail,
      compact: args.compact,
    });

    const header = [
      `HOST: ${label}`,
      `EXIT CODE: ${result.code}`,
      `DURATION: ${durationMs}ms`,
    ];
    if (result.signal) header.push(`SIGNAL: ${result.signal}`);
    if (result.timedOut) header.push('STATUS: timed out, output is partial');
    if (result.truncated || formattedStdout.truncated || formattedStderr.truncated) {
      header.push('STATUS: output truncated/windowed');
    }

    const outputBlocks: string[] = [header.join(' | ')];
    if (autoNotice) {
      outputBlocks.push(`NOTE: ${autoNotice}`);
    }

    if (formattedStdout.text) {
      outputBlocks.push('', '--- STDOUT ---', formattedStdout.text);
    } else {
      outputBlocks.push('', '--- STDOUT ---', '(empty)');
    }

    // Only render STDERR block if non-empty to save tokens
    if (formattedStderr.text) {
      outputBlocks.push('', '--- STDERR ---', formattedStderr.text);
    }

    const formatted = outputBlocks.join('\n');

    return {
      content: [{ type: 'text' as const, text: formatted }],
      // A non-zero exit code is data, not a tool failure: grep, diff and test all use exit 1
      // to report a normal result. Only a timeout is surfaced as an error here.
      ...(result.timedOut ? { isError: true } : {}),
    };
  } catch (err: any) {
    let resolvedTarget: ReturnType<typeof helperFor>['target'];
    try {
      resolvedTarget = helperFor(args).target;
    } catch {
      return textResult(`SSH execution failed on ${label}: ${err.message || String(err)}`, true);
    }
    return textResult(diagnoseSshError(err, resolvedTarget), true);
  }
}
