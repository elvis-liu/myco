# Claude Agent SDK — research report for myco

**Branch:** `agent-sdk-research`  
**Date:** 2026-05-15  
**Author:** Claude Opus 4.7 (1M context), via WebFetch of `code.claude.com/docs/en/agent-sdk/*`  
**Audience:** kkrazy, senior engineer — deciding whether to pivot myco off the
PTY-scraping `claude` CLI subprocess onto the Agent SDK.

---

## 1. SDK identity + availability

| Item | Value |
|---|---|
| TypeScript package | `@anthropic-ai/claude-agent-sdk` ([npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)) |
| Python package | `claude-agent-sdk` ([PyPI](https://pypi.org/project/claude-agent-sdk/) / [GitHub](https://github.com/anthropics/claude-agent-sdk-python)) |
| TS GitHub | [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) |
| Canonical docs | [code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview) |
| Renamed from | "Claude Code SDK" → "Claude Agent SDK" (migration guide on docs) |
| License | Anthropic Commercial Terms of Service (commercial use permitted) |
| Maintenance | Active — both SDKs have public CHANGELOG.md and open issue trackers |

**Critical note for myco's deploy model:** the TypeScript SDK *bundles a native
Claude Code binary* as an optional dependency — so it ships with the same
underlying engine the CLI uses. There's no second runtime to install.

**Auth modes:**
- `ANTHROPIC_API_KEY` env var (default)
- AWS Bedrock (`CLAUDE_CODE_USE_BEDROCK=1` + AWS creds)
- Vertex AI (`CLAUDE_CODE_USE_VERTEX=1`)
- Azure (`CLAUDE_CODE_USE_FOUNDRY=1`)
- **No claude.ai subscription auth for third-party REDISTRIBUTION** — Anthropic
  disallows third parties offering subscription login *to their customers*
  (e.g., a SaaS where N customers share one sub). **For personal use it's
  fine**: empirically verified by installing the SDK in this container with
  no `ANTHROPIC_API_KEY` set — the SDK picked up `~/.claude/.credentials.json`
  (populated by `claude login`) and ran a successful query against the Pro
  subscription. For myco specifically: as long as each collaborator runs
  `claude login` with their OWN account, no auth changes needed for the SDK
  pivot. The centralized-API-key model only matters if myco wanted to bill
  on behalf of users (free-trial, demo accounts, etc.).

**June 15 2026 billing change:** Agent SDK and `claude -p` usage on
subscription plans draws from a new monthly Agent SDK credit pool ($20/mo
on Pro, $200/mo on Max), separate from interactive limits.

---

## 2. What you get (with exact names)

### Message loop
- **Entry point:** `query({ prompt, options })` returns an **async iterable** of
  message objects. Iterate with `for await (const message of query(...))`.
- **Single-turn:** pass a string as `prompt`.
- **Multi-turn / streaming input:** pass an async generator yielding
  `{type: 'user', message: {role, content}}`; lets you interrupt or send
  follow-up while the agent is mid-task.
- **Long-running session object:** `ClaudeSDKClient` (Python) /
  the iterator's `setPermissionMode()`-style methods (TS) — for sessions
  that need to mutate mid-flight.

### Message types you receive
- `system` (subtypes include `init` carrying `session_id`)
- `assistant` (text and tool_use blocks)
- `tool_result`
- `result` (final outcome, with `subtype: "success"` etc.)

### Built-in tools (no BYO required)
Same set as Claude Code CLI: `Read`, `Write`, `Edit`, `Bash`, `Monitor`,
`Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task` (subagents),
`AskUserQuestion`, plus MCP tools.

### Permission gating — `canUseTool` callback
- **Option name:** `canUseTool` (TS) / `can_use_tool` (Python).
- **Fires:** before a tool runs, when nothing in the evaluation chain
  (Hooks → deny rules → permission mode → allow rules) resolved it.
- **Signature:**
  ```ts
  async (toolName: string, input: object, options: { signal: AbortSignal, suggestions?: PermissionUpdate[] }) =>
    | { behavior: "allow", updatedInput: object, updatedPermissions?: PermissionUpdate[] }
    | { behavior: "deny",  message: string }
  ```
- **Allow + remember:** echo any of `options.suggestions` back in
  `updatedPermissions` to persist a `.claude/settings.local.json` rule so
  future matching calls skip the prompt.
- **Allow + modify:** pass a modified `updatedInput` (server-side sanitization
  of paths, scope-limiting Bash commands, etc.).
- **Deny + explain:** `message` is shown to Claude so it can adjust its plan.
- **Indefinite pause:** the SDK pauses until you return; ok for human-in-loop.
  For very long waits, return the `defer` hook decision and resume via
  persisted session later.

### AskUserQuestion
- Implemented as a tool whose name is `"AskUserQuestion"`. Fires the SAME
  `canUseTool` callback as any other tool — distinguish by
  `toolName === "AskUserQuestion"`.
- **Input shape** (verbatim from docs):
  ```json
  {
    "questions": [
      {
        "question": "<full text>",
        "header": "<≤12 char chip>",
        "options": [{ "label": "...", "description": "...", "preview"?: "..." }],
        "multiSelect": false
      }
    ]
  }
  ```
- **Response shape:** return `{ behavior: "allow", updatedInput: { questions: input.questions, answers: {<question>: <selected label>} } }`.
- **Per-session preview format:** `toolConfig.askUserQuestion.previewFormat: "markdown" | "html"` adds a `preview` field with rich content per option.
  HTML is sanitised (`<script>`, `<style>`, `<!DOCTYPE>` stripped before our
  callback sees it).
- **Limits:** 1–4 questions per call, 2–4 options each. NOT available inside
  subagents.

### Permission modes (`permissionMode`)
- `default` — no auto-approvals, unmatched tools hit `canUseTool`
- `dontAsk` — anything not pre-approved is denied; `canUseTool` skipped
- `acceptEdits` — auto-approves file ops + filesystem commands (`mkdir`, `rm`,
  `mv`, `cp`, `sed`); only within `cwd` or `additionalDirectories`
- `bypassPermissions` — approves everything (hooks still run); deny rules
  still hold
- `plan` — read-only mode for analysis without edits; `AskUserQuestion`
  works here
- `auto` (TS only) — model-classified approvals

Mode can be changed mid-session via `setPermissionMode()` / `set_permission_mode()`.

### Hooks
- Options key: `hooks: { PreToolUse: [...], PostToolUse: [...], Stop: [...], SessionStart, SessionEnd, UserPromptSubmit, ... }`.
- Each entry is a `HookMatcher`-style `{ matcher: <tool-name-regex>, hooks: [<callback>] }`.
- Hooks run BEFORE permission evaluation — can `allow`, `deny`, or `modify`
  before `canUseTool` is even consulted.
- There's a dedicated `PermissionRequest` hook for external notifications
  (Slack/email/push) when Claude is waiting on approval — myco could use
  this directly for chat-pane menu cards.

### MCP server support
- Option: `mcpServers: { <name>: { command, args, env? } }`.
- The SDK spawns + manages each MCP child process; tools from MCP servers
  appear in the same `tool_use` stream as built-ins.

### Auth + credential discovery
- Reads `~/.claude/` and `.claude/` in cwd for settings (skills,
  slash-commands, memory `CLAUDE.md`, plugins).
- `settingSources` option restricts which sources load.

### Sessions
- Each `query()` emits a `system` message with `subtype: "init"` carrying
  `session_id`. Persist that ID to resume later.
- Resume: `options.resume: <session_id>`. Full prior conversation + read
  files + analysis intact.
- Fork: same mechanism, lets you branch off a prior session.
- Session state: JSONL on local filesystem (same path Claude Code CLI uses,
  `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`).

### Working directory
- `options.cwd` sets where built-in tools (Read/Write/Edit/Bash) operate.
- `additionalDirectories` widens the safe scope for `acceptEdits` and
  filesystem operations.

### Subagents
- `options.agents: { <name>: { description, prompt, tools } }` defines
  specialized subagents.
- Subagent invocations show up in the parent's message stream tagged with
  `parent_tool_use_id` so you can route them appropriately.
- ⚠ **Subagent inheritance:** if the parent runs with `bypassPermissions`,
  `acceptEdits`, or `auto`, subagents inherit it and **cannot override** per
  subagent. Relevant for any future myco "agent within agent" features.

---

## 3. SDK vs CLI subprocess (myco-specific)

### Wins from switching to SDK
1. **Structured `AskUserQuestion`** — eliminates the entire menu-interceptor
   TUI-scraping path. The questions, options, and answers are typed objects.
   Today's "Superseded by a newer dialog" bug class **disappears at the root**.
2. **Structured permission requests** — `canUseTool` fires with `toolName +
   input`, no regex matching against terminal text. Today's `permissions.js`
   pattern-matching for `Bash(git)` etc. becomes a server-side decision instead
   of TUI-position-dependent scraping.
3. **No PTY ring buffer / no replay flicker** — events are JSON; resume just
   re-iterates from `session_id`. **The open "resume after background → missed
   output" bug goes away** as a class.
4. **Hooks (PreToolUse, PostToolUse, SessionStart, etc.)** — first-class
   extension points for things like our `[chat→pty]` logging, the
   `_supersedeStaleMenus` pattern (no longer needed), audit trails.
5. **Single Node process per session, not a forked subprocess** — fewer fd
   leaks, easier to instrument, more deterministic test fixtures.
6. **Live `setPermissionMode()`** — myco could expose a UI toggle that flips
   from `default` → `acceptEdits` mid-session, replacing today's per-tool
   `/allow Bash(rm)` allow-list churn.

### What we LOSE / things to plan around
1. **No xterm.js replay of arbitrary tool output as a terminal.** Today we
   render the live PTY in a browser xterm. With the SDK there IS no TTY —
   tool output is structured JSON. We'd need to render Bash output, Read
   results, etc. as styled blocks. Could be a feature (richer UI) or a
   regression (no copy-paste from a real terminal). The CLI Plan-mode wizard's
   custom TUI rendering doesn't exist either.
2. **Subscription auth — fine for personal use, blocked for redistribution.**
   (Updated 2026-05-15 after empirical test.) The SDK picks up
   `~/.claude/.credentials.json` populated by `claude login` and runs against
   the subscription — no API key needed. Verified in-container with no
   `ANTHROPIC_API_KEY` set. The "third-party redistribution" wording in the
   docs is about offering subscription auth *to your customers*, not about
   the SDK refusing to work with subscription credentials. **Net: no auth
   changes required for the SDK pivot in myco's current single-tenant
   model.**
3. **Slash commands** that Claude Code's TUI implements (`/clear`, `/agents`,
   `/init`, `/help` inside Claude) — we'd need to reimplement any user-facing
   ones, or surface "this is an SDK session, those commands don't apply" UX.
4. **MCP servers run per-session-process.** With the CLI today, each session
   gets one MCP child. With the SDK we'd do the same, but it's now OUR
   responsibility to lifecycle (start/stop/reap zombie MCP processes).
5. **No `claude --resume` semantics from outside the SDK.** Session-resume
   only works from within the SDK; you can't `claude --resume <id>` to drop
   into the same context interactively. (Probably fine for myco — the
   session lives in our process either way.)
6. **Model fallbacks, cost-routing.** CLI has built-in fallback chains
   (Opus → Sonnet, etc.). SDK exposes `model` option but the routing logic
   is the caller's problem.

### CLI-only features as of cutoff
- Plan-mode wizard rendering (the `❯` selector menus we currently scrape).
  SDK's `plan` permission mode exists but the wizard UI is CLI-rendered;
  in SDK that flow becomes `AskUserQuestion` calls.
- Trust-folder onboarding dialog (CLI shows on first cwd visit).
- The `--continue` shortcut to resume the latest session in a dir.
- TUI status bar / spinner / token counter.

---

## 4. Canonical hello-world (Node)

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "List the *.ts files under server/ and tell me which is largest",
  options: {
    cwd: "/wks/kkrazy/myco",
    permissionMode: "default",
    allowedTools: ["Bash", "Glob", "Read", "AskUserQuestion"],
    canUseTool: async (toolName, input, { suggestions = [] }) => {
      // 1. AskUserQuestion → present to user, return their selection
      if (toolName === "AskUserQuestion") {
        const answers: Record<string, string> = {};
        for (const qq of input.questions) {
          // ... gather answer from your UI ...
          answers[qq.question] = qq.options[0].label;  // pretend user picked first
        }
        return { behavior: "allow", updatedInput: { questions: input.questions, answers } };
      }
      // 2. Tool needs approval → defer to UI; here we auto-approve Bash for the demo
      if (toolName === "Bash") {
        console.log("[permission] Bash:", input.command);
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "Tool not on the demo allow-list" };
    },
    hooks: {
      PreToolUse: [{ matcher: ".*", hooks: [async (input, toolUseId, ctx) => {
        console.log("[hook] PreToolUse:", input.tool_name, "(id=" + toolUseId + ")");
        return { continue_: true };
      }] }],
    },
  },
});

