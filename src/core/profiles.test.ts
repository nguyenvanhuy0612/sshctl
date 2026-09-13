import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { derefSecret, describeProfiles, expandHome, resolveTarget } from './profiles.js';

let tmpDir: string;
let profileFile: string;

function writeProfiles(data: unknown): void {
  fs.writeFileSync(profileFile, JSON.stringify(data), { mode: 0o600 });
  process.env.SSHCTL_PROFILES = profileFile;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshctl-test-'));
  profileFile = path.join(tmpDir, 'profiles.json');
});

afterEach(() => {
  delete process.env.SSHCTL_PROFILES;
  delete process.env.TEST_HOST_PASSWORD;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('expandHome only expands a bare ~ segment', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/.ssh/id_ed25519'), path.join(os.homedir(), '.ssh/id_ed25519'));
  assert.equal(expandHome('/etc/ssh/key'), '/etc/ssh/key');
  // ~user is another user's home, not ours; leaving it alone is the safe behaviour.
  assert.equal(expandHome('~other/keys'), '~other/keys');
});

test('derefSecret reads an env: indirection at call time', () => {
  process.env.TEST_HOST_PASSWORD = 's3cret';
  assert.equal(derefSecret('env:TEST_HOST_PASSWORD', 'p'), 's3cret');
  assert.equal(derefSecret('literal', 'p'), 'literal');
  assert.equal(derefSecret(undefined, 'p'), undefined);
});

test('derefSecret fails loudly when the referenced variable is missing', () => {
  assert.throws(() => derefSecret('env:NOT_SET_ANYWHERE', 'win-qa'), /NOT_SET_ANYWHERE/);
});

test('resolveTarget fills host, username and port from a profile', () => {
  writeProfiles({ 'win-qa': { host: '10.0.0.5', username: 'qa', port: 2222, targetOs: 'windows' } });
  const target = resolveTarget({ profile: 'win-qa' });
  assert.equal(target.host, '10.0.0.5');
  assert.equal(target.username, 'qa');
  assert.equal(target.port, 2222);
  assert.equal(target.targetOs, 'windows');
  assert.equal(target.profileName, 'win-qa');
});

test('resolveTarget defaults port to 22 and targetOs to auto', () => {
  writeProfiles({ box: { host: 'h', username: 'u' } });
  const target = resolveTarget({ profile: 'box' });
  assert.equal(target.port, 22);
  assert.equal(target.targetOs, 'auto');
});

test('explicit arguments override the profile', () => {
  writeProfiles({ box: { host: 'h', username: 'u', port: 22 } });
  const target = resolveTarget({ profile: 'box', username: 'root', port: 2200 });
  assert.equal(target.username, 'root');
  assert.equal(target.port, 2200);
  assert.equal(target.host, 'h');
});

test('resolveTarget works with no profile at all', () => {
  const target = resolveTarget({ host: 'h', username: 'u', password: 'p' });
  assert.equal(target.port, 22);
  assert.equal(target.password, 'p');
  assert.equal(target.profileName, undefined);
});

test('resolveTarget resolves an env: password stored in a profile', () => {
  process.env.TEST_HOST_PASSWORD = 'from-env';
  writeProfiles({ box: { host: 'h', username: 'u', password: 'env:TEST_HOST_PASSWORD' } });
  assert.equal(resolveTarget({ profile: 'box' }).password, 'from-env');
});

test('resolveTarget names the known profiles when one is misspelled', () => {
  writeProfiles({ 'win-qa': { host: 'h', username: 'u' }, linux: { host: 'h2', username: 'u' } });
  assert.throws(() => resolveTarget({ profile: 'win-qb' }), /win-qa, linux/);
});

test('resolveTarget refuses to guess a missing host or username', () => {
  assert.throws(() => resolveTarget({ username: 'u' }), /No host given/);
  assert.throws(() => resolveTarget({ host: 'h' }), /No username given/);
});

test('resolveTarget expands ~ in a profile key path', () => {
  writeProfiles({ box: { host: 'h', username: 'u', privateKeyPath: '~/.ssh/id_ed25519' } });
  assert.equal(
    resolveTarget({ profile: 'box' }).privateKeyPath,
    path.join(os.homedir(), '.ssh/id_ed25519')
  );
});

test('describeProfiles never returns secret material', () => {
  writeProfiles({
    box: { host: 'h', username: 'u', password: 'super-secret', description: 'a box' },
  });
  const described = describeProfiles();
  assert.equal(described.length, 1);
  assert.equal(described[0].hasPassword, true);
  assert.equal(described[0].hasPrivateKey, false);
  assert.ok(!JSON.stringify(described).includes('super-secret'));
});

test('a malformed profiles file reports the path instead of throwing a bare parse error', () => {
  fs.writeFileSync(profileFile, '{ not json');
  process.env.SSHCTL_PROFILES = profileFile;
  assert.throws(() => resolveTarget({ profile: 'box' }), new RegExp(profileFile.replace(/\\/g, '\\\\')));
});

test('a profiles file containing an array is rejected', () => {
  writeProfiles([{ host: 'h' }]);
  assert.throws(() => resolveTarget({ profile: 'box' }), /must contain a JSON object/);
});
