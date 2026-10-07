#!/usr/bin/env node

export * from './core/index.js';
export * from './mcp/server.js';

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startServer } from './mcp/server.js';

function isMainEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = path.resolve(process.argv[1]);
    const thisPath = fileURLToPath(import.meta.url);

    const s = scriptPath.toLowerCase();
    const t = thisPath.toLowerCase();

    if (s === t) return true;
    if (s + '.js' === t || s + '.ts' === t) return true;
    if (path.join(s, 'dist', 'index.js').toLowerCase() === t) return true;
    if (path.join(s, 'src', 'index.ts').toLowerCase() === t) return true;

    const distTarget = path.join('dist', 'index.js').toLowerCase();
    const srcTarget = path.join('src', 'index.ts').toLowerCase();
    const distBare = path.join('dist', 'index').toLowerCase();
    const srcBare = path.join('src', 'index').toLowerCase();

    return s.endsWith(distTarget) || s.endsWith(srcTarget) || s.endsWith(distBare) || s.endsWith(srcBare);
  } catch {
    return false;
  }
}

const isMain = isMainEntry();

if (isMain) {
  startServer().catch((error) => {
    console.error('[sshctl] Fatal Server Error:', error);
    process.exit(1);
  });
}
