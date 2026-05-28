// fr-85 r7 (round 2) — the clarify reply must be SHORT. The r7 soft
// prompt nudge ("answer concisely") wasn't enough — the model still
// returned multi-paragraph replies that overflow the popover. User
// reported it twice, so this round makes it a HARD guarantee:
//
//   1. server/src/attach.js — strengthen the prompt wrap so the
//      instruction is forceful ("2-3 sentences MAX").
//   2. server/src/agent-session.js — _capClarifyReply() truncates the
//      accumulated replyText to at most 3 sentences (with a char
//      backstop) BEFORE it's emitted on the clarify-reply WS frame.
//      The rec.chat audit record keeps the full text; only the popover
//      payload is capped.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── fr-85 r7 r2: clarify reply is hard-capped short ──');

// ── behavioral: the cap helper itself ──────────────────────────────
const { _capClarifyReply } = require('../server/src/agent-session');

t('_capClarifyReply is exported as a function', () => {
  assert.strictEqual(typeof _capClarifyReply, 'function',
    'agent-session must export _capClarifyReply for testing + reuse');
});

t('caps a long multi-sentence reply to at most 3 sentences', () => {
  const long = 'First sentence here. Second sentence follows. Third one too. '
             + 'Fourth should be dropped. Fifth as well. Sixth gone.';
  const out = _capClarifyReply(long);
  // Count sentence terminators in the output.
  const sentences = (out.match(/[.!?]+/g) || []).length;
  assert.ok(sentences <= 3,
    `expected ≤ 3 sentences, got ${sentences}: ${JSON.stringify(out)}`);
  assert.ok(/First sentence here\./.test(out), 'must keep the first sentence');
  assert.ok(!/Fourth should be dropped/.test(out),
    'must drop the 4th+ sentences');
});

t('leaves a short reply (≤ 3 sentences) untouched', () => {
  const short = 'Just one clarifying line. Maybe a second.';
  const out = _capClarifyReply(short);
  assert.strictEqual(out.trim(), short.trim(),
    'a reply already within the cap must pass through unchanged');
});

t('char backstop trims a runaway single sentence with no terminators', () => {
  const runaway = 'word '.repeat(400).trim();   // ~2000 chars, no period
  const out = _capClarifyReply(runaway);
  assert.ok(out.length <= 620,
    `runaway single sentence must be char-capped (got ${out.length} chars)`);
  assert.ok(/…$/.test(out) || out.length < runaway.length,
    'char-capped output should be visibly truncated');
});

t('handles empty / nullish input without throwing', () => {
  assert.strictEqual(_capClarifyReply(''), '');
  assert.strictEqual(_capClarifyReply(null), '');
  assert.strictEqual(_capClarifyReply(undefined), '');
});

// ── static: the cap is wired into the flush + the prompt is forceful ──
const SESSION = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

t('agent-session.js: clarify-reply emit pipes replyText through _capClarifyReply', () => {
  const idx = SESSION.search(/this\.emit\(\s*['"]clarify-reply['"]/);
  assert.ok(idx > -1, 'clarify-reply emit must exist');
  // The emit payload (next ~600 chars — comment-heavy) must call
  // _capClarifyReply on the accumulated replyText, not ship it raw.
  const win = SESSION.slice(idx, idx + 600);
  assert.ok(/_capClarifyReply\s*\(/.test(win),
    'r7 r2: the clarify-reply emit must cap the text via _capClarifyReply(...) before sending to the popover');
});

t('attach.js: clarify prompt wrap is forceful about 2-3 sentence brevity', () => {
  const idx = ATTACH.search(/function\s+handleChatMessage\s*\(/);
  const win = ATTACH.slice(idx, idx + 6000);
  // message.text wrap must mention a hard 2-3 sentence cap.
  assert.ok(/message\.text\s*=[\s\S]{0,300}(2-3 sentences|2‑3 sentences|three sentences|3 sentences)/i.test(win),
    'r7 r2: the prompt wrap must explicitly demand 2-3 sentences');
  assert.ok(/message\.text\s*=[\s\S]{0,300}(MAX|maximum|at most|no more than)/i.test(win),
    'r7 r2: the prompt wrap must phrase the cap as a hard maximum');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
