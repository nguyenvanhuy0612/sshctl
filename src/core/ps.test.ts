import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CMD_EXE_WIRE_LIMIT,
  assertSafePublicKey,
  buildPowerShellCommand,
  cleanClixml,
  encodePowerShell,
  exceedsWireLimit,
  formatOutputText,
  psSingleQuote,
  resolveExitCode,
  sftpPathToWindows,
  shSingleQuote,
} from './ps.js';

/** Recover the script body from a built -EncodedCommand line. */
function decodeCommand(wire: string): string {
  const match = wire.match(/-EncodedCommand (\S+)$/);
  assert.ok(match, `no -EncodedCommand payload in: ${wire}`);
  return Buffer.from(match![1], 'base64').toString('utf16le');
}

test('encodePowerShell round-trips a script body through UTF-16LE base64', () => {
  const script = 'Write-Output "xin chào"\nWrite-Output $env:TEMP';
  assert.equal(Buffer.from(encodePowerShell(script), 'base64').toString('utf16le'), script);
});

test('buildPowerShellCommand preserves newlines exactly and injects ProgressPreference', () => {
  const script = 'line one\n# a comment\nline three';
  assert.equal(
    decodeCommand(buildPowerShellCommand(script)),
    "$ProgressPreference = 'SilentlyContinue';\n" + script
  );
});

test('buildPowerShellCommand keeps a nested double quote intact', () => {
  const script = 'Write-Host "deployment completed."';
  const wire = buildPowerShellCommand(script);
  assert.ok(!wire.includes('"'), `wire command must contain no quotes at all: ${wire}`);
  assert.equal(
    decodeCommand(wire),
    "$ProgressPreference = 'SilentlyContinue';\n" + script
  );
});

test('cleanClixml strips pure progress records and returns empty string', () => {
  const clixmlProgress = `#< CLIXML
<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>`;
  assert.equal(cleanClixml(clixmlProgress), '');
});

test('cleanClixml extracts decoded error messages from CLIXML', () => {
  const clixmlError = `#< CLIXML
<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">The term 'foo' is not recognized._x000D__x000A_</S><S S="Error">At line:1 char:1_x000D__x000A_</S></Objs>`;
  assert.equal(
    cleanClixml(clixmlError),
    "The term 'foo' is not recognized.\nAt line:1 char:1"
  );
});

test('cleanClixml leaves non-CLIXML stderr untouched', () => {
  const normalStderr = 'bash: command not found: bar';
  assert.equal(cleanClixml(normalStderr), normalStderr);
});

test('buildPowerShellCommand emits NonInteractive by default and drops it on request', () => {
  assert.match(buildPowerShellCommand('x'), /-NoProfile -NonInteractive -EncodedCommand/);
  assert.match(
    buildPowerShellCommand('x', { nonInteractive: false }),
    /-NoProfile -EncodedCommand/
  );
  assert.ok(!buildPowerShellCommand('x', { nonInteractive: false }).includes('-NonInteractive'));
});

test('exceedsWireLimit trips just past the cmd.exe wall, not before', () => {
  const under = buildPowerShellCommand('x'.repeat(2800));
  const over = buildPowerShellCommand('x'.repeat(3000));
  assert.equal(exceedsWireLimit(under), false);
  assert.equal(exceedsWireLimit(over), true);
  assert.ok(over.length > CMD_EXE_WIRE_LIMIT);
});

test('psSingleQuote doubles single quotes so the literal stays balanced', () => {
  assert.equal(psSingleQuote('plain'), "'plain'");
  assert.equal(psSingleQuote("it's"), "'it''s'");
  // A balanced literal has an even number of quote characters.
  const quoted = psSingleQuote("a'b'c");
  assert.equal((quoted.match(/'/g) || []).length % 2, 0);
});

test('psSingleQuote neutralises an attempt to close the literal and append a command', () => {
  const hostile = "key'; Remove-Item C:\\ -Recurse; '";
  const script = `$key = ${psSingleQuote(hostile)}`;
  // The injected semicolon must remain inside the literal, so no bare Remove-Item statement.
  assert.ok(!/;\s*Remove-Item/.test(script.replace(/'[^']*'/g, "''")));
  assert.equal((script.match(/'/g) || []).length % 2, 0);
});

test('shSingleQuote closes and reopens the literal around a single quote', () => {
  assert.equal(shSingleQuote('plain'), "'plain'");
  assert.equal(shSingleQuote("it's"), `'it'\\''s'`);
});

test('assertSafePublicKey accepts the key types ssh-keygen produces', () => {
  const keys = [
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHxyz admin@host',
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ== huy@mac',
    'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY= u@h',
    'sk-ssh-ed25519@openssh.com AAAAGnNr yubikey',
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHxyz',
  ];
  for (const key of keys) assert.doesNotThrow(() => assertSafePublicKey(key), key);
});

test('assertSafePublicKey rejects empty, multi-line and non-key input', () => {
  assert.throws(() => assertSafePublicKey(''), /empty/i);
  assert.throws(() => assertSafePublicKey('   '), /empty/i);
  assert.throws(
    () => assertSafePublicKey('ssh-ed25519 AAAA host\nssh-ed25519 BBBB other'),
    /newline/i
  );
  assert.throws(() => assertSafePublicKey('rm -rf /'), /does not look like/i);
});

test('resolveExitCode reports a signal death as non-zero', () => {
  assert.equal(resolveExitCode(0, null), 0);
  assert.equal(resolveExitCode(1, null), 1);
  assert.equal(resolveExitCode(null, 'SIGKILL'), 137);
  assert.equal(resolveExitCode(null, 'KILL'), 137);
  assert.equal(resolveExitCode(null, 'SIGTERM'), 143);
  assert.equal(resolveExitCode(undefined, null), 0);
  // Unknown signal name still has to be non-zero rather than a silent success.
  assert.ok(resolveExitCode(null, 'SIGWHATEVER') >= 128);
});

test('sftpPathToWindows converts an SFTP drive path to a native one', () => {
  assert.equal(sftpPathToWindows('/C:/Users/admin/.sshctl-tmp/a.ps1'), 'C:\\Users\\admin\\.sshctl-tmp\\a.ps1');
  assert.equal(sftpPathToWindows('C:/Windows/Temp'), 'C:\\Windows\\Temp');
  assert.equal(sftpPathToWindows('/home/huy/x'), '\\home\\huy\\x');
});

test('formatOutputText compacts whitespace and trims line endings', () => {
  const input = 'line 1   \n\n\n\n\nline 2   \n';
  const res = formatOutputText(input, { compact: true });
  assert.equal(res.text, 'line 1\n\nline 2\n');
});

test('formatOutputText handles tail argument', () => {
  const input = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const res = formatOutputText(input, { tail: 5 });
  assert.equal(res.truncated, true);
  assert.ok(res.text.includes('45 lines omitted'));
  assert.ok(res.text.includes('line 50'));
  assert.ok(!res.text.includes('line 1\n'));
});

test('formatOutputText handles head argument', () => {
  const input = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const res = formatOutputText(input, { head: 5 });
  assert.equal(res.truncated, true);
  assert.ok(res.text.includes('45 lines omitted'));
  assert.ok(res.text.includes('line 1'));
  assert.ok(!res.text.includes('line 50'));
});

test('formatOutputText smart windows outputs exceeding maxLines', () => {
  const input = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  const res = formatOutputText(input, { maxLines: 20 });
  assert.equal(res.truncated, true);
  assert.ok(res.text.includes('omitted in middle'));
  assert.ok(res.text.includes('line 1'));
  assert.ok(res.text.includes('line 100'));
});
