#!/usr/bin/env node

export * from './core/index.js';
export * from './mcp/server.js';

import { startServer } from './mcp/server.js';

// If executed directly as a script / MCP server entrypoint
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('dist/index.js') ||
  process.argv[1]?.endsWith('src/index.ts');

if (isMain) {
  startServer().catch((error) => {
    console.error('[sshctl] Fatal Server Error:', error);
    process.exit(1);
  });
}
