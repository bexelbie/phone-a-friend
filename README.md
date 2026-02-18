# Phone a Friend

An MCP server that lets [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) in Visual Studio Code dispatch work to a **different AI model** via [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli/about-github-copilot-in-the-cli).  This not only allows diverse model usage but it also provides a path to getting gutter indicators for those changes.

## The Problem

When you use GitHub Copilot Chat in VS Code, every subagent it spawns runs on the same model as the parent conversation. If you're on Claude Opus 4.6, all subagents are Claude Opus 4.6. Sometimes you want a different model for a subtask — a faster one for simple work, or a different vendor for a second opinion.

GitHub Copilot CLI supports `--model` to pick any available model, but using it directly doesn't help — changes made by the CLI don't produce VS Code's [gutter indicators](https://code.visualstudio.com/docs/sourcecontrol/staging-commits#_editor-gutter-indicators) (the green/blue/red diff decorations in the editor margin).

Phone a Friend solves this by returning a unified diff that the calling agent applies through VS Code's edit tools, giving you the same inline diff experience as if the changes were made natively.

## How It Works

1. GitHub Copilot Chat calls the `phone_a_friend` MCP tool with a prompt and model name
2. The MCP server creates an isolated **git worktree** from the current repo's HEAD
3. It launches GitHub Copilot CLI in non-interactive mode in that worktree with the requested model
4. The subagent does its work and writes its response to a **message-in-a-bottle file** (`.paf-response.md`)
5. The MCP server reads the response, captures a `git diff` of all changes, and cleans up the worktree
6. Returns the response text and unified diff to the calling agent
7. The calling agent applies the diff using VS Code's edit tools, producing gutter indicators

**Context cost warning:** The unified diff is returned as part of the tool result, which means it lands in the calling agent's context window. For large diffs this can be significant. Keep subtasks focused to keep diffs small.

### Why "message in a bottle"?

GitHub Copilot CLI does not provide a way to retrieve just the agent's final response text. Its stdout mixes the response with progress output and is unreliable to parse. Rather than trying to extract a clean response from noisy output — and inflating the calling agent's context with the subagent's full thinking and execution log — we skip stdout entirely. The subagent writes its response to a file. We read the file.

## Prerequisites

- **Node.js** >= 22.0.0
- **GitHub Copilot CLI** — installed, configured, and authenticated. See [About GitHub Copilot in the CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli/about-github-copilot-in-the-cli) for setup instructions.
- **Git** — for worktree management
- A **git repository** to work in (the tool operates on git repos)

Verify Copilot CLI is working:

```bash
copilot --help
```

## Setup

In VS Code, open the Command Palette and run `MCP: Add Server...`, select `npm Package`, and enter `@bexelbie/phone-a-friend`.

Or add it manually to `.vscode/mcp.json` (workspace) or via `MCP: Open User Configuration` (global):

```json
{
  "servers": {
    "phone-a-friend": {
      "type": "stdio",
      "command": "npx",
      "args": ["@bexelbie/phone-a-friend"]
    }
  }
}
```

## Usage

Once configured, the `phone_a_friend` tool is available in GitHub Copilot Chat. You tell the agent what you want, and the agent decides how to use the tool — constructing the prompt, choosing the model, including context, and applying the returned diff.

### Example prompts you might give Copilot Chat

Ask a different model for a code review:
```
Use phone_a_friend with gpt-5 to review the changes in src/parser.ts and suggest improvements.
```

Get a second opinion on architecture:
```
Phone a friend using claude-sonnet-4.5 to evaluate whether our current database schema will scale to 100k users.
```

Have a faster model do grunt work:
```
Use phone_a_friend with gpt-5-mini to write unit tests for all public functions in src/utils.ts.
```

### How agents discover the tool

The MCP server exposes the tool name, description, and parameter schemas to the calling agent via the MCP protocol. The tool description includes "when to use" and "when not to use" guidance so agents can decide whether `phone_a_friend` is appropriate for a given task.

**Interaction patterns that work:**
- **Explicit tool name**: "Use phone_a_friend with gpt-5 to..." — always works
- **Natural name**: "Phone a friend using claude-sonnet-4.5 to..." — agents match the tool name
- **Model-oriented**: "Ask gpt-5 to review this code" or "Get a second opinion from claude-sonnet-4" — agents recognize the request for a different model and match it to the tool
- **Keyword triggers**: Mentioning "subagent", "different model", or "second opinion" in a coding context — the tool description tells agents to look for these signals

