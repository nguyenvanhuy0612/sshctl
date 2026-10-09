/**
 * End-to-end container test runner for sshctl.
 *
 * Detects Docker / OrbStack on the host, builds a tiny Alpine OpenSSH server (~7MB),
 * starts a temporary container, runs comprehensive E2E tests (including auto-match,
 * auto-provisioning, snapshot revert self-healing, and diagnostic error classification),
 * and automatically tears down the container and stops/closes OrbStack in the finally block.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

import { SSHHelper } from '../dist/core/ssh-client.js';
import { handleSshExec } from '../dist/mcp/tools/ssh-exec.js';
import { handleSshTestConnection, handleSshListProfiles } from '../dist/mcp/tools/ssh-connect.js';
import { handleSshSetupPasswordless, handleSshRemovePasswordless } from '../dist/mcp/tools/ssh-passwordless.js';
import { handleSshUpload, handleSshDownload } from '../dist/mcp/tools/ssh-transfer.js';
import { loadProfiles } from '../dist/core/profiles.js';

let startedOrbstack = false;

function isDockerRunning() {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function tryStartOrbstack() {
  try {
    execSync('which orb && orb start', { stdio: 'ignore', timeout: 8000 });
    // Give daemon a couple of seconds to accept connections
    for (let i = 0; i < 8; i++) {
      if (isDockerRunning()) {
        startedOrbstack = true;
        return true;
      }
      execSync('sleep 1');
    }
  } catch {
    // Orb not available
  }
  return isDockerRunning();
}

console.log('=== sshctl Container E2E Test Runner ===');

let dockerReady = isDockerRunning();
if (!dockerReady) {
  console.log('Docker daemon not running, attempting to start OrbStack...');
  dockerReady = tryStartOrbstack();
}

if (!dockerReady) {
  console.log('[SKIPPED] Docker / OrbStack is not available on this host.');
  console.log('To run container E2E tests, start Docker Desktop or OrbStack (orb start).');
  process.exit(0);
}

console.log(`Docker environment detected and ready${startedOrbstack ? ' (started by test runner)' : ''}.`);

const IMAGE_NAME = 'sshctl-e2e-test:latest';
const CONTAINER_NAME = `sshctl-e2e-${Date.now()}`;
const PORT = 22222;
const HOST = '127.0.0.1';
const USER = 'sshtest';
const PASSWORD = 'testpw123';

const DOCKERFILE = `
FROM alpine:3.20
RUN apk add --no-cache openssh-server bash shadow sudo && \\
    ssh-keygen -A && \\
    adduser -D -s /bin/bash ${USER} && \\
    echo "${USER}:${PASSWORD}" | chpasswd && \\
    echo "root:rootpw123" | chpasswd && \\
    echo "${USER} ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \\
    echo "PermitRootLogin no" >> /etc/ssh/sshd_config && \\
    echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`;

// 1. Build image if needed
try {
  console.log('Ensuring test image exists...');
  execSync(`docker build -t ${IMAGE_NAME} -`, {
    input: DOCKERFILE,
    stdio: ['pipe', 'ignore', 'pipe'],
    timeout: 60000,
  });
} catch (err) {
  console.error(`Failed to build test image: ${err.message}`);
  if (startedOrbstack) {
    try { execSync('orb stop', { stdio: 'ignore' }); } catch {}
  }
  process.exit(1);
}

let passed = 0;
let failed = 0;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sshctl-container-e2e-'));
const testProfilesFile = path.join(scratch, 'profiles.json');
fs.writeFileSync(testProfilesFile, '{}', { mode: 0o600 });
process.env.SSHCTL_PROFILES = testProfilesFile;

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  console.log(`\n[Cleanup] Tearing down test container ${CONTAINER_NAME}...`);
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'ignore' });
    console.log('[Cleanup] Test container stopped and removed.');
  } catch {}

  if (scratch && fs.existsSync(scratch)) {
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log('[Cleanup] Temporary test directories removed.');
  }

  if (startedOrbstack || process.env.STOP_ORBSTACK === '1') {
    console.log('[Cleanup] Stopping and closing OrbStack (started for this test run)...');
    try {
      execSync('orb stop', { stdio: 'ignore', timeout: 15000 });
    } catch {}
    try {
      execSync('osascript -e \'quit app "OrbStack"\' 2>/dev/null || true', { stdio: 'ignore' });
    } catch {}
    console.log('[Cleanup] OrbStack stopped and closed.');
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

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

function text(r) {
  return r.content?.[0]?.text ?? '';
}

// Wait for sshd to accept connections
async function waitForSshd(maxAttempts = 15) {
  const probeHelper = new SSHHelper({ host: HOST, port: PORT, username: USER, password: PASSWORD });
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await probeHelper.testConnection();
      if (res.connected) return true;
    } catch {
      // Retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`sshd did not become ready on ${HOST}:${PORT} after ${maxAttempts} attempts`);
}

try {
  // 2. Start container
  console.log(`Starting SSH test container on port ${PORT}...`);
  execSync(`docker run -d --name ${CONTAINER_NAME} -p ${PORT}:22 ${IMAGE_NAME}`, {
    stdio: 'ignore',
    timeout: 15000,
  });

  await waitForSshd();
  console.log(`SSH container is up and accepting connections.\n`);

  console.log('--- Suite 1: Standard Connection & Execution ---');
  await check('testConnection identifies target as Linux', async () => {
    const helper = new SSHHelper({ host: HOST, port: PORT, username: USER, password: PASSWORD });
    const res = await helper.testConnection();
    assert.equal(res.connected, true);
    assert.equal(res.targetOs, 'linux');
  });

  await check('execSmart returns stdout, stderr and exit code', async () => {
    const helper = new SSHHelper({ host: HOST, port: PORT, username: USER, password: PASSWORD });
    const r = await helper.execSmart('echo "container-live" && echo "err-msg" >&2 && exit 0');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /container-live/);
    assert.match(r.stderr, /err-msg/);
  });

  console.log('\n--- Suite 2: SFTP Transfers ---');
  await check('upload and download round trip works seamlessly', async () => {
    const localUpload = path.join(scratch, 'test-up.txt');
    const localDownload = path.join(scratch, 'test-down.txt');
    fs.writeFileSync(localUpload, 'sftp-content-1234\n');

    const upRes = await handleSshUpload({
      host: HOST,
      port: PORT,
      username: USER,
      password: PASSWORD,
      localPath: localUpload,
      remotePath: '/tmp/nested/test-up.txt',
    });
    assert.ok(!upRes.isError, text(upRes));

    const downRes = await handleSshDownload({
      host: HOST,
      port: PORT,
      username: USER,
      password: PASSWORD,
      remotePath: '/tmp/nested/test-up.txt',
      localPath: localDownload,
    });
    assert.ok(!downRes.isError, text(downRes));
    assert.equal(fs.readFileSync(localDownload, 'utf8'), 'sftp-content-1234\n');
  });

  console.log('\n--- Suite 3: Auto-provisioning & Profile Auto-match ---');
  await check('auto-provisions passwordless and auto-saves profile when password is provided', async () => {
    const res = await handleSshExec({
      host: HOST,
      port: PORT,
      username: USER,
      password: PASSWORD,
      command: 'echo auto-provisioned-ok',
    });
    assert.ok(!res.isError, text(res));
    assert.match(text(res), /auto-provisioned-ok/);
    assert.match(text(res), /Automatically configured passwordless key and saved profile/);

    const profiles = loadProfiles();
    const matched = Object.values(profiles).find((p) => p.host === HOST && p.port === PORT);
    assert.ok(matched, 'Profile was not saved in profiles.json');
    assert.ok(matched.privateKeyPath, 'Profile has no privateKeyPath');
  });

  await check('subsequent call auto-matches profile by host without credentials or profile argument', async () => {
    const res = await handleSshExec({
      host: HOST,
      port: PORT,
      command: 'whoami',
    });
    assert.ok(!res.isError, text(res));
    assert.match(text(res), new RegExp(USER));
  });

  console.log('\n--- Suite 4: Snapshot Revert & Self-Healing ---');
  await check('auto-heals and redeploys key when remote authorized_keys is wiped', async () => {
    // Simulate snapshot revert wiping the key
    execSync(`docker exec ${CONTAINER_NAME} rm -f /home/${USER}/.ssh/authorized_keys`);

    // Call ssh_exec with password: should detect key rejection, auto-redeploy key, and succeed
    const res = await handleSshExec({
      host: HOST,
      port: PORT,
      username: USER,
      password: PASSWORD,
      command: 'echo recovered-after-wipe',
    });
    assert.ok(!res.isError, text(res));
    assert.match(text(res), /recovered-after-wipe/);
  });

  console.log('\n--- Suite 5: Diagnostic Error Reporting for Blocked Cases ---');
  await check('diagnoses PermitRootLogin denial when connecting as root', async () => {
    const res = await handleSshExec({
      host: HOST,
      port: PORT,
      username: 'root',
      password: 'rootpw123',
      command: 'id',
    });
    assert.equal(res.isError, true);
    assert.match(text(res), /disables root login/);
  });

  await check('diagnoses connection refused when target port is closed', async () => {
    const res = await handleSshExec({
      host: HOST,
      port: 54321,
      username: USER,
      command: 'id',
    });
    assert.equal(res.isError, true);
    assert.match(text(res), /Connection refused/);
  });

} finally {
  cleanup();
}

console.log(`\nContainer E2E results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
