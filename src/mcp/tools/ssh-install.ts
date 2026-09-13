import { z } from 'zod';
import { getRdpBootstrapOneLiner } from './ssh-connect.js';

export const sshGenerateRdpBootstrapSchema = {
  host: z.string().optional().describe('Target host IP or hostname'),
  userType: z.enum(['admin', 'user']).optional().default('admin').describe('Type of Windows user logged into RDP: admin (Elevated PowerShell) or user (Standard PowerShell triggering UAC)'),
};

export async function handleSshGenerateRdpBootstrap(args: z.infer<z.ZodObject<typeof sshGenerateRdpBootstrapSchema>>) {
  const isUser = args.userType === 'user';

  let script: string;
  if (isUser) {
    script = `Start-Process powershell -Verb RunAs -Wait -Args @('-NoP','-ep','Bypass','-c','$t=$env:TEMP;iwr https://github.com/PowerShell/Win32-OpenSSH/releases/latest/download/OpenSSH-Win64.zip -Out $t\\s.zip;Expand-Archive $t\\s.zip $t -Force;$d=ls $t -d|?{$_.Name-like''OpenSSH*''}|select -f 1;cp $d.FullName C:\\ -r -Force;if($d.Name-ne''OpenSSH-Win64''){ren C:\\$($d.Name) OpenSSH-Win64};powershell -ep Bypass -NonI -File C:\\OpenSSH-Win64\\install-sshd.ps1;Set-Service sshd,ssh-agent -StartupType Automatic;Start-Service ssh-agent,sshd;netsh advfirewall firewall add rule name=sshd protocol=TCP dir=in localport=22 action=allow|Out-Null;$f=''C:\\ProgramData\\ssh\\administrators_authorized_keys'';if(!(Test-Path $f)){ni $f -Force};icacls $f /inheritance:r /grant ''SYSTEM:(F)'' /grant ''Administrators:(F)''|Out-Null')`;
  } else {
    script = getRdpBootstrapOneLiner();
  }

  const instructions = `
==================================================
ONE-TIME RDP BOOTSTRAP POWERSHELL SCRIPT (${args.userType.toUpperCase()})
==================================================
Target Machine: ${args.host || 'Windows Host'}

Copy and paste the following 1-liner into PowerShell on the RDP desktop:

${script}

What this script accomplishes in ~10 seconds:
1. Downloads & installs official Win32-OpenSSH to C:\\OpenSSH-Win64
2. Configures sshd & ssh-agent services to auto-start with Windows
3. Opens TCP Port 22 on Windows Firewall
4. Initializes C:\\ProgramData\\ssh\\administrators_authorized_keys with strict ACLs
`;

  return {
    content: [{ type: 'text', text: instructions.trim() }],
  };
}
