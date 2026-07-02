import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const OPENROUTER_CONFIG_PATH = path.join(os.homedir(), '.pixel-agents', 'openrouter.json');
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

// ── API key bootstrap — runs once at module load ───────────────
// Ensures process.env.OPENROUTER_API_KEY is always set before any LLM call.
// Priority: env var → config file → hardcoded project key
// Server-side only — this value never reaches the browser.
const _FALLBACK_KEY = 'sk-or-v1-';

let _apiKeySource = 'hardcoded';

if (process.env['OPENROUTER_API_KEY']) {
  _apiKeySource = 'env';
} else {
  // Try config file (handle UTF-8 BOM written by Windows PowerShell)
  let fromFile = '';
  try {
    const raw = fs.readFileSync(OPENROUTER_CONFIG_PATH, 'utf-8');
    const cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const cfg = JSON.parse(cleaned) as { apiKey?: string; OPENROUTER_API_KEY?: string };
    fromFile = cfg.apiKey ?? cfg.OPENROUTER_API_KEY ?? '';
  } catch { /* no config file */ }

  if (fromFile) {
    process.env['OPENROUTER_API_KEY'] = fromFile;
    _apiKeySource = 'config-file';
  } else {
    process.env['OPENROUTER_API_KEY'] = _FALLBACK_KEY;
    _apiKeySource = 'hardcoded';
  }
}

export function logApiKeyStatus(): void {
  const key = process.env['OPENROUTER_API_KEY'] ?? '';
  console.log(`[OpenRouter] OPENROUTER_API_KEY loaded from: ${_apiKeySource}`);
  console.log(`[OpenRouter] API key available: ${key.length > 0 ? 'yes' : 'NO — requests will fail'}`);
  if (key.length > 0) {
    console.log(`[OpenRouter] Key prefix: ${key.slice(0, 12)}...`);
  }
}

function getApiKey(): string {
  // process.env.OPENROUTER_API_KEY is guaranteed to be set by the module initialiser above
  const key = process.env['OPENROUTER_API_KEY'] ?? _FALLBACK_KEY;
  if (!key) {
    throw new Error(
      'OpenRouter API Key를 찾지 못했습니다. ' +
        '환경변수 OPENROUTER_API_KEY 또는 ~/.pixel-agents/openrouter.json 파일을 확인해 주세요.',
    );
  }
  return key;
}

function getBaseUrl(): string {
  return process.env['OPENROUTER_BASE_URL'] ?? DEFAULT_BASE_URL;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  content: string;
  model: string;
}

interface OpenRouterResponse {
  choices: Array<{ message: { content: string } }>;
  model?: string;
}

export async function complete(model: string, messages: ChatMessage[]): Promise<CompletionResult> {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/pixel-agents-hq/pixel-agents',
      'X-Title': 'Pixel Agents',
    },
    body: JSON.stringify({ model, messages, max_tokens: 2048, temperature: 0.7 }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message?.content ?? '';
  return { content, model: data.model ?? model };
}
