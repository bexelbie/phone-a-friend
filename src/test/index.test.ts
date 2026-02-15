// ABOUTME: Unit tests for phone-a-friend MCP server.
// ABOUTME: Tests pure functions and git worktree operations.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wrapPrompt, generateWorktreePath, promptSizeWarning, PROMPT_SIZE_WARNING_THRESHOLD } from "../util.js";

const execFileAsync = promisify(execFile);

describe("wrapPrompt", () => {
  it("includes the user prompt", () => {
    const result = wrapPrompt("Fix the bug in parser.ts");
    assert.ok(result.includes("Fix the bug in parser.ts"));
  });

  it("includes the response filename instruction", () => {
    const result = wrapPrompt("Do something");
    assert.ok(result.includes(".paf-response.md"));
  });

  it("includes the no-push instruction", () => {
    const result = wrapPrompt("Do something");
    assert.ok(result.includes("NEVER push"));
  });

  it("includes instruction to always create response file", () => {
    const result = wrapPrompt("Do something");
    assert.ok(result.includes("MUST create"));
  });
});

describe("generateWorktreePath", () => {
  it("produces paths under .worktrees directory", () => {
    const result = generateWorktreePath("/some/repo");
    assert.ok(result.startsWith("/some/repo/.worktrees/paf-"));
  });

  it("produces unique paths on repeated calls", () => {
    const a = generateWorktreePath("/repo");
    const b = generateWorktreePath("/repo");
    assert.notEqual(a, b);
  });

  it("includes a timestamp component", () => {
    const before = Date.now();
    const result = generateWorktreePath("/repo");
    const after = Date.now();
    // Extract the timestamp from paf-<timestamp>-<suffix>
    const name = result.split("/").pop()!;
    const timestamp = parseInt(name.split("-")[1], 10);
    assert.ok(timestamp >= before && timestamp <= after);
  });
});

describe("promptSizeWarning", () => {
  it("returns null for short prompts", () => {
    const result = promptSizeWarning("Fix the bug");
    assert.equal(result, null);
  });

  it("returns null for prompts just under the threshold", () => {
    const prompt = "x".repeat(PROMPT_SIZE_WARNING_THRESHOLD - 1);
    const result = promptSizeWarning(prompt);
    assert.equal(result, null);
  });

  it("returns a warning for prompts at or above the threshold", () => {
    const prompt = "x".repeat(PROMPT_SIZE_WARNING_THRESHOLD);
    const result = promptSizeWarning(prompt);
    assert.ok(result !== null);
    assert.ok(typeof result === "string");
  });

  it("warning includes the prompt size in KB", () => {
    const prompt = "x".repeat(15000);
    const result = promptSizeWarning(prompt)!;
    assert.ok(result.includes("15"));
  });

  it("warning mentions uncommitted changes as a likely cause", () => {
    const prompt = "x".repeat(PROMPT_SIZE_WARNING_THRESHOLD);
    const result = promptSizeWarning(prompt)!;
    assert.ok(result.includes("uncommitted"));
  });

  it("warning includes a link to the project repo", () => {
    const prompt = "x".repeat(PROMPT_SIZE_WARNING_THRESHOLD);
    const result = promptSizeWarning(prompt)!;
    assert.ok(result.includes("github.com"));
  });
});

