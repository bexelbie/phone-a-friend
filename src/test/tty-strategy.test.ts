// ABOUTME: Tests different TTY strategies for spawning Copilot CLI.
// ABOUTME: Determines whether `script` wrapper is needed or direct spawn works.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { RESPONSE_FILENAME, wrapPrompt, shellEscape } from "../util.js";

const execFileAsync = promisify(execFile);

// Skip the entire file if copilot CLI is not installed
let copilotAvailable = false;
try {
  await execFileAsync("copilot", ["--version"]);
  copilotAvailable = true;
} catch {
  // copilot not available
}

// Simple task that's fast and easy to verify
const TEST_PROMPT = "Create a file called test-output.txt in the repo root containing exactly the text 'hello from copilot'. Nothing else.";
const WRAPPED_PROMPT = wrapPrompt(TEST_PROMPT);

// Generous timeout — copilot can be slow to start
const CLI_TIMEOUT_MS = 120_000;

/**
 * Spawns copilot directly with no TTY wrapper.
 * This is the simplest approach — if it works, Windows support is free.
 */
function spawnDirect(
  cwd: string,
  prompt: string,
  model: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      "-p", prompt,
      "--model", model,
      "--allow-all",
      "--deny-tool", "shell(git push*)",
      "--no-alt-screen",
      "--no-color",
    ];

    const child = spawn("copilot", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ exitCode: -1, stdout, stderr: stderr + "\n[TIMEOUT after " + CLI_TIMEOUT_MS + "ms]" });
    }, CLI_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });
}

/**
 * Spawns copilot with stdio: 'inherit' — gives it the parent's TTY.
 * Won't work in MCP (stdio is the protocol), but tells us if
 * copilot *needs* a TTY or just *prefers* one.
 */
function spawnInherit(
  cwd: string,
  prompt: string,
  model: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      "-p", prompt,
      "--model", model,
      "--allow-all",
      "--deny-tool", "shell(git push*)",
      "--no-alt-screen",
      "--no-color",
    ];

    const child = spawn("copilot", args, {
      cwd,
      // Give it our terminal's stdin/stdout/stderr directly
      stdio: "inherit",
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ exitCode: -1, stdout: "", stderr: "[TIMEOUT after " + CLI_TIMEOUT_MS + "ms]" });
    }, CLI_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      // Can't capture output with inherit, just report exit code
      resolve({ exitCode: code ?? 1, stdout: "[inherited stdio]", stderr: "" });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: "", stderr: err.message });
    });
  });
}

/**
 * Spawns copilot via the `script` command (current production approach).
 * macOS and Linux only.
 */
function spawnWithScript(
  cwd: string,
  prompt: string,
  model: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const copilotArgs = [
      "-p", prompt,
      "--model", model,
      "--allow-all",
      "--deny-tool", "shell(git push*)",
      "--no-alt-screen",
      "--no-color",
    ];

    const isLinux = platform() === "linux";
    const scriptArgs = isLinux
      ? ["-qc", `copilot ${copilotArgs.map(shellEscape).join(" ")}`, "/dev/null"]
      : ["-q", "/dev/null", "copilot", ...copilotArgs];

    const child = spawn("script", scriptArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ exitCode: -1, stdout, stderr: stderr + "\n[TIMEOUT after " + CLI_TIMEOUT_MS + "ms]" });
    }, CLI_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });
}

/**
 * Sets up a fresh temp git repo for a test, runs a strategy,
 * and returns both the spawn result and what files were created.
 */
