// OpenAI/Codex critic wrapper. Delegates to the unified ModelProvider system.

const { getProviderForScenario, getModelForScenario } = require('../models');

async function runCritique(prompt, systemInstruction = '', opts = {}) {
  // Use scenario config by default (preferId='config'), unless user explicitly selected openai
  const preferId = opts.preferId && opts.preferId !== 'config' ? opts.preferId : 'config';
  const provider = getProviderForScenario('critic', { preferId });

  if (!provider || !provider.isAvailable()) {
    const providerName = provider?.name || provider?.id || 'provider';
    return `(${providerName} API key missing; please check your models.json configuration)`;
  }

  // Model selection:
  // - preferId='config' → use scenario config model
  // - preferId='openai' → use OPENAI_CRITIC_MODEL or gpt-4o
  // - env override always takes precedence
  const model = process.env.MYCO_CRITIC_MODEL
    || process.env.OPENAI_CRITIC_MODEL
    || (preferId === 'config' ? getModelForScenario('critic') : 'gpt-4o');

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
