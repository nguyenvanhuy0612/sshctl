import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ChannelOpenError, PooledConnection, TargetOs, withConnection } from './pool.js';
import {
  buildPowerShellCommand,
  cleanClixml,
  exceedsWireLimit,
  resolveExitCode,
  sftpPathToWindows,
} from './ps.js';

export interface SSHCredentials {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
  timeout?: number;
  /**
   * Offer keys held by the local ssh-agent. Defaults to true. Set false when a connection has
   * to prove that one specific key works, otherwise an unrelated agent key can authenticate
   * and the check passes for the wrong reason.
   */
  useAgent?: boolean;
}

export interface ExecOptions {
  /** Hard ceiling on how long a single remote command may run. */
  timeoutMs?: number;
  /** Hard ceiling on captured stdout/stderr, so a large file cannot flood the agent context. */
  maxOutputBytes?: number;
  /** Written to the remote command's stdin before EOF. */
  stdin?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  signal?: string;
  /** True when stdout or stderr hit maxOutputBytes and was cut. */
  truncated?: boolean;
  /** True when the command was cut off by timeoutMs rather than finishing on its own. */
  timedOut?: boolean;
}

export const DEFAULT_EXEC_TIMEOUT_MS = Number(process.env.SSHCTL_EXEC_TIMEOUT_MS ?? process.env.MCP_SSH_EXEC_TIMEOUT_MS ?? 60_000);
export const DEFAULT_MAX_OUTPUT_BYTES = Number(process.env.SSHCTL_MAX_OUTPUT_BYTES ?? process.env.MCP_SSH_MAX_OUTPUT_BYTES ?? 32_000);
/** Exit code used for a timeout, following the GNU coreutils `timeout` convention. */
export const TIMEOUT_EXIT_CODE = 124;

/**
 * Smart Head+Tail bounded output capture.
 * When output fits within max, retains everything.
 * When output exceeds max, retains:
 *   - Head: first ~35% of max bytes
 *   - Tail: last ~65% of max bytes
 * Preserves initial startup output and final results/stack traces.
 */
class Capture {
  private headChunks: Buffer[] = [];
  private headKept = 0;
  private readonly headMax: number;

  private tailChunks: Buffer[] = [];
  private tailKept = 0;
  private readonly tailMax: number;

  private total = 0;

  constructor(private readonly max: number) {
    this.headMax = Math.max(1024, Math.floor(max * 0.35));
    this.tailMax = max - this.headMax;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;

    // Fill head buffer
    if (this.headKept < this.headMax) {
      const room = this.headMax - this.headKept;
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.headChunks.push(slice);
      this.headKept += slice.length;
    }

    // Feed tail ring buffer
    this.tailChunks.push(chunk);
    this.tailKept += chunk.length;

    while (this.tailChunks.length > 0 && this.tailKept - this.tailChunks[0].length >= this.tailMax) {
      this.tailKept -= this.tailChunks[0].length;
      this.tailChunks.shift();
    }
  }

  get truncated(): boolean {
    return this.total > this.max;
  }

  toString(): string {
    if (!this.truncated) {
      if (this.total <= this.headMax) {
        return Buffer.concat(this.headChunks).toString('utf8');
      }
      return Buffer.concat(this.tailChunks).toString('utf8');
    }

    const headText = Buffer.concat(this.headChunks).toString('utf8');
    const tailFull = Buffer.concat(this.tailChunks);
    const tailSlice = tailFull.length > this.tailMax ? tailFull.subarray(tailFull.length - this.tailMax) : tailFull;
    const tailText = tailSlice.toString('utf8');

    const omitted = this.total - (this.headKept + tailSlice.length);
    return `${headText}\n\n[... sshctl: ${omitted} bytes omitted in middle (kept ${this.headKept} head + ${tailSlice.length} tail of ${this.total} total bytes). Use 'tail' or redirect to file & ssh_download_file ...]\n\n${tailText}`;
  }
}

export class SSHHelper {
  private config: ConnectConfig;
  /** Identifies the auth material in the pool key without putting the secret in the key. */
  private authTag: string;

