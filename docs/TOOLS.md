# sshctl Tools Reference & Agent Guidance

Comprehensive specification of all 9 Model Context Protocol (MCP) tools provided by `sshctl`.

---

## Tool Overview Matrix

| Tool | Mode / Safety | Idempotent | Open World | Primary Use Case |
| :--- | :--- | :--- | :--- | :--- |
| `ssh_list_profiles` | Read-only | Yes | No | Discover saved connection profiles in `~/.sshctl/profiles.json` |
| `ssh_test_connection` | Read-only | Yes | Yes | Probe connectivity, verify credentials, and detect remote OS |
| `ssh_clear_known_hosts` | Destructive | Yes | No | Purge obsolete host keys from local `~/.ssh/known_hosts` |
| `ssh_exec` | Destructive | No | Yes | Run remote commands (PowerShell Base64, Session 0, SFTP fallback) |
| `ssh_setup_passwordless` | Write | Yes | Yes | Install Ed25519 key to Linux or Windows with correct ACLs |
| `ssh_remove_passwordless` | Destructive | Yes | Yes | Revoke Ed25519 key from remote `authorized_keys` |
| `ssh_upload_file` | Destructive | Yes | Yes | Transfer local file to remote host via SFTP |
| `ssh_download_file` | Read-only | Yes | Yes | Retrieve remote file to local host via SFTP |
| `ssh_generate_rdp_bootstrap` | Read-only | Yes | No | Generate Windows OpenSSH server installation one-liner |

---

## Detailed Tool Specifications

### 1. `ssh_list_profiles`

Reads and enumerates profiles saved in `~/.sshctl/profiles.json`. Secrets and passwords are never returned in plain text (returns `"(set)"` or `"(env:VAR)"`).

* **Annotations**: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`
* **Parameters**: None.
* **Agent Guidance**: Call this tool first before prompting the user for credentials or connection settings. If a profile exists for the target host, supply `profile: "<name>"` to subsequent tool calls.

---

### 2. `ssh_test_connection`

Probes SSH connectivity, authenticates, and determines the remote operating system (`windows`, `linux`, `mac`).

* **Annotations**: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`
* **Parameters**:
  * `profile` *(string, optional)*: Name of saved profile.
  * `host` *(string, optional)*: Target hostname or IP.
  * `port` *(number, optional, default 22)*: SSH port.
  * `username` *(string, optional)*: SSH username.
  * `password` *(string, optional)*: Plain text password or secret indirection.
  * `privateKeyPath` *(string, optional)*: Local private key path.
  * `passphrase` *(string, optional)*: Private key passphrase.
  * `timeoutMs` *(number, optional, default 10000)*: Connection probe timeout.
* **Agent Guidance**: Always call this prior to multi-step deployment or automation tasks to fail early if credentials or host reachability are invalid.

---

### 3. `ssh_clear_known_hosts`

Executes `ssh-keygen -R` locally to remove stale entries when remote host fingerprints change (e.g. after VM rebuilds).

* **Annotations**: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false`
* **Parameters**:
  * `host` *(string, required)*: Hostname or IP to remove.
  * `port` *(number, optional, default 22)*: SSH port for bracketed `[host]:port` syntax.
* **Agent Guidance**: Use when connection fails with host key verification errors.

---

### 4. `ssh_exec`

The core remote execution tool. Features automated Base64 UTF-16LE encoding for PowerShell on Windows, automatic fallback to SFTP script upload when commands exceed 8,191 characters, Session 0 desktop launcher, and token-optimized head/tail windowing.

* **Annotations**: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`
* **Parameters**:
  * `command` *(string, required)*: The command line or script body to execute remotely.
  * `profile` *(string, optional)*: Saved profile name.
  * `host`, `port`, `username`, `password`, `privateKeyPath`, `passphrase`: Connection parameters (if not using profile).
  * `targetOs` *(enum: `auto`, `windows`, `linux`, `mac`, default `auto`)*: Target OS override.
  * `desktop` *(boolean, optional, default false)*: Windows only. Bypasses Session 0 by launching the application interactively inside the logged-in user desktop (Session 1).
  * `stdin` *(string, optional)*: Input piped to standard input before EOF.
  * `timeoutMs` *(number, optional, default 60000)*: Hard execution timeout.
  * `maxOutputBytes` *(number, optional, default 32000)*: Cap for captured stdout/stderr buffer.
  * `maxLines` *(number, optional, default 200)*: Max output lines before windowing.
  * `tail` *(number, optional)*: Return only the last N lines of output (optimal for build/test logs).
  * `head` *(number, optional)*: Return only the first N lines of output.
  * `compact` *(boolean, optional, default true)*: Collapses blank lines and trims whitespace.

---

### 5. `ssh_setup_passwordless`

Deploys a local Ed25519 public key onto the remote machine. On Windows, detects administrative users and installs to `C:\ProgramData\ssh\administrators_authorized_keys` with strict `icacls` permissions. On Linux/macOS, deploys to `~/.ssh/authorized_keys` with `chmod 600`.

* **Annotations**: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`
* **Parameters**:
  * `publicKey` *(string, required)*: The OpenSSH public key string (e.g. `ssh-ed25519 AAAAC3... user@host`).
  * Target parameters (`profile`, `host`, `username`, credentials).

---

### 6. `ssh_remove_passwordless`

Removes a specific public key or wipes the `authorized_keys` file on the remote host.

* **Annotations**: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`
* **Parameters**:
  * `publicKey` *(string, optional)*: Key to remove. If omitted and `all: true`, revokes all keys.
  * `all` *(boolean, optional, default false)*: Wipe all authorized keys.
  * Target connection parameters.

---

### 7. `ssh_upload_file`

Transfers a local file to the remote host using an optimized SFTP channel (`FastPut`).

* **Annotations**: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`
* **Parameters**:
  * `localPath` *(string, required)*: Absolute or relative local path.
  * `remotePath` *(string, required)*: Remote destination path (Windows drive path `C:\...` or Unix path).
  * Target connection parameters.

---

### 8. `ssh_download_file`

Downloads a remote file to the local host using an optimized SFTP channel (`FastGet`).

* **Annotations**: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`
* **Parameters**:
  * `remotePath` *(string, required)*: Remote source path.
  * `localPath` *(string, required)*: Local destination path.
  * Target connection parameters.

---

### 9. `ssh_generate_rdp_bootstrap`

Generates a standalone PowerShell one-liner that downloads, installs, configures, and starts Win32-OpenSSH server on a fresh Windows system.

* **Annotations**: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`
* **Parameters**:
  * `port` *(number, optional, default 22)*: SSH port to configure in `sshd_config`.
  * `allowAdminKey` *(boolean, optional, default true)*: Enable administrator key file support.

---

## Recommended AI Agent Workflow

When executing automated tasks on remote infrastructure, agents should follow this standard cycle:

1. **Discovery**: Call `ssh_list_profiles` to verify existing targets and avoid prompting for passwords.
2. **Pre-flight Check**: Run `ssh_test_connection` to ensure target host is reachable and identify operating system.
3. **Execution**:
   * For short/medium commands: Use `ssh_exec`.
   * For long-running builds or tests: Supply `tail: 50` or `maxLines: 100` to prevent context token overflow.
   * For Windows GUI tools: Set `desktop: true` so the process runs in Session 1 where users can see it.
4. **File Operations**: For files larger than a few kilobytes, always use `ssh_upload_file` / `ssh_download_file` instead of echoing or catting Base64 over `ssh_exec`.