async function runStrategy(
  strategyName: string,
  spawnFn: (cwd: string, prompt: string, model: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  model: string
): Promise<{
  strategyName: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  responseFileExists: boolean;
  responseContent: string | null;
  testOutputExists: boolean;
  testOutputContent: string | null;
}> {
  // Each strategy gets its own temp repo
  const tempDir = await mkdtemp(join(tmpdir(), `paf-tty-${strategyName}-`));

  try {
    // Init repo with a committed file
    await execFileAsync("git", ["init"], { cwd: tempDir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: tempDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: tempDir });
    await writeFile(join(tempDir, "README.md"), "# Test repo for TTY strategy\n");
    await execFileAsync("git", ["add", "."], { cwd: tempDir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: tempDir });

    // Run the strategy
    const result = await spawnFn(tempDir, WRAPPED_PROMPT, model);

    // Check results
    const responseFilePath = join(tempDir, RESPONSE_FILENAME);
    const testOutputPath = join(tempDir, "test-output.txt");

    const responseFileExists = existsSync(responseFilePath);
    let responseContent: string | null = null;
    if (responseFileExists) {
      responseContent = await readFile(responseFilePath, "utf-8");
    }

    const testOutputExists = existsSync(testOutputPath);
    let testOutputContent: string | null = null;
    if (testOutputExists) {
      testOutputContent = await readFile(testOutputPath, "utf-8");
    }

    return {
      strategyName,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      responseFileExists,
      responseContent,
      testOutputExists,
      testOutputContent,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// Use a fast, cheap model for testing
const TEST_MODEL = "claude-haiku-4.5";

describe("TTY strategy investigation", { skip: !copilotAvailable ? "copilot CLI not installed" : undefined }, () => {

  it("Strategy 1: direct spawn (no TTY)", { timeout: CLI_TIMEOUT_MS + 10_000 }, async () => {
    const result = await runStrategy("direct", spawnDirect, TEST_MODEL);

    console.log("\n=== DIRECT SPAWN RESULTS ===");
    console.log(`Exit code: ${result.exitCode}`);
    console.log(`Response file exists: ${result.responseFileExists}`);
    console.log(`Test output file exists: ${result.testOutputExists}`);
    if (result.responseContent) {
      console.log(`Response content (first 200 chars): ${result.responseContent.substring(0, 200)}`);
    }
    if (result.testOutputContent) {
      console.log(`Test output content: ${result.testOutputContent}`);
    }
    if (result.stderr) {
      console.log(`Stderr (first 500 chars): ${result.stderr.substring(0, 500)}`);
    }
    console.log("=== END DIRECT ===\n");

    // We're investigating — record what happened, don't assert success.
    // The key question: did it work at all?
    if (result.exitCode === 0 && result.testOutputExists) {
      console.log(">>> DIRECT SPAWN WORKS! No TTY wrapper needed. <<<");
    } else if (result.exitCode === 0 && !result.testOutputExists) {
      console.log(">>> Direct spawn exited OK but task wasn't completed. Suspicious. <<<");
    } else {
      console.log(`>>> Direct spawn failed with exit code ${result.exitCode}. TTY likely required. <<<`);
    }

    // Always pass — this is investigative
    assert.ok(true, "Investigation complete");
  });

  it("Strategy 2: stdio inherit (TTY from parent)", { timeout: CLI_TIMEOUT_MS + 10_000 }, async () => {
    const result = await runStrategy("inherit", spawnInherit, TEST_MODEL);

    console.log("\n=== INHERIT SPAWN RESULTS ===");
    console.log(`Exit code: ${result.exitCode}`);
    console.log(`Response file exists: ${result.responseFileExists}`);
    console.log(`Test output file exists: ${result.testOutputExists}`);
    if (result.responseContent) {
      console.log(`Response content (first 200 chars): ${result.responseContent.substring(0, 200)}`);
    }
    if (result.testOutputContent) {
      console.log(`Test output content: ${result.testOutputContent}`);
    }
    console.log("=== END INHERIT ===\n");

    if (result.exitCode === 0 && result.testOutputExists) {
      console.log(">>> INHERIT works. Copilot needs a TTY but accepts the parent's. <<<");
    } else if (result.exitCode === 0 && !result.testOutputExists) {
      console.log(">>> Inherit exited OK but task wasn't completed. <<<");
    } else {
      console.log(`>>> Inherit failed with exit code ${result.exitCode}. <<<`);
    }

    assert.ok(true, "Investigation complete");
  });

  it("Strategy 3: script wrapper (current production approach)", { timeout: CLI_TIMEOUT_MS + 10_000 }, async () => {
    const result = await runStrategy("script", spawnWithScript, TEST_MODEL);

    console.log("\n=== SCRIPT WRAPPER RESULTS ===");
    console.log(`Exit code: ${result.exitCode}`);
    console.log(`Response file exists: ${result.responseFileExists}`);
    console.log(`Test output file exists: ${result.testOutputExists}`);
    if (result.responseContent) {
      console.log(`Response content (first 200 chars): ${result.responseContent.substring(0, 200)}`);
    }
    if (result.testOutputContent) {
      console.log(`Test output content: ${result.testOutputContent}`);
    }
    if (result.stderr) {
      console.log(`Stderr (first 500 chars): ${result.stderr.substring(0, 500)}`);
    }
    console.log("=== END SCRIPT ===\n");

    if (result.exitCode === 0 && result.testOutputExists) {
      console.log(">>> SCRIPT WRAPPER works (expected — this is the known-good baseline). <<<");
    } else {
      console.log(`>>> SCRIPT WRAPPER failed! Exit code ${result.exitCode}. Something is wrong. <<<`);
    }

    assert.ok(true, "Investigation complete");
  });
});
