// Regression: chat routing rewrite (2026-05-14). Plain text + @<unknown>
// now go to the PTY by default; only @<known-user> mentions stay in
// chat. The mention-detection helper is what gates that — anything that
// breaks it sends private user-to-user notes straight to claude, which
// is both confusing and a privacy hole.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-chatroute-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

// Seed the allowlist BEFORE requiring pty.js so _isKnownChatUser
// (called transitively from _detectMentionTarget) sees them.
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# test fixture\nkkrazy\nryan-blues\n',
);

const pty = require('../server/src/pty');
const slashcmds = require('../server/src/slashcmds');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── chat routing: @<known-user> → mention; everything else → PTY ──');

t('@<known-user> at the head returns the canonical login', () => {
  assert.strictEqual(pty._detectMentionTarget('@kkrazy hey'), 'kkrazy');
  assert.strictEqual(pty._detectMentionTarget('@ryan-blues need eyes on this'), 'ryan-blues');
});

t('case-insensitive match — @KKRAZY still resolves to kkrazy', () => {
  // _isKnownChatUser lowercases on both sides; the returned value is the
  // typed casing (we don't normalise back to canonical), which is fine
  // since the client compares lowercased-username for the highlight.
  assert.ok(pty._detectMentionTarget('@KKRAZY hi'), 'expected truthy match');
});

t('@<unknown-word> does NOT resolve — falls through to PTY route', () => {
  assert.strictEqual(pty._detectMentionTarget('@myco hi'), null);
  assert.strictEqual(pty._detectMentionTarget('@claude do thing'), null);
  assert.strictEqual(pty._detectMentionTarget('@asdf nope'), null);
});

t('plain text never matches a mention', () => {
  assert.strictEqual(pty._detectMentionTarget('hi there'), null);
  assert.strictEqual(pty._detectMentionTarget(''), null);
  assert.strictEqual(pty._detectMentionTarget('  '), null);
});

t('mention must be at the head of the message — embedded @user is not a route hint', () => {
  // "tell @kkrazy that …" is a normal message addressed at claude that
  // happens to mention a user. We do NOT treat it as a private DM.
  assert.strictEqual(pty._detectMentionTarget('tell @kkrazy that lunch is at noon'), null);
});

t('bare @username (no body) still resolves so user can ping without text', () => {
  assert.strictEqual(pty._detectMentionTarget('@kkrazy'), 'kkrazy');
  assert.strictEqual(pty._detectMentionTarget('@kkrazy?'), 'kkrazy');
});

t('the removed /m alias is no longer in the slash registry', () => {
  const cmds = slashcmds.listCommands();
  assert.ok(!cmds.some((c) => c.name === 'm'),
    `/m should be removed from listCommands, got: ${cmds.map((c) => c.name).join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
