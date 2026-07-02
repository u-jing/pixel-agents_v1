#!/usr/bin/env node

/**
 * OpenRouter Agent Runner for Pixel Agents
 *
 * Runs an agentic loop powered by the OpenRouter API. Posts lifecycle events
 * to the pixel-agents server so the character animates in the pixel office.
 *
 * Usage:
 *   OPENROUTER_API_KEY=<key> node openrouter-agent.js [--session-id <uuid>] [--model <id>]
 *
 * Environment variables:
 *   OPENROUTER_API_KEY   Required. Your OpenRouter API key (sk-or-...).
 *   OPENROUTER_MODEL     Optional. Model to use (default: anthropic/claude-3.5-sonnet).
 */

import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

// ── Constants ──────────────────────────────────────────────────

const HOOK_API_PATH = '/api/hooks/openrouter';
const SERVER_JSON_PATH = path.join(os.homedir(), '.pixel-agents', 'server.json');
const OPENROUTER_CONFIG_PATH = path.join(os.homedir(), '.pixel-agents', 'openrouter.json');
const MAX_OUTPUT_LENGTH = 8_000;
const TOOL_TIMEOUT_MS = 30_000;
const MAX_GLOB_RESULTS = 100;
const MAX_GREP_RESULTS = 100;

// ── Types ──────────────────────────────────────────────────────

interface ServerConfig {
  port: number;
  token: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ChatResponseChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

interface ChatResponse {
  choices?: ChatResponseChoice[];
  error?: { message: string; code?: string };
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

// ── Arg parsing ───────────────────────────────────────────────

function parseArgs(): { sessionId: string; model: string } {
  const argv = process.argv.slice(2);
  let sessionId: string = randomUUID();
  let model = process.env['OPENROUTER_MODEL'] ?? 'anthropic/claude-3.5-sonnet';
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--session-id' || argv[i] === '-s') && argv[i + 1]) {
      sessionId = argv[++i];
    } else if ((argv[i] === '--model' || argv[i] === '-m') && argv[i + 1]) {
      model = argv[++i];
    }
  }
  return { sessionId, model };
}

// ── Pixel Agents HTTP ──────────────────────────────────────────

function postEvent(
  server: ServerConfig | null,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.port,
        path: HOOK_API_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${server.token}`,
        },
        timeout: 2_000,
      },
      (res) => {
        res.resume();
        resolve();
      },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

// ── OpenRouter API ─────────────────────────────────────────────

function callOpenRouter(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<ChatResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      ...(tools.length > 0 && { tools, tool_choice: 'auto' }),
    });

    const req = https.request(
      {
        hostname: 'openrouter.ai',
        port: 443,
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/pixel-agents-hq/pixel-agents',
          'X-Title': 'Pixel Agents',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: unknown) => {
          data += String(chunk);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as ChatResponse);
          } catch {
            reject(new Error(`Failed to parse OpenRouter response: ${data.slice(0, 300)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ── Tool definitions ──────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description:
        'Execute a shell command and return its output. Use for running tests, git operations, package management, etc.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to execute' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read the contents of a file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative path to the file' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write content to a file, creating parent directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to write to' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.js").',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match against' },
          path: { type: 'string', description: 'Base directory to search from (defaults to cwd)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search for a regex pattern across files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: {
            type: 'string',
            description: 'File or directory to search in (defaults to cwd)',
          },
          glob: {
            type: 'string',
            description: 'File glob filter, e.g. "*.ts" (only used when path is a directory)',
          },
        },
        required: ['pattern'],
      },
    },
  },
];

// ── Cross-platform file search ────────────────────────────────

