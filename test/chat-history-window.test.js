// bug-9 regression: getChatHistory accepts { limit, before } for
// windowed reads, and getChatHistoryLength returns the total filtered
// count. The initial chat-history WS frame on attach is capped at
// DEFAULT_CHAT_HISTORY_LIMIT (25 — lowered from 100 in round 2 after
// user feedback that 100 markdown rows was still slow on first paint)
// so the chat pane opens fast on multi-hour sessions; older windows
// are fetched on demand via the new GET /sessions/:id/chat/history
// ?before=&limit= route.
//
// This file pins the server contract — the route + WS-frame call
// sites depend on it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-chw-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const sessionsMod = require('../server/src/sessions');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function seedSession(sid, n) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid, user: 'kkrazy', cwd: '.',
    absCwd: process.env.MYCO_WORKSPACE,
    createdAt: new Date().toISOString(),
    chat: [],
  };
  sessionsMod.saveStore();
  // Generate `n` messages with monotonically increasing ts strings so
  // `before` filtering is deterministic. Format: 2026-05-16T10:HH:MM:SS.
  for (let i = 0; i < n; i++) {
    const mm = String(Math.floor(i / 60)).padStart(2, '0');
    const ss = String(i % 60).padStart(2, '0');
    sessionsMod.appendChatMessage(sid, {
      user: 'alice', text: 'msg ' + i,
      ts: `2026-05-16T10:${mm}:${ss}.000Z`,
    });
  }
}

console.log('── bug-9: windowed getChatHistory + getChatHistoryLength ──');

t('DEFAULT_CHAT_HISTORY_BYTES is exported and equals 256 KB', () => {
  // Round 3 (the current cap): byte-budget instead of count. One 30 KB
  // markdown blob and one 50-char "ok" cost wildly different to
  // render; a count-based cap couldn't see the difference. The byte
  // budget bounds wire payload + first-paint workload predictably.
  // The load-older button + paginated /chat/history?before= route
  // fetch earlier windows on demand, so a smaller initial budget is
  // no info loss — just faster first paint.
  assert.strictEqual(sessionsMod.DEFAULT_CHAT_HISTORY_BYTES, 256 * 1024,
    'the WS chat-history frame default must cap at 256 KB to keep first paint fast');
});

t('DEFAULT_CHAT_HISTORY_LIMIT (legacy count-cap) is still exported for the /chat/history?limit= route', () => {
  // The count cap survived as a small default for paginated older-
  // window fetches via GET /sessions/:id/chat/history?limit= when
  // the client doesn't pass an explicit count. Independent of the
  // byte budget that gates the initial attach frame.
  assert.strictEqual(typeof sessionsMod.DEFAULT_CHAT_HISTORY_LIMIT, 'number');
  assert.ok(sessionsMod.DEFAULT_CHAT_HISTORY_LIMIT > 0
            && sessionsMod.DEFAULT_CHAT_HISTORY_LIMIT <= 100,
    'legacy count default should sit in a sensible range');
});

t('opts.maxBytes returns the tail prefix that fits the budget', () => {
  const sid = 'sess-chw-bytes';
  seedSession(sid, 50);
  // Each message is small (~80 bytes when stringified). A 500-byte
  // budget should fit ~6 messages.
  const tight = sessionsMod.getChatHistory(sid, { maxBytes: 500 });
  assert.ok(tight.length > 0 && tight.length < 50,
    'maxBytes should trim a fraction of the messages, got ' + tight.length);
  assert.strictEqual(tight[tight.length - 1].text, 'msg 49',
    'last element must be the most recent (msg 49)');
  // Budget large enough to fit everything — full list returned.
  const loose = sessionsMod.getChatHistory(sid, { maxBytes: 1024 * 1024 });
  assert.strictEqual(loose.length, 50, 'big budget returns everything');
});

t('opts.maxBytes always keeps at least one message even if it exceeds the budget', () => {
  const sid = 'sess-chw-bytes-min';
  seedSession(sid, 5);
  // Set the budget below the size of a single stringified message.
  const result = sessionsMod.getChatHistory(sid, { maxBytes: 1 });
  assert.strictEqual(result.length, 1,
    'a single oversized message should still be returned (most recent), not an empty window');
  assert.strictEqual(result[0].text, 'msg 4');
});

t('opts.maxBytes + opts.limit — whichever produces fewer messages wins', () => {
  const sid = 'sess-chw-bytes-limit';
  seedSession(sid, 50);
  // Tight count cap with a generous byte budget → count wins.
  const byCount = sessionsMod.getChatHistory(sid, { maxBytes: 999999, limit: 3 });
  assert.strictEqual(byCount.length, 3);
  assert.strictEqual(byCount[2].text, 'msg 49');
  // Generous count cap with a tight byte budget → bytes win.
  const byBytes = sessionsMod.getChatHistory(sid, { maxBytes: 250, limit: 9999 });
  assert.ok(byBytes.length > 0 && byBytes.length < 50,
    'byte budget should trim despite generous count limit');
});

