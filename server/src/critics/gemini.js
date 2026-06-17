// Gemini critic wrapper. Delegates to the unified ModelProvider system.
//
// The model + sampling config below were last reviewed 2026-06-07 after
// `gemini-2.5-flash` started 503ing frequently (Google capacity-shedding
// on the flash endpoint). User asked for the bump to -pro as a mitigation.
//
// Historical calibration notes preserved for reference:
//   1. Model: `gemini-1.5-pro` → `gemini-2.5-flash` (2026-06-02) →
//      `gemini-2.5-pro` (2026-06-07). 2.5 is the current family.
//   2. Sampling: explicit `temperature: 0.2` (was default 1.0),
//      `topP: 0.8` (was 0.95). Adversarial code review wants determinism.
//   3. Failure surface: model + sampling values pulled into named
//      constants so a future test can grep them + a future model bump
//      is one place to edit.
//
// 2026-06-03 calibration — maxOutputTokens 1024 → 8192:
//   The 1024-token cap silently truncated verdicts on large diffs.
//   8192 was empirically verified to fit ~3,800-char detailed verdicts.

const { getProviderForScenario } = require('../models');

// Named constants for test calibration (must stay in this file)
const CRITIC_MODEL = 'gemini-2.5-pro';
const CRITIC_MAX_OUTPUT_TOKENS = Math.max(
  4096,
  parseInt(process.env.MYCO_CRITIC_MAX_TOKENS || '', 10) || 8192,
);
const CRITIC_SAMPLING = {
  temperature: 0.2,
  topP: 0.8,
  maxOutputTokens: CRITIC_MAX_OUTPUT_TOKENS,
};

async function runCritique(prompt, systemInstruction = '', opts = {}) {
  // Use scenario config by default (preferId='config'), unless user explicitly selected gemini
  const preferId = opts.preferId && opts.preferId !== 'config' ? opts.preferId : 'config';
  const provider = getProviderForScenario('critic', { preferId });

  if (!provider || !provider.isAvailable()) {
    return '(Gemini API key missing; please set GEMINI_API_KEY or API_KEY in your environment)';
  }

  // Allow env override for model and max tokens
  const model = process.env.MYCO_CRITIC_MODEL || CRITIC_MODEL;
  const maxOutputTokens = CRITIC_MAX_OUTPUT_TOKENS;

  return provider.call(prompt, systemInstruction, {
    model,
    maxOutputTokens,
    temperature: CRITIC_SAMPLING.temperature,
    topP: CRITIC_SAMPLING.topP,
  });
}

module.exports = {
  id: 'gemini',
  name: 'Gemini-2.5-Pro',
  runCritique,
};