  constructor(creds: SSHCredentials) {
    let privateKey: string | undefined = creds.privateKey;

    if (!privateKey && creds.privateKeyPath) {
      const resolvedPath = creds.privateKeyPath.replace(/^~(?=$|[/\\])/, os.homedir());
      if (fs.existsSync(resolvedPath)) {
        privateKey = fs.readFileSync(resolvedPath, 'utf8');
      }
    }

    // Default key search if neither password nor explicit key provided
    if (!creds.password && !privateKey) {
      const defaultKeys = [
        path.join(os.homedir(), '.ssh', 'id_ed25519'),
        path.join(os.homedir(), '.ssh', 'id_rsa'),
      ];
      for (const kPath of defaultKeys) {
        if (fs.existsSync(kPath)) {
          privateKey = fs.readFileSync(kPath, 'utf8');
          break;
        }
      }
    }

    this.config = {
      host: creds.host,
      port: creds.port || 22,
      username: creds.username,
      password: creds.password,
      privateKey: privateKey,
      passphrase: creds.passphrase,
      readyTimeout: creds.timeout || 10000,
      // Use the local ssh-agent when one is running. This is what makes a passphrase-protected
      // key usable without ever passing the passphrase through a tool argument.
      agent: creds.useAgent === false ? undefined : process.env.SSH_AUTH_SOCK || undefined,
      // Long-running commands otherwise get their connection reaped by NAT and stateful firewalls.
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      // NOTE ON HOST KEYS: ssh2 auto-accepts the server host key unless a `hostVerifier` is
      // supplied, and none is supplied here. This server therefore does NOT authenticate the
      // remote host and offers no protection against man-in-the-middle interception. That is a
      // deliberate choice for the intended use case (internal lab and QA machines that are
      // re-imaged often, where a changed host key is routine rather than suspicious), not an
      // oversight. `hostHash` below only selects the digest format handed to a `hostVerifier`;
      // on its own it verifies nothing. Do not run this against hosts reached over an untrusted
      // network without adding a real `hostVerifier`.
      hostHash: 'sha256',
    };

    this.authTag = crypto
      .createHash('sha256')
      .update(
        [
          creds.password ? `p:${creds.password}` : '',
          privateKey ? `k:${privateKey}` : '',
          creds.passphrase ? `f:${creds.passphrase}` : '',
          this.config.agent ? `a:${this.config.agent}` : '',
        ].join('|')
      )
      .digest('hex')
      .slice(0, 12);
  }

  /** Run an operation on a pooled connection to this target. */
  public async withClient<T>(fn: (conn: PooledConnection) => Promise<T>): Promise<T> {
    return withConnection(this.config, this.authTag, fn);
  }

  /**
   * Opens a dedicated, unpooled connection. Only for callers that need to prove a fresh
   * handshake succeeds, such as verifying key-only login right after deploying a key.
   */
  public async connect(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;

      client.once('ready', () => {
        settled = true;
        resolve(client);
      });

      client.once('error', (err) => {
        if (settled) return;
        settled = true;
        client.end();
        reject(err);
      });

      try {
        client.connect(this.config);
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }

  /**
   * Probe SSH connection and return diagnostic status.
   */
  public async testConnection(): Promise<{
    connected: boolean;
    targetOs?: TargetOs;
    error?: string;
    unreachable?: boolean;
    authFailed?: boolean;
    suggestPasswordless?: boolean;
  }> {
    try {
      const targetOs = await this.withClient((conn) => this.detectOs(conn));
      return {
        connected: true,
        targetOs,
        suggestPasswordless: !!this.config.password && !this.config.privateKey,
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      return {
        connected: false,
        error: errMsg,
        unreachable: /ECONNREFUSED|ETIMEDOUT|timed out|ENETUNREACH|EHOSTUNREACH|ENOTFOUND/i.test(
          errMsg
        ),
        authFailed: /All configured authentication methods failed|Permission denied/i.test(errMsg),
      };
    }
  }

  /**
   * Execute one command on an existing connection.
   *
   * Guarantees the previous implementation did not: stdin is closed so a command that waits
   * for input gets EOF instead of hanging forever, a timeout destroys the channel, a
   * connection dropped mid-command rejects instead of leaving the promise pending, output is
   * capped, and a signal death is reported as a non-zero exit code.
   */
  public async execRaw(
    client: Client,
    command: string,
    options: ExecOptions = {}
  ): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    return new Promise<ExecResult>((resolve, reject) => {
      const stdout = new Capture(maxOutputBytes);
      const stderr = new Capture(maxOutputBytes);

      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        client.removeListener('error', onConnectionError);
        client.removeListener('close', onConnectionClose);
      };
      const succeed = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      // Without these two, a connection that dies mid-command leaves this promise pending
      // forever and the MCP client hangs with no diagnostic.
      function onConnectionError(err: Error) {
        fail(new Error(`SSH connection failed while the command was running: ${err.message}`));
      }
      function onConnectionClose() {
        fail(new Error('SSH connection closed while the command was running.'));
      }

      client.on('error', onConnectionError);
      client.on('close', onConnectionClose);

      client.exec(command, (err, stream) => {
        // A failure here means the channel never opened, so the command did not run. Tagging it
        // is what lets the pool retry safely: once the command is running, a later failure is
        // never retried because the command may already have taken effect remotely.
        if (err) return fail(new ChannelOpenError(err));

        timer = setTimeout(() => {
          try {
            stream.close();
          } catch {
            // Channel may already be gone.
          }
          try {
            stream.destroy();
          } catch {
            // Ignore.
          }
          // Return partial output rather than discarding it: a timed-out command has usually
          // already printed the interesting part.
          succeed({
            code: TIMEOUT_EXIT_CODE,
            stdout: stdout.toString(),
            stderr:
              cleanClixml(stderr.toString()) +
              `\n[sshctl: command exceeded timeout of ${timeoutMs} ms and the channel was closed. Raise it with the timeoutMs argument, or run the command detached.]`,
            truncated: stdout.truncated || stderr.truncated,
            timedOut: true,
          });
        }, timeoutMs);

        stream.on('close', (code: number | null, signal: string | null) => {
          succeed({
            code: resolveExitCode(code, signal),
            stdout: stdout.toString(),
            stderr: cleanClixml(stderr.toString()),
            signal: signal ?? undefined,
            truncated: stdout.truncated || stderr.truncated,
          });
        });

        stream.on('error', (streamErr: Error) => fail(streamErr));
        stream.on('data', (data: Buffer) => stdout.push(data));
        stream.stderr.on('data', (data: Buffer) => stderr.push(data));

        // Close stdin. A remote command that reads stdin (sudo prompting for a password,
        // apt asking Y/n, cmd.exe `pause`, shell `read`) used to hang the server forever
        // because the channel never closed.
        if (options.stdin) stream.write(options.stdin);
        stream.end();
      });
    });
  }

