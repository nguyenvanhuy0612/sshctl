import { z } from 'zod';
import { execSchema, helperFor, targetLabel, targetOsSchema, targetSchema, textResult } from './common.js';
import { formatOutputText } from '../../core/ps.js';

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

  try {
    const { helper, target } = helperFor(args);
    label = targetLabel(target);

    const startMs = Date.now();
    const result = await helper.execSmart(args.command, {
      targetOs: args.targetOs ?? target.targetOs,
      desktop: args.desktop,
      timeoutMs: args.timeoutMs,
      maxOutputBytes: args.maxOutputBytes,
      stdin: args.stdin,
    });
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
    return textResult(`SSH execution failed on ${label}: ${err.message || String(err)}`, true);
  }
}
