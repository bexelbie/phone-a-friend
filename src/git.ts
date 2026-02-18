// ABOUTME: Git operations for worktree management, repo inspection, and change capture.
// ABOUTME: Extracted from index.ts so these functions can be tested directly.

import { execFile, spawn } from "node:child_process";
import { readFile, unlink, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Verifies that a directory is inside a git repository.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
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
export async function getGitRoot(dir: string): Promise<string> {
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
export async function createWorktree(
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
export async function removeWorktree(
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
export async function runCopilotCli(
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

    child.on("error", (err: NodeJS.ErrnoException) => {
      const message =
        err.code === "ENOENT"
          ? "Copilot CLI not found. Install it (https://docs.github.com/en/copilot/github-copilot-in-the-cli) and ensure 'copilot' is on your PATH."
          : err.message;
      resolvePromise({ exitCode: 1, stderr: message });
    });
  });
}

/**
 * Returns the current HEAD commit SHA for a git directory.
 */
export async function getHeadSha(dir: string): Promise<string> {
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
export async function captureChanges(
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
export async function readAndRemoveResponse(
  worktreePath: string,
  responseFilename: string
): Promise<string | null> {
  const responsePath = join(worktreePath, responseFilename);
  try {
    const content = await readFile(responsePath, "utf-8");
    await unlink(responsePath);
    return content;
  } catch {
    return null;
  }
}