let sessionId: string | undefined;
for await (const m of q) {
  // m.type: "system" | "assistant" | "tool_result" | "result"
  if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
  if (m.type === "assistant") {
    for (const block of m.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
      if (block.type === "tool_use") console.log("\n[tool_use]", block.name, JSON.stringify(block.input).slice(0, 200));
    }
  }
  if ("result" in m) console.log("\n[result]", m.result?.slice(0, 200));
}
console.log("\nsession_id for resume:", sessionId);
```

What we'd observe:
- `system/init` arrives first carrying `session_id`.
- `assistant` messages carry interleaved `text` and `tool_use` blocks.
- `canUseTool` fires per tool the model wants to run — including the special
  `AskUserQuestion` case.
- `tool_result` lands after each tool returns.
- `result` (`subtype: "success"`) marks end-of-turn.

That `tool_use` block IS our future menu-card source for permission dialogs,
and the `AskUserQuestion` branch is the menu-card source for clarifying
questions. Neither requires touching a terminal.

---

## 5. Gotchas

| Issue | Notes for myco |
|---|---|
| `canUseTool` requires streaming-input mode in **Python** + a dummy `PreToolUse` hook returning `{continue_: True}` to keep the stream open. TS is fine without the workaround. | We're TS, so unaffected. |
| Subagents can't call `AskUserQuestion`. | If we use SDK subagents for parallel work, they won't be able to ask clarifying questions back through our UI. |
| `bypassPermissions` is inherited by subagents and cannot be overridden. | Big footgun for "spawn this subagent in safe mode" patterns. |
| The TS SDK bundles a Claude Code native binary as `optionalDependency`. | Means our Docker image gets bigger; means alpine vs glibc could bite. Confirm the binary exists for our base image (Debian-slim is currently used). |
| Subscription auth not permitted for third parties. | **Hard blocker for "user brings their own claude.ai sub"** model. We'd centralize on an API key or require per-user API keys. |
| `defer` hook decision lets the process exit and resume later. | Useful for long-pending approvals (user takes hours). But persistence-layer details are on us. |
| Errors / 429 / 529: SDK surfaces them as messages in the stream; retry policy is the caller's responsibility. | Today's "API Error: 529 Overloaded" we see in logs would still appear; we'd handle it as a `result` subtype rather than scraping the TUI. |
| Sessions persist as JSONL at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`. | Same place CLI writes them. We already tail this for transcript view; the SDK driving the loop instead of CLI doesn't change the on-disk format. |

