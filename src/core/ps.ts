/**
 * Pure helpers for building remote command strings.
 *
 * Everything in this file is deliberately side-effect free so it can be unit tested
 * without an SSH server. The bugs this module exists to prevent are all escaping bugs:
 * a multi-line PowerShell script that is flattened into `-Command "..."` loses every
 * line after the first `#` comment, and any nested double quote breaks argument parsing.
 * The only safe way to ship a script body to powershell.exe is -EncodedCommand.
 */

/** Longest command line cmd.exe will accept, minus headroom for the shell wrapper. */
export const CMD_EXE_WIRE_LIMIT = 8000;

/**
 * Encode a PowerShell script body as a Base64 UTF-16LE string for -EncodedCommand.
 * Removes all quoting and newline concerns: the payload is opaque to the outer shell.
 */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Wrap a PowerShell script body into a complete, quote-safe remote command line.
 * Automatically injects `$ProgressPreference = 'SilentlyContinue'` to suppress
 * spurious CLIXML progress stream noise on stderr over SSH.
 * Never interpolate a script into `-Command "..."`; use this instead.
 */
export function buildPowerShellCommand(
  script: string,
  options: { nonInteractive?: boolean; suppressProgress?: boolean } = {}
): string {
  const nonInteractive = options.nonInteractive !== false;
  const suppressProgress = options.suppressProgress !== false;
  const flags = nonInteractive ? '-NoProfile -NonInteractive' : '-NoProfile';
  const prefix = suppressProgress ? "$ProgressPreference = 'SilentlyContinue';\n" : '';
  return `powershell.exe ${flags} -EncodedCommand ${encodePowerShell(prefix + script)}`;
}

/**
 * Clean up PowerShell CLIXML output from stderr.
 *
 * When PowerShell executes non-interactively over SSH, non-stdout streams (Progress, Warning,
 * Error, Information) are serialized as CLIXML (starting with `#< CLIXML`).
 * Progress records like "Preparing modules for first use" are emitted to stderr as XML even on
 * successful executions.
 *
 * This helper strips progress/informational noise and extracts clean error/warning text.
 */
export function cleanClixml(raw: string): string {
  if (!raw || !raw.includes('#< CLIXML')) return raw;

  const clixmlStart = raw.indexOf('#< CLIXML');
  const preText = raw.slice(0, clixmlStart).trim();
  const clixmlContent = raw.slice(clixmlStart);

  // Extract <S S="Error">...</S> and <S S="Warning">...</S> strings
  const matches = clixmlContent.matchAll(/<S S="(?:Error|Warning)">(.*?)<\/S>/gs);
  const messages: string[] = [];

  for (const m of matches) {
    if (m[1]) {
      const decoded = m[1]
        .replace(/_x000D__x000A_/g, '\n')
        .replace(/_x000A_/g, '\n')
        .replace(/_x000D_/g, '\r')
        .replace(/_x0020_/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
      const trimmed = decoded.replace(/\r?\n$/, '');
      if (trimmed) messages.push(trimmed);
    }
  }

  const cleanedClixml = messages.join('\n').trim();
  if (preText && cleanedClixml) {
    return `${preText}\n${cleanedClixml}`;
  }
  return cleanedClixml || preText;
}

/** True when the wrapped command line would blow past the cmd.exe length wall. */
export function exceedsWireLimit(wireCommand: string): boolean {
  return wireCommand.length > CMD_EXE_WIRE_LIMIT;
}

/**
 * Escape a value for embedding inside a PowerShell single-quoted literal.
 * PowerShell escapes a single quote by doubling it. Inside single quotes no other
 * character is special, so this is sufficient and total.
 */
export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Escape a value for embedding inside a POSIX shell single-quoted literal.
 * A single quote cannot appear inside single quotes, so close, escape, reopen.
 */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Reject values that cannot be a well-formed OpenSSH public key line.
 * Belt-and-braces alongside psSingleQuote/shSingleQuote: a key is only ever
 * `<type> <base64> [comment]`, so control characters and newlines are always a bug
 * or an injection attempt.
 */
export function assertSafePublicKey(key: string): void {
  if (!key || !key.trim()) {
    throw new Error('Public key is empty.');
  }
  if (/[\r\n\0]/.test(key)) {
    throw new Error('Public key contains a newline or null byte; refusing to deploy it.');
  }
  if (!/^(ssh|ecdsa|sk-)[-a-z0-9@.]+\s+[A-Za-z0-9+/=]+(\s+\S.*)?$/.test(key.trim())) {
    throw new Error(
      `Public key does not look like an OpenSSH public key line: ${key.slice(0, 40)}...`
    );
  }
}

/** Map an SSH exit signal to the shell convention of 128 + signal number. */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGUSR1: 10,
  SIGUSR2: 12,
};

