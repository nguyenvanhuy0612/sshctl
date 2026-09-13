/**
 * Builders for the authorized_keys deployment and removal scripts.
 *
 * These are pure string functions so the unit tests can assert their shape without a server.
 * That matters here specifically: the original Windows deployment script was flattened with
 * `.replace(/\n/g, ' ')` before being interpolated into `powershell -Command "..."`, which put
 * `icacls`, `Restart-Service` and the success marker behind a `#` comment on a single line, so
 * the ACLs sshd requires were never applied and the failure was invisible. Newlines are load
 * bearing; the tests pin that down.
 */

import { psSingleQuote, shSingleQuote } from './ps.js';

export const DEPLOY_MARKER = 'SSHCTL_DEPLOY_OK';
export const REMOVE_MARKER = 'SSHCTL_REMOVE_OK';

/**
 * Windows key deployment.
 *
 * Picks the authorized-keys file the way sshd does: members of the built-in Administrators
 * group authenticate against C:\ProgramData\ssh\administrators_authorized_keys, everyone else
 * against their own profile. Group membership is checked, not elevation, because an SSH session
 * is not elevated even when the account is an administrator.
 *
 * There is deliberately no `Restart-Service sshd` here. sshd reads authorized_keys at
 * authentication time, so a restart buys nothing, and restarting the service you are currently
 * connected through is a good way to drop your own session.
 */
export function buildWindowsDeployScript(publicKey: string): string {
  return `$ErrorActionPreference = 'Stop'
$key = ${psSingleQuote(publicKey)}

$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$adminSid = New-Object System.Security.Principal.SecurityIdentifier(
  [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
$inAdmins = $false
foreach ($g in $id.Groups) { if ($g -eq $adminSid) { $inAdmins = $true } }

if ($inAdmins) {
  $dir = Join-Path $env:ProgramData 'ssh'
  $file = Join-Path $dir 'administrators_authorized_keys'
} else {
  $dir = Join-Path $env:USERPROFILE '.ssh'
  $file = Join-Path $dir 'authorized_keys'
}

if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
if (-not (Test-Path -LiteralPath $file)) { New-Item -ItemType File -Path $file -Force | Out-Null }

$already = $false
foreach ($line in @(Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)) {
  if ($line.Trim() -eq $key) { $already = $true }
}
if (-not $already) { Add-Content -LiteralPath $file -Value $key -Encoding ASCII }

# sshd rejects an authorized_keys file that any other account can write to.
if ($inAdmins) {
  icacls $file /inheritance:r /grant 'SYSTEM:(F)' /grant 'Administrators:(F)' | Out-Null
} else {
  icacls $file /inheritance:r /grant 'SYSTEM:(F)' /grant ('{0}:(F)' -f $id.Name) | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE on $file" }

Write-Output ('${DEPLOY_MARKER} ' + $file + ' already=' + $already)
`;
}

/** Linux and macOS key deployment. */
export function buildUnixDeployScript(publicKey: string): string {
  return `set -e
umask 077
KEY=${shSingleQuote(publicKey)}
F="$HOME/.ssh/authorized_keys"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$F"
chmod 600 "$F"
if grep -qxF "$KEY" "$F" 2>/dev/null; then
  ALREADY=True
else
  printf '%s\\n' "$KEY" >> "$F"
  ALREADY=False
fi
echo "${DEPLOY_MARKER} $F already=$ALREADY"
`;
}

/**
 * Windows key removal. Backs the file up before rewriting it, and covers both the
 * administrators file and the per-user file so removal is not silently partial.
 */
export function buildWindowsRemoveScript(publicKey: string, removeAll: boolean): string {
  const matchClause = removeAll
    ? '$keep = @()'
    : `$keep = @($lines | Where-Object { $_.Trim() -ne $key -and $_.Trim().Length -gt 0 })`;

  return `$ErrorActionPreference = 'Stop'
$key = ${psSingleQuote(publicKey)}

$candidates = @(
  (Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'),
  (Join-Path $env:USERPROFILE '.ssh\\authorized_keys')
)

$touched = @()
foreach ($file in $candidates) {
  if (-not (Test-Path -LiteralPath $file)) { continue }
  Copy-Item -LiteralPath $file -Destination ($file + '.sshctl.bak') -Force
  $lines = @(Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)
  ${matchClause}
  Set-Content -LiteralPath $file -Value $keep -Encoding ASCII
  $touched += ('{0} ({1} -> {2} lines)' -f $file, $lines.Count, $keep.Count)
}

if ($touched.Count -eq 0) {
  Write-Output '${REMOVE_MARKER} no authorized_keys file found'
} else {
  Write-Output ('${REMOVE_MARKER} ' + ($touched -join '; '))
}
`;
}

/** Linux and macOS key removal. */
export function buildUnixRemoveScript(publicKey: string, removeAll: boolean): string {
  const body = removeAll
    ? `: > "$F"`
    : `KEY=${shSingleQuote(publicKey)}
grep -vxF "$KEY" "$F" > "$F.sshctl.tmp" || true
mv "$F.sshctl.tmp" "$F"`;

  return `set -e
F="$HOME/.ssh/authorized_keys"
if [ ! -f "$F" ]; then
  echo "${REMOVE_MARKER} no authorized_keys file found"
  exit 0
fi
cp "$F" "$F.sshctl.bak"
BEFORE=$(wc -l < "$F" | tr -d ' ')
${body}
chmod 600 "$F"
AFTER=$(wc -l < "$F" | tr -d ' ')
echo "${REMOVE_MARKER} $F ($BEFORE -> $AFTER lines, backup at $F.sshctl.bak)"
`;
}