  /**
   * Detect the target OS once per connection and cache it.
   *
   * The probe is a bare `uname -s`. The previous `uname -s || echo WINDOWS_CMD` was unsafe:
   * `||` is a PowerShell 7 pipeline chain operator and a parse error in PowerShell 5.1, so on
   * a Windows host whose sshd DefaultShell is PowerShell the whole probe failed and the right
   * answer only came out of the fallback branch by luck. A bare `uname -s` behaves usefully in
   * all three shells: POSIX shells print the kernel, cmd.exe and PowerShell print a
   * command-not-found error to stderr and leave stdout empty.
   */
  public async detectOs(conn: PooledConnection): Promise<TargetOs> {
    if (conn.detectedOs) return conn.detectedOs;

    const probe = await this.execRaw(conn.client, 'uname -s', {
      timeoutMs: 15_000,
      maxOutputBytes: 4096,
    });
    const out = probe.stdout.trim().toLowerCase();

    let detected: TargetOs;
    if (out.includes('darwin')) detected = 'mac';
    else if (out.includes('linux')) detected = 'linux';
    else detected = 'windows';

    conn.detectedOs = detected;
    return detected;
  }

  /** Remote home directory, resolved over SFTP so it costs no shell round trip. Cached. */
  public async getHomeDir(conn: PooledConnection): Promise<string> {
    if (conn.homeDir) return conn.homeDir;

    const sftp = await this.getSftp(conn.client);
    try {
      const resolved = await new Promise<string>((resolve, reject) => {
        sftp.realpath('.', (err, absPath) => (err ? reject(err) : resolve(absPath)));
      });
      conn.homeDir = resolved;
      return resolved;
    } finally {
      sftp.end();
    }
  }

  /**
   * Smart command execution handling:
   * - Windows PowerShell UTF-16LE Base64 encoding
   * - 8191 cmd.exe length limit workaround via SFTP upload
   * - Desktop GUI launch (Session 1) via Task Scheduler
   */
  public async execSmart(
    command: string,
    options: {
      targetOs?: 'auto' | TargetOs;
      desktop?: boolean;
      session?: number;
    } & ExecOptions = {}
  ): Promise<ExecResult> {
    return this.withClient(async (conn) => {
      const targetOs =
        !options.targetOs || options.targetOs === 'auto'
          ? await this.detectOs(conn)
          : options.targetOs;

      if (targetOs !== 'windows') {
        return this.execRaw(conn.client, command, options);
      }

      return this.execWindows(conn, command, options);
    });
  }

  private async execWindows(
    conn: PooledConnection,
    command: string,
    options: { desktop?: boolean; session?: number } & ExecOptions
  ): Promise<ExecResult> {
    if (options.desktop) {
      return this.execWindowsDesktop(conn, command, options);
    }

    const wireCommand = buildPowerShellCommand(command);

    // cmd.exe 8191 character length wall check
    if (exceedsWireLimit(wireCommand)) {
      return this.execWindowsSftpFile(conn, command, options);
    }

    return this.execRaw(conn.client, wireCommand, options);
  }

