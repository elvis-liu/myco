// Regression: /todo /fr /bug must persist the new plan item to BOTH
// sessions.json AND <project>/_myco_/plan.json. The GET /artifact
// handler reads the on-disk file first and falls back to rec.artifacts
// only when the file is absent — without the file write, the next
// plan-tab open re-reads the file (which doesn't have the new item)
// and silently drops what the user just added.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-slashtd-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const sessionsMod = require('../server/src/sessions');
const slashcmds = require('../server/src/slashcmds');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function seedSession(sid) {
  const cwd = path.join(tmpRoot, 'proj-' + sid);
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });    // findProjectRoot anchor
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid,
    user: 'kkrazy',
    cwd: '.',
    absCwd: cwd,
    chat: [],
    artifacts: {},
  };
  sessionsMod.saveStore();
  return cwd;
}

async function run(text, ctx) {
  const replies = [];
  await slashcmds.dispatch({
    user: 'kkrazy',
    sessionId: ctx.sessionId,
    absCwd: ctx.absCwd,
    reply: (m) => replies.push(m),
  }, text);
  return replies;
}

(async () => {
  console.log('── /td /fr /bug → _myco_/plan.json ──');

  await t('/td <text> writes to _myco_/plan.json', async () => {
    const sid = 'sess-td-a';
    const cwd = seedSession(sid);
    const replies = await run('/td wire up the cursor pager', { sessionId: sid, absCwd: cwd });
    assert.ok(replies.some((r) => /Todo/.test(r) && /Plan/.test(r)), 'expected confirmation reply, got: ' + JSON.stringify(replies));
    const file = path.join(cwd, '_myco_', 'plan.json');
    assert.ok(fs.existsSync(file), '_myco_/plan.json was NOT written — /todo would be silently lost on next GET');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(data.items) && data.items.length === 1, 'plan.json missing the new item');
    assert.strictEqual(data.items[0].text, 'wire up the cursor pager');
    assert.strictEqual(data.items[0].layer, 'Todo');
    assert.strictEqual(data.items[0].source, 'user');
  });

  await t('/todo (long-name alias) writes to disk', async () => {
    const sid = 'sess-td-b';
    const cwd = seedSession(sid);
    await run('/todo refactor the menu interceptor for clarity', { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    assert.ok(data.items.some((it) => it.text === 'refactor the menu interceptor for clarity'),
      '/todo alias did not persist the item to plan.json');
  });

  await t('/fr writes a Feature item, /bug writes a Bug item — both land in plan.json', async () => {
    const sid = 'sess-td-c';
    const cwd = seedSession(sid);
    await run('/fr add dark-mode toggle', { sessionId: sid, absCwd: cwd });
    await run('/bug menu picker drops clicks on race', { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    const layers = data.items.map((it) => it.layer).sort();
    assert.deepStrictEqual(layers, ['Bug', 'Feature']);
  });

  await t('multiple /td calls accumulate in plan.json (no overwrite)', async () => {
    const sid = 'sess-td-d';
    const cwd = seedSession(sid);
    await run('/td first item', { sessionId: sid, absCwd: cwd });
    await run('/td second item', { sessionId: sid, absCwd: cwd });
    await run('/td third item', { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    assert.strictEqual(data.items.length, 3);
    assert.deepStrictEqual(
      data.items.map((it) => it.text),
      ['first item', 'second item', 'third item']
    );
  });

  await t('quoted / punctuated description preserved verbatim', async () => {
    // The original bug report: /todo with a body containing quotes,
    // commas, and example menu-option labels was being dropped. Verify
    // the full body lands intact.
    const sid = 'sess-td-e';
    const cwd = seedSession(sid);
    const body = `for selection question, there are options such as "chat about it", "type something", it will require typing a message and hit submit.`;
    await run('/todo ' + body, { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    assert.strictEqual(data.items.length, 1);
    assert.strictEqual(data.items[0].text, body);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (failed) process.exit(1);
})();
