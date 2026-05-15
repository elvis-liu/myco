#!/usr/bin/env node
// migrate-pty-to-agent.js
//
// One-shot migration for SDK Phase 9 — flip any legacy PTY-mode (or
// unset-mode) session record over to mode='agent' so the next
// ensureLiveSession respawn uses the AgentSession class. Idempotent.
//
// Why: Phase 9 retires the PTY driver. Existing sessions in
// /data/sessions.json with rec.mode='pty' (or rec.mode unset, which
// the pre-Phase-8 default-to-PTY path treats as PTY) would respawn
// under pty.js after the deletion. Migrating them sets rec.mode and
// (when a claude-cli session id exists) hands it to the SDK as the
// sdkSessionId so the same JSONL transcript is resumed seamlessly.
// The SDK's resume option accepts any UUID — claude-cli + SDK share
// the per-cwd JSONL storage.
//
// Usage:
//   node /app/migrate-pty-to-agent.js                  # in-container
//   node migrate-pty-to-agent.js --dry-run             # report-only
//   node migrate-pty-to-agent.js --file /tmp/sess.json # custom path
//   STATE_DIR=/path/to/state node migrate-pty-to-agent.js
//
// Exit code: 0 on success (whether or not anything was migrated),
// non-zero on file I/O errors. Run while the server is stopped or
// be aware that in-memory state may diverge until the next process
// restart — the SDK records its own rec.sdkSessionId during normal
// operation, so this script's writes are mostly relevant for
// freshly-loaded server instances.

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { dryRun: false, file: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error('Unknown arg:', a); printHelp(); process.exit(2); }
  }
  return args;
}

function printHelp() {
  console.log(`migrate-pty-to-agent.js — Phase 9 migration helper

Usage:
  node migrate-pty-to-agent.js [--dry-run] [--file <path>]

Defaults:
  --file ${process.env.STATE_DIR || '/data'}/sessions.json
`);
}

function resolveStateFile(custom) {
  if (custom) return custom;
  const base = process.env.STATE_DIR || '/data';
  return path.join(base, 'sessions.json');
}

function main() {
  const args = parseArgs(process.argv);
  const file = resolveStateFile(args.file);
  if (!fs.existsSync(file)) {
    console.error(`sessions file not found: ${file}`);
    process.exit(2);
  }
  let store;
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { console.error(`failed to parse ${file}: ${err.message}`); process.exit(2); }
  const sessions = store.sessions || {};
  let migrated = 0;
  let alreadyAgent = 0;
  let total = 0;
  for (const [sid, rec] of Object.entries(sessions)) {
    total++;
    if (rec.mode === 'agent') { alreadyAgent++; continue; }
    const before = { mode: rec.mode || null, sdkSessionId: rec.sdkSessionId || null };
    rec.mode = 'agent';
    if (!rec.sdkSessionId && rec.claudeSessionId) {
      rec.sdkSessionId = rec.claudeSessionId;
    }
    migrated++;
    console.log(`  → ${sid} cwd=${rec.cwd} mode=${before.mode || '(unset)'} → agent, sdk=${rec.sdkSessionId ? rec.sdkSessionId.slice(0,8) : 'none'}`);
  }
  console.log();
  console.log(`Total: ${total} | already agent: ${alreadyAgent} | migrated: ${migrated} | dry-run: ${args.dryRun}`);
  if (migrated && !args.dryRun) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, file);
    console.log(`wrote ${file}`);
  }
}

main();
