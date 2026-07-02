import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { OPENROUTER_AGENT_SCRIPT_NAME, OPENROUTER_TERMINAL_NAME_PREFIX } from './constants.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './openrouterInstaller.js';

// ── Event normalization ────────────────────────────────────────
//
// The openrouter-agent runner posts events using the same field naming as
// Claude hooks (hook_event_name, session_id, tool_name, tool_input, cwd).
// normalizeHookEvent maps those to the common AgentEvent union.

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `hook-${Date.now()}`,
          toolName,
          input: toolInput,
        },
      };
    }

    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };

    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };

    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    default:
      return null;
  }
}

// ── Tool status display ────────────────────────────────────────

function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Bash': {
      const cmd = (inp.command as string) || '';
      return `Running: ${cmd.length > 30 ? cmd.slice(0, 30) + '…' : cmd}`;
    }
    case 'Read':
      return `Reading ${base(inp.file_path)}`;
    case 'Write':
      return `Writing ${base(inp.file_path)}`;
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebSearch':
      return 'Searching the web';
    case 'WebFetch':
      return 'Fetching web content';
    default:
      return `Using ${toolName}`;
  }
}

// ── Launch command ────────────────────────────────────────────

function buildLaunchCommand(
  sessionId: string,
  cwd: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  const scriptPath = path.join(os.homedir(), HOOK_SCRIPTS_DIR, OPENROUTER_AGENT_SCRIPT_NAME);
  return {
    command: 'node',
    args: [scriptPath, '--session-id', sessionId],
    env: { PWD: cwd },
  };
}

// ── Installer wrappers ─────────────────────────────────────────

function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  installerInstallHooks();
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  installerUninstallHooks();
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(installerAreHooksInstalled());
}

// ── The provider ───────────────────────────────────────────────

export const openrouterProvider: HookProvider = {
  kind: 'hook',
  id: 'openrouter',
  displayName: 'OpenRouter',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  permissionExemptTools: new Set<string>(),
  subagentToolNames: new Set<string>(),
  readingTools: new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
  terminalNamePrefix: OPENROUTER_TERMINAL_NAME_PREFIX,

  buildLaunchCommand,
  // No getSessionDirs / getAllSessionRoots / sessionFilePattern: OpenRouter agents
  // post events via HTTP hooks; there are no JSONL transcript files to scan.
};
