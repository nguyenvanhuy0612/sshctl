import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'index.js');

interface Rpc {
  id?: number;
  result?: any;
  error?: any;
  method?: string;
}

/**
 * Boot the server over stdio, send a batch of JSON-RPC requests, and collect the responses.
 * This is the cheapest end-to-end check that matters: it proves the process starts, speaks
 * MCP, and that every advertised tool is actually dispatchable.
 */
async function rpc(requests: object[], timeoutMs = 20_000): Promise<Map<number, Rpc>> {
  const child = spawn(process.execPath, [serverEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SSHCTL_PROFILES: path.join(here, '__no_such_profiles__.json') },
  });

  const responses = new Map<number, Rpc>();
  let buffer = '';

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not answer ${requests.length} requests within ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Rpc;
        if (typeof message.id === 'number') responses.set(message.id, message);
      }
      if (responses.size >= requests.length) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve();
      }
    });

    child.on('error', reject);
  });

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...request })}\n`);
  }

  await done;
  return responses;
}

test('server initializes and advertises every tool it can dispatch', async () => {
  const responses = await rpc([
    {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sshctl-test', version: '0' },
      },
    },
    { id: 2, method: 'tools/list', params: {} },
    { id: 3, method: 'prompts/list', params: {} },
  ]);

  const init = responses.get(1);
  assert.ok(init?.result, `initialize failed: ${JSON.stringify(init)}`);
  assert.equal(init.result.serverInfo.name, 'sshctl');

  const tools = responses.get(2)?.result?.tools;
  assert.ok(Array.isArray(tools), 'tools/list must return an array');

  const names = tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, [
    'ssh_clear_known_hosts',
    'ssh_download_file',
    'ssh_exec',
    'ssh_generate_rdp_bootstrap',
    'ssh_list_profiles',
    'ssh_remove_passwordless',
    'ssh_setup_passwordless',
    'ssh_test_connection',
    'ssh_upload_file',
  ]);

  for (const tool of tools) {
    assert.ok(tool.description, `${tool.name} has no description`);
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} has no object input schema`);
  }

  const prompts = responses.get(3)?.result?.prompts;
  assert.ok(Array.isArray(prompts) && prompts.length === 2, 'expected two prompts');
});

test('every advertised tool is wired to a handler', async () => {
  // Guards the failure mode of the hand-written dispatch switch: a tool can be added to the
  // advertised list and forgotten in the switch, and nothing would catch it until an agent
  // called it and got "Unknown tool".
  const listing = await rpc([
    {
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    },
    { id: 2, method: 'tools/list', params: {} },
  ]);
  const names: string[] = listing.get(2)!.result.tools.map((t: any) => t.name);

  // Call each tool with empty arguments. A missing switch case answers "Unknown tool"; a wired
  // tool answers with a validation or connection error instead, which is what we want to see.
  const calls = names.map((name, i) => ({
    id: 10 + i,
    method: 'tools/call',
    params: { name, arguments: {} },
  }));

  const responses = await rpc([
    {
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    },
    ...calls,
  ]);

  for (const [i, name] of names.entries()) {
    const body = JSON.stringify(responses.get(10 + i) ?? {});
    assert.ok(body !== '{}', `${name} produced no response at all`);
    assert.ok(!body.includes('Unknown tool'), `${name} is advertised but has no dispatch case`);
  }
});

test('ssh_generate_rdp_bootstrap returns a usable one-liner without touching the network', async () => {
  const responses = await rpc([
    {
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    },
    {
      id: 2,
      method: 'tools/call',
      params: { name: 'ssh_generate_rdp_bootstrap', arguments: { host: '10.0.0.5' } },
    },
  ]);

  const text = responses.get(2)?.result?.content?.[0]?.text ?? '';
  assert.match(text, /10\.0\.0\.5/);
  assert.match(text, /install-sshd\.ps1/);
  assert.match(text, /administrators_authorized_keys/);
});

test('a tool call with no host and no profile explains itself instead of throwing a stack', async () => {
  const responses = await rpc([
    {
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    },
    { id: 2, method: 'tools/call', params: { name: 'ssh_exec', arguments: { command: 'whoami' } } },
  ]);

  const result = responses.get(2)?.result;
  assert.equal(result?.isError, true);
  assert.match(result.content[0].text, /No host given|profile/i);
});