t('no opts → returns ALL filtered messages (backward compat)', () => {
  const sid = 'sess-chw-all';
  seedSession(sid, 250);
  const all = sessionsMod.getChatHistory(sid);
  assert.strictEqual(all.length, 250, 'expected all 250, got ' + all.length);
  assert.strictEqual(all[0].text, 'msg 0');
  assert.strictEqual(all[249].text, 'msg 249');
});

t('opts.limit returns the LAST N messages, chronologically ordered', () => {
  const sid = 'sess-chw-limit';
  seedSession(sid, 250);
  const tail = sessionsMod.getChatHistory(sid, { limit: 100 });
  assert.strictEqual(tail.length, 100);
  assert.strictEqual(tail[0].text, 'msg 150', 'first of last-100 should be msg 150');
  assert.strictEqual(tail[99].text, 'msg 249', 'last of last-100 should be msg 249');
});

t('opts.before excludes messages with ts >= the cursor', () => {
  const sid = 'sess-chw-before';
  seedSession(sid, 250);
  // Cursor = msg 100's ts. Window should exclude msg 100 itself.
  const cursor = '2026-05-16T10:01:40.000Z';  // msg 100
  const before = sessionsMod.getChatHistory(sid, { before: cursor });
  assert.strictEqual(before.length, 100, 'expected 100 (msgs 0-99), got ' + before.length);
  assert.strictEqual(before[0].text, 'msg 0');
  assert.strictEqual(before[99].text, 'msg 99');
});

t('opts.before + opts.limit pages backwards N at a time', () => {
  const sid = 'sess-chw-paginate';
  seedSession(sid, 250);
  // Fetch a 50-message window strictly older than msg 200.
  const cursor = '2026-05-16T10:03:20.000Z';  // msg 200
  const win = sessionsMod.getChatHistory(sid, { before: cursor, limit: 50 });
  assert.strictEqual(win.length, 50);
  assert.strictEqual(win[0].text, 'msg 150', 'oldest of the 50-before-200 window should be msg 150');
  assert.strictEqual(win[49].text, 'msg 199', 'newest of the 50-before-200 window should be msg 199');
});

t('getChatHistoryLength returns total filtered count regardless of limit/before', () => {
  const sid = 'sess-chw-len';
  seedSession(sid, 75);
  assert.strictEqual(sessionsMod.getChatHistoryLength(sid), 75);
});

t('fromTranscript rows are excluded from BOTH length and window reads', () => {
  const sid = 'sess-chw-fromtxn';
  seedSession(sid, 10);
  // Inject 5 fromTranscript rows in between. They should be silently
  // filtered out — only the 10 user messages should be visible to
  // either accessor.
  for (let i = 0; i < 5; i++) {
    sessionsMod.appendChatMessage(sid, {
      user: 'claude', text: 'transcript ' + i, ts: '2026-05-16T11:00:0' + i + '.000Z',
      meta: { fromTranscript: true, transcriptUuid: 'u' + i },
    });
  }
  assert.strictEqual(sessionsMod.getChatHistoryLength(sid), 10,
    'fromTranscript rows must NOT count toward the filtered total');
  const all = sessionsMod.getChatHistory(sid);
  assert.strictEqual(all.length, 10);
  assert.ok(all.every((m) => !(m.meta && m.meta.fromTranscript)),
    'window must drop fromTranscript rows');
});

t('limit=0 falls through (treated as no-limit, no-op)', () => {
  const sid = 'sess-chw-zero';
  seedSession(sid, 5);
  // 0 is the only "limit set but invalid" sentinel — the route also
  // clamps to DEFAULT_CHAT_HISTORY_LIMIT. The lib-level helper just
  // returns full filtered list when limit is falsy/non-positive.
  const all = sessionsMod.getChatHistory(sid, { limit: 0 });
  assert.strictEqual(all.length, 5);
});

t('attach.js wire calls chat-history with the byte budget', () => {
  // Source-level guard against a future cleanup pass dropping the
  // cap and silently restoring the "ship all 500" behavior.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  assert.ok(src.includes('DEFAULT_CHAT_HISTORY_BYTES'),
    'attach.js must reference DEFAULT_CHAT_HISTORY_BYTES when sending the chat-history WS frame');
  assert.ok(/maxBytes:\s*sessionsMod\.DEFAULT_CHAT_HISTORY_BYTES/.test(src),
    'attach.js must pass maxBytes: DEFAULT_CHAT_HISTORY_BYTES to getChatHistory');
  assert.ok(/messages:\s*history,\s*total/.test(src),
    'chat-history WS frame must carry `total` so the client knows whether more exists');
});

t('index.js has the GET /sessions/:id/chat/history route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
  assert.ok(/app\.get\(\s*['"]\/sessions\/:id\/chat\/history['"]/.test(src),
    'index.js must register GET /sessions/:id/chat/history');
  assert.ok(/hasMore/.test(src),
    'route response must include hasMore so the client knows when to retire the load-older button');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
