#!/usr/bin/env node
// ABOUTME: MCP server that invokes Copilot CLI with a different model.
// ABOUTME: Enables cross-model subagent calls from VS Code Copilot Chat.

import { execFile, spawn } from "node:child_process";
import { readFile, unlink, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  RESPONSE_FILENAME,
  AVAILABLE_MODELS,
  wrapPrompt,
  generateWorktreePath,
  promptSizeWarning,
} from "./util.js";

const execFileAsync = promisify(execFile);

/**
 * Verifies that a directory is inside a git repository.
 */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the root of the git repository containing the given directory.
 */
async function getGitRoot(dir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: dir }
  );
  return stdout.trim();
}

/**
 * Creates a git worktree at the specified path, branching from HEAD.
 */
async function createWorktree(
  repoDir: string,
  worktreePath: string
): Promise<void> {
  const worktreesDir = join(worktreePath, "..");
  if (!existsSync(worktreesDir)) {
    await mkdir(worktreesDir, { recursive: true });
  }

  const branchName = `paf/${worktreePath.split("/").pop()}`;
  await execFileAsync(
    "git",
    ["worktree", "add", "-B", branchName, worktreePath, "HEAD"],
    { cwd: repoDir }
  );
}

/**
 * Removes a git worktree and its associated branch.
 */
async function removeWorktree(
  repoDir: string,
  worktreePath: string
): Promise<void> {
  const branchName = `paf/${worktreePath.split("/").pop()}`;
  try {
    await execFileAsync(
      "git",
      ["worktree", "remove", worktreePath, "--force"],
      { cwd: repoDir }
    );
  } catch {
    // If worktree remove fails, try manual cleanup
    if (existsSync(worktreePath)) {
      await rm(worktreePath, { recursive: true, force: true });
    }
    try {
      await execFileAsync("git", ["worktree", "prune"], { cwd: repoDir });
    } catch {
      // Best effort
    }
  }
  try {
    await execFileAsync("git", ["branch", "-D", branchName], {
      cwd: repoDir,
    });
  } catch {
    // Branch may not exist or may already be deleted
  }
}

/**
 * Runs the Copilot CLI in non-interactive mode inside the worktree.
 * Stdout/stderr are discarded — the response comes from the
 * message-in-a-bottle file.
 */
async function runCopilotCli(
  worktreePath: string,
  prompt: string,
  model: string
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    const args = [
      "-p",
      prompt,
      "--model",
      model,
      "--allow-all",
      "--deny-tool",
      "shell(git push*)",
      "--no-alt-screen",
      "--no-color",
    ];

    const child = spawn("copilot", args, {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });

    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Drain stdout so the process doesn't block
    child.stdout?.on("data", () => {});

    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? 1, stderr });
    });

    child.on("error", (err) => {
      resolvePromise({ exitCode: 1, stderr: err.message });
    });
  });
}

/**
 * Returns the current HEAD commit SHA for a git directory.
 */
async function getHeadSha(dir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: dir }
  );
  return stdout.trim();
}

/**
 * Captures all changes in the worktree as a unified diff.
 * Stages everything first to include untracked files, then diffs
 * against the given base SHA (the original commit before the agent ran).
 * This ensures committed changes are also captured.
 */
async function captureChanges(
  worktreePath: string,
  baseSha: string
): Promise<string> {
  // Stage everything so untracked files appear in the diff
  try {
    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
  } catch {
    // May fail if nothing to add
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--staged", baseSha],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 }
    );
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Reads and removes the message-in-a-bottle response file.
 */
async function readAndRemoveResponse(
  worktreePath: string
): Promise<string | null> {
  const responsePath = join(worktreePath, RESPONSE_FILENAME);
  try {
    const content = await readFile(responsePath, "utf-8");
    await unlink(responsePath);
    return content;
  } catch {
    return null;
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "phone-a-friend",
  version: "0.1.0",
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
    }),
  },
  async ({ prompt, model, working_directory }) => {
    const workDir = resolve(working_directory);

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
      const wrappedPrompt = wrapPrompt(prompt);
      const { exitCode, stderr } = await runCopilotCli(
        worktreePath,
        wrappedPrompt,
        model
      );

      // Read the response file before diffing
      const response = await readAndRemoveResponse(worktreePath);

      // Capture all file changes
      const diff = await captureChanges(worktreePath, baseSha);

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

      if (diff.trim()) {
        parts.push("## File Changes (unified diff)\n\n```diff\n" + diff + "\n```");
      } else {
        parts.push("## File Changes\n\nNo file changes were made.");
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
      } catch {
        // Best effort cleanup
      }
    }
  }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
