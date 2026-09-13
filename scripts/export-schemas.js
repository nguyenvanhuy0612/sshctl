import * as fs from 'fs';
import * as path from 'path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import {
  sshTestConnectionSchema,
  sshClearKnownHostsSchema,
  sshListProfilesSchema,
} from '../dist/mcp/tools/ssh-connect.js';
import { sshExecSchema } from '../dist/mcp/tools/ssh-exec.js';
import {
  sshPasswordlessSchema,
  sshRemovePasswordlessSchema,
} from '../dist/mcp/tools/ssh-passwordless.js';
import { sshUploadSchema, sshDownloadSchema } from '../dist/mcp/tools/ssh-transfer.js';
import { sshGenerateRdpBootstrapSchema } from '../dist/mcp/tools/ssh-install.js';

import * as os from 'os';

const defaultDirs = [
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp', 'sshctl'),
  path.join(os.homedir(), '.gemini', 'antigravity', 'mcp', 'sshctl'),
];

const targetDirs = process.argv[2] ? [process.argv[2]] : defaultDirs;

for (const dir of targetDirs) {
  fs.mkdirSync(dir, { recursive: true });
}

const tools = [
  {
    name: 'ssh_list_profiles',
    description:
      'List saved connection profiles from ~/.sshctl/profiles.json. Never returns secrets. Call this first to find a profile name instead of asking the user for a password.',
    schema: sshListProfilesSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ssh_test_connection',
    description:
      'Test SSH connection & probe target OS. Reports whether the failure was unreachable host or rejected credentials.',
    schema: sshTestConnectionSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'ssh_clear_known_hosts',
    description:
      'Remove stale/changed host entries from local ~/.ssh/known_hosts via ssh-keygen -R, handling hashed entries and [host]:port form.',
    schema: sshClearKnownHostsSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ssh_exec',
    description:
      'Execute remote commands over SSH. Handles Base64 UTF-16LE PowerShell encoding, Session 0 bypass (desktop: true), the 8191 char command limit, and enforces a timeout and an output size cap.',
    schema: sshExecSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ssh_setup_passwordless',
    description:
      'Deploy ed25519 public key to Linux (~/.ssh/authorized_keys) or Windows (administrators_authorized_keys with ACLs) and verify key login.',
    schema: sshPasswordlessSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'ssh_remove_passwordless',
    description:
      'Remove public key entry or clear ALL keys from authorized_keys on remote host, revoking passwordless SSH login.',
    schema: sshRemovePasswordlessSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'ssh_upload_file',
    description: 'Upload a local file to remote host via SFTP channel.',
    schema: sshUploadSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'ssh_download_file',
    description: 'Download a remote file to local host via SFTP channel.',
    schema: sshDownloadSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'ssh_generate_rdp_bootstrap',
    description:
      'Generate 1-liner PowerShell script to copy-paste into an RDP session to install OpenSSH server on Windows target.',
    schema: sshGenerateRdpBootstrapSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

for (const targetDir of targetDirs) {
  for (const t of tools) {
    const jsonSchema = zodToJsonSchema(z.object(t.schema));
    const doc = {
      name: t.name,
      description: t.description,
      parameters: jsonSchema,
      annotations: t.annotations,
    };
    fs.writeFileSync(path.join(targetDir, `${t.name}.json`), JSON.stringify(doc, null, 2) + '\n');
  }

  const instructions = `# sshctl MCP Server Guidance

## Best Practices & Policies

- **Named Profiles First**: Call \`ssh_list_profiles\` first to check for existing profiles in \`~/.sshctl/profiles.json\`. Avoid asking the user for plain passwords.
- **Probe Connection**: Before running long multi-step remote jobs, run \`ssh_test_connection\` to confirm connectivity, credentials, and target OS.
- **Windows PowerShell**: Commands targeting Windows are automatically encoded as Base64 UTF-16LE (\`-EncodedCommand\`). You do not need to manually escape quotes.
- **Windows GUI Apps (Session 0 Bypass)**: Set \`desktop: true\` on \`ssh_exec\` to launch GUI applications interactively on the user's active desktop (Session 1) instead of running invisibly in Session 0.
- **SFTP File Transfers**: Use \`ssh_upload_file\` and \`ssh_download_file\` for moving logs, archives, and binaries instead of piping heavy Base64 strings over stdout.
`;

  fs.writeFileSync(path.join(targetDir, 'instructions.md'), instructions);
  console.log(`Generated schemas and instructions in ${targetDir}`);
}