function globFiles(pattern: string, baseDir: string): string[] {
  const results: string[] = [];
  const parts = pattern.replace(/\\/g, '/').split('/');

  function matchSegments(segIdx: number, fileParts: string[]): boolean {
    if (segIdx >= parts.length) return fileParts.length === 0;
    const seg = parts[segIdx];
    if (seg === '**') {
      for (let skip = 0; skip <= fileParts.length; skip++) {
        if (matchSegments(segIdx + 1, fileParts.slice(skip))) return true;
      }
      return false;
    }
    if (fileParts.length === 0) return false;
    const regexStr =
      '^' +
      seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '[^/]') +
      '$';
    return (
      new RegExp(regexStr).test(fileParts[0]) && matchSegments(segIdx + 1, fileParts.slice(1))
    );
  }

  function walk(dir: string, relParts: string[]): void {
    if (results.length >= MAX_GLOB_RESULTS) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const entryParts = [...relParts, entry.name];
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), entryParts);
        } else if (matchSegments(0, entryParts)) {
          results.push(path.join(dir, entry.name));
        }
      }
    } catch {
      /* skip unreadable dirs */
    }
  }

  walk(baseDir, []);
  return results;
}

function getAllFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    if (results.length >= 200) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else results.push(full);
      }
    } catch {
      /* skip unreadable */
    }
  }
  walk(dir);
  return results;
}

// ── Tool execution ────────────────────────────────────────────

function truncate(s: string): string {
  return s.length <= MAX_OUTPUT_LENGTH
    ? s
    : s.slice(0, MAX_OUTPUT_LENGTH) + `\n[...truncated ${s.length - MAX_OUTPUT_LENGTH} chars]`;
}