**Patterns that probably won't trigger the tool automatically:**
- Vague delegation like "use subagents where appropriate" — the agent may not proactively reach for this tool without a specific model or second-opinion request
- Tasks that the current model can handle directly — agents generally prefer their own capabilities over adding a tool-call round trip

If you want the agent to consistently use this tool, be specific: name the tool, name the model, or clearly ask for a different model's perspective.

### What the calling agent is responsible for

The tool description tells the calling agent what it needs to know, but in short:

- **Prompt construction**: The subagent only sees committed files. If the user's request involves uncommitted work, the calling agent must include the relevant file contents in the prompt.
- **Working directory**: The calling agent must always pass `working_directory` explicitly, using the workspace path from the conversation context. The MCP server's own working directory is not the user's workspace.
- **Diff application**: The tool returns a unified diff. The calling agent applies it using its own edit tools to produce gutter indicators.
- **Context management**: The diff lands in the calling agent's context window. The calling agent should keep subtasks focused to avoid large diffs.

### Available models

The following models are available as of the latest release of this project. We try to check periodically, but if you discover models are missing, please open an issue or PR.

- `claude-sonnet-4.5`, `claude-haiku-4.5`, `claude-opus-4.6`, `claude-opus-4.6-fast`, `claude-opus-4.5`, `claude-sonnet-4`
- `gemini-3-pro-preview`
- `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1-codex-max`, `gpt-5.1-codex`, `gpt-5.1`, `gpt-5`, `gpt-5.1-codex-mini`, `gpt-5-mini`, `gpt-4.1`

You can direct the model to pass any model name directly — GitHub Copilot CLI validates it at runtime.

## Tool Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `prompt` | Yes | The task or question for the other model. Include relevant context. |
| `model` | Yes | Which AI model to use (see list above). |
| `working_directory` | Yes | Git repo directory to work in. Must be inside a git repository. Always pass this explicitly — the server's own working directory is not the user's workspace. |
| `mode` | No | `"default"` returns the response and a unified diff of file changes. `"query"` discards all file changes and returns only the response — use for reviews, analysis, or questions. Default: `"default"`. |

## Safety

- **Push protection**: The CLI is invoked with `--deny-tool 'shell(git push*)'` which blocks all push attempts at the tool level. The prompt also instructs the agent not to push.
- **Worktree isolation**: All work happens in a temporary git worktree. Your working tree is never modified directly.
- **Query mode**: When `mode` is `"query"`, all file changes in the worktree are discarded. The subagent is instructed that the repo is read-only. No git diff is returned.
- **Automatic cleanup**: Worktrees are removed after each invocation, even on errors.
- **No secrets exposure**: The subagent has the same access as `copilot` CLI running locally — no additional permissions are granted.

## Known Limitations

- **Blocks the calling agent**: MCP tool calls are synchronous — this is a property of the MCP protocol, not this tool. The calling agent waits for the subagent to finish before it can do anything else. Keep subtasks focused.
- **Uncommitted changes**: The worktree is created from HEAD. Uncommitted changes in your working tree are not visible to the subagent. The calling agent's tool description instructs it to include relevant file contents in the prompt when needed.
- **Message-in-a-bottle compliance**: The subagent must follow instructions to write `.paf-response.md`. Most models do, but some may occasionally ignore the instruction.
- **No streaming**: There is nothing to stream — the response is a file and a diff, both captured after the subagent finishes.

## Development

```bash
git clone https://github.com/bexelbie/phone-a-friend.git
cd phone-a-friend
npm install
npm run build     # Compile TypeScript
npm test          # Run tests
npm run dev       # Watch mode for development
```

### Testing a local build in VS Code

If you have phone-a-friend installed globally (via `npx @bexelbie/phone-a-friend`), you need to point VS Code at your local build instead. Update your MCP configuration (`.vscode/mcp.json` or user-level `mcp.json`) to use `node` with the local dist path:

```json
{
  "servers": {
    "phone-a-friend": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/phone-a-friend/dist/index.js"
      ],
      "env": {}
    }
  }
}
```

Replace `/absolute/path/to/phone-a-friend` with the actual path to your clone.

After changing the config:

1. Build your changes: `npm run build`
2. In VS Code, open the Command Palette and run `MCP: List Servers`
3. Select `phone-a-friend` and choose `Restart Server` to pick up the new code
4. Test in Copilot Chat — the tool will now use your local build

When you're done testing, revert the MCP config back to `npx`:

```json
{
  "servers": {
    "phone-a-friend": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "@bexelbie/phone-a-friend"
      ],
      "env": {}
    }
  }
}
```

## License

MIT
