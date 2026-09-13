/**
 * End-to-end checks against a live Linux SSH target.
 *
 * NOT part of `npm test`. Run it with `npm run test:e2e` against a throwaway host you control,
 * because it writes to the target's ~/.ssh/authorized_keys and, with E2E_ALLOW_KILL=1, kills
 * sshd processes on it.
 *
 *   E2E_HOST=127.0.0.1 E2E_PORT=2222 E2E_USER=sshtest E2E_PASSWORD=testpw123 npm run test:e2e
 *
 * Environment:
 *   E2E_HOST, E2E_PORT, E2E_USER, E2E_PASSWORD   target and password auth (required)
 *   E2E_ALLOW_KILL=1                             also run the resilience section, which needs
 *                                                to kill and restart sshd on the target and so
 *                                                only works when the target is this machine
 *   E2E_SSHD_RESTART                             command used to restart sshd for that section
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

import { SSHHelper, TIMEOUT_EXIT_CODE } from '../dist/utils/ssh-client.js';
import { ChannelOpenError, closeAll, poolStats } from '../dist/utils/pool.js';
import { handleSshExec } from '../dist/tools/ssh-exec.js';
import { handleSshUpload, handleSshDownload } from '../dist/tools/ssh-transfer.js';
import {
  handleSshSetupPasswordless,
  handleSshRemovePasswordless,
} from '../dist/tools/ssh-passwordless.js';
import { handleSshTestConnection, handleSshListProfiles } from '../dist/tools/ssh-connect.js';

/** PIDs of the sshd processes serving this user, read from /proc to avoid pkill self-matching. */
function sessionPids(user) {
  return fs
    .readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .filter((pid) => {
      try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`sshd: ${user}`);
      } catch {
        return false;
      }
    })
    .map(Number);
}

const HOST = process.env.E2E_HOST;
const PORT = Number(process.env.E2E_PORT ?? 22);
const USER = process.env.E2E_USER;
const PASSWORD = process.env.E2E_PASSWORD;

if (!HOST || !USER || !PASSWORD) {
  console.error('Set E2E_HOST, E2E_USER and E2E_PASSWORD. See the header of this file.');
  process.exit(2);
}

const base = { host: HOST, port: PORT, username: USER, password: PASSWORD };
const raw = new SSHHelper({ ...base, useAgent: false });
const text = (r) => r.content[0].text;

let passed = 0;
let failed = 0;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-e2e-'));

async function check(name, fn) {
  try {
    const note = await fn();
    console.log(`  ok    ${name}${note ? ` (${note})` : ''}`);
    passed += 1;
  } catch (err) {
    const detail = err.message.split('\n').filter(Boolean).slice(0, 4).join('\n        ');
    console.log(`  FAIL  ${name}\n        ${detail}`);
    failed += 1;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Read a remote file through the connection under test. */
async function remoteRead(file) {
  const res = await raw.execSmart(`cat ${file} 2>/dev/null || true`);
  return res.stdout;
}

async function remoteStatMode(file) {
  const res = await raw.execSmart(`stat -c %a ${file} 2>/dev/null || stat -f %Lp ${file}`);
  return res.stdout.trim();
}

section('Connection and execution');

await check('testConnection reports connected and detects Linux', async () => {
  const probe = await raw.testConnection();
  assert.equal(probe.connected, true, JSON.stringify(probe));
  assert.equal(probe.targetOs, 'linux');
  assert.equal(probe.suggestPasswordless, true, 'password auth should suggest key setup');
});

await check('stdout, stderr and a real exit code all come back', async () => {
  const r = await raw.execSmart('echo hello; echo oops >&2; exit 3');
  assert.equal(r.code, 3);
  assert.match(r.stdout, /hello/);
  assert.match(r.stderr, /oops/);
});

await check('concurrent commands share one pooled connection', async () => {
  const before = poolStats().open;
  await Promise.all(Array.from({ length: 8 }, (_, i) => raw.execSmart(`echo n${i}`)));
  const added = poolStats().open - before;
  assert.ok(added <= 1, `8 concurrent commands opened ${added} connections, expected at most 1`);
  return '8 commands, 1 handshake';
});

await check('the detected OS is cached on the connection', async () => {
  await raw.withClient(async (conn) => assert.equal(conn.detectedOs, 'linux'));
});

section('Hang and resource bounds');

await check('a command reading stdin gets EOF instead of hanging', async () => {
  const t0 = Date.now();
  const r = await raw.execSmart('read -r line; echo "got:[$line]"', { timeoutMs: 8000 });
  const ms = Date.now() - t0;
  assert.ok(ms < 7000, `took ${ms}ms, so stdin was not closed`);
  assert.match(r.stdout, /got:\[\]/);
  return `returned in ${ms}ms`;
});

await check('the stdin option is delivered to the remote command', async () => {
  const r = await raw.execSmart('read -r line; echo "got:[$line]"', { stdin: 'from-agent\n' });
  assert.match(r.stdout, /got:\[from-agent\]/);
});

await check('a command past its timeout returns code 124 with partial output', async () => {
  const t0 = Date.now();
  const r = await raw.execSmart('echo partial; sleep 30', { timeoutMs: 2000 });
  const ms = Date.now() - t0;
  assert.equal(r.code, TIMEOUT_EXIT_CODE);
  assert.equal(r.timedOut, true);
  assert.match(r.stdout, /partial/);
  assert.match(r.stderr, /exceeded timeout/);
  assert.ok(ms < 6000, `took ${ms}ms`);
  return `cut off after ${ms}ms`;
});

await check('a signal death is reported as a non-zero exit code', async () => {
  const r = await raw.execSmart("sh -c 'kill -9 $$'");
  assert.notEqual(r.code, 0, 'signal death reported as success');
  return `exit ${r.code}`;
});

await check('oversized output is capped with a truncation notice', async () => {
  const r = await raw.execSmart('head -c 500000 /dev/zero | tr "\\0" "x"', {
    maxOutputBytes: 5000,
  });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length < 20000, `stdout was ${r.stdout.length} bytes`);
  assert.match(r.stdout, /output truncated, kept 5000 of 500000 bytes/);
  return `500KB down to ${r.stdout.length} chars`;
});

section('SFTP transfers');

const srcFile = path.join(scratch, 'src.txt');
const remoteFile = `/tmp/mcp-ssh-e2e/nested/dir/payload.txt`;

await check('upload creates every missing remote parent directory', async () => {
  fs.writeFileSync(srcFile, 'payload-abc\n');
  await raw.execSmart('rm -rf /tmp/mcp-ssh-e2e');
  const res = await handleSshUpload({ ...base, localPath: srcFile, remotePath: remoteFile });
  assert.ok(!res.isError, text(res));
  assert.match(await remoteRead(remoteFile), /payload-abc/);
});

await check('download round trip preserves content', async () => {
  const dest = path.join(scratch, 'deep', 'back.txt');
  const res = await handleSshDownload({ ...base, remotePath: remoteFile, localPath: dest });
  assert.ok(!res.isError, text(res));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'payload-abc\n');
});

