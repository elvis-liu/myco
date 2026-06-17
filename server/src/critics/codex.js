// OpenAI/Codex critic wrapper. Delegates to the unified ModelProvider system.

const { getProviderForScenario } = require('../models');

async function runCritique(prompt, systemInstruction = '', opts = {}) {
  // Use scenario config by default (preferId='config'), unless user explicitly selected openai
  const preferId = opts.preferId && opts.preferId !== 'config' ? opts.preferId : 'config';
  const provider = getProviderForScenario('critic', { preferId });

  if (!provider || !provider.isAvailable()) {
    return '(OpenAI/Codex API key missing; please set OPENAI_API_KEY or CODEX_API_KEY in your environment)';
  }

  // Allow env override for model
  const model = process.env.OPENAI_CRITIC_MODEL || 'gpt-4o';

  return provider.call(prompt, systemInstruction, {
    model,
    temperature: 0.2,
  });
}

module.exports = {
  id: 'codex',
  name: 'Codex (OpenAI)',
  runCritique,
};
