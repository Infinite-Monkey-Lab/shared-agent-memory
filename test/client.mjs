import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function connect(memoryPath, protocolVersion = '2024-11-05', options = {}) {
  const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL(options.entry ?? '../start.mjs', import.meta.url))], {
    env: {
      ...globalThis.process.env,
      MEMORY_FILE_PATH: memoryPath,
      MEMORY_DB_PATH: path.join(path.dirname(memoryPath), `${path.basename(memoryPath)}.sqlite3`),
      MEMORY_EXPORT_PATH: path.join(path.dirname(memoryPath), 'exports', 'memory.md'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  process.stderr.on('data', chunk => { stderr += chunk; });
  let id = 0;
  const pending = new Map();
  const lines = createInterface({ input: process.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { throw new Error(`Non-JSON MCP stdout: ${line}`); }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  process.on('exit', code => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  function request(method, params = {}) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`MCP timeout: ${method}; ${stderr}`));
      }, 10_000);
      pending.set(requestId, { resolve, reject, timer });
      process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  }
  async function close() {
    if (process.exitCode !== null || process.signalCode !== null) return;
    const exited = once(process, 'exit');
    process.stdin.end();
    const timer = setTimeout(() => process.kill('SIGKILL'), 3000);
    const [code, signal] = await exited;
    clearTimeout(timer);
    if (code !== 0 || signal) throw new Error(`Unclean MCP shutdown: ${code}/${signal}; ${stderr}`);
  }
  try {
    await request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'shared-memory-test', version: '1' } });
    process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  } catch (error) {
    process.kill();
    throw error;
  }
  return {
    request, close,
    async call(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(JSON.stringify(result.content));
      return result;
    },
  };
}

export function graph(result) {
  return result.structuredContent ?? JSON.parse(result.content.find(block => block.type === 'text').text);
}
