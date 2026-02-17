### Proposal: Structured Tool Return Format

Here’s an additional option for solving this problem by introducing structured tool responses that guide the calling agent:

#### How It Works
The tool would return its output in a structured format, explicitly separating metadata, artifacts, and actionable guidance. For example:

- **Metadata**: Summarizes key details about the output (e.g., number of files/lines changed).
- **Artifacts**: Provides paths to temporary files (e.g., diffs or logs) with descriptions of their purpose and how they should be used.
- **Guidance**: Explicit next steps for the calling agent (e.g., review the patch file, apply it using `git apply`, and clean up temporary files).
- **Warnings**: Highlights concerns, such as large diff sizes or the need for thoughtful cleanup.

#### Example Workflow
1. The tool generates a structured response with metadata and paths to temporary artifacts (e.g., diffs saved to `/tmp/working-dir/`).
2. The calling agent reviews the provided metadata and decides whether to read, apply, or ignore the artifacts.
3. If desired, the calling agent applies patches using tools like `git apply`.
4. The calling agent is responsible for cleaning up artifacts after use.

This approach balances flexibility and responsibility by giving the calling agent clear, actionable information while minimizing unnecessary context bloat. It also ensures that temporary changes aren’t inadvertently committed unless explicitly included by the calling agent.