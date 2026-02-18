// ABOUTME: Tests for git operations (worktree lifecycle, repo inspection, change capture).
// ABOUTME: Uses real temp git repos — no mocking.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isGitRepo,
  getGitRoot,
  createWorktree,
  removeWorktree,
  getHeadSha,
  captureChanges,
  readAndRemoveResponse,
} from "../git.js";

const execFileAsync = promisify(execFile);

/**
 * Creates a temp directory with an initialized git repo and one commit.
 * Returns the path.
 */
async function makeTempRepo(): Promise<string> {
  const rawDir = await mkdtemp(join(tmpdir(), "paf-git-test-"));
  // Resolve symlinks so paths match what git returns (macOS: /var -> /private/var)
  const dir = await realpath(rawDir);
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# Test\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir });
  return dir;
}

describe("isGitRepo", () => {
  let tempRepo: string;
  let tempNonRepo: string;

  before(async () => {
    tempRepo = await makeTempRepo();
    tempNonRepo = await mkdtemp(join(tmpdir(), "paf-non-repo-"));
  });

  after(async () => {
    await rm(tempRepo, { recursive: true, force: true });
    await rm(tempNonRepo, { recursive: true, force: true });
  });

  it("returns true for a git repo root", async () => {
    assert.equal(await isGitRepo(tempRepo), true);
  });

  it("returns true for a subdirectory of a git repo", async () => {
    const subdir = join(tempRepo, "subdir");
    await mkdir(subdir, { recursive: true });
    assert.equal(await isGitRepo(subdir), true);
  });

  it("returns false for a non-git directory", async () => {
    assert.equal(await isGitRepo(tempNonRepo), false);
  });

  it("returns false for a non-existent directory", async () => {
    assert.equal(await isGitRepo("/tmp/paf-does-not-exist-" + Date.now()), false);
  });
});

