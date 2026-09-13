import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

// Tools
import {
  sshTestConnectionSchema,
  handleSshTestConnection,
  sshClearKnownHostsSchema,
  handleSshClearKnownHosts,
  sshListProfilesSchema,
  handleSshListProfiles,
} from './tools/ssh-connect.js';

import { sshExecSchema, handleSshExec } from './tools/ssh-exec.js';
import {
  sshPasswordlessSchema,
  handleSshSetupPasswordless,
  sshRemovePasswordlessSchema,
  handleSshRemovePasswordless,
} from './tools/ssh-passwordless.js';
import { sshUploadSchema, handleSshUpload, sshDownloadSchema, handleSshDownload } from './tools/ssh-transfer.js';
import { sshGenerateRdpBootstrapSchema, handleSshGenerateRdpBootstrap } from './tools/ssh-install.js';

// Prompts
import { SSH_TROUBLESHOOT_PROMPT, SSH_DESKTOP_GUIDE_PROMPT } from './prompts/index.js';

export function createServer(): Server {
  const server = new Server(
    {
      name: 'sshctl',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    }
  );

  // Register Tools Schema
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'ssh_list_profiles',
          description:
            'List saved connection profiles from ~/.sshctl/profiles.json. Never returns secrets. Call this first to find a profile name instead of asking the user for a password.',
          inputSchema: zodToJsonSchema(z.object(sshListProfilesSchema)) as any,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: 'ssh_test_connection',
          description: 'Test SSH connection & probe target OS. Reports whether the failure was unreachable host or rejected credentials.',
          inputSchema: zodToJsonSchema(z.object(sshTestConnectionSchema)) as any,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: 'ssh_clear_known_hosts',
          description: 'Remove stale/changed host entries from local ~/.ssh/known_hosts via ssh-keygen -R, handling hashed entries and [host]:port form.',
          inputSchema: zodToJsonSchema(z.object(sshClearKnownHostsSchema)) as any,
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: 'ssh_exec',
          description: 'Execute remote commands over SSH. Handles Base64 UTF-16LE PowerShell encoding, Session 0 bypass (desktop: true), the 8191 char command limit, and enforces a timeout and an output size cap.',
          inputSchema: zodToJsonSchema(z.object(sshExecSchema)) as any,
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        {
          name: 'ssh_setup_passwordless',
          description: 'Deploy ed25519 public key to Linux (~/.ssh/authorized_keys) or Windows (administrators_authorized_keys with ACLs) and verify key login.',
          inputSchema: zodToJsonSchema(z.object(sshPasswordlessSchema)) as any,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: 'ssh_remove_passwordless',
          description: 'Remove public key entry or clear ALL keys from authorized_keys on remote host, revoking passwordless SSH login.',
          inputSchema: zodToJsonSchema(z.object(sshRemovePasswordlessSchema)) as any,
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
          inputSchema: zodToJsonSchema(z.object(sshUploadSchema)) as any,
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
          inputSchema: zodToJsonSchema(z.object(sshDownloadSchema)) as any,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: 'ssh_generate_rdp_bootstrap',
          description: 'Generate 1-liner PowerShell script to copy-paste into an RDP session to install OpenSSH server on Windows target.',
          inputSchema: zodToJsonSchema(z.object(sshGenerateRdpBootstrapSchema)) as any,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ],
    };
  });

  // Handle Tool Executions
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'ssh_list_profiles':
          return await handleSshListProfiles();
        case 'ssh_test_connection':
          return await handleSshTestConnection(z.object(sshTestConnectionSchema).parse(args));
        case 'ssh_clear_known_hosts':
          return await handleSshClearKnownHosts(z.object(sshClearKnownHostsSchema).parse(args));
        case 'ssh_exec':
          return await handleSshExec(z.object(sshExecSchema).parse(args));
        case 'ssh_setup_passwordless':
          return await handleSshSetupPasswordless(z.object(sshPasswordlessSchema).parse(args));
        case 'ssh_remove_passwordless':
          return await handleSshRemovePasswordless(z.object(sshRemovePasswordlessSchema).parse(args));
        case 'ssh_upload_file':
          return await handleSshUpload(z.object(sshUploadSchema).parse(args));
        case 'ssh_download_file':
          return await handleSshDownload(z.object(sshDownloadSchema).parse(args));
        case 'ssh_generate_rdp_bootstrap':
          return await handleSshGenerateRdpBootstrap(z.object(sshGenerateRdpBootstrapSchema).parse(args));
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Tool Error [${name}]: ${error.message || String(error)}` }],
        isError: true,
      };
    }
  });

  // Register Prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [SSH_TROUBLESHOOT_PROMPT, SSH_DESKTOP_GUIDE_PROMPT],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'ssh-troubleshoot') {
      const host = args?.host || '<host>';
      const user = args?.user || '<user>';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please help me troubleshoot my SSH connection to ${user}@${host}. What diagnostic steps and tools should we run?`,
            },
          },
        ],
      };
    }

    if (name === 'ssh-desktop-guide') {
      const app = args?.application || 'notepad.exe';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `How do I properly launch ${app} interactively on a remote Windows host desktop using sshctl, bypassing Session 0 isolation?`,
            },
          },
        ],
      };
    }

    throw new Error(`Prompt not found: ${name}`);
  });

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[sshctl] MCP Server running on stdio');
}
