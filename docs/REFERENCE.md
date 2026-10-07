# sshctl Technical Reference

A comprehensive reference for `sshctl` (Architecture, Windows Session 0, PowerShell Base64 encoding, SFTP fallback, connection pooling, and error codes).

---

## Architecture

```
User / Terminal                      Agent (Claude / Antigravity)
       │                                         │
       ▼                                         ▼
   sshctl CLI (bin/sshctl.js)          MCP Protocol (stdio JSON-RPC)
       │                                         │
       └──────────────────┬──────────────────────┘
                          ▼
                   Core SSH Engine
              (src/core/ssh-client.ts)
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

## Operating System Matrix

| Feature | Windows (Win32-OpenSSH) | Linux (OpenSSH) | macOS (Remote Login) |
| :--- | :--- | :--- | :--- |
| **Default Shell** | PowerShell (via `-EncodedCommand`) | `bash` / default user shell | `zsh` / `bash` |
| **Command Encoding** | Base64 UTF-16LE | Raw string | Raw string |
| **Command Limit** | 8,191 chars (`cmd.exe` wall) -> Auto SFTP fallback | OS `ARG_MAX` (>2MB) | OS `ARG_MAX` (>2MB) |
| **Interactive GUI (`desktop: true`)** | Supported (Task Scheduler Session 1) | N/A (X11 / Wayland) | N/A |
| **Key Location (Admin)** | `C:\ProgramData\ssh\administrators_authorized_keys` | `~/.ssh/authorized_keys` | `~/.ssh/authorized_keys` |
| **Key Location (Non-Admin)** | `~/.ssh/authorized_keys` | `~/.ssh/authorized_keys` | `~/.ssh/authorized_keys` |
| **Key Permissions (ACL)** | `SYSTEM:F`, `Administrators:F` (`icacls`) | `chmod 600` | `chmod 600` |

---

## Windows Edge Cases Solved

### 1. PowerShell Quote Escaping (`-EncodedCommand`)
* **Problem**: Passing complex commands or script blocks to `powershell -Command "..."` frequently breaks when nested quotes (`"` or `'`), special characters (`$`, `&`, `|`), or comment symbols (`#`) are involved.
* **Solution**: `sshctl` converts all script bodies into Base64 UTF-16LE buffers and invokes:
  ```bash
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <Base64>
  ```

### 2. The 8,191-Character Command Line Boundary
* **Problem**: When the Base64 payload exceeds ~8,000 characters, `cmd.exe` (the default Windows shell wrapper) silently rejects or truncates the command.
* **Solution**: `sshctl` automatically detects payload size before execution. If it exceeds 8,000 characters:
  1. Uploads the script as a temporary file (`.sshctl-tmp/sshctl_<timestamp>.ps1`) with UTF-8 BOM over SFTP into the user's home directory.
  2. Executes `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`.
  3. Deletes the temporary script in a `finally` block.

### 3. Session 0 Isolation Bypass (`desktop: true`)
* **Problem**: Remote commands executed over Win32-OpenSSH run in non-interactive Session 0. Any GUI application (e.g. `notepad.exe`, automated test tools) runs in the background and is invisible to the logged-in user.
* **Solution**: When `desktop: true` (or `--desktop` CLI option) is supplied, `sshctl`:
  1. Queries the active `explorer.exe` process to identify the logged-in desktop user.
  2. Registers a temporary Windows Scheduled Task under that user's identity with `LogonType Interactive` (`RunLevel Highest`).
  3. Triggers the task to spawn the process into Session 1 (User Desktop) and unregisters the task immediately.

### 4. PowerShell CLIXML Progress Suppression
* **Problem**: In non-interactive SSH sessions, PowerShell serializes progress records (like `Preparing modules for first use.`) into `#< CLIXML` blocks and pushes them to `stderr`, confusing AI agents and polluting logs.
* **Solution**: `sshctl`:
  1. Injects `$ProgressPreference = 'SilentlyContinue'` into PowerShell command wrappers.
  2. Runs `cleanClixml` on `stderr` to strip out pure progress noise while decoding real PowerShell errors cleanly.

---

## Output Token Optimization & Smart Windowing

To prevent massive command outputs (such as directory listings, test suites, or large build logs) from overflowing the AI model's context window, `sshctl` implements smart output management:

1. **Smart Head + Tail Ring Buffer (`Capture`)**:
   * Instead of cutting off the tail (where build failures and stack traces live), `Capture` retains the first 35% (Head) and the last 65% (Tail) of output up to `maxOutputBytes` (default 32 KB).
2. **Line Windowing (`maxLines: 200`)**:
   * Multi-thousand-line outputs are automatically windowed into head context + middle omission notice + tail results.
3. **Targeted Log Extraction (`tail` & `head`)**:
   * Tools can pass `tail: 50` or `head: 30` to retrieve exact line slices.
4. **Clean Formatting (`compact: true`)**:
   * Collapses redundant empty lines, trims trailing whitespace, and suppresses empty `--- STDERR ---` blocks entirely.

---

## Connection Pooling & Resource Controls

* **Connection Reuse**: Connections are pooled by `user@host:port`.
* **Idle Timeout**: Pooled connections stay warm for 60 seconds of inactivity before gracefully closing.
* **Hard Execution Timeout**: Remote commands have a configurable hard timeout (default 60,000ms).
* **Output Capping**: Default `maxOutputBytes` is 32,000 bytes (~6,000–8,000 tokens) with smart head/tail ring buffering.

---

## Exit Codes & Diagnostics

| Exit Code | Meaning |
| :--- | :--- |
| `0` | Command succeeded. |
| `1` - `123` | Target process returned error. |
| `124` | Command timed out (following GNU `timeout` standard). Channel destroyed safely. |
| `128 + N` | Process terminated by Unix signal `N` (e.g. 137 = SIGKILL, 143 = SIGTERM). |
