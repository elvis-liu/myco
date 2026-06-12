// Self-hosted critic wrapper. Delegates to the unified ModelProvider system.
// Designed for local models via Ollama or other OpenAI-compatible servers.

const { getProviderForScenario } = require('../models');

async function runCritique(prompt, systemInstruction = '') {
  const provider = getProviderForScenario('critic', { preferId: 'custom' });

  // Custom provider is always available (may not require API key for local Ollama)

  // Allow env override for model
  const model = process.env.CUSTOM_CRITIC_MODEL || 'llama3';

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
