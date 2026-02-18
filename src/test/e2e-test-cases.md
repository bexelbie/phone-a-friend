# End-to-End Test Cases

These tests exercise the `phone_a_friend` MCP tool from within VS Code
Copilot Chat. They require the MCP server to be running and configured.

Run them by asking the calling agent to use the `phone_a_friend` tool
with the specified parameters.

## Test 1: Read-only task (no file changes expected)

**Goal:** Verify the tool returns a response with no diff when the
subagent doesn't modify files.

**Parameters:**
- model: `gpt-5-mini`
- prompt: `Read the file README.md and tell me in one sentence what this project does.`
- working_directory: (this repo)

**Expected:**
- Response: A coherent one-sentence summary of the project
- Diff: "No file changes were made."
- No errors or warnings

---

## Test 2: File creation (uncommitted changes)

**Goal:** Verify the tool returns a diff when the subagent creates a
new file without committing.

**Parameters:**
- model: `claude-haiku-4.5`
- prompt: `Create a new file called src/version.ts that exports a single constant VERSION set to "0.1.0". Include the required ABOUTME comments at the top of the file. The ABOUTME format is two comment lines at the very top, each starting with "// ABOUTME: ". Do NOT commit the changes.`
- working_directory: (this repo)

**Expected:**
- Response: Confirmation of file creation
- Diff: Unified diff showing `src/version.ts` as a new file with the
  ABOUTME comments and VERSION export
- No errors or warnings

---

## Test 3: File creation (committed changes)

**Goal:** Verify the tool captures changes even when the subagent
commits them. This was a bug (fixed by diffing against base SHA
instead of HEAD).

**Parameters:**
- model: `gemini-3-pro-preview`
- prompt: `Create a new file called src/version.ts with the following exact content, then commit the change:\n\n// ABOUTME: Exports the project version constant.\n// ABOUTME: Single source of truth for version strings.\n\nexport const VERSION = "0.1.0";`
- working_directory: (this repo)

**Expected:**
- Response: Confirmation of file creation and commit
- Diff: Unified diff showing `src/version.ts` as a new file (**must
  NOT be empty** — this is the regression test for the base SHA fix)
- No errors or warnings

---

## Test 4: Existing file modification

**Goal:** Verify the tool returns a diff when the subagent modifies an
existing file.

**Parameters:**
- model: `gpt-4.1`
- prompt: `In src/util.ts, add a new exported function called "parseModelName" that takes a string and returns it lowercased and trimmed. Add it after the existing exports. Include a brief JSDoc comment.`
- working_directory: (this repo)

**Expected:**
- Response: Confirmation of the change
- Diff: Unified diff showing modifications to `src/util.ts` with the
  new function added
- No errors or warnings

---

## Test 5: Error handling — non-git directory

**Goal:** Verify the tool returns a clear error when pointed at a
directory outside any git repo.

**Parameters:**
- model: `gpt-5-mini`
- prompt: `List files`
- working_directory: `/tmp`

**Expected:**
- Response: Error message stating the directory is not a git repository
- `isError: true` in the MCP response

---

## Test 6: Query mode (read-only analysis)

**Goal:** Verify that query mode returns only the response with no diff
section, even if the subagent makes file changes.

**Parameters:**
- model: `gpt-5-mini`
- prompt: `Read src/util.ts and describe what each exported function does in one sentence each.`
- working_directory: (this repo)
- mode: `query`

**Expected:**
- Response: A coherent summary of the exported functions
- No "File Changes" section in the output at all
- No errors or warnings

---

## Notes

- Tests 1-4 all run in isolated worktrees, so they don't modify the
  actual working tree. Safe to re-run at any time.
- After each test, verify the working tree is clean (`git status`).
- If a test fails due to an empty diff, check whether the MCP server
  process was restarted after the latest build.
- Models occasionally ignore the message-in-a-bottle instructions. If
  the response says "No response file was created," the test is still
  valid — it's a model reliability issue, not a code bug.
