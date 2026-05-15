// Phase 1 smoke test for server/src/agent-session.js.
//
// Spawns ONE AgentSession with a trivial initialPrompt against the
// real Claude Agent SDK and asserts the basic event lifecycle: a
// system_init lands, at least one assistant_text or tool_use, then
// a turn_result with subtype='success'.
//
// Skips gracefully when credentials aren't available (CI / fresh
// container without `claude login`). Real-network test by design —
// the whole point is verifying SDK round-trip works against our
// auth surface, not mocking the SDK.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const SDK_INSTALLED = (() => {
  try { require.resolve('@anthropic-ai/claude-agent-sdk'); return true; }
  catch { return false; }
})();

if (!SDK_INSTALLED) {
  console.log('── agent-session ──');
  console.log('  ~ skipped: @anthropic-ai/claude-agent-sdk not installed');
  process.exit(0);
}
if (!fs.existsSync(CRED_PATH) && !process.env.ANTHROPIC_API_KEY) {
  console.log('── agent-session ──');
  console.log(`  ~ skipped: no creds at ${CRED_PATH} and ANTHROPIC_API_KEY unset`);
  process.exit(0);
}

const { spawnAgent, AgentSession } = require('../server/src/agent-session');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function collectEvents(session, { until, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => {
      session.off('agent-event', onEvent);
      reject(new Error(`timed out after ${timeoutMs}ms — got ${events.length} events: ${events.map((e) => e.type).join(', ')}`));
    }, timeoutMs);
    function onEvent(e) {
      events.push(e);
      if (until(events, e)) {
        clearTimeout(timer);
        session.off('agent-event', onEvent);
        resolve(events);
      }
    }
    session.on('agent-event', onEvent);
  });
}

(async () => {
  console.log('── agent-session ──');

  await t('spawnAgent kicks a turn → emits system_init + turn_result/success', async () => {
    const session = spawnAgent('test-sess-1', {
      cwd: process.cwd(),
      initialPrompt: 'Reply with exactly the word READY and nothing else.',
    });
    assert.strictEqual(session.alive, true);
    assert.strictEqual(session.mode, 'agent');

    const events = await collectEvents(session, {
      until: (all, e) => e.type === 'turn_result',
      timeoutMs: 90000,  // first-turn cache-creation can take ~15s; allow padding for slow networks
    });

    const types = events.map((e) => e.type);
    assert.ok(types.includes('system_init'), `expected system_init event, got: ${types.join(', ')}`);
    assert.ok(
      types.includes('assistant_text') || types.includes('tool_use'),
      `expected at least one assistant_text or tool_use, got: ${types.join(', ')}`,
    );
    const result = events.find((e) => e.type === 'turn_result');
    assert.strictEqual(result.subtype, 'success', `expected success, got: ${result.subtype}`);
    assert.ok(result.totalCostUsd >= 0, 'expected totalCostUsd in result');
    assert.ok(session.sdkSessionId, 'expected SDK session id captured from system_init');

    session.kill();
    assert.strictEqual(session.alive, false);
  });

  await t('write() runs a follow-up turn that resumes the SDK session', async () => {
    const session = spawnAgent('test-sess-2', {
      cwd: process.cwd(),
      initialPrompt: 'Reply with the single word ONE.',
    });
    // Attach the collector BEFORE kicking the second turn, so it
    // catches events that may fire synchronously after write(). The
    // collector waits for TWO turn_result events — one per turn.
    let firstSdkSessionId = null;
    const allDone = collectEvents(session, {
      until: (all, e) => {
        if (e.type === 'system_init' && !firstSdkSessionId) {
          firstSdkSessionId = e.sdkSessionId;
        }
        // Kick the second turn the moment the first turn_result lands.
        if (e.type === 'turn_result' && all.filter((x) => x.type === 'turn_result').length === 1) {
          setImmediate(() => session.write('Reply with the single word TWO.'));
        }
        return all.filter((x) => x.type === 'turn_result').length === 2;
      },
      timeoutMs: 120000,
    });
    const events = await allDone;
    assert.ok(firstSdkSessionId, 'first turn should have captured an SDK session id via system_init');
    // The same SDK session id should be reused (resume semantics).
    assert.strictEqual(session.sdkSessionId, firstSdkSessionId,
      'second turn should reuse the SDK session id (resume), not start a new one');
    const results = events.filter((e) => e.type === 'turn_result');
    assert.strictEqual(results.length, 2, `expected 2 turn_results, got ${results.length}`);
    assert.strictEqual(results[1].subtype, 'success');
    session.kill();
  });

  await t('class shape — exposes the same surface PtySession does', () => {
    const s = new AgentSession('test-sess-3', { cwd: process.cwd() });
    // No initialPrompt → idle until first write().
    assert.strictEqual(s.alive, true);
    assert.strictEqual(s.mode, 'agent');
    assert.deepStrictEqual(s.pendingMenu, null);
    assert.ok(s.openToolCalls instanceof Map);
    assert.ok(Array.isArray(s.buffer));
    assert.strictEqual(typeof s.write, 'function');
    assert.strictEqual(typeof s.resize, 'function');
    assert.strictEqual(typeof s.kill, 'function');
    s.kill();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((err) => {
  console.error('test harness failed:', err);
  process.exit(1);
});