  /**
   * Handles oversized PowerShell scripts by uploading them over SFTP and running with -File.
   *
   * The script goes under the connecting user's home directory rather than C:\Windows\Temp:
   * that path needed elevation on a locked-down host and is readable by other accounts, while
   * the script body may contain secrets. Cleanup runs in a finally block so a failing command
   * cannot leave the file behind.
   */
  private async execWindowsSftpFile(
    conn: PooledConnection,
    scriptContent: string,
    options: ExecOptions
  ): Promise<ExecResult> {
    const home = await this.getHomeDir(conn);
    const stamp = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const remoteDirSftp = `${home.replace(/\/$/, '')}/.sshctl-tmp`;
    const remotePathSftp = `${remoteDirSftp}/sshctl_${stamp}.ps1`;
    const remotePathWin = sftpPathToWindows(remotePathSftp);

    const sftp = await this.getSftp(conn.client);
    try {
      await new Promise<void>((resolve) => {
        // Directory may already exist; either way the write below is the real test.
        sftp.mkdir(remoteDirSftp, () => resolve());
      });

      // UTF-8 BOM and ProgressPreference so PowerShell 5.1 parses scripts cleanly without CLIXML progress.
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const fullScript = `$ProgressPreference = 'SilentlyContinue'\r\n${scriptContent}`;
      const contentBuf = Buffer.concat([bom, Buffer.from(fullScript, 'utf8')]);

      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(remotePathSftp);
        stream.on('close', () => resolve());
        stream.on('error', (err: Error) => reject(err));
        stream.end(contentBuf);
      });

      const execCmd = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${remotePathWin}"`;
      return await this.execRaw(conn.client, execCmd, options);
    } finally {
      await new Promise<void>((resolve) => {
        sftp.unlink(remotePathSftp, () => resolve());
      });
      sftp.end();
    }
  }

  /**
   * Session 0 bypass launcher onto Windows Interactive Desktop (Session 1).
   * Uses Task Scheduler with LogonType Interactive.
   */
  private async execWindowsDesktop(
    conn: PooledConnection,
    command: string,
    options: { session?: number } & ExecOptions
  ): Promise<ExecResult> {
    const taskName = `SshctlTask_${Date.now()}`;
    const base64Cmd = Buffer.from(command, 'utf16le').toString('base64');

    const launcherScript = `
$ProgressPreference = 'SilentlyContinue'
$taskName = "${taskName}"
$explorer = Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $explorer) {
  Write-Error "No active explorer process found for interactive desktop launch."
  exit 1
}

$user = (Get-WmiObject Win32_Process -Filter "ProcessId=$($explorer.Id)").GetOwner()
$username = "$($user.Domain)\\$($user.User)"

$actionArg = '-NoProfile -EncodedCommand ${base64Cmd}'
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArg
$principal = New-ScheduledTaskPrincipal -UserId $username -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName | Out-Null
Start-Sleep -Seconds 2
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
Write-Host "Task $taskName launched successfully on interactive desktop for $username."
`;

    return this.execRaw(conn.client, buildPowerShellCommand(launcherScript), options);
  }

  /** Alias for execSmart */
  public async exec(
    command: string,
    options: {
      targetOs?: 'auto' | TargetOs;
      desktop?: boolean;
      session?: number;
    } & ExecOptions = {}
  ): Promise<ExecResult> {
    return this.execSmart(command, options);
  }

  public async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const sftpPath = remotePath.replace(/\\/g, '/');
    await this.withClient(async (conn) => {
      const sftp = await this.getSftp(conn.client);
      try {
        const parent = path.posix.dirname(sftpPath);
        const parts = parent.split('/').filter(Boolean);
        let cur = parent.startsWith('/') ? '' : '';
        for (const part of parts) {
          cur = cur === '' ? (parent.startsWith('/') ? `/${part}` : part) : `${cur}/${part}`;
          await new Promise<void>((res) => sftp.mkdir(cur, () => res()));
        }

        await new Promise<void>((resolve, reject) => {
          sftp.fastPut(localPath, sftpPath, (err) => (err ? reject(err) : resolve()));
        });
      } finally {
        sftp.end();
      }
    });
  }

  public async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const sftpPath = remotePath.replace(/\\/g, '/');
    const parent = path.dirname(localPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }

    await this.withClient(async (conn) => {
      const sftp = await this.getSftp(conn.client);
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.fastGet(sftpPath, localPath, (err) => (err ? reject(err) : resolve()));
        });
      } finally {
        sftp.end();
      }
    });
  }

  public async getSftp(client: Client): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(new ChannelOpenError(err));
        resolve(sftp);
      });
    });
  }
}
