# Mycelium — Handoff Spec

This is the implementation spec for **Mycelium**, a web UI to monitor and control Claude Code agent sessions running on remote workstations over SSH. Mobile-first, with a custom keyboard tuned for Claude Code's prompts.

You (Claude Code) are picking up this project from scratch. Implement the day-1 scope at the bottom of this doc. Defer everything in the "out of scope" section.

---

## Architecture

```
[browser] ←─ HTTP/WS ─→ [mycod (Node.js)] ←─ SSH ─→ [workstation N]
                                                                ├─ ~/.myco/hook.sh
                                                                ├─ ~/.myco/sessions/<id>/state.json
                                                                └─ tmux session running `claude`
```

Three components:

1. **Hook** (`hook/hook.sh`) — Bash script invoked by Claude Code's hook system on every event (SessionStart, UserPromptSubmit, Notification, Stop, etc.). Atomically updates `~/.myco/sessions/<session_id>/state.json` on the workstation. Must be fast (<50ms) and never block Claude — exits 0 on any error.

2. **Server** (`server/`) — Single Node.js process. Maintains one SSH connection per configured workstation. Polls or watches state files. Exposes HTTP + WebSocket to browsers. Proxies pty bytes between browser WebSockets and remote tmux sessions via `ssh exec`.

3. **Web** (`web/public/`) — Static HTML/JS app. Lists sessions across all workstations. Click a session to attach: full-screen terminal (xterm.js) with the custom keyboard pinned to the bottom on mobile.

No auth in v1. No daemon process on the workstation. No database — server holds state in memory.

---

## state.json schema

Written by the hook, consumed by the server. One file per Claude Code session, at `~/.myco/sessions/<session_id>/state.json`.

```json
{
  "session_id": "abc123",
  "workstation": "studio-mbp",
  "cwd": "/Users/me/code/acme-api",
  "transcript_path": "/Users/me/.claude/projects/.../abc123.jsonl",
  "title": "Refactor the auth middleware to support OIDC",
  "status": "waiting_for_input",
  "pending_options": ["Yes", "Yes, don't ask again", "No"],
  "pending_question": "Permission required to run: npm run migrate",
  "started_at": "2026-04-28T14:02:11Z",
  "last_activity_at": "2026-04-28T14:22:09Z"
}
```

`status` is one of: `idle`, `working`, `waiting_for_input`, `done`, `errored`.
`title` is set from the first user prompt, max 80 chars.
`pending_options` is parsed from the latest assistant message in the transcript when a Notification fires (regex: `^\s*[1-9][.)]\s+(.+)$`). Best effort — if parsing fails, leave empty array.

---

## Hook events → state transitions

| Hook event        | New status          | Other updates                                              |
|-------------------|---------------------|------------------------------------------------------------|
| `SessionStart`    | `idle`              | initialize file if absent, set `started_at`, `cwd`         |
| `UserPromptSubmit`| `working`           | set `title` if empty, clear `pending_options`              |
| `PreToolUse`      | `working`           | bump `last_activity_at`                                    |
| `PostToolUse`     | (unchanged)         | bump `last_activity_at`                                    |
| `Notification`    | `waiting_for_input` | set `pending_question`, parse `pending_options` from transcript |
| `Stop`            | `idle`              | clear `pending_options`, `pending_question`                 |
| `SessionEnd`      | `done` or `errored` | based on `reason` field                                     |

The Notification hook is the most important one — it's what triggers the mobile keyboard's "choose 1/2/3" mode.

---

## Server responsibilities