/**
 * Resolve the exit code to report for a finished remote command.
 * A command killed by a signal reports code null over the wire; treating that as 0
 * makes an OOM-killed or SIGTERM'd process look successful.
 */
export function resolveExitCode(code: number | null | undefined, signal?: string | null): number {
  if (typeof code === 'number') return code;
  if (signal) {
    const bare = signal.startsWith('SIG') ? signal : `SIG${signal}`;
    return 128 + (SIGNAL_NUMBERS[bare] ?? 0);
  }
  return 0;
}

/** Convert an SFTP-style path (/C:/Users/x) to a native Windows path (C:\Users\x). */
export function sftpPathToWindows(sftpPath: string): string {
  const stripped = sftpPath.replace(/^\/(?=[A-Za-z]:)/, '');
  return stripped.replace(/\//g, '\\');
}

export interface FormatOptions {
  maxLines?: number;
  maxOutputBytes?: number;
  head?: number;
  tail?: number;
  compact?: boolean;
}

/**
 * Format and window remote command output for token efficiency.
 * Supports compacting whitespace, explicit head/tail line counts, and automatic
 * smart head+tail windowing when output exceeds maxLines.
 */
export function formatOutputText(
  text: string,
  options: FormatOptions = {}
): { text: string; lineCount: number; byteCount: number; truncated: boolean } {
  if (!text) {
    return { text: '', lineCount: 0, byteCount: 0, truncated: false };
  }

  let processed = text;
  const isCompact = options.compact !== false;

  // 1. Compact: trim trailing whitespace per line and collapse 3+ empty lines to 1
  if (isCompact) {
    processed = processed
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  const lines = processed.split('\n');
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(processed, 'utf8');

  // 2. Explicit tail: keep only last N lines
  if (typeof options.tail === 'number' && options.tail > 0) {
    if (totalLines > options.tail) {
      const keptLines = lines.slice(totalLines - options.tail);
      const omitted = totalLines - options.tail;
      const resultText = `[... sshctl: ${omitted} lines omitted, showing last ${options.tail} lines ...]\n` + keptLines.join('\n');
      return {
        text: resultText,
        lineCount: totalLines,
        byteCount: totalBytes,
        truncated: true,
      };
    }
    return {
      text: processed,
      lineCount: totalLines,
      byteCount: totalBytes,
      truncated: false,
    };
  }

  // 3. Explicit head: keep only first N lines
  if (typeof options.head === 'number' && options.head > 0) {
    if (totalLines > options.head) {
      const keptLines = lines.slice(0, options.head);
      const omitted = totalLines - options.head;
      const resultText = keptLines.join('\n') + `\n[... sshctl: ${omitted} lines omitted, showing first ${options.head} lines ...]`;
      return {
        text: resultText,
        lineCount: totalLines,
        byteCount: totalBytes,
        truncated: true,
      };
    }
    return {
      text: processed,
      lineCount: totalLines,
      byteCount: totalBytes,
      truncated: false,
    };
  }

  // 4. maxLines windowing (default 200)
  const maxLines = options.maxLines ?? 200;
  if (totalLines > maxLines) {
    const headCount = Math.max(10, Math.floor(maxLines * 0.35)); // 35% head
    const tailCount = maxLines - headCount; // 65% tail
    const headLines = lines.slice(0, headCount);
    const tailLines = lines.slice(totalLines - tailCount);
    const omitted = totalLines - (headCount + tailCount);

    const resultText = [
      ...headLines,
      `\n[... sshctl: ${omitted} lines omitted in middle. Use 'tail: ${tailCount}' or redirect to file & ssh_download_file ...]\n`,
      ...tailLines,
    ].join('\n');

    return {
      text: resultText,
      lineCount: totalLines,
      byteCount: totalBytes,
      truncated: true,
    };
  }

  return {
    text: processed,
    lineCount: totalLines,
    byteCount: totalBytes,
    truncated: false,
  };
}