await check('a directory is refused rather than partially copied', async () => {
  const res = await handleSshUpload({ ...base, localPath: scratch, remotePath: '/tmp/nope' });
  assert.equal(res.isError, true);
  assert.match(text(res), /is a directory/);
});

section('Passwordless key lifecycle');

const keyPath = path.join(scratch, 'e2e-key');
const authKeys = '~/.ssh/authorized_keys';
await raw.execSmart('rm -f ~/.ssh/authorized_keys*');

await check('setup deploys the key and verifies key-only login', async () => {
  const res = await handleSshSetupPasswordless({ ...base, keyPath });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /configured and verified/);
});

await check('authorized_keys is 600 and ~/.ssh is 700', async () => {
  assert.equal(await remoteStatMode('~/.ssh/authorized_keys'), '600');
  assert.equal(await remoteStatMode('~/.ssh'), '700');
});

await check('a second deploy does not duplicate the key line', async () => {
  await handleSshSetupPasswordless({ ...base, keyPath });
  const lines = (await remoteRead(authKeys)).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected 1 key, found ${lines.length}`);
});

await check('key-only login works with no password supplied', async () => {
  const res = await handleSshTestConnection({
    host: HOST,
    port: PORT,
    username: USER,
    privateKeyPath: keyPath,
  });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /Target OS: LINUX/);
});

await check('a key comment full of shell metacharacters is stored, not executed', async () => {
  const hostileKey = path.join(scratch, 'hostile');
  execFileSync('ssh-keygen', [
    '-t', 'ed25519', '-f', hostileKey, '-N', '', '-q',
    '-C', "x'; touch /tmp/mcp-ssh-PWNED; echo '",
  ]);
  await raw.execSmart('rm -f /tmp/mcp-ssh-PWNED');

  const res = await handleSshSetupPasswordless({ ...base, keyPath: hostileKey });
  assert.ok(!res.isError, text(res));

  const pwned = await raw.execSmart('test -e /tmp/mcp-ssh-PWNED && echo YES || echo NO');
  assert.match(pwned.stdout, /NO/, 'the injected command executed on the target');

  const lines = (await remoteRead(authKeys)).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2, `expected 2 keys, found ${lines.length}`);
  assert.ok(
    lines.some((l) => l.includes('touch /tmp/mcp-ssh-PWNED')),
    'the hostile comment should be stored verbatim inside the key line'
  );
  return 'injection stored as data';
});

await check('removing one key keeps the other and leaves a backup', async () => {
  const res = await handleSshRemovePasswordless({
    ...base,
    keyPathToRemove: `${path.join(scratch, 'hostile')}.pub`,
  });
  assert.ok(!res.isError, text(res));
  const lines = (await remoteRead(authKeys)).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected 1 key left, found ${lines.length}`);
  const bak = await raw.execSmart('test -f ~/.ssh/authorized_keys.mcp-ssh.bak && echo YES || echo NO');
  assert.match(bak.stdout, /YES/, 'no .mcp-ssh.bak was written');
});

