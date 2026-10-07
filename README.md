# sshctl-mcp

[![npm version](https://img.shields.io/npm/v/sshctl-mcp.svg)](https://www.npmjs.com/package/sshctl-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-purple.svg)](https://modelcontextprotocol.io)

Cross-platform SSH remote execution engine, passwordless key manager, Windows Session 0 desktop launcher, SFTP client, and Model Context Protocol (MCP) server for AI coding agents.

---

## Architecture

```
Terminal / Human (CLI)             AI Agent (Claude / Antigravity / Cursor)
       │                                         │
       ▼                                         ▼
   sshctl (CLI binary)                  MCP Protocol (stdio JSON-RPC)
       │                                         │
       └──────────────────┬──────────────────────┘
                          ▼
                   Core SSH Engine
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   Connection Pool    PowerShell/UTF-16LE   SFTP Channel
   (60s idle reuse)   (Session 0 / 8K limit) (FastPut / FastGet)
          │               │               │
          └───────────────┼───────────────┘
                          ▼
                  Remote Target Host
            (Windows / Linux / macOS)
```

---

## Key Capabilities

- **Zero Local Client Shell Dependencies**: Pure TypeScript built on `ssh2`. Executes uniformly across Windows (cmd, PowerShell), macOS, and Linux without requiring OpenSSH client binaries, WSL, Git Bash, `sshpass`, or `iconv`.
- **Native Windows Host Engineering**: Automatically encodes Windows PowerShell commands into Base64 UTF-16LE (`powershell.exe -EncodedCommand`) to eliminate quote escaping bugs. Automatically falls back to SFTP script upload when command payloads exceed `cmd.exe`'s 8,191-character boundary limit.
- **Windows Session 0 Desktop Handoff (`--desktop` / `desktop: true`)**: Solves the classic limitation where SSH-spawned GUI processes run invisibly in Session 0. Automatically hands off GUI processes to the active user's interactive desktop (Session 1) via Task Scheduler.
- **AI Agent Native (MCP Protocol)**: Exposes 9 first-class tools with rich parameter metadata, annotations (`readOnlyHint`, `idempotentHint`), token-efficient smart output capping (`head`/`tail`/`compact`), and prompt templates.
- **Transport Connection Pooling**: Reuses underlying SSH2 connections per `user@host:port` with a 60-second idle timeout, eliminating handshake latency across multi-step agent workflows.
- **Secure Profile Management**: Store targets in `~/.sshctl/profiles.json` with environment variable indirection (`env:VAR_NAME`) so secret passwords are never leaked into agent conversation transcripts.

---

## Installation & Setup

### As an MCP Server (Recommended)

No manual clone or build required. You can run `sshctl-mcp` directly via `npx`.

#### 1. Claude Code CLI
```bash
claude mcp add sshctl -- npx -y sshctl-mcp
```

#### 2. Claude Desktop (`claude_desktop_config.json`)
Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):
```json
{
  "mcpServers": {
    "sshctl": {
      "command": "npx",
      "args": ["-y", "sshctl-mcp"]
    }
  }
}
```

#### 3. Cursor / Windsurf / Cline (`mcp.json`)
```json
{
  "mcpServers": {
    "sshctl": {
      "command": "npx",
      "args": ["-y", "sshctl-mcp"]
    }
  }
}
```

#### 4. Google Antigravity
Add to `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "sshctl": {
      "command": "npx",
      "args": ["-y", "sshctl-mcp"]
    }
  }
}
```
For Antigravity lazy-loading tool schemas, run `npm run export:schemas` from a local clone.

---

### As a Global CLI Tool

Install globally via npm:
```bash
npm install -g sshctl-mcp
```
Once installed, both `sshctl` and `sshctl-mcp` commands are available globally.

Alternatively, execute one-off commands without installing:
```bash
npx sshctl-mcp --help
```

---

### From Source (Development)

```bash
git clone https://github.com/nguyenvanhuy0612/sshctl.git
cd sshctl
npm install
npm test        # 50 unit and integration tests (100% pass)
npm run build
```

---

## Connection Profiles (`~/.sshctl/profiles.json`)

To avoid specifying credentials on every command or leaking passwords into agent conversation transcripts, define named profiles in `~/.sshctl/profiles.json`:

```json
{
  "win-host": {
    "host": "192.168.1.100",
    "port": 22,
    "username": "Administrator",
    "privateKeyPath": "~/.ssh/id_ed25519",
    "targetOs": "windows",
    "description": "Windows QA workstation"
  },
  "linux-box": {
    "host": "10.0.0.15",
    "port": 22,
    "username": "deploy",
    "password": "env:DEPLOY_PASSWORD",
    "targetOs": "linux",
    "description": "Linux CI runner"
  }
}
```

* Values prefixed with `env:` are resolved dynamically from process environment variables at runtime.
* Ensure profile permissions are restricted: `chmod 600 ~/.sshctl/profiles.json`.

---

## CLI Command Reference

```bash
# List configured profiles
sshctl profiles

# Probe connectivity, target OS, and authentication
sshctl test win-host

# Execute remote command
sshctl exec win-host "Get-Process | Select-Object -First 10"

# Launch GUI app interactively on active Windows desktop (Session 1 bypass)
sshctl exec win-host "notepad.exe" --desktop

# Transfer files via SFTP
sshctl push win-host ./local-package.zip C:/Deploy/package.zip
sshctl pull win-host C:/Deploy/output.log ./output.log

# Generate Windows OpenSSH Server 1-liner bootstrap for RDP
sshctl bootstrap-rdp --admin

# Clear stale or changed host key from known_hosts
sshctl clear-hosts 192.168.1.100

# Start stdio MCP JSON-RPC server manually
sshctl mcp
```

---

## MCP Tools Reference

| Tool | Read-Only | Description |
| :--- | :---: | :--- |
| `ssh_list_profiles` | Yes | List saved connection profiles from `~/.sshctl/profiles.json` without exposing secret credentials. |
| `ssh_test_connection` | Yes | Probe connectivity, detect remote OS (`windows`, `linux`, `mac`), and check auth methods. |
| `ssh_clear_known_hosts` | No | Remove stale host entries from `~/.ssh/known_hosts` via `ssh-keygen -R` with hashed and port support. |
| `ssh_exec` | No | Execute remote command with Base64 UTF-16LE encoding, 8K boundary fallback, and optional Session 1 GUI bypass. |
| `ssh_setup_passwordless` | No | Generate local `ed25519` key (if missing) and install to target with strict ACLs for Windows or Linux. |
| `ssh_remove_passwordless` | No | Remove deployed public key from remote target with automatic backup file creation. |
| `ssh_upload_file` | No | Upload local file to remote destination over SFTP with automatic ancestor directory creation. |
| `ssh_download_file` | No | Download remote file to local destination over SFTP with parent directory creation. |
| `ssh_generate_rdp_bootstrap`| Yes | Generate a self-contained PowerShell one-liner to install and configure OpenSSH on Windows over RDP. |

---

## Technical Documentation

- **[docs/TOOLS.md](docs/TOOLS.md)**: Parameter matrices, tool annotations, hints, and AI agent workflow patterns.
- **[docs/REFERENCE.md](docs/REFERENCE.md)**: Deep architectural dive into PowerShell Base64 encoding, the 8,191-character boundary fallback, Windows Session 0 bypass mechanism, and exit code tables.

---

## License

[MIT](LICENSE) © 2026 Nguyen Van Huy
