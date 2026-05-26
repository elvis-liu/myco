// fr-80: `/fr @<target>`, `/bug @<target>`, `/td @<target>` route to a
// remote GitHub repo via the user's PAT instead of appending to the
// session's local plan.
//
// User-reported (kkrazy 2026-05-26):
//   "Slash commands `/fr @myco`, `/bug @myco`, and `/td @myco` rewrite
//    the user's note into a proper issue, submit it to
//    `github.com/kkrazy/myco`, and return a link for the user to
//    review/update."
//
// Implementation in server/src/slashcmds.js:
//   • REMOTE_TARGETS = { myco: { provider, owner, repo } }  registry
//   • addPlanItem detects `@<target>` prefix in args → routes to
//     handleRemoteIssue instead of adding a local plan item
//   • handleRemoteIssue reuses gitHosts.createIssue + getToken (same
//     auth path as /feature: per-repo PAT preferred, GitHub OAuth
//     fallback for github-hosted targets)
//   • Per-layer labels: Feature → enhancement, Bug → bug, Todo → todo
//
// Static-shape guards (no live HTTP — gitHosts.createIssue is an
// external boundary; integration testing belongs in a different
// suite).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');

console.log('── fr-80: /fr /bug /td @<target> remote issue routing ──');

t('slashcmds.js: REMOTE_TARGETS registry defines @myco → kkrazy/myco', () => {
  assert.ok(/const\s+REMOTE_TARGETS\s*=/.test(SRC),
    'REMOTE_TARGETS map must be declared');
  const idx = SRC.search(/const\s+REMOTE_TARGETS\s*=/);
  const win = SRC.slice(idx, idx + 600);
  assert.ok(/myco\s*:\s*\{[^}]*provider\s*:\s*['"]github['"]/.test(win),
    '@myco target must map to provider:github');
  assert.ok(/owner\s*:\s*['"]kkrazy['"]/.test(win),
    '@myco target owner must be kkrazy');
  assert.ok(/repo\s*:\s*['"]myco['"]/.test(win),
    '@myco target repo must be myco');
});

t('slashcmds.js: REMOTE_LABEL_BY_LAYER maps Feature/Bug/Todo to issue labels', () => {
  const idx = SRC.search(/const\s+REMOTE_LABEL_BY_LAYER\s*=/);
  assert.ok(idx > -1, 'REMOTE_LABEL_BY_LAYER must be declared');
  const win = SRC.slice(idx, idx + 400);
  assert.ok(/Feature\s*:\s*\[\s*['"]enhancement['"]/.test(win),
    'Feature → ["enhancement"]');
  assert.ok(/Bug\s*:\s*\[\s*['"]bug['"]/.test(win),
    'Bug → ["bug"]');
  assert.ok(/Todo\s*:\s*\[\s*['"]todo['"]/.test(win),
    'Todo → ["todo"]');
});

t('slashcmds.js: addPlanItem detects @<target> prefix + routes to handleRemoteIssue', () => {
  const idx = SRC.search(/function\s+addPlanItem\s*\(/);
  assert.ok(idx > -1);
  const win = SRC.slice(idx, idx + 3500);
  // The regex match for `@<target>`.
  assert.ok(/text\.match\(\s*\/\^@\(\[a-z0-9_-\]\+\)/i.test(win),
    'must match a leading @<target> token in args');
  // The route call.
  assert.ok(/return\s+handleRemoteIssue\(\s*ctx,\s*layer,\s*targetName,\s*remainder/.test(win),
    'must call handleRemoteIssue(ctx, layer, targetName, remainder) on match');
  // Unknown target bounces with a hint.
  assert.ok(/REMOTE_TARGETS\[targetName\]/.test(win),
    'must validate the target against REMOTE_TARGETS before routing');
  // Empty body after the target bounces with usage.
  assert.ok(/!remainder/.test(win),
    'must reject empty description after @target with a usage hint');
});

t('slashcmds.js: handleRemoteIssue is defined + uses gitHosts.{getToken,createIssue}', () => {
  assert.ok(/async\s+function\s+handleRemoteIssue\s*\(/.test(SRC),
    'handleRemoteIssue must be defined');
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  const win = SRC.slice(idx, idx + 3000);
  assert.ok(/gitHosts\.getToken\(\s*ctx\.user/.test(win),
    'must call gitHosts.getToken(ctx.user, provider, owner, repo)');
  assert.ok(/gitHosts\.createIssue\(/.test(win),
    'must call gitHosts.createIssue to file the issue');
  // Per-layer labels via REMOTE_LABEL_BY_LAYER.
  assert.ok(/REMOTE_LABEL_BY_LAYER\[layer\]/.test(win),
    'must read labels from REMOTE_LABEL_BY_LAYER[layer]');
  // Returns a link on success.
  assert.ok(/result\.url/.test(win),
    'must include result.url in the success reply');
});

t('slashcmds.js: handleRemoteIssue title is the first line, capped at 80 chars', () => {
  // Long body lines shouldn't bleed into the issue title — the GitHub
  // issue list is scannable when titles stay short.
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  const win = SRC.slice(idx, idx + 3000);
  assert.ok(/firstLine\.length\s*>\s*80/.test(win),
    'must cap the title at 80 chars (truncate with ellipsis)');
  assert.ok(/split\(\s*\/\[\\r\\n\]\/,\s*1\)/.test(win),
    'must take only the first line (split on \\r or \\n, limit 1)');
});

t('slashcmds.js: handleRemoteIssue body includes user attribution + cmd marker', () => {
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  const win = SRC.slice(idx, idx + 3000);
  assert.ok(/Filed by/.test(win),
    'body must include "Filed by **@<user>**" attribution');
  assert.ok(/\/\$\{cmdName\} @\$\{targetName\}/.test(win),
    'body must cite the exact slash-command shape (e.g., `/fr @myco`)');
});

t('slashcmds.js: command usage strings advertise @<target>', () => {
  // The /fr /bug /td registrations should hint at the remote-target
  // form in their usage line so the new path is discoverable from /help.
  const block = SRC.match(/names:\s*\[['"]fr['"]\][\s\S]{0,1500}/);
  assert.ok(block, 'fr/bug/td block must be findable');
  for (const cmd of ['fr', 'td', 'bug']) {
    const re = new RegExp(`usage:[^\\n]*${cmd}[^\\n]*@<target>`);
    assert.ok(re.test(SRC),
      `/${cmd} usage string must mention @<target> form`);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