await check('removeAllKeys clears every authorized key', async () => {
  const res = await handleSshRemovePasswordless({ ...base, removeAllKeys: true });
  assert.ok(!res.isError, text(res));
  assert.equal((await remoteRead(authKeys)).trim(), '');
});

section('Profiles and result shape');

const profileFile = path.join(scratch, 'profiles.json');
process.env.MCP_SSH_PROFILES = profileFile;
process.env.E2E_PROFILE_PASSWORD = PASSWORD;
fs.writeFileSync(
  profileFile,
  JSON.stringify({
    'e2e-target': {
      host: HOST,
      port: PORT,
      username: USER,
      password: 'env:E2E_PROFILE_PASSWORD',
      targetOs: 'linux',
      description: 'e2e target',
    },
  }),
  { mode: 0o600 }
);

await check('ssh_list_profiles lists the profile without leaking the password', async () => {
  const res = await handleSshListProfiles();
  assert.match(text(res), /e2e-target/);
  assert.ok(!text(res).includes(PASSWORD), 'the password appeared in the listing');
});

await check('ssh_exec runs with a profile name and no credentials in the call', async () => {
  const res = await handleSshExec({ profile: 'e2e-target', command: 'whoami' });
  assert.match(text(res), new RegExp(USER));
  assert.match(text(res), /HOST: e2e-target/);
});

await check('a non-zero exit code is data, not a tool error', async () => {
  const res = await handleSshExec({ profile: 'e2e-target', command: 'echo x | grep -q nomatch' });
  assert.equal(res.isError, undefined, 'grep exit 1 was flagged as a tool error');
  assert.match(text(res), /EXIT CODE: 1/);
});

await check('a timeout is surfaced as a tool error with a clear reason', async () => {
  const res = await handleSshExec({ profile: 'e2e-target', command: 'sleep 20', timeoutMs: 1500 });
  assert.equal(res.isError, true);
  assert.match(text(res), /timed out/);
});

await check('an unknown profile names the profiles that do exist', async () => {
  const res = await handleSshExec({ profile: 'nope', command: 'true' });
  assert.equal(res.isError, true);
  assert.match(text(res), /e2e-target/);
});

if (process.env.E2E_ALLOW_KILL === '1') {
  section('Resilience (kills sshd on the target)');

  const restart = process.env.E2E_SSHD_RESTART ?? 'systemctl restart ssh';
  const marker = '/tmp/mcp-ssh-side-effect.log';

  await check('a drop mid-command rejects promptly and is not retried', async () => {
    await raw.execSmart(`rm -f ${marker}`);
    await raw.execSmart('echo warm');
    assert.ok(poolStats().open >= 1, 'expected at least one pooled connection to kill');

    const t0 = Date.now();
    const inflight = raw.execSmart(`echo ran >> ${marker}; sleep 60`, { timeoutMs: 45000 });
    const killer = setTimeout(() => {
      // Read /proc directly rather than shelling out to pkill: a shell running
      // `pkill -f "sshd: user"` matches its own command line and kills itself first.
      for (const pid of sessionPids(USER)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 1200);

    let err;
    try {
      await inflight;
    } catch (e) {
      err = e;
    }
    clearTimeout(killer);
    const ms = Date.now() - t0;

    assert.ok(err, 'the command did not reject when the connection died');
    assert.match(err.message, /connection (failed|closed)/i);
    assert.ok(ms < 15000, `rejection took ${ms}ms, near the 45s timeout rather than promptly`);
    // The safety property: a command interrupted after it started must never be re-run,
    // otherwise a non-idempotent operation could take effect twice.
    assert.ok(!(err instanceof ChannelOpenError), 'a mid-flight drop must not count as retryable');
    // Killing every sshd process for this user takes down all pooled connections, but each
    // client receives its close event on its own tick, so let them settle before counting.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(poolStats().open, 0, 'dead connections stayed in the pool');

    try {
      execSync(restart);
    } catch {
      /* the listener may still be alive */
    }
    await new Promise((r) => setTimeout(r, 1500));

    const after = await raw.execSmart(`wc -l < ${marker} 2>/dev/null || echo 0`);
    assert.equal(
      after.stdout.trim(),
      '1',
      `side effect ran ${after.stdout.trim()} times, expected exactly 1`
    );
    return `rejected in ${ms}ms, side effect ran once`;
  });

  await check('the next command reconnects transparently', async () => {
    const r = await raw.execSmart('echo recovered');
    assert.match(r.stdout, /recovered/);
  });
} else {
  console.log('\nResilience section skipped. Set E2E_ALLOW_KILL=1 to run it.');
}

closeAll();
assert.equal(poolStats().open, 0, 'closeAll left connections open');
fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
