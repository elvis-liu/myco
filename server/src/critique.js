const fs = require('fs');
const path = require('path');
const sessionsMod = require('./sessions');
const { getCritic } = require('./critics');
const runQueue = require('./runQueue');
// fr-94 Phase 1: delegate _myco_/ path resolution to the shared
// helper in artifacts.js. The helper honors rec.mainProject (the
// explicit project root set at session creation) and falls back
// to auto-detection. Pre-fr-94 this file hand-rolled
// `path.join(absCwd, '_myco_', 'critic.md')` which always wrote to
// session-root — wrong on sessions whose actual project lives in
// a subdirectory.
const { resolveMycoDir } = require('./artifacts');

// fr-89: load the project's _myco_/critic.md so its content can be
// appended to the critic's system prompt. On the first critique run
// for a project (file missing), seed it from the myco-shipped default
// at server/templates/critic.md so the critic always has a baseline
// of project-relevant rules + anti-patterns. The file is project-
// owned after seeding — myco template updates do NOT overwrite local
// edits. To reset to the default, delete `_myco_/critic.md` and
// trigger another critic run.
//
// Returns the file's content as a string, or '' if the load failed
// (the critique still runs, just without the project-specific rules
// — graceful degradation).
function _loadProjectCriticRules(rec) {
  // fr-94 Phase 1: resolveMycoDir(rec) honors rec.mainProject (the
  // designated project root for this session) or falls back to the
  // legacy auto-detect (look for .git/ in absCwd or one subdir
  // deep). Pre-fr-94 this hand-rolled `path.join(absCwd, '_myco_',
  // ...)` and always wrote to session-root — wrong on sessions
  // whose actual project lives in a subdirectory.
  const mycoDir = resolveMycoDir(rec);
  if (!mycoDir) {
    console.warn('[fr-89] no project root resolvable for this session — skipping critic.md');
    return '';
  }
  const rulesPath = path.join(mycoDir, 'critic.md');
  try {
    if (!fs.existsSync(rulesPath)) {
      const templatePath = path.join(__dirname, '..', 'templates', 'critic.md');
      if (fs.existsSync(templatePath)) {
        fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
        fs.copyFileSync(templatePath, rulesPath);
        console.log(`[fr-89] seeded ${rulesPath} from myco default template`);
      } else {
        console.warn('[fr-89] myco-shipped default critic.md template missing — running critique without project rules');
        return '';
      }
    }
    return fs.readFileSync(rulesPath, 'utf8');
  } catch (err) {
    console.error(`[fr-89] failed to load project critic.md: ${err && err.message ? err.message : err}`);
    return '';
  }
}

// td-33: critic-error detection. When the SDK returns an envelope like
// "(Gemini call failed: ...)" / "(Gemini API key missing...)" / etc.,
// the critique payload is unusable and we want to surface a ↻ Retry
// affordance instead of a malformed verdict. The wrappers consistently
// emit a parenthesised "(X failed: ...)" or "(X error: ...)" shape;
// the same pattern catches missing-key sentinels too. Any string that
// fits is broadcast with isError=true so the client renders the retry
// button + skips the run-queue-pause logic (a verdict that never
// happened can't gate a queue advance).
function _looksLikeCriticError(critique) {
  const s = String(critique || '').trim();
  if (!s) return true;                              // empty verdict = error
  // The wrappers prefix with "(": "(Gemini call failed: ...)",
  // "(Gemini API key missing...)", "(no Gemini key provided)", etc.
  if (!s.startsWith('(')) return false;
  return /failed|missing|error|invalid|timeout|rate.?limit|quota|503|429|401|400/i.test(s);
}

