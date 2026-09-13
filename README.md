# sshctl

A unified CLI and Model Context Protocol (MCP) server for cross-platform SSH remote execution, passwordless key management, Windows Session 0 interactive desktop process launching, and SFTP file transfers.

---

## Architecture

```
Terminal / Human (CLI)             AI Agent (Claude / Antigravity)
       │                                         │
       ▼                                         ▼
  sshctl (bin/sshctl.js)               MCP Protocol (stdio JSON-RPC)
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

## Features

- **Dual-Mode**: Run interactively via CLI (`sshctl`) or as an automated MCP server (`sshctl mcp`).
- **Zero Local Client Shell Dependencies**: Pure TypeScript with `ssh2`. Does not require WSL, Git Bash, `sshpass`, `iconv`, or local `ssh` binaries.
- **Automated PowerShell Command Encoding**: Converts Windows command bodies to Base64 UTF-16LE strings (`powershell.exe -EncodedCommand`), removing quote escaping errors.
- **Session 0 Desktop Handoff (`--desktop`)**: Launches Windows GUI applications directly onto the logged-in user's interactive desktop (Session 1) via Task Scheduler.
- **8,191-Character Auto-Fallback**: Automatically detects when PowerShell payloads exceed the `cmd.exe` command length limit, uploading a temporary script via SFTP with execution and cleanup.
- **Connection Pooling**: Reuses SSH2 connections per `user@host:port` with 60-second idle timeouts.
- **Profiles & Secret Resolution**: Store targets in `~/.sshctl/profiles.json`, resolving environment variables (`env:VAR_NAME`) without storing plain text passwords in chat logs.

---

## Quick Start

### 1. Build

```bash
git clone https://github.com/nguyenvanhuy0612/sshctl.git
cd sshctl
npm install
npm run build
npm test        # 50 unit and integration tests (100% pass)
```

### 2. CLI Usage

```bash
# List profiles
sshctl profiles

# Test connectivity and probe remote OS
sshctl test my-profile

# Run remote command
sshctl exec my-profile "hostname && dir"

# Launch GUI app on Windows active desktop
sshctl exec my-profile "calc.exe" --desktop

# Upload/Download files via SFTP
sshctl push my-profile local.txt /remote/path/file.txt
sshctl pull my-profile /remote/path/file.txt local.txt

# Generate Windows OpenSSH installer 1-liner
sshctl bootstrap-rdp --admin
```

### 3. Register as MCP Server

`sshctl` implements the standard [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Any MCP client automatically discovers all tools, arguments, and prompts over stdio JSON-RPC without needing external configuration files.

#### Claude Code CLI
```bash
claude mcp add sshctl -- node "/path/to/sshctl/dist/index.js"
```

#### Claude Desktop (`claude_desktop_config.json`) / Cursor (`~/.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "sshctl": {
      "command": "node",
      "args": ["/path/to/sshctl/dist/index.js"]
    }
  }
}
```

#### Google Antigravity
To enable Antigravity's lazy-loading schema discovery:
```bash
npm run export:schemas
```
This automatically writes tool definition JSONs and `instructions.md` to `~/.gemini/antigravity/mcp/sshctl/`.

---

## MCP Tools Reference

* **`ssh_list_profiles`**: List profiles from `~/.sshctl/profiles.json`.
* **`ssh_test_connection`**: Probe SSH connectivity & detect target OS.
* **`ssh_clear_known_hosts`**: Clear stale entries from `~/.ssh/known_hosts`.
* **`ssh_exec`**: Execute remote commands with Base64 UTF-16LE, Session 0 bypass (`desktop: true`), and output capping.
* **`ssh_setup_passwordless`**: Deploy `ed25519` key to Linux (`~/.ssh/authorized_keys`) or Windows (`administrators_authorized_keys` with strict ACLs).
* **`ssh_remove_passwordless`**: Revoke public key or clear all keys.
* **`ssh_upload_file`**: Upload file via SFTP.
* **`ssh_download_file`**: Download file via SFTP.
* **`ssh_generate_rdp_bootstrap`**: Generate OpenSSH installation 1-liner.

---

## Technical Documentation

* **[docs/TOOLS.md](docs/TOOLS.md)**: Full parameter matrix, tool annotations/hints, and AI Agent workflows.
* **[docs/REFERENCE.md](docs/REFERENCE.md)**: Deep dive into PowerShell Base64 encoding, the 8,191-character boundary fallback, Windows Session 0 bypass mechanism, and error code tables.

---

## License

[MIT](LICENSE) © 2026 Nguyen Van Huy
