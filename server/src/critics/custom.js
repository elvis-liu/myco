// Self-hosted critic wrapper. Delegates to the unified ModelProvider system.
// Designed for local models via Ollama or other OpenAI-compatible servers.

const { getProviderForScenario, getModelForScenario } = require('../models');

async function runCritique(prompt, systemInstruction = '', opts = {}) {
  // Use scenario config by default (preferId='config'), unless user explicitly selected custom
  const preferId = opts.preferId && opts.preferId !== 'config' ? opts.preferId : 'config';
  const provider = getProviderForScenario('critic', { preferId });

  // Custom provider is always available (may not require API key for local Ollama)

  // Model selection:
  // - preferId='config' → use scenario config model
  // - preferId='custom' → use CUSTOM_CRITIC_MODEL or llama3
  // - env override always takes precedence
  const model = process.env.MYCO_CRITIC_MODEL
    || process.env.CUSTOM_CRITIC_MODEL
    || (preferId === 'config' ? getModelForScenario('critic') : 'llama3');

  return provider.call(prompt, systemInstruction, {
    model,
    temperature: 0.2,
  });
}

module.exports = {
  id: 'custom',
  name: 'Self-Hosted Model',
  runCritique,
};