async function triggerGeminiCritique(sessionId, session, item, diff, claudeOutput, opts = {}) {
  // td-33: opts.isIntermediate flags a stage-checkpoint critique fired
  // mid-run (claude announced [stage: analyze done] / [stage: code
  // done] / [stage: verify done] in its assistant text). Intermediate
  // critiques broadcast for the user's awareness but do NOT pause the
  // run queue — pausing on every stage transition would freeze
  // multi-step work behind a sequence of approvals. Only the FINAL
  // critique (the one fired on turn_result success) gates queue
  // advance, matching pre-td-33 behavior.
  const isIntermediate = !!(opts && opts.isIntermediate);
  const stage = (opts && opts.stage) || null;
  const isRetry = !!(opts && opts.isRetry);
  // bug-52: optional follow-up prompt the user types into the verdict
  // pane's input field. Append to the critic's user-prompt so Gemini
  // looks into the specific concern the user flagged on top of the
  // standard review. Empty/whitespace inputs are ignored. Capped at
  // 2 KB to keep the prompt budget under control.
  const userFollowupRaw = (opts && typeof opts.userPrompt === 'string') ? opts.userPrompt.trim() : '';
  const userFollowup = userFollowupRaw.slice(0, 2048);

  const rec = sessionsMod.getSessionRecord(sessionId);
  // td-33 r1 (Gemini critique catch — 2026-06-03): the original
  // ordering paused the queue BEFORE running the critic. That meant
  // a critic-error result (Gemini 503, missing key, etc.) left the
  // queue paused with only a ↻ Retry button — if retries kept
  // failing, the user was stuck. The pause now happens AFTER the
  // critic returns, gated on `!isError` so error verdicts don't
  // freeze the queue. The window between turn_result and the pause
  // is small (one Gemini API call, ~5-60s) and harmless: the
  // critique gate in attach.js returns early on triggerGeminiCritique
  // success so _advanceRunQueue isn't called during that window.

  // td-33 (A — retry support): cache the inputs on rec so the ↻ Retry
  // button can re-fire this exact critique without round-tripping the
  // full diff back through the client. Cache is overwritten on each
  // fire (we only support retrying the MOST RECENT critique — older
  // ones are out of scope per "no speculative features").
  if (rec) {
    rec._lastCritique = {
      itemId: item && item.id,
      itemSnapshot: item,
      diff,
      claudeOutput,
      isIntermediate,
      stage,
      firedAt: new Date().toISOString(),
    };
    sessionsMod.saveStore();
  }

  // Resolve critic plugin dynamically (default to rec.criticModel, then env, then gemini)
  const criticId = (rec && rec.criticModel) || process.env.MYCO_CRITIC_MODEL || 'gemini';
  const critic = getCritic(criticId);

  // Critic system prompt. Calibration notes (2026-06-02):
  //   · "INSUFFICIENT INFORMATION" opt-out: critics with broad
  //     instructions tend to rubber-stamp when they can't actually
  //     tell. The explicit out lets the critic admit uncertainty
  //     instead of confabulating a plausible-but-wrong verdict.
  //     Combined with low temperature in the model wrapper, this
  //     catches a class of hallucination the prior prompt missed.
  //   · Anti-speculation clause: the critic only sees the diff —
  //     no chat history, no full file contents, no test runs. Make
  //     that limitation explicit so it doesn't invent context.
  //   · The "✓ AGREED" sentinel stays exactly the same string —
  //     `isAgreed = critique.includes('✓ AGREED')` is the gate that
  //     decides whether the run-queue auto-advances.
  const basePrompt = `You are an elite, independent QA and security auditor.
Review the provided git diff against the user's original task.
Compare Claude's changes to the original requirement.
Identify if Claude introduced bugs, security holes, ignored edge cases, or missed requirements.

You can ONLY see the diff and Claude's short explanation — no full file contents, no chat history, no test runs. If you cannot tell from those alone whether something is correct, write "INSUFFICIENT INFORMATION:" followed by what you would need to verify. Do NOT speculate or rubber-stamp.

If you agree with Claude's implementation, write "✓ AGREED" on the first line, then on the lines below give a concise 2-4 sentence explanation of WHY you agree: what the change does well, which parts of the original requirement it satisfies, and any non-blocking observations or polish suggestions worth mentioning. Do not be terse — a bare "✓ AGREED" with no reasoning is unhelpful (the user has explicitly asked the critic to show its reasoning even when approving — bug-52). If you disagree, write a clear, concise markdown list of issues/bugs and suggest corrections. Cite specific lines from the diff.`;

  // fr-89: append project-specific critic rules from
  // <project>/_myco_/critic.md to the base system prompt. The file
  // is seeded from the myco default template on first run for a
  // project; project-owned thereafter (user edits don't get clobbered
  // on subsequent runs).
  // fr-94 Phase 1: _loadProjectCriticRules now takes the full `rec`
  // so it can call resolveMycoDir(rec) — that helper honors
  // rec.mainProject (the designated project root for this session)
  // or falls back to legacy auto-detect.
  const projectCriticRules = rec ? _loadProjectCriticRules(rec) : '';
  const systemPrompt = projectCriticRules
    ? `${basePrompt}\n\n=== Project-specific critic rules (from _myco_/critic.md) ===\nThese extend, but never override, the above instructions.\n\n${projectCriticRules}`
    : basePrompt;

  // td-33 (B — stage-aware critic): intermediate critiques get a
  // checkpoint preamble so Gemini calibrates correctly. The end-of-
  // run critique still expects "all work done"; an intermediate one
  // is reviewing partial progress + should flag obvious issues only
  // without expecting completeness. Same INSUFFICIENT INFORMATION
  // opt-out applies either way.
  const checkpointHeader = isIntermediate
    ? `\n[CHECKPOINT REVIEW — STAGE: ${String(stage || 'unknown').toUpperCase()}]\nThis is a mid-run checkpoint, not the final review. Claude is currently working on this item — the diff reflects partial progress through the ${stage || 'current'} stage. Flag obvious issues + missing pieces; do NOT mark INSUFFICIENT INFORMATION for "work isn't done yet" because that's expected. The next stage will produce a follow-up critique.\n`
    : '';
  // bug-52: when the user typed a follow-up prompt into the verdict
  // pane's input field, surface it as a TOP-PRIORITY instruction so
  // Gemini centers its review on that concern. Without the explicit
  // "user is specifically asking" framing, the model often gives the
  // same generic review and ignores the user's question.
  const userFollowupBlock = userFollowup
    ? `\n\n[USER FOLLOW-UP — give this priority over the generic review]\nThe user has typed the following concern they want you to look into specifically:\n"${userFollowup}"\nAddress this concern explicitly in your reasoning. If the diff doesn't have enough information to answer it, say so plainly.\n`
    : '';
  const userPrompt = `${checkpointHeader}
Task to accomplish: ${item.text}
Claude's explanation: ${claudeOutput}

=== Staged Git Changes ===
${diff}
${userFollowupBlock}`;

  const label = isIntermediate ? `intermediate-${stage}` : 'final';
  console.log(`[critique] Invoking critic "${critic.name}" (${critic.id}) for item ${item.id} (${label}${isRetry ? ', retry' : ''})...`);

  // Run the critique stateless completion
  const critique = await critic.runCritique(userPrompt, systemPrompt);
  const isError = _looksLikeCriticError(critique);
  const isAgreed = !isError && critique.includes('✓ AGREED');

  console.log(`[critique] "${critic.name}" critique complete for ${item.id} (${label}). Agreement=${isAgreed} isError=${isError}`);

  // td-33 r1: pause the run queue NOW (only for non-error, non-
  // intermediate critiques). Error verdicts intentionally leave the
  // queue free so the user isn't trapped by a 503-retry loop.
  if (rec && !isIntermediate && !isError) {
    rec.runQueuePaused = true;
    sessionsMod.saveStore();
    session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
  }

  // Broadcast the critique event over WebSockets with brand metadata.
  // td-33: isError lets the client render a ↻ Retry button; isIntermediate
  // lets the client render a [Checkpoint: <stage>] badge + skip the
  // run-queue-pause-banner. The diff is included so a future client
  // could expose "diff at checkpoint" if useful.
  session.emit('state-update', {
    kind: 'critique-review',
    itemId: item.id,
    hasDisagreement: !isAgreed,
    isError,
    isIntermediate,
    isRetry,
    stage,
    critique: critique,
    diff: diff,
    criticName: critic.name,
    criticId: critic.id,
  });
}

// td-33 (A — retry support): re-fire the most recently cached
// critique inputs for this session. Returns true on success, false
// when there's nothing to retry (e.g. server restarted + cache lost,
// or no critique has ever fired on this session). The retried
// critique broadcasts with isRetry=true so the client can render a
// "retrying…" → fresh verdict transition.
//
// bug-52: opts.userPrompt is the optional follow-up prompt the user
// typed into the verdict pane's input field. When set, the next
// critique is steered to address that specific concern. Caller
// (the /critique/retry route) passes it through from the request body.
async function retryLastCritique(sessionId, session, opts = {}) {
  const rec = sessionsMod.getSessionRecord(sessionId);
  if (!rec || !rec._lastCritique) return false;
  const last = rec._lastCritique;
  if (!last.itemSnapshot || !last.itemId) return false;
  await triggerGeminiCritique(sessionId, session, last.itemSnapshot, last.diff, last.claudeOutput, {
    isIntermediate: last.isIntermediate,
    stage: last.stage,
    isRetry: true,
    userPrompt: opts && typeof opts.userPrompt === 'string' ? opts.userPrompt : '',
  });
  return true;
}

module.exports = {
  triggerGeminiCritique,
  retryLastCritique,
  _looksLikeCriticError,
};
