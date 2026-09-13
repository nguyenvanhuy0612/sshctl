import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, '..', '..', 'bin', 'sshctl.js');

function runCliSubprocess(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

test('sshctl --help prints usage information', async () => {
  const result = await runCliSubprocess(['--help']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('sshctl - Cross-platform SSH'));
  assert.ok(result.stdout.includes('COMMANDS:'));
  assert.ok(result.stdout.includes('test <profile|host>'));
  assert.ok(result.stdout.includes('exec <profile|host> <cmd>'));
});

test('sshctl --version prints version', async () => {
  const result = await runCliSubprocess(['--version']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('sshctl v1.0.0'));
});

test('sshctl bootstrap-rdp outputs valid powershell script', async () => {
  const result = await runCliSubprocess(['bootstrap-rdp', '--admin']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('Windows OpenSSH Server 1-Liner Bootstrap'));
  assert.ok(result.stdout.includes('OpenSSH-Win64'));
});

test('sshctl profiles runs without throwing', async () => {
  const result = await runCliSubprocess(['profiles']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('Profiles file:'));
});
