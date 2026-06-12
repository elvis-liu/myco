// Shared Anthropic Messages-API client - thin wrapper over models/provider.
//
// Used by the session summarizer. Internally delegates to the unified
// ModelProvider system. Returns the assistant's text or null on any failure
// (missing API key, network error, timeout, malformed response).
// Callers MUST handle the null case — silent fallback is intentional so
// a missing key downgrades gracefully instead of breaking the request.

const { getProviderForScenario } = require('./models');

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Legacy interface for backward compatibility.
 * Internally delegates to ModelProvider.
 */
function callAnthropic({ system, userMessage, model = DEFAULT_MODEL, maxTokens = 200, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const provider = getProviderForScenario('summarizer');

  if (!provider || !provider.isAvailable()) {
    return Promise.resolve(null);
  }

  return provider.call(userMessage, system, { model, maxTokens, timeoutMs });
}

module.exports = { callAnthropic, DEFAULT_MODEL };