- Read `config.json` listing workstations: `[{ id, host, user, port?, identityFile? }]`
- For each workstation, open one persistent SSH connection (`ssh2` npm package). Reconnect with backoff.
- **State sync**: every 2 seconds (or via `inotifywait` if available), `cat ~/.myco/sessions/*/state.json` on the workstation, parse, diff against in-memory map, push `session_update` / `session_removed` events to subscribed browser WebSockets.
- **Attach**: when browser opens `ws://server/attach/:session_id`, look up which workstation hosts it, open a new SSH channel running `tmux attach -t myco-<session_id>`, pipe stdout to the WebSocket and WebSocket messages to stdin. One SSH channel per browser viewer (don't multiplex viewers — tmux already lets multiple viewers see the same session if they all attach to the same tmux name).
- **Spawn**: `POST /sessions { workstation, cwd, prompt? }` → SSH and run `tmux new-session -d -s myco-<uuid> -c <cwd> 'claude'`. Return the new uuid. Hook fires on the workstation, state.json appears, sync picks it up.
- **List**: `GET /sessions` returns the in-memory union across workstations.

WebSocket message types — keep them simple, JSON:

```
client → server (on /attach/:session_id):
  { "t": "input", "data": "<base64 bytes>" }
  { "t": "resize", "cols": 80, "rows": 24 }

server → client:
  { "t": "output", "data": "<base64 bytes>" }
  { "t": "exit", "code": 0 }

client → server (on /events):
  (subscribe-only, no messages from client)

server → client (on /events):
  { "t": "session_update", "session": {...} }
  { "t": "session_removed", "session_id": "..." }
```

---

## The mobile keyboard (the actual product surface)

This is the differentiator — get it right.

**Three modes**, switched automatically based on session state:

| Mode       | Triggered when                       | Layout                                                       |
|------------|--------------------------------------|--------------------------------------------------------------|
| Choosing   | `status == waiting_for_input` && `pending_options.length > 0` | Big buttons labeled with the option text (`1. Yes`, `2. Yes, don't ask again`, `3. No`). Plus Esc, Enter. |
| Working    | `status == working`                  | Subdued. Big Esc button (interrupt). Smaller `↑↓ Tab Esc-Esc`. |
| Composing  | `status == idle`                     | Text input + Send. Plus `↑` (history), `Tab` (file picker), `⌨` (toggle native kbd). |

Always-visible toggle button: `⌨ ABC` switches to OS keyboard for free-text typing.

**Byte mappings** (send each tap as its own WebSocket frame, no debouncing, no auto-Enter on digits):

| Button       | Bytes        |
|--------------|--------------|
| 1 / 2 / 3    | `1` `2` `3`  |
| Enter        | `\r`         |
| Esc          | `\x1b`       |
| Esc-Esc      | `\x1b\x1b` (one frame) |
| ↑            | `\x1b[A`     |
| ↓            | `\x1b[B`     |
| Tab          | `\t`         |
| Ctrl+C       | `\x03`       |
| Shift+Enter  | `\x1b\r`     |

**Critical UX rules:**
- Disable the OS soft keyboard by default (`inputmode="none"` on the focused element). The custom keyboard is the primary input.
- When `pending_options` is set, replace digit-button labels with the option text (truncate to ~30 chars). User taps "Yes" not "1".
- Show `pending_question` as a sticky banner above the keyboard, separate from the terminal scrollback. The terminal becomes secondary on mobile.
- Haptic feedback on every tap (`navigator.vibrate(10)`).
- When `status == working`, dim digit buttons and don't send their input (queue or block — just block in v1).
- Lock orientation portrait in chat view; allow landscape in terminal-only view.

---

## File layout

```
myco/
├── README.md
├── hook/
│   ├── hook.sh                   # bash script, ~150 lines, jq-based
│   ├── install.sh                # copies to ~/.myco/, merges into ~/.claude/settings.json
│   └── claude-settings.example.json
├── server/
│   ├── package.json
│   ├── config.example.json       # { workstations: [{id, host, user, ...}] }
│   └── src/
│       ├── index.js              # Express + ws, ~80 lines
│       ├── ssh.js                # ssh2 connection manager, ~120 lines
│       ├── sessions.js           # state polling + diff, ~80 lines
│       └── pty.js                # WebSocket-to-pty bridge, ~50 lines
└── web/
    └── public/
        ├── index.html            # single page, sessions list + terminal view
        ├── app.js                # router + state, ~150 lines
        ├── keyboard.js           # the Claude-Code-aware custom keyboard, ~200 lines
        ├── styles.css
        └── vendor/
            ├── xterm.js
            └── xterm.css
```

---

## Day-1 scope (do this first)

In order:

1. `hook/hook.sh` and `hook/install.sh`. Test by running `claude` manually, confirm `~/.myco/sessions/<id>/state.json` updates correctly across all hook events.
2. `server/` — express + ws + ssh2. Implement `GET /sessions`, the `/attach/:id` WebSocket, and `POST /sessions` for spawn. State sync via 2-second polling for now (no inotify yet).
3. `web/public/` — desktop layout first. Sessions list on left, xterm.js on right. Verify you can attach and type into a remote `claude` session.
4. Mobile responsive. Custom keyboard with the three modes above. Test on actual phone over LAN.
5. Spawn-from-UI button. Pick workstation + cwd, server SSHes and runs `tmux new-session ...`.

Hard rule: **don't touch anything in the "Out of scope" list below until day 1 works end-to-end on your phone.**

---

## Out of scope for v1 (do not build these yet)

- Authentication / authorization (run on localhost or behind Tailscale)
- Docker containers (sessions run as plain tmux sessions on workstation)
- Sub-agent / Task tool tree visualization
- Project / category grouping in the UI
- AI-generated session summaries
- VSCode "upgrade session" deeplink
- Multi-user support
- Persistent storage (in-memory state in the server is fine)
- Auto-reconnect for the SSH connection beyond simple exponential backoff
- inotify-based state watching (polling is fine)

---

## Implementation tips

- **SSH library**: use `ssh2` (npm). Open one `Client` per workstation, keep it alive. For pty attach, use `client.exec('tmux attach -t ...', { pty: true }, cb)` and pipe.
- **Polling state**: `client.exec('cat ~/.myco/sessions/*/state.json 2>/dev/null')` then split the output. Each file is small JSON; concat with newlines and parse.
- **Hook script**: use `jq` for all JSON. Use `flock` for atomic writes. Keep the script under 200 lines.
- **Mobile keyboard**: pure JS, no framework needed. `xterm.js` for the terminal. `xterm.send()` for input from button taps.
- **Claude Code session detection**: a session is "real" if `~/.myco/sessions/<id>/state.json` exists. Sessions persist on disk; clean up files where `last_activity_at` is older than 7 days on server start.

---

## Test plan

1. On the workstation, install hook: `cd hook && ./install.sh`
2. Start a Claude session: `tmux new -s myco-test 'claude'`
3. Send a prompt that triggers a permission request (e.g. `Run npm install`).
4. Confirm `state.json` shows `status: waiting_for_input` and `pending_options` populated.
5. On laptop, start server: `cd server && npm install && npm start`
6. Open `http://localhost:3000` on phone (same WiFi).
7. Tap the session, see terminal, see the three labeled buttons, tap "Yes", see Claude proceed.
8. Lock phone. Done.

If step 7 works, you've shipped the actual product.
