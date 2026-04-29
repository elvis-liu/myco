# myco

A mobile-first web UI to monitor and control Claude Code sessions running locally on your machine.

The server (`mycod`) lists tmux sessions running `claude`, lets you spawn new ones in any directory inside a configured workspace, and proxies a terminal connection to your phone or laptop browser.

## Requirements

- **macOS or Linux** (uses `tmux` and POSIX paths)
- **Node.js 18+**
- **tmux** (`brew install tmux` on macOS)
- **Claude Code CLI** installed and on `PATH` as `claude`

## Install

```bash
git clone <repo-url> myco
# or: scp -r myco user@host:~/

cd myco/server
npm install
```

## Run

```bash
# from the project root
./mycod
```

Or directly:

```bash
cd server
MYCO_WORKSPACE=$HOME/projects npm start
```

The server binds to `0.0.0.0:3000`. Open `http://<your-machine-ip>:3000` from any device on the same network.

## Configuration

Environment variables:

| Var               | Default     | What it does                                                              |
|-------------------|-------------|---------------------------------------------------------------------------|
| `MYCO_WORKSPACE`  | `$HOME`     | Root directory for sessions. Spawn requests cannot escape this directory. |
| `PORT`            | `3000`      | HTTP/WS port to listen on.                                                |

## Day-1 features

- Lists tmux sessions running `claude` (and any session prefixed `myco-`)
- Spawns new sessions in any subdirectory of `MYCO_WORKSPACE` (auto-creates the directory)
- Live terminal attach over WebSocket
- Mobile-native UI: card-based session grid, FAB-style new-session button, bottom-sheet spawn modal
- Custom keyboard bar with `Esc` (double-tap = `Esc×2`), digit picks `1`/`2`/`3`, and `Enter`
- "ABC" toggle for native text input — type freely, send buffered on Enter

## Architecture

See [architecture.md](./architecture.md). The hook layer that captures Claude Code lifecycle events is deferred to Stage 2.

## Troubleshooting

**Sessions don't appear** — check `tmux list-panes -a -F '#{session_name}|#{pane_current_command}'` shows `claude` as the current command.

**`posix_spawnp failed`** — `node-pty`'s `spawn-helper` lost its executable bit during `npm install`. The `postinstall` script re-applies it; if you see this, run:

```bash
chmod +x server/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

**Phone can't reach the Mac** — verify both devices are on the same WiFi, and check macOS firewall (System Settings → Network → Firewall → allow `node`).
