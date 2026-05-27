// fr-85 r4 server-side static guards.
//
// The clarify-in-place flow has two server touchpoints:
//   1. attach.js handleChatMessage: accepts opts.meta, tags the
//      message + sets session._pendingClarify when meta.kind=clarify.
//   2. agent-session.js _persistAssistantTextToRecChat: when
//      session._pendingClarify is set, tags the assistant reply
//      with meta.kind=clarify-reply AND emits a 'clarify-reply'
//      WS event so the popover can render it instead of letting
//      it pollute chat.
//
// These guards prevent a future refactor from quietly breaking the
// in-place flow (which would silently send clarifies back into chat).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const SESSION = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── fr-85 r4: server-side clarify routing ──');

// ── attach.js ──────────────────────────────────────────────────────

t('attach.js: WS chat-frame parser forwards meta.kind=clarify only (security whitelist)', () => {
  // We pass through clarify-tagged meta but ignore other meta keys
  // to prevent a client from spoofing menu / mention / denied meta.
  const idx = ATTACH.search(/msg\.t === ['"]chat['"][\s\S]{0,200}msg\.text/);
  assert.ok(idx > -1, 'chat-frame parser branch must be findable');
  const win = ATTACH.slice(idx, idx + 1500);
  assert.ok(/msg\.meta[\s\S]{0,200}kind === ['"]clarify['"]/.test(win),
    'parser must check msg.meta.kind === "clarify" before forwarding');
  assert.ok(/opts\.meta\s*=/.test(win) || /opts = \{/.test(win),
    'parser must construct an opts object that handleChatMessage reads');
});

t('attach.js: handleChatMessage tags message meta + sets session._pendingClarify on clarify', () => {
  const idx = ATTACH.search(/function\s+handleChatMessage\s*\(/);
  assert.ok(idx > -1, 'handleChatMessage must be defined');
  // Slice big — handleChatMessage is ~80 lines + comment-heavy.
  const win = ATTACH.slice(idx, idx + 6000);
  assert.ok(/opts\.meta\.kind === ['"]clarify['"]/.test(win),
    'handleChatMessage must branch on opts.meta.kind === "clarify"');
  assert.ok(/message\.meta\s*=\s*\{\s*kind:\s*['"]clarify['"]/.test(win),
    'clarify branch must stamp message.meta = { kind: "clarify", selected: ... }');
  assert.ok(/session\._pendingClarify\s*=\s*\{[\s\S]{0,300}questionTs:/.test(win),
    'clarify branch must set session._pendingClarify with questionTs + selected');
});

t('attach.js: WS attach loop forwards `clarify-reply` session event to the client', () => {
  // The popover-as-response-surface model needs a dedicated WS frame
  // to route claude's reply back to the user's popover instead of
  // letting it render as a normal chat-msg / agent-event card.
  assert.ok(/session\.on\(['"]clarify-reply['"]/.test(ATTACH),
    'attach loop must register session.on("clarify-reply", ...)');
  // The forwarder is `ws.send(JSON.stringify({ t: 'clarify-reply', ...payload }))`.
  assert.ok(/ws\.send\(\s*JSON\.stringify\(\{\s*t:\s*['"]clarify-reply['"]/.test(ATTACH),
    'clarify-reply listener must forward the payload to the WS client via ws.send(JSON.stringify({t:"clarify-reply", ...}))');
});

// ── agent-session.js ───────────────────────────────────────────────

t('agent-session.js: _persistAssistantTextToRecChat tags reply when _pendingClarify is set', () => {
  // Anchor on the method DECLARATION (name + (text) + {) — plain
  // `_persistAssistantTextToRecChat(` also matches call sites earlier
  // in the file, which would slice an unrelated window.
  const idx = SESSION.search(/_persistAssistantTextToRecChat\s*\(\s*text\s*\)\s*\{/);
  assert.ok(idx > -1, '_persistAssistantTextToRecChat must be defined');
  const win = SESSION.slice(idx, idx + 3000);
  assert.ok(/this\._pendingClarify/.test(win),
    'method must read this._pendingClarify');
  assert.ok(/msg\.meta\.kind\s*=\s*['"]clarify-reply['"]/.test(win),
    'reply meta must be stamped with kind="clarify-reply"');
  assert.ok(/msg\.meta\.clarifyQuestionTs\s*=/.test(win),
    'reply meta must include clarifyQuestionTs so the client can match it to the popover');
  assert.ok(/this\.emit\(['"]clarify-reply['"]/.test(win),
    'method must emit a "clarify-reply" event for attach.js to forward via WS');
});

t('agent-session.js: pendingClarify cleared after one reply (so follow-up tool calls go to chat)', () => {
  // The pending state is consumed by the FIRST assistant_text after
  // the clarify input — subsequent assistant_text in the same turn
  // (e.g. tool calls + reasoning) goes to chat normally.
  // Anchor on the method DECLARATION (name + (text) + {) — plain
  // `_persistAssistantTextToRecChat(` also matches call sites earlier
  // in the file, which would slice an unrelated window.
  const idx = SESSION.search(/_persistAssistantTextToRecChat\s*\(\s*text\s*\)\s*\{/);
  const win = SESSION.slice(idx, idx + 3000);
  assert.ok(/this\._pendingClarify\s*=\s*null/.test(win),
    'method must clear this._pendingClarify after stamping the reply');
});

t('attach.js: r2 — questionTs is round-tripped from the client meta (not server-generated)', () => {
  // Without this, server made its own questionTs in message.ts at
  // message-creation time, which never matched the client's
  // _clarifyState.questionTs → the clarify-reply WS frame dropped
  // silently on the client side → "nothing in the popover".
  // Fix: client ships questionTs in meta; server uses opts.meta.questionTs
  // when setting session._pendingClarify (with message.ts as a fallback).
  // WS parser must whitelist questionTs alongside selected.
  const parserIdx = ATTACH.search(/msg\.t === ['"]chat['"][\s\S]{0,200}msg\.text/);
  const parserWin = ATTACH.slice(parserIdx, parserIdx + 2000);
  assert.ok(/questionTs/.test(parserWin),
    'WS chat parser must whitelist meta.questionTs so it reaches handleChatMessage');
  // handleChatMessage must consume opts.meta.questionTs (with fallback).
  const idx = ATTACH.search(/function\s+handleChatMessage\s*\(/);
  const win = ATTACH.slice(idx, idx + 6000);
  assert.ok(/opts\.meta\.questionTs/.test(win),
    'handleChatMessage must use opts.meta.questionTs (the client-generated value)');
  assert.ok(/message\.ts/.test(win),
    'handleChatMessage should still have message.ts available as a fallback');
});

t('app.js: r2 — client passes questionTs in clarify meta', () => {
  const idx = APP.search(/function\s+_sendClarify\s*\(/);
  const win = APP.slice(idx, idx + 4500);
  // The questionTs must be in the meta object that sendChatMessage
  // sees — otherwise the server picks its own and the client never
  // matches the reply.
  assert.ok(/meta:\s*\{\s*kind:\s*['"]clarify['"][\s\S]{0,200}questionTs/.test(win),
    '_sendClarify must include questionTs in meta');
});

t('agent-session.js: r2 — both `assistant_text` agent-event emits are SKIPPED when _pendingClarify is set', () => {
  // r1 (initial r4) only tagged the rec.chat record. The live
  // `agent-event` stream still emitted assistant_text → rendered as
  // a card in the main chat pane → the reply looked like it went to
  // chat anyway. r2 gates BOTH emit sites in agent-session.js on
  // `!this._pendingClarify` so the live chat-pane card is suppressed
  // when a clarify is in flight. The clarify-reply WS frame
  // (emitted inside _persistAssistantTextToRecChat) still delivers
  // the reply to the popover — so the user sees the answer there,
  // but NOT also in their main thread.
  const emitMatches = SESSION.match(/this\._emit\(\s*\{\s*type:\s*['"]assistant_text['"]/g);
  assert.ok(emitMatches && emitMatches.length >= 2,
    `both assistant_text emit sites must exist (text-block + result-fallback); got ${emitMatches ? emitMatches.length : 0}`);
  // Each emit must be guarded by a !this._pendingClarify check
  // within a short window above it.
  const emitRe = /this\._emit\(\s*\{\s*type:\s*['"]assistant_text['"]/g;
  let m;
  let count = 0;
  while ((m = emitRe.exec(SESSION)) !== null) {
    count++;
    const idx = m.index;
    const before = SESSION.slice(Math.max(0, idx - 400), idx);
    assert.ok(/!\s*this\._pendingClarify/.test(before),
      `assistant_text emit #${count} (at offset ${idx}) must be guarded by !this._pendingClarify within 400 chars above — otherwise the agent-event card pollutes chat during a clarify`);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
