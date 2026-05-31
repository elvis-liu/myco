const sessionsMod = require('./sessions');
const { getCritic } = require('./critics');
const runQueue = require('./runQueue');

async function triggerGeminiCritique(sessionId, session, item, diff, claudeOutput) {
  // Pause the run queue immediately so no other queue items dispatch during review
  const rec = sessionsMod.getSessionRecord(sessionId);
  if (rec) {
    rec.runQueuePaused = true;
    sessionsMod.saveStore();
  }
  
  // Broadcast queue update to clients so they know it is paused
  session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });

  // Resolve critic plugin dynamically (default to rec.criticModel, then env, then gemini)
  const criticId = (rec && rec.criticModel) || process.env.MYCO_CRITIC_MODEL || 'gemini';
  const critic = getCritic(criticId);

  const systemPrompt = `You are an elite, independent QA and security auditor.
Review the provided git diff against the user's original task.
Compare Claude's changes to the original requirement.
Identify if Claude introduced bugs, security holes, ignored edge cases, or missed requirements.
If you agree with Claude's implementation, write: "✓ AGREED".
If you disagree, write a clear, concise markdown list of issues/bugs and suggest corrections.`;

  const userPrompt = `
Task to accomplish: ${item.text}
Claude's explanation: ${claudeOutput}

=== Staged Git Changes ===
${diff}
`;

  console.log(`[critique] Invoking critic "${critic.name}" (${critic.id}) for item ${item.id}...`);

  // Run the critique stateless completion
  const critique = await critic.runCritique(userPrompt, systemPrompt);
  const isAgreed = critique.includes('✓ AGREED');

  console.log(`[critique] "${critic.name}" critique complete for ${item.id}. Agreement=${isAgreed}`);

  // Broadcast the critique event over WebSockets with brand metadata
  session.emit('state-update', {
    kind: 'critique-review',
    itemId: item.id,
    hasDisagreement: !isAgreed,
    critique: critique,
    diff: diff,
    criticName: critic.name,
    criticId: critic.id
  });
}

module.exports = {
  triggerGeminiCritique
};
