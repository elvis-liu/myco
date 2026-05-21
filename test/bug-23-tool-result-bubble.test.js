// bug-23 regression: tool_result events render as their own
// claude-style message bubble instead of folding into the chrome
// batch with tool_use + hook_allow + system_init.
//
// User-reported repro: `📖 Read USER_MANUAL.md` turn showed
//   ▶ turn · ▶ session · 📖 Read · ✓ hook allow · ✓ result · 4132 bytes
// as 5 sibling rows. The user clarified scope: "We only want the
// result to show in the message bubble, the rest should stay the same."
//
// Fix shape:
//   1. AGENT_CHROME_TYPES no longer contains 'tool_result' — so it
//      doesn't short-circuit through the chrome-batch fold path
//   2. AGENT_DEFAULT_EXPANDED gains 'tool_result' — a collapsed
//      result bubble would be pointless
//   3. CSS rule .agent-card.agent-card-tool_result styles the card
//      as a bubble (left border + padding + tinted background)
//      mirroring .agent-card.agent-card-assistant_text's shape

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── bug-23: tool_result renders as a message bubble ──');

function _chromeTypesBlock() {
  const start = APP.search(/const\s+AGENT_CHROME_TYPES\s*=\s*new\s+Set\s*\(\s*\[/);
  assert.ok(start > -1, 'AGENT_CHROME_TYPES must exist');
  const end = APP.indexOf(']);', start);
  assert.ok(end > -1, 'AGENT_CHROME_TYPES must have a closing ])');
  return APP.slice(start, end + 3);
}

function _defaultExpandedLine() {
  const m = APP.match(/const\s+AGENT_DEFAULT_EXPANDED\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]/);
  assert.ok(m, 'AGENT_DEFAULT_EXPANDED must exist');
  return m[1];
}

// ──────────────────────────────────────────────────────────────────────
// Classification: tool_result is NOT a chrome event
// ──────────────────────────────────────────────────────────────────────

t('AGENT_CHROME_TYPES does NOT include tool_result', () => {
  const block = _chromeTypesBlock();
  // The Set initializer is a list of string literals — assert
  // 'tool_result' is not present as a quoted item.
  assert.ok(!/['"]tool_result['"]/.test(block),
    "'tool_result' must NOT appear in the AGENT_CHROME_TYPES Set (was making it fold into chrome batches)");
});

t('AGENT_CHROME_TYPES still includes tool_use + hook_allow (the rest stays the same)', () => {
  const block = _chromeTypesBlock();
  // The user explicitly said "the rest should stay the same" — verify
  // we didn't accidentally pull other chrome event types out.
  assert.ok(/['"]hook_allow['"]/.test(block),
    'hook_allow must remain a chrome event so it still folds into the batch');
  assert.ok(/['"]turn_start['"]/.test(block),
    'turn_start must remain a chrome event');
  assert.ok(/['"]system_init['"]/.test(block),
    'system_init must remain a chrome event');
  assert.ok(/['"]turn_result['"]/.test(block),
    'turn_result must remain a chrome event (cost/tokens footer);'
    + ' bug-23 only pulled tool_result out');
});

// _isChromeEvent has a special case for tool_use (returns true outside
// the set). Verify tool_use is still chrome too — and tool_result is
// not. We grep the function body.
t('_isChromeEvent special-cases tool_use as chrome but not tool_result', () => {
  const fnIdx = APP.search(/function\s+_isChromeEvent\s*\(/);
  assert.ok(fnIdx > -1);
  const body = APP.slice(fnIdx, fnIdx + 400);
  assert.ok(/ev\.type\s*===\s*['"]tool_use['"]/.test(body),
    'tool_use must still be classified as chrome via the special case');
  assert.ok(!/ev\.type\s*===\s*['"]tool_result['"]/.test(body),
    '_isChromeEvent must NOT have a tool_result special case (would re-introduce the bug)');
});

// ──────────────────────────────────────────────────────────────────────
// Default-expanded set
// ──────────────────────────────────────────────────────────────────────

t('AGENT_DEFAULT_EXPANDED includes tool_result (so the bubble shows expanded)', () => {
  const line = _defaultExpandedLine();
  assert.ok(/['"]tool_result['"]/.test(line),
    'tool_result must be in AGENT_DEFAULT_EXPANDED — a collapsed result bubble would be pointless');
  // Sanity: assistant_text + fatal should still be there.
  assert.ok(/['"]assistant_text['"]/.test(line), 'assistant_text must remain default-expanded');
  assert.ok(/['"]fatal['"]/.test(line), 'fatal must remain default-expanded');
});

// ──────────────────────────────────────────────────────────────────────
// CSS: bubble shape for tool_result mirrors the assistant_text bubble
// ──────────────────────────────────────────────────────────────────────

t('CSS: .agent-card-tool_result has bubble-shape rule (padding + border-left + background)', () => {
  // Extract the rule body.
  const m = CSS.match(/\.agent-card\.agent-card-tool_result\s*\{[^}]+\}/);
  assert.ok(m, '.agent-card.agent-card-tool_result rule must exist');
  const rule = m[0];
  assert.ok(/border-left:/.test(rule),
    'bubble shape requires a colored left border (mirrors .agent-card-assistant_text)');
  assert.ok(/padding:/.test(rule),
    'bubble shape requires padding');
  assert.ok(/background:/.test(rule),
    'bubble shape requires a subtle background tint');
  assert.ok(/border-radius:/.test(rule),
    'bubble shape requires rounded corners');
});

t('CSS: tool_result bubble uses a different tint than the assistant_text bubble (recognizable as result, not narration)', () => {
  const txt = CSS.match(/\.agent-card\.agent-card-assistant_text\s*\{[^}]+\}/);
  const res = CSS.match(/\.agent-card\.agent-card-tool_result\s*\{[^}]+\}/);
  assert.ok(txt && res, 'both rules must exist');
  // The two backgrounds should differ. Cheap check: extract the rgba()
  // tints and confirm they\'re not byte-identical.
  const txtBg = (txt[0].match(/background:\s*([^;]+);/) || [])[1] || '';
  const resBg = (res[0].match(/background:\s*([^;]+);/) || [])[1] || '';
  assert.ok(txtBg && resBg, 'both rules have background');
  assert.notStrictEqual(txtBg.trim(), resBg.trim(),
    'tool_result bubble background must differ from assistant_text bubble background');
});

t('CSS: the .agent-card-result chip inside the bubble gets pill styling', () => {
  // The "✓ result" chip should look like a tag inside the bubble (mirrors
  // the .agent-card-claude pill inside the assistant_text bubble).
  assert.ok(/\.agent-card\.agent-card-tool_result\s+\.agent-card-result\s*\{[^}]*border-radius/i.test(CSS),
    'the .agent-card-result chip inside the tool_result bubble should be pill-shaped');
});

// ──────────────────────────────────────────────────────────────────────
// Rendering branch — the existing tool_result rendering path still
// builds the result content (we didn\'t accidentally remove it).
// ──────────────────────────────────────────────────────────────────────

t('rendering branch for tool_result still builds head + body in the fresh-card path', () => {
  // Grep the existing branch — should still construct the result chip
  // and a <pre> with the content.
  assert.ok(/ev\.type\s*===\s*['"]tool_result['"][\s\S]{0,800}?agent-card-result/.test(APP),
    'tool_result rendering branch must still construct the .agent-card-result head chip');
  assert.ok(/ev\.type\s*===\s*['"]tool_result['"][\s\S]{0,800}?agent-tool-result-preview/.test(APP),
    'tool_result rendering branch must still construct the .agent-tool-result-preview body');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
