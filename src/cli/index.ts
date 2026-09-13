import * as path from 'path';
import * as fs from 'fs';
import { SSHHelper } from '../core/ssh-client.js';
import { describeProfiles, resolveTarget, profilesPath } from '../core/profiles.js';
import { getRdpBootstrapOneLiner } from '../mcp/tools/ssh-connect.js';
import { startServer } from '../mcp/server.js';

export async function runCli(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log('sshctl v1.0.0');
    return;
  }

  if (command === 'mcp' || command === 'serve') {
    await startServer();
    return;
  }

  if (command === 'profiles' || command === 'list') {
    const pPath = profilesPath();
    const profiles = describeProfiles();
    console.log(`Profiles file: ${pPath}`);
    if (Object.keys(profiles).length === 0) {
      console.log('No profiles found. You can create one in ' + pPath);
      return;
    }
    console.log('\nConfigured Profiles:');
    for (const [name, p] of Object.entries(profiles)) {
      const auth = p.hasPassword ? 'password' : p.hasPrivateKey ? 'key' : 'default / agent';
      console.log(`  - ${name}:`);
      console.log(`      Host:      ${p.host}:${p.port}`);
      console.log(`      User:      ${p.username}`);
      console.log(`      Auth:      ${auth}`);
      console.log(`      Target OS: ${p.targetOs}`);
      if (p.description) console.log(`      Info:      ${p.description}`);
    }
    return;
  }

  if (command === 'bootstrap-rdp' || command === 'rdp') {
    const userType = args.includes('--admin') ? 'admin' : args.includes('--user') ? 'user' : 'admin';
    let script: string;
    if (userType === 'user') {
      script = `Start-Process powershell -Verb RunAs -Wait -Args @('-NoP','-ep','Bypass','-c','$t=$env:TEMP;iwr https://github.com/PowerShell/Win32-OpenSSH/releases/latest/download/OpenSSH-Win64.zip -Out $t\\s.zip;Expand-Archive $t\\s.zip $t -Force;$d=ls $t -d|?{$_.Name-like''OpenSSH*''}|select -f 1;cp $d.FullName C:\\ -r -Force;if($d.Name-ne''OpenSSH-Win64''){ren C:\\$($d.Name) OpenSSH-Win64};powershell -ep Bypass -NonI -File C:\\OpenSSH-Win64\\install-sshd.ps1;Set-Service sshd,ssh-agent -StartupType Automatic;Start-Service ssh-agent,sshd;netsh advfirewall firewall add rule name=sshd protocol=TCP dir=in localport=22 action=allow|Out-Null;$f=''C:\\ProgramData\\ssh\\administrators_authorized_keys'';if(!(Test-Path $f)){ni $f -Force};icacls $f /inheritance:r /grant ''SYSTEM:(F)'' /grant ''Administrators:(F)''|Out-Null')`;
    } else {
      script = getRdpBootstrapOneLiner();
    }
    console.log(`# Windows OpenSSH Server 1-Liner Bootstrap (${userType.toUpperCase()}):\n`);
    console.log(script);
    return;
  }

  if (command === 'clear-hosts' || command === 'clear-known-hosts') {
    const host = args[1];
    if (!host) {
      console.error('Error: missing host argument. Usage: sshctl clear-hosts <host>');
      process.exit(1);
    }
    const { execFileSync } = await import('child_process');
    try {
      execFileSync('ssh-keygen', ['-R', host], { stdio: 'pipe' });
      console.log(`Cleared '${host}' from ~/.ssh/known_hosts`);
    } catch (err: any) {
      console.error(`Failed to clear host: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'test' || command === 'probe') {
    const targetName = args[1];
    if (!targetName) {
      console.error('Error: missing profile name or host. Usage: sshctl test <profile|host>');
      process.exit(1);
    }

    const target = resolveTarget({
      profile: targetName.includes('.') || targetName.includes('@') ? undefined : targetName,
      host: targetName.includes('@') ? targetName.split('@')[1] : targetName.includes('.') ? targetName : undefined,
      username: targetName.includes('@') ? targetName.split('@')[0] : undefined,
    });

    console.log(`Testing SSH connection to ${target.username}@${target.host}:${target.port}...`);
    const helper = new SSHHelper({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      privateKeyPath: target.privateKeyPath,
      passphrase: target.passphrase,
    });

    const result = await helper.testConnection();
    if (result.connected) {
      console.log(`Connection SUCCESS!`);
      console.log(`Target OS: ${result.targetOs}`);
      if (result.suggestPasswordless) {
        console.log(`Hint: Currently using password. Run ssh_setup_passwordless to enable key-based login.`);
      }
    } else {
      console.error(`Connection FAILED: ${result.error}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'exec' || command === 'run') {
    const targetName = args[1];
    const cmd = args[2];
    if (!targetName || !cmd) {
      console.error('Error: missing arguments. Usage: sshctl exec <profile|host> "<command>" [--desktop]');
      process.exit(1);
    }

    const isDesktop = args.includes('--desktop');
    const tailIdx = args.indexOf('--tail');
    const tail = tailIdx !== -1 ? parseInt(args[tailIdx + 1], 10) : undefined;
    const headIdx = args.indexOf('--head');
    const head = headIdx !== -1 ? parseInt(args[headIdx + 1], 10) : undefined;
    const maxLinesIdx = args.indexOf('--max-lines');
    const maxLines = maxLinesIdx !== -1 ? parseInt(args[maxLinesIdx + 1], 10) : undefined;
    const raw = args.includes('--raw');

    const target = resolveTarget({
      profile: targetName.includes('.') || targetName.includes('@') ? undefined : targetName,
      host: targetName.includes('@') ? targetName.split('@')[1] : targetName.includes('.') ? targetName : undefined,
      username: targetName.includes('@') ? targetName.split('@')[0] : undefined,
    });

    const helper = new SSHHelper({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      privateKeyPath: target.privateKeyPath,
      passphrase: target.passphrase,
    });

    const result = await helper.exec(cmd, {
      targetOs: target.targetOs,
      desktop: isDesktop,
    });

    const { formatOutputText } = await import('../core/ps.js');
    let out = result.stdout;
    let err = result.stderr;
    if (!raw && (tail || head || maxLines)) {
      out = formatOutputText(out, { tail, head, maxLines }).text;
      err = formatOutputText(err, { tail, head, maxLines }).text;
    }

    if (out) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
    if (err) process.stderr.write(err.endsWith('\n') ? err : err + '\n');
    if (result.code !== 0) {
      process.exit(result.code);
    }
    return;
  }

  if (command === 'push' || command === 'upload') {
    const targetName = args[1];
    const localFile = args[2];
    const remoteFile = args[3];
    if (!targetName || !localFile || !remoteFile) {
      console.error('Error: Usage: sshctl push <profile|host> <localPath> <remotePath>');
      process.exit(1);
    }

    const target = resolveTarget({ profile: targetName });
    const helper = new SSHHelper(target);
    console.log(`Uploading ${localFile} -> ${target.host}:${remoteFile}...`);
    await helper.uploadFile(path.resolve(localFile), remoteFile);
    console.log('Upload complete.');
    return;
  }

  if (command === 'pull' || command === 'download') {
    const targetName = args[1];
    const remoteFile = args[2];
    const localFile = args[3];
    if (!targetName || !remoteFile || !localFile) {
      console.error('Error: Usage: sshctl pull <profile|host> <remotePath> <localPath>');
      process.exit(1);
    }

    const target = resolveTarget({ profile: targetName });
    const helper = new SSHHelper(target);
    console.log(`Downloading ${target.host}:${remoteFile} -> ${localFile}...`);
    await helper.downloadFile(remoteFile, path.resolve(localFile));
    console.log('Download complete.');
    return;
  }

  console.error(`Unknown command: ${command}. Run 'sshctl --help' for available commands.`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`
sshctl - Cross-platform SSH remote execution, key management & MCP server

USAGE:
  sshctl <command> [arguments] [options]

COMMANDS:
  profiles                   List saved profiles from ~/.sshctl/profiles.json
  test <profile|host>        Test SSH connectivity & probe remote OS
  exec <profile|host> <cmd>  Execute a remote command (with Base64 UTF-16LE & Session 0 bypass)
  push <profile> <src> <dst> Upload a file to remote host via SFTP
  pull <profile> <src> <dst> Download a file from remote host via SFTP
  bootstrap-rdp [--admin]    Generate PowerShell 1-liner to install OpenSSH on Windows via RDP
  clear-hosts <host>         Remove host from ~/.ssh/known_hosts
  mcp                        Start stdio JSON-RPC MCP Server (for AI agents)

OPTIONS:
  --desktop                  Launch command interactively on user's active GUI desktop (Windows Session 1)
  --version, -v              Display version
  --help, -h                 Display this help message
`);
}
