import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { helperFor, targetLabel, targetSchema, textResult } from './common.js';
import { expandHome } from '../../core/profiles.js';

/** SFTP wants forward slashes even on Windows targets; C:\a\b has to become C:/a/b. */
function toSftpPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Create a remote directory and every missing ancestor.
 *
 * SFTP mkdir is one level only, so a single call fails as soon as a grandparent is missing.
 * Each level is attempted and its error ignored, since "already exists" and "cannot create" are
 * indistinguishable here; the transfer itself is the real test.
 */
async function ensureRemoteDir(
  sftp: { mkdir: (p: string, cb: (err?: unknown) => void) => void },
  dir: string
): Promise<void> {
  if (!dir || dir === '.' || dir === '/') return;

  const absolute = dir.startsWith('/');
  const parts = dir.split('/').filter(Boolean);
  let current = absolute ? '' : '';

  for (const part of parts) {
    current = current === '' ? (absolute ? `/${part}` : part) : `${current}/${part}`;
    await new Promise<void>((resolve) => sftp.mkdir(current, () => resolve()));
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const sshUploadSchema = {
  ...targetSchema,
  localPath: z.string().describe('Local file path to upload'),
  remotePath: z.string().describe('Remote target destination path'),
};

export async function handleSshUpload(args: z.infer<z.ZodObject<typeof sshUploadSchema>>) {
  const localPath = expandHome(args.localPath);
  if (!fs.existsSync(localPath)) {
    return textResult(`Local file does not exist: ${localPath}`, true);
  }
  const stat = fs.statSync(localPath);
  if (stat.isDirectory()) {
    return textResult(
      `${localPath} is a directory. This tool transfers single files; archive the directory first.`,
      true
    );
  }

  const { helper, target } = helperFor(args);
  const remotePath = toSftpPath(args.remotePath);

  try {
    await helper.withClient(async (conn) => {
      const sftp = await helper.getSftp(conn.client);
      try {
        // Create the remote parent directory. Download already did this for the local side;
        // upload used to fail outright when the destination directory did not exist.
        await ensureRemoteDir(sftp, path.posix.dirname(remotePath));

        await new Promise<void>((resolve, reject) => {
          sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()));
        });
      } finally {
        sftp.end();
      }
    });

    return textResult(
      [
        `Uploaded to ${targetLabel(target)}.`,
        `Local:  ${localPath} (${formatBytes(stat.size)})`,
        `Remote: ${remotePath}`,
      ].join('\n')
    );
  } catch (err: any) {
    return textResult(`Upload failed: ${err.message || String(err)}`, true);
  }
}

export const sshDownloadSchema = {
  ...targetSchema,
  remotePath: z.string().describe('Remote file path to download'),
  localPath: z.string().describe('Local destination path'),
};

export async function handleSshDownload(args: z.infer<z.ZodObject<typeof sshDownloadSchema>>) {
  const { helper, target } = helperFor(args);
  const localPath = expandHome(args.localPath);
  const remotePath = toSftpPath(args.remotePath);

  try {
    await helper.withClient(async (conn) => {
      const sftp = await helper.getSftp(conn.client);
      try {
        const parentDir = path.dirname(localPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        await new Promise<void>((resolve, reject) => {
          sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()));
        });
      } finally {
        sftp.end();
      }
    });

    const size = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
    return textResult(
      [
        `Downloaded from ${targetLabel(target)}.`,
        `Remote: ${remotePath}`,
        `Local:  ${localPath} (${formatBytes(size)})`,
      ].join('\n')
    );
  } catch (err: any) {
    return textResult(`Download failed: ${err.message || String(err)}`, true);
  }
}
