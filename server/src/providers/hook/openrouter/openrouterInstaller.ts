import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { OPENROUTER_AGENT_SCRIPT_NAME } from './constants.js';

function getAgentScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, OPENROUTER_AGENT_SCRIPT_NAME);
}

/** Check if the OpenRouter agent runner is deployed at ~/.pixel-agents/hooks/. */
export function areHooksInstalled(): boolean {
  return fs.existsSync(getAgentScriptPath());
}

/**
 * No-op: unlike Claude, OpenRouter has no external settings file to modify.
 * The agent runner itself posts events to pixel-agents when launched.
 * Call copyOpenRouterAgent() to deploy the script file.
 */
export function installHooks(): void {
  // Nothing to install in an external config.
}

/** Remove the OpenRouter agent runner from ~/.pixel-agents/hooks/. */
export function uninstallHooks(): void {
  const scriptPath = getAgentScriptPath();
  try {
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
      console.log('[Pixel Agents] OpenRouter agent runner removed');
    }
  } catch (e) {
    console.error(`[Pixel Agents] Failed to remove OpenRouter agent runner: ${e}`);
  }
}

/** Copy the bundled agent runner from dist/hooks/ to ~/.pixel-agents/hooks/. */
export function copyOpenRouterAgent(extensionPath: string): void {
  const src = path.join(extensionPath, 'dist', 'hooks', OPENROUTER_AGENT_SCRIPT_NAME);
  const dst = getAgentScriptPath();
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] OpenRouter agent runner not found at ${src}`);
      return;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] OpenRouter agent runner installed at ${dst}`);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy OpenRouter agent runner: ${e}`);
  }
}