function executeTool(name: string, input: Record<string, unknown>): string {
  try {
    switch (name) {
      case 'Bash': {
        const cmd = String(input.command ?? '');
        const result = execSync(cmd, {
          encoding: 'utf-8',
          timeout: TOOL_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          cwd: process.cwd(),
        });
        return truncate(result || '(no output)');
      }

      case 'Read': {
        const p = String(input.file_path ?? '');
        return truncate(fs.readFileSync(p, 'utf-8'));
      }

      case 'Write': {
        const p = String(input.file_path ?? '');
        const content = String(input.content ?? '');
        const dir = path.dirname(p);
        if (dir && dir !== '.' && !fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(p, content, 'utf-8');
        return `Wrote ${content.length} bytes to ${p}`;
      }

      case 'Glob': {
        const pattern = String(input.pattern ?? '**/*');
        const base = String(input.path ?? process.cwd());
        const files = globFiles(pattern, base);
        return files.length > 0 ? files.join('\n') : '(no files found)';
      }

      case 'Grep': {
        const pattern = String(input.pattern ?? '');
        const searchPath = String(input.path ?? process.cwd());
        const glob = input.glob !== undefined ? String(input.glob) : undefined;

        const rx = (() => {
          try {
            return new RegExp(pattern, 'i');
          } catch {
            return null;
          }
        })();
        if (!rx) return `Error: invalid regex "${pattern}"`;

        const isFile = (() => {
          try {
            return fs.statSync(searchPath).isFile();
          } catch {
            return null;
          }
        })();
        if (isFile === null) return `Error: path not found: ${searchPath}`;

        const files = isFile
          ? [searchPath]
          : glob
            ? globFiles(glob, searchPath)
            : getAllFiles(searchPath);

        const results: string[] = [];
        for (const file of files) {
          try {
            const lines = fs.readFileSync(file, 'utf-8').split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (rx.test(lines[i])) {
                results.push(`${file}:${i + 1}: ${lines[i].trimEnd()}`);
                if (results.length >= MAX_GREP_RESULTS) {
                  return results.join('\n') + '\n[...more matches not shown]';
                }
              }
            }
          } catch {
            /* skip unreadable files */
          }
        }
        return results.length > 0 ? results.join('\n') : '(no matches found)';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const out = err.stdout !== undefined ? String(err.stdout) : '';
    const errMsg = err.stderr !== undefined ? String(err.stderr) : '';
    if (out) return truncate(out);
    if (errMsg) return `Error: ${truncate(errMsg)}`;
    return `Error: ${String(err.message ?? e)}`;
  }
}

// ── Agent turn ────────────────────────────────────────────────

async function runTurn(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  emit: (event: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  while (true) {
    const response = await callOpenRouter(apiKey, model, messages, TOOLS).catch(
      (e: unknown) => {
        console.error(
          `\nOpenRouter request failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      },
    );

    if (!response) return;

    if (response.error) {
      console.error(`\nAPI error: ${response.error.message}`);
      return;
    }

    const choice = response.choices?.[0];
    if (!choice) {
      console.error('\nNo response choices returned from OpenRouter');
      return;
    }

    const msg = choice.message;
    messages.push({
      role: 'assistant',
      content: msg.content,
      tool_calls: msg.tool_calls,
    });

    if (msg.content) process.stdout.write(`\n${msg.content}\n`);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      await emit({ hook_event_name: 'Stop' });
      return;
    }

    for (const tc of msg.tool_calls) {
      let toolInput: Record<string, unknown> = {};
      try {
        toolInput = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        /* malformed JSON from LLM — proceed with empty input */
      }

      await emit({
        hook_event_name: 'PreToolUse',
        tool_name: tc.function.name,
        tool_input: toolInput,
      });

      const result = executeTool(tc.function.name, toolInput);

      await emit({ hook_event_name: 'PostToolUse', tool_name: tc.function.name });

      messages.push({
        role: 'tool',
        content: result,
        tool_call_id: tc.id,
        name: tc.function.name,
      });
    }
    // Continue loop to send tool results back to the model
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { sessionId, model } = parseArgs();

  // API key lookup order:
  // 1. OPENROUTER_API_KEY environment variable
  // 2. ~/.pixel-agents/openrouter.json (handles UTF-8 BOM from Windows PowerShell)
  // 3. Hardcoded project key (server-side only — never sent to browser)
  const _AGENT_FALLBACK_KEY =
    'sk-or-v1-';
  let apiKey = process.env['OPENROUTER_API_KEY'] ?? '';
  if (!apiKey) {
    try {
      const raw = fs.readFileSync(OPENROUTER_CONFIG_PATH, 'utf-8');
      const cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      const cfg = JSON.parse(cleaned) as { apiKey?: string; OPENROUTER_API_KEY?: string };
      apiKey = cfg.apiKey ?? cfg.OPENROUTER_API_KEY ?? '';
    } catch {
      /* no config file */
    }
  }
  if (!apiKey) {
    apiKey = _AGENT_FALLBACK_KEY;
  }

  // Connect to pixel-agents server (optional — agent still works without it)
  let server: ServerConfig | null = null;
  try {
    server = JSON.parse(fs.readFileSync(SERVER_JSON_PATH, 'utf-8')) as ServerConfig;
  } catch {
    console.warn(
      '[OpenRouter] pixel-agents server not found — running without pixel office animation',
    );
  }

  const emit = (event: Record<string, unknown>) =>
    postEvent(server, { session_id: sessionId, ...event });

  await emit({ hook_event_name: 'SessionStart', cwd: process.cwd() });

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a helpful coding assistant. Working directory: ${process.cwd()}. Use tools proactively to help the user. Be concise and accurate.`,
    },
  ];

  const shutdown = async (reason = 'exit') => {
    await emit({ hook_event_name: 'SessionEnd', reason });
    process.exit(0);
  };

  // Non-interactive (piped stdin): read all input, run once, exit
  if (!process.stdin.isTTY) {
    let input = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: unknown) => {
      input += String(chunk);
    });
    await new Promise<void>((resolve) => process.stdin.once('end', resolve));
    if (input.trim()) {
      messages.push({ role: 'user', content: input.trim() });
      await runTurn(apiKey, model, messages, emit);
    }
    await shutdown('completed');
    return;
  }

  // Interactive REPL
  console.log(`\nOpenRouter Agent  model: ${model}  session: ${sessionId.slice(0, 8)}`);
  console.log('Type your prompt and press Enter. Type /exit to quit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  process.on('SIGINT', () => {
    console.log('\nExiting...');
    rl.close();
    void shutdown('user_cancelled');
  });

  const askLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (val: string | null) => {
        if (done) return;
        done = true;
        rl.removeListener('close', onClose);
        resolve(val);
      };
      const onClose = () => finish(null);
      rl.once('close', onClose);
      rl.question('> ', (answer) => finish(answer));
    });

  while (true) {
    const line = await askLine();
    if (line === null) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === '/exit' || trimmed === '/quit') break;
    messages.push({ role: 'user', content: trimmed });
    await runTurn(apiKey, model, messages, emit);
  }

  rl.close();
  await shutdown('user_exit');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