describe("git worktree integration", () => {
  let tempDir: string;

  before(async () => {
    // Create a temp dir with a git repo for testing
    tempDir = await mkdtemp(join(tmpdir(), "paf-test-"));
    await execFileAsync("git", ["init"], { cwd: tempDir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], {
      cwd: tempDir,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: tempDir,
    });
    // Need at least one commit for worktrees to work
    await writeFile(join(tempDir, "README.md"), "# Test repo\n");
    await execFileAsync("git", ["add", "."], { cwd: tempDir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: tempDir });
  });

  after(async () => {
    // Clean up temp dir
    await rm(tempDir, { recursive: true, force: true });
  });

  it("can create and remove a worktree", async () => {
    const worktreePath = join(tempDir, ".worktrees", "test-wt");
    const branchName = "paf/test-wt";

    // Create worktrees dir
    await mkdir(join(tempDir, ".worktrees"), { recursive: true });

    // Create worktree
    await execFileAsync(
      "git",
      ["worktree", "add", "-B", branchName, worktreePath, "HEAD"],
      { cwd: tempDir }
    );

    assert.ok(existsSync(worktreePath));
    assert.ok(existsSync(join(worktreePath, "README.md")));

    // Verify it's a separate working tree
    const { stdout } = await execFileAsync("git", ["worktree", "list"], {
      cwd: tempDir,
    });
    assert.ok(stdout.includes("test-wt"));

    // Clean up
    await execFileAsync(
      "git",
      ["worktree", "remove", worktreePath, "--force"],
      { cwd: tempDir }
    );
    await execFileAsync("git", ["branch", "-D", branchName], {
      cwd: tempDir,
    });

    assert.ok(!existsSync(worktreePath));
  });

  it("captures changes in worktree as diff", async () => {
    const worktreePath = join(tempDir, ".worktrees", "test-diff");
    const branchName = "paf/test-diff";

    await mkdir(join(tempDir, ".worktrees"), { recursive: true });
    await execFileAsync(
      "git",
      ["worktree", "add", "-B", branchName, worktreePath, "HEAD"],
      { cwd: tempDir }
    );

    // Make changes in the worktree
    await writeFile(join(worktreePath, "new-file.txt"), "hello world\n");
    await writeFile(
      join(worktreePath, "README.md"),
      "# Modified repo\n\nWith changes.\n"
    );

    // Stage and diff
    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
    const { stdout: diff } = await execFileAsync(
      "git",
      ["diff", "--staged", "HEAD"],
      { cwd: worktreePath }
    );

    // Should show both the new file and the modified file
    assert.ok(diff.includes("new-file.txt"));
    assert.ok(diff.includes("hello world"));
    assert.ok(diff.includes("Modified repo"));

    // Clean up
    await execFileAsync(
      "git",
      ["worktree", "remove", worktreePath, "--force"],
      { cwd: tempDir }
    );
    await execFileAsync("git", ["branch", "-D", branchName], {
      cwd: tempDir,
    });
  });

  it("message-in-a-bottle read and delete works", async () => {
    const worktreePath = join(tempDir, ".worktrees", "test-bottle");
    const branchName = "paf/test-bottle";

    await mkdir(join(tempDir, ".worktrees"), { recursive: true });
    await execFileAsync(
      "git",
      ["worktree", "add", "-B", branchName, worktreePath, "HEAD"],
      { cwd: tempDir }
    );

    // Simulate the subagent writing the response file
    const responsePath = join(worktreePath, ".paf-response.md");
    await writeFile(
      responsePath,
      "I fixed the bug in parser.ts by adding null checks."
    );
    assert.ok(existsSync(responsePath));

    // Read the response
    const response = await readFile(responsePath, "utf-8");
    assert.equal(response, "I fixed the bug in parser.ts by adding null checks.");

    // Delete it
    const { unlink } = await import("node:fs/promises");
    await unlink(responsePath);
    assert.ok(!existsSync(responsePath));

    // Now diff should NOT include the response file
    await writeFile(join(worktreePath, "parser.ts"), "// fixed code\n");
    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
    const { stdout: diff } = await execFileAsync(
      "git",
      ["diff", "--staged", "HEAD"],
      { cwd: worktreePath }
    );

    assert.ok(!diff.includes(".paf-response.md"));
    assert.ok(diff.includes("parser.ts"));

    // Clean up
    await execFileAsync(
      "git",
      ["worktree", "remove", worktreePath, "--force"],
      { cwd: tempDir }
    );
    await execFileAsync("git", ["branch", "-D", branchName], {
      cwd: tempDir,
    });
  });

  it("captures committed changes when diffing against base SHA", async () => {
    const worktreePath = join(tempDir, ".worktrees", "test-committed");
    const branchName = "paf/test-committed";

    await mkdir(join(tempDir, ".worktrees"), { recursive: true });
    await execFileAsync(
      "git",
      ["worktree", "add", "-B", branchName, worktreePath, "HEAD"],
      { cwd: tempDir }
    );

    // Record the base SHA before making changes
    const { stdout: baseSha } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: worktreePath }
    );

    // Make changes AND commit them (simulating an agent that commits)
    await writeFile(join(worktreePath, "committed-file.txt"), "committed content\n");
    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
    await execFileAsync("git", ["commit", "-m", "agent commit"], {
      cwd: worktreePath,
    });

    // Verify: diffing against HEAD shows nothing (the bug scenario)
    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
    const { stdout: headDiff } = await execFileAsync(
      "git",
      ["diff", "--staged", "HEAD"],
      { cwd: worktreePath }
    );
    assert.equal(headDiff.trim(), "", "diff against HEAD should be empty after commit");

    // Verify: diffing against base SHA captures the committed changes (the fix)
    const { stdout: baseDiff } = await execFileAsync(
      "git",
      ["diff", "--staged", baseSha.trim()],
      { cwd: worktreePath }
    );
    assert.ok(
      baseDiff.includes("committed-file.txt"),
      "diff against base SHA should capture committed changes"
    );
    assert.ok(
      baseDiff.includes("committed content"),
      "diff should include the file content"
    );

    // Clean up
    await execFileAsync(
      "git",
      ["worktree", "remove", worktreePath, "--force"],
      { cwd: tempDir }
    );
    await execFileAsync("git", ["branch", "-D", branchName], {
      cwd: tempDir,
    });
  });
});
