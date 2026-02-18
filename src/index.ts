#!/usr/bin/env node
// ABOUTME: MCP server that invokes Copilot CLI with a different model.
// ABOUTME: Enables cross-model subagent calls from VS Code Copilot Chat.

import { resolve } from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  RESPONSE_FILENAME,
  AVAILABLE_MODELS,
  TOOL_MODES,
  wrapPrompt,
  generateWorktreePath,
  promptSizeWarning,
} from "./util.js";
import type { ToolMode } from "./util.js";
import {
  isGitRepo,
  getGitRoot,
  createWorktree,
  removeWorktree,
  runCopilotCli,
  getHeadSha,
  captureChanges,
  readAndRemoveResponse,
} from "./git.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// --- MCP Server Setup ---

const server = new McpServer({
  name: "phone-a-friend",
  version,
});

server.registerTool(
  "phone_a_friend",
  {
    title: "Phone a Friend",
    description:
      "Invoke GitHub Copilot CLI with a different AI model to perform a task. " +
      "The other model works in an isolated git worktree. Returns the model's " +
      "response message and a unified diff of any file changes it made. " +
      "You can then apply the diff using your own edit tools to give the user " +
      "inline diff highlighting." +
      "\n\nWhen to use this tool:\n" +
      "- The user asks for a second opinion or review from a different model\n" +
      "- The user wants a specific model for a subtask (e.g., a faster model for simple work, or a different vendor)\n" +
      "- The user mentions \"phone a friend\", \"subagent\", or \"different model\"\n" +
      "- The user wants to delegate a focused coding task to another model and get the changes back as a diff\n" +
      "- Use mode \"query\" when you only want the agent's analysis — reviews, explanations, architectural assessments — not file changes\n" +
      "\n\nWhen NOT to use this tool:\n" +
      "- The current model can handle the task directly — don't add round-trip overhead for no benefit\n" +
      "- The task requires seeing uncommitted changes and the user hasn't provided the file contents\n" +
      "- The task is conversational (no code changes expected and no specialized model needed)\n" +
      "\n\nIMPORTANT: The subagent only sees committed files (HEAD). It cannot " +
      "see uncommitted changes in the working tree. If the user's request " +
      "involves uncommitted work, YOU must include the relevant file contents " +
      "in the prompt. The diff returned will be in your context — keep " +
      "subtasks focused to avoid large diffs consuming your context window.",
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          "The task or question for the other model. Be specific and include " +
            "relevant context since the other model starts with only the " +
            "committed repository files. If the user has uncommitted changes " +
            "that are relevant, include those file contents in this prompt."
        ),
      model: z
        .string()
        .describe(
          `The AI model to use. Available models: ${AVAILABLE_MODELS.join(", ")}`
        ),
      working_directory: z
        .string()
        .describe(
          "The git repository directory to work in. Must be inside a git " +
            "repository. Always pass this explicitly using the workspace " +
            "path from your conversation context — the server's own working " +
            "directory is not the user's workspace."
        ),
      mode: z
        .enum(TOOL_MODES)
        .optional()
        .default("default")
        .describe(
          '"default" returns the agent response and a unified diff of file changes. ' +
            '"query" discards all file changes and returns only the agent response — ' +
            "use for reviews, analysis, or questions where you don't need code changes."
        ),
    }),
  },
  async ({ prompt, model, working_directory, mode }) => {
    const workDir = resolve(working_directory);
    const toolMode: ToolMode = mode ?? "default";

    // Validate git repo
    if (!(await isGitRepo(workDir))) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${workDir} is not inside a git repository.`,
          },
        ],
        isError: true,
      };
    }

    const gitRoot = await getGitRoot(workDir);
    const worktreePath = generateWorktreePath(gitRoot);

    try {
      // Create isolated worktree
      await createWorktree(gitRoot, worktreePath);

      // Record the starting commit so we can diff against it later,
      // even if the agent commits during its run.
      const baseSha = await getHeadSha(worktreePath);

      // Run the CLI agent
      const wrappedPrompt = wrapPrompt(prompt, toolMode);
      const { exitCode, stderr } = await runCopilotCli(
        worktreePath,
        wrappedPrompt,
        model
      );

      // Read the response file before diffing
      const response = await readAndRemoveResponse(worktreePath, RESPONSE_FILENAME);

      // Build result
      const parts: string[] = [];

      if (response) {
        parts.push("## Agent Response\n\n" + response);
      } else {
        parts.push(
          "## Agent Response\n\n" +
            "*No response file was created. The agent may have failed " +
            "to follow the message-in-a-bottle instructions.*"
        );
      }

      // Capture and include file changes only in default mode
      if (toolMode === "default") {
        const diff = await captureChanges(worktreePath, baseSha);
        if (diff.trim()) {
          parts.push("## File Changes (unified diff)\n\n```diff\n" + diff + "\n```");
        } else {
          parts.push("## File Changes\n\nNo file changes were made.");
        }
      }

      if (exitCode !== 0) {
        parts.push(
          `## Warnings\n\nCopilot CLI exited with code ${exitCode}.` +
            (stderr ? `\n\nStderr:\n${stderr}` : "")
        );
      }

      const sizeWarning = promptSizeWarning(prompt);
      if (sizeWarning) {
        parts.push("## Context Size Notice\n\n" + sizeWarning);
      }

      return {
        content: [{ type: "text" as const, text: parts.join("\n\n") }],
      };
    } finally {
      // Always clean up the worktree
      try {
        await removeWorktree(gitRoot, worktreePath);
      } catch (err) {
        console.error(
          `[phone-a-friend] worktree cleanup failed for ${worktreePath}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
