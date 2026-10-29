// Stable entry shared by Codex, Claude Code and rcode-cli.
import { main } from './v2/start.mjs';

await main().catch(error => {
  const code = /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'startup_failed';
  console.error(`[shared-memory] ${code}`);
  process.exitCode = 1;
});
