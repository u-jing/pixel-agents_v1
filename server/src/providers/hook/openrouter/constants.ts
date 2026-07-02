/**
 * OpenRouter-specific constants. Kept separate from server/src/constants.ts so a
 * single-provider build doesn't depend on OpenRouter unless it is the active provider.
 */

/** Output filename after esbuild compiles openrouter-agent.ts to CJS */
export const OPENROUTER_AGENT_SCRIPT_NAME = 'openrouter-agent.js';

/** Terminal name prefix when launching OpenRouter agents in VS Code. */
export const OPENROUTER_TERMINAL_NAME_PREFIX = 'OpenRouter Agent';

/** Default model if OPENROUTER_MODEL env var is not set. */
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';
