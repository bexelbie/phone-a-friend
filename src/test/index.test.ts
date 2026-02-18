// ABOUTME: Unit tests for pure utility functions in util.ts.
// ABOUTME: Tests wrapPrompt, generateWorktreePath, promptSizeWarning, shellEscape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wrapPrompt, generateWorktreePath, promptSizeWarning, shellEscape, PROMPT_SIZE_WARNING_THRESHOLD } from "../util.js";

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

  it("does not include commits encouragement in default mode", () => {
    const result = wrapPrompt("Do something");
    assert.ok(!result.includes("Commits are fine"));
  });

  it("default mode matches behavior when mode is omitted", () => {
    const withDefault = wrapPrompt("Do something", "default");
    const withoutMode = wrapPrompt("Do something");
    assert.equal(withDefault, withoutMode);
  });

  describe("query mode", () => {
    it("includes the user prompt", () => {
      const result = wrapPrompt("Review my code", "query");
      assert.ok(result.includes("Review my code"));
    });

    it("includes the response filename instruction", () => {
      const result = wrapPrompt("Review my code", "query");
      assert.ok(result.includes(".paf-response.md"));
    });

    it("tells the subagent changes will be discarded", () => {
      const result = wrapPrompt("Review my code", "query");
      assert.ok(result.includes("discarded"));
    });

    it("tells the subagent not to modify files", () => {
      const result = wrapPrompt("Review my code", "query");
      assert.ok(result.includes("Do NOT modify files"));
    });

    it("does not include push restriction", () => {
      const result = wrapPrompt("Review my code", "query");
      assert.ok(!result.includes("git push"));
    });

    it("includes instruction to create the response file", () => {
      const result = wrapPrompt("Review my code", "query");
      assert.ok(result.includes("MUST create"));
    });

    it("mentions the repo is for reading only", () => {
      const result = wrapPrompt("Review my code", "query");
      assert.ok(result.includes("reference only"));
    });
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

describe("shellEscape", () => {
  it("wraps a simple string in single quotes", () => {
    const result = shellEscape("hello");
    assert.equal(result, "'hello'");
  });

  it("escapes embedded single quotes", () => {
    const result = shellEscape("it's a test");
    assert.equal(result, "'it'\\''s a test'");
  });

  it("handles empty string", () => {
    const result = shellEscape("");
    assert.equal(result, "''");
  });

  it("handles strings with spaces", () => {
    const result = shellEscape("hello world");
    assert.equal(result, "'hello world'");
  });

  it("handles strings with special shell characters", () => {
    const result = shellEscape("echo $HOME && rm -rf /");
    assert.equal(result, "'echo $HOME && rm -rf /'");
  });

  it("handles multiple single quotes", () => {
    const result = shellEscape("it's Bob's");
    assert.equal(result, "'it'\\''s Bob'\\''s'");
  });
});
