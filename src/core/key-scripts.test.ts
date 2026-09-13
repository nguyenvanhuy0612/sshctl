import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPowerShellCommand } from './ps.js';
import {
  DEPLOY_MARKER,
  REMOVE_MARKER,
  buildUnixDeployScript,
  buildUnixRemoveScript,
  buildWindowsDeployScript,
  buildWindowsRemoveScript,
} from './key-scripts.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHexampleexampleexample admin@Huys-MacBook.local';

function decodeCommand(wire: string): string {
  const match = wire.match(/-EncodedCommand (\S+)$/);
  assert.ok(match, `no -EncodedCommand payload in: ${wire}`);
  return Buffer.from(match![1], 'base64').toString('utf16le');
}

/** The mangling the original implementation applied before sending the script. */
function legacyFlatten(script: string): string {
  return script.replace(/\n/g, ' ');
}

/** Statements that survive PowerShell comment stripping, line by line. */
function executableText(script: string): string {
  return script
    .split('\n')
    .map((line) => line.split('#')[0])
    .join('\n');
}

test('REGRESSION: flattening the deploy script hides the ACL step behind a comment', () => {
  // This is the bug the -EncodedCommand path exists to prevent. Collapsing newlines puts
  // icacls, and everything after it, on the same line as a # comment, so PowerShell never
  // runs the ACL step that sshd requires and the success marker is never printed.
  const flattened = legacyFlatten(buildWindowsDeployScript(KEY));
  const surviving = executableText(flattened);

  assert.ok(flattened.includes('icacls'), 'flattened text still contains the icacls characters');
  assert.ok(!surviving.includes('icacls'), 'but icacls is commented out once newlines are gone');
  assert.ok(!surviving.includes(DEPLOY_MARKER), 'and the success marker is commented out too');
});

test('the deploy script sent over the wire keeps icacls and the marker executable', () => {
  const script = decodeCommand(buildPowerShellCommand(buildWindowsDeployScript(KEY)));
  const surviving = executableText(script);

  assert.ok(surviving.includes('icacls'), 'icacls must be live code');
  assert.ok(surviving.includes(DEPLOY_MARKER), 'success marker must be live code');
  assert.ok(script.includes('\n'), 'newlines must survive encoding');
});

test('the deploy script picks the authorized-keys file by group membership, not elevation', () => {
  const script = buildWindowsDeployScript(KEY);
  assert.match(script, /BuiltinAdministratorsSid/);
  assert.match(script, /administrators_authorized_keys/);
  assert.match(script, /USERPROFILE/);
});

test('the deploy script does not restart sshd', () => {
  // Restarting the service the session is running through can drop that session, and
  // authorized_keys is read at authentication time, so a restart achieves nothing.
  assert.ok(!/Restart-Service/.test(buildWindowsDeployScript(KEY)));
});

test('a hostile key comment cannot break out of the PowerShell literal', () => {
  const hostile = `ssh-ed25519 AAAAB3Nz comment'; Remove-Item -Recurse C:\\; '`;
  const script = buildWindowsDeployScript(hostile);
  const assignment = script.split('\n').find((l) => l.startsWith('$key = '));
  assert.ok(assignment, 'expected a $key assignment line');
  assert.equal((assignment!.match(/'/g) || []).length % 2, 0, 'quotes must stay balanced');
  // With quotes stripped, no bare Remove-Item statement is left behind.
  assert.ok(!/Remove-Item/.test(assignment!.replace(/'(?:[^']|'')*'/g, "''")));
});

test('a hostile key comment cannot break out of the shell literal', () => {
  const hostile = `ssh-ed25519 AAAAB3Nz x'; rm -rf /; echo '`;
  const script = buildUnixDeployScript(hostile);
  const assignment = script.split('\n').find((l) => l.startsWith('KEY='));
  assert.ok(assignment, 'expected a KEY= assignment line');
  assert.ok(!/rm -rf \/;\s*$/.test(assignment!.replace(/'\\''/g, '').replace(/'[^']*'/g, "''")));
});

test('the unix deploy script fails fast, fixes permissions and is idempotent', () => {
  const script = buildUnixDeployScript(KEY);
  assert.match(script, /^set -e/m);
  assert.match(script, /umask 077/);
  assert.match(script, /chmod 700 "\$HOME\/\.ssh"/);
  assert.match(script, /chmod 600 "\$F"/);
  assert.match(script, /grep -qxF "\$KEY"/);
  assert.ok(script.includes(DEPLOY_MARKER));
});

test('remove scripts back up before rewriting and report both modes', () => {
  const winOne = buildWindowsRemoveScript(KEY, false);
  const winAll = buildWindowsRemoveScript(KEY, true);
  assert.match(winOne, /\.sshctl\.bak/);
  assert.match(winOne, /Where-Object/);
  assert.match(winAll, /\$keep = @\(\)/);
  assert.ok(!winAll.includes('Where-Object'), 'clearing all keys needs no filter');
  assert.ok(winOne.includes(REMOVE_MARKER) && winAll.includes(REMOVE_MARKER));

  const unixOne = buildUnixRemoveScript(KEY, false);
  const unixAll = buildUnixRemoveScript(KEY, true);
  assert.match(unixOne, /cp "\$F" "\$F\.sshctl\.bak"/);
  // grep exits 1 when it filters out every line; without the guard, set -e would abort
  // before the file was replaced.
  assert.match(unixOne, /grep -vxF "\$KEY" "\$F" > "\$F\.sshctl\.tmp" \|\| true/);
  assert.match(unixAll, /: > "\$F"/);
});

test('remove scripts cover both Windows authorized-keys locations', () => {
  const script = buildWindowsRemoveScript(KEY, false);
  assert.match(script, /administrators_authorized_keys/);
  assert.match(script, /USERPROFILE/);
});