describe("getGitRoot", () => {
  let tempRepo: string;

  before(async () => {
    tempRepo = await makeTempRepo();
  });

  after(async () => {
    await rm(tempRepo, { recursive: true, force: true });
  });

  it("returns the repo root when called from root", async () => {
    const root = await getGitRoot(tempRepo);
    assert.equal(root, tempRepo);
  });

  it("returns the repo root when called from a subdirectory", async () => {
    const subdir = join(tempRepo, "deep", "nested");
    await mkdir(subdir, { recursive: true });
    const root = await getGitRoot(subdir);
    assert.equal(root, tempRepo);
  });

  it("throws for a non-git directory", async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), "paf-non-repo-"));
    try {
      await assert.rejects(() => getGitRoot(nonRepo));
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("getHeadSha", () => {
  let tempRepo: string;

  before(async () => {
    tempRepo = await makeTempRepo();
  });

  after(async () => {
    await rm(tempRepo, { recursive: true, force: true });
  });

  it("returns a 40-character hex SHA", async () => {
    const sha = await getHeadSha(tempRepo);
    assert.match(sha, /^[0-9a-f]{40}$/);
  });

  it("changes after a new commit", async () => {
    const sha1 = await getHeadSha(tempRepo);
    await writeFile(join(tempRepo, "new.txt"), "content\n");
    await execFileAsync("git", ["add", "."], { cwd: tempRepo });
    await execFileAsync("git", ["commit", "-m", "second"], { cwd: tempRepo });
    const sha2 = await getHeadSha(tempRepo);
    assert.notEqual(sha1, sha2);
  });
});

describe("createWorktree and removeWorktree", () => {
  let tempRepo: string;

  before(async () => {
    tempRepo = await makeTempRepo();
  });

  after(async () => {
    await rm(tempRepo, { recursive: true, force: true });
  });

  it("creates a worktree with the expected files", async () => {
    const wtPath = join(tempRepo, ".worktrees", "test-create");
    try {
      await createWorktree(tempRepo, wtPath);
      assert.ok(existsSync(wtPath));
      assert.ok(existsSync(join(wtPath, "README.md")));
    } finally {
      await removeWorktree(tempRepo, wtPath);
    }
  });

  it("creates the .worktrees parent directory if missing", async () => {
    const wtPath = join(tempRepo, ".worktrees-new", "test-mkdir");
    try {
      assert.ok(!existsSync(join(tempRepo, ".worktrees-new")));
      await createWorktree(tempRepo, wtPath);
      assert.ok(existsSync(wtPath));
    } finally {
      await removeWorktree(tempRepo, wtPath);
      await rm(join(tempRepo, ".worktrees-new"), { recursive: true, force: true });
    }
  });

  it("removeWorktree cleans up the directory and branch", async () => {
    const wtPath = join(tempRepo, ".worktrees", "test-remove");
    await createWorktree(tempRepo, wtPath);
    assert.ok(existsSync(wtPath));

    await removeWorktree(tempRepo, wtPath);
    assert.ok(!existsSync(wtPath));

    // Branch should be gone too
    const { stdout } = await execFileAsync("git", ["branch"], { cwd: tempRepo });
    assert.ok(!stdout.includes("paf/test-remove"));
  });

  it("removeWorktree handles already-removed directory gracefully", async () => {
    const wtPath = join(tempRepo, ".worktrees", "test-double-remove");
    await createWorktree(tempRepo, wtPath);
    await removeWorktree(tempRepo, wtPath);

    // Calling remove again should not throw
    await removeWorktree(tempRepo, wtPath);
  });
});

describe("captureChanges", () => {
  let tempRepo: string;

  before(async () => {
    tempRepo = await makeTempRepo();
  });

  after(async () => {
    await rm(tempRepo, { recursive: true, force: true });
  });

  it("returns empty string when nothing changed", async () => {
    const wtPath = join(tempRepo, ".worktrees", "test-no-changes");
    try {
      await createWorktree(tempRepo, wtPath);
      const baseSha = await getHeadSha(wtPath);
      const diff = await captureChanges(wtPath, baseSha);
      assert.ok(diff !== null);
      assert.equal(diff.trim(), "");
    } finally {
      await removeWorktree(tempRepo, wtPath);
    }
  });

  it("captures new untracked files", async () => {
    const wtPath = join(tempRepo, ".worktrees", "test-untracked");
    try {
      await createWorktree(tempRepo, wtPath);
      const baseSha = await getHeadSha(wtPath);
      await writeFile(join(wtPath, "new-file.txt"), "new content\n");
      const diff = await captureChanges(wtPath, baseSha);
      assert.ok(diff !== null);
      assert.ok(diff.includes("new-file.txt"));
      assert.ok(diff.includes("new content"));
    } finally {
      await removeWorktree(tempRepo, wtPath);
    }
  });

  it("captures modifications to existing files", async () => {
    const wtPath = join(tempRepo, ".worktrees", "test-modified");
    try {
      await createWorktree(tempRepo, wtPath);
      const baseSha = await getHeadSha(wtPath);
      await writeFile(join(wtPath, "README.md"), "# Changed\n");
      const diff = await captureChanges(wtPath, baseSha);
      assert.ok(diff !== null);
      assert.ok(diff.includes("README.md"));
      assert.ok(diff.includes("Changed"));
    } finally {
      await removeWorktree(tempRepo, wtPath);
    }
  });

  it("captures committed changes when diffing against base SHA", async () => {
    const wtPath = join(tempRepo, ".worktrees", "test-committed");
    try {
      await createWorktree(tempRepo, wtPath);
      const baseSha = await getHeadSha(wtPath);

      // Commit changes (simulating an agent that commits)
      await writeFile(join(wtPath, "committed.txt"), "agent output\n");
      await execFileAsync("git", ["add", "-A"], { cwd: wtPath });
      await execFileAsync("git", ["commit", "-m", "agent work"], { cwd: wtPath });

      const diff = await captureChanges(wtPath, baseSha);
      assert.ok(diff !== null);
      assert.ok(diff.includes("committed.txt"));
      assert.ok(diff.includes("agent output"));
    } finally {
      await removeWorktree(tempRepo, wtPath);
    }
  });

  it("returns null when git diff fails", async () => {
    const wtPath = join(tempRepo, ".worktrees", "test-diff-fail");
    try {
      await createWorktree(tempRepo, wtPath);
      // Pass an invalid SHA to force git diff to fail
      const result = await captureChanges(wtPath, "0000000000000000000000000000000000000000");
      assert.equal(result, null);
    } finally {
      await removeWorktree(tempRepo, wtPath);
    }
  });
});

describe("readAndRemoveResponse", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "paf-response-test-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads and deletes the response file", async () => {
    const filename = ".paf-response.md";
    await writeFile(join(tempDir, filename), "The response content");

    const result = await readAndRemoveResponse(tempDir, filename);
    assert.equal(result, "The response content");
    assert.ok(!existsSync(join(tempDir, filename)));
  });

  it("returns null when the response file does not exist", async () => {
    const result = await readAndRemoveResponse(tempDir, ".paf-response.md");
    assert.equal(result, null);
  });

  it("works with a different filename", async () => {
    const filename = "custom-response.txt";
    await writeFile(join(tempDir, filename), "custom content");

    const result = await readAndRemoveResponse(tempDir, filename);
    assert.equal(result, "custom content");
    assert.ok(!existsSync(join(tempDir, filename)));
  });
});