---

## TL;DR for the build/buy/stay decision

**Stay on CLI subprocess** if:
- Per-user claude.ai subscription auth is a hard requirement, OR
- The xterm.js live terminal pane is non-negotiable UX, OR
- We want CLI-only features (plan-mode wizard rendering, trust dialog, etc.) intact

**Switch to Agent SDK** if:
- We're willing to centralize on API-key billing (or per-user API keys), AND
- We accept rebuilding the "terminal pane" as a structured tool-output renderer, AND
- We value killing the entire TUI-scraping bug class — `AskUserQuestion` /
  `PermissionRequest` mismatches stop being a thing.

The structural wins are real: today's menu-interceptor `_supersedeStaleMenus`,
hash-guard for "stale click on menu A", queue-and-retry for post-restart picks,
ring-buffer for resume — all become unnecessary. They exist because we're
inferring conversation state from rendered terminal text. With the SDK the
state IS the data, not a rendering of it.

**Concrete first step (Phase 0):** spend an evening on
`server/src/agent-sdk-experiment.js` driving a single query, printing every
event shape against THIS repo's CLAUDE.md so we see the real `AskUserQuestion`
+ `PermissionRequest` payloads on our actual auth + working dir. Then decide
whether to scope Phase 1+.

## Sources

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [@anthropic-ai/claude-agent-sdk on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [anthropics/claude-agent-sdk-typescript GitHub](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Use the Claude Agent SDK with your Claude plan (billing)](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
