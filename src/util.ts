// ABOUTME: Pure utility functions for prompt wrapping and path generation.
// ABOUTME: Separated from server startup so tests can import without side effects.

import { join } from "node:path";

export const TOOL_MODES = ["default", "query"] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

export const RESPONSE_FILENAME = ".paf-response.md";

export const AVAILABLE_MODELS = [
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "claude-opus-4.6",
  "claude-opus-4.6-fast",
  "claude-opus-4.5",
  "claude-sonnet-4",
  "gemini-3-pro-preview",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1",
  "gpt-5",
  "gpt-5.1-codex-mini",
  "gpt-5-mini",
  "gpt-4.1",
] as const;

/**
 * Wraps the user's prompt with instructions for the subagent about
 * the message-in-a-bottle response file and operating constraints.
 * In query mode, tells the subagent changes will be discarded.
 */
export function wrapPrompt(userPrompt: string, mode: ToolMode = "default"): string {
  if (mode === "query") {
    return `## CRITICAL INSTRUCTIONS — READ BEFORE DOING ANYTHING

You are operating as a subagent inside an isolated git worktree for reference only. Any file changes you make will be discarded. Focus on analysis and your written response.

1. **Do NOT modify files.** Any changes will be thrown away. The repository is available for you to read, not to edit.
2. **When you are finished**, write your complete final response to the file \`${RESPONSE_FILENAME}\` in the repository root. This file is your ONLY communication channel back to the calling agent. Include:
   - Your analysis or answer
   - Any important findings or decisions
   - Any warnings or caveats
3. You MUST create the \`${RESPONSE_FILENAME}\` file. It is how you report back.

## YOUR TASK

${userPrompt}`;
  }

  return `## CRITICAL INSTRUCTIONS — READ BEFORE DOING ANYTHING

You are operating as a subagent inside an isolated git worktree. Follow these rules:

1. **NEVER push to any remote.** Do not run \`git push\` under any circumstances.
2. **When you are finished**, write your complete final response to the file \`${RESPONSE_FILENAME}\` in the repository root. This file is your ONLY communication channel back to the calling agent. Include:
   - A summary of what you did
   - Any important findings or decisions
   - Any warnings or caveats
3. You MUST create the \`${RESPONSE_FILENAME}\` file even if you made no code changes. It is how you report back.

## YOUR TASK

${userPrompt}`;
}

/**
 * Generates a unique worktree path based on timestamp and random suffix.
 */
export function generateWorktreePath(baseDir: string): string {
  const timestamp = Date.now();
  const suffix = Math.random().toString(36).substring(2, 8);
  return join(baseDir, `.worktrees`, `paf-${timestamp}-${suffix}`);
}

/**
 * Escapes a string for safe shell inclusion.
 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export const PROMPT_SIZE_WARNING_THRESHOLD = 10 * 1024; // 10 KB

const REPO_ISSUES_URL = "https://github.com/bexelbie/phone-a-friend/issues";

/**
 * Returns a warning string if the prompt is large enough to suggest
 * the calling agent pasted file contents (likely for uncommitted changes).
 * Returns null if the prompt is under the threshold.
 */
export function promptSizeWarning(prompt: string): string | null {
  if (prompt.length < PROMPT_SIZE_WARNING_THRESHOLD) {
    return null;
  }
  const sizeKB = Math.round(prompt.length / 1024);
  return (
    `**Large prompt warning:** The prompt sent to the subagent was ~${sizeKB}KB. ` +
    `If this included pasted file contents to work around the uncommitted changes ` +
    `limitation, be aware this consumes significant context in both directions. ` +
    `If this is causing problems, consider requesting built-in uncommitted changes ` +
    `support: ${REPO_ISSUES_URL}`
  );
}
