// Model provider registry - unified entry point for all scenarios.
//
// Provides getProviderForScenario() for scenario-based model selection
// and getAllProviders() for enumeration. Phase 2 loads from config file
// with precedence chain: runtime > session > file > env > default.

const { AnthropicProvider } = require('./providers/anthropic');
const { GeminiProvider } = require('./providers/gemini');
const { OpenAIProvider } = require('./providers/openai');
const { CustomProvider } = require('./providers/custom');
const { AzureOpenAIProvider } = require('./providers/azure-openai');
const { loadConfig, getConfigPath } = require('./configLoader');
const defaults = require('./defaults');

// Provider class registry
const providerClasses = {
  anthropic: AnthropicProvider,
  gemini: GeminiProvider,
  openai: OpenAIProvider,
  custom: CustomProvider,
  azure: AzureOpenAIProvider,
};

// Loaded configuration (file + defaults merged)
let config = null;
let providers = {};

/**
 * Initialize provider instances from loaded config.
 * Called once on first access, or after config reload.
 */
function initializeProviders() {
  if (!config) {
    config = loadConfig();
  }

  // Create provider instances from config
  providers = {};
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    const ProviderClass = providerClasses[id] || providerClasses.custom;
    if (providerConfig.apiKey) {
      providers[id] = new ProviderClass(providerConfig);
    }
  }

  // Ensure at least anthropic provider exists
  if (!providers.anthropic && defaults.providers.anthropic.apiKey) {
    providers.anthropic = new AnthropicProvider(defaults.providers.anthropic);
  }
}

/**
 * Get a specific provider by ID.
 * @param {string} id - Provider ID ('anthropic', 'gemini', 'openai', 'custom', 'azure')
 * @returns {ModelProvider|undefined}
 */
function getProvider(id) {
  if (Object.keys(providers).length === 0) {
    initializeProviders();
  }
  return providers[id];
}

/**
 * Get provider for a scenario.
 * Implements precedence chain with 'config' as default preference.
 * @param {string} scenario - Scenario name ('agent', 'critic', 'summarizer', 'extractor', 'btw')
 * @param {object} opts - Override options
 *   - preferId: string - Preferred provider ID. Special value 'config' (default) uses scenario config.
 *                       Other values ('gemini', 'openai', 'custom', etc.) force specific provider.
 *   - model: string - Model override
 *   - sessionModel: string - Session-level override (e.g., rec.criticModel format 'provider:model')
 * @returns {ModelProvider}
 */
function getProviderForScenario(scenario, opts = {}) {
  if (Object.keys(providers).length === 0) {
    initializeProviders();
  }

  // Determine preference mode
  const preferId = opts.preferId || 'config';  // default to 'config'

  // 1. If preferId is 'config' (default), use scenario config first
  if (preferId === 'config') {
    const scenarioConfig = config.scenarios[scenario] || config.fallback;
    const providerId = scenarioConfig.provider || 'anthropic';
    if (providers[providerId]) {
      return providers[providerId];
    }
    // fallback to anthropic if scenario provider not available
    return providers.anthropic;
  }

  // 2. If preferId is a specific provider ID, use it (user manual selection)
  if (providers[preferId]) {
    return providers[preferId];
  }

  // 3. Session-level override (e.g., rec.criticModel)
  if (opts.sessionModel) {
    const [providerId, model] = opts.sessionModel.split(':');
    if (providers[providerId]) {
      return providers[providerId];
    }
  }

  // 4. Fallback to scenario config
  const scenarioConfig = config.scenarios[scenario] || config.fallback;
  const providerId = scenarioConfig.provider || 'anthropic';
  return providers[providerId] || providers.anthropic;
}

/**
 * Get all available providers.
 * @returns {ModelProvider[]}
 */
function getAllProviders() {
  if (Object.keys(providers).length === 0) {
    initializeProviders();
  }
  return Object.values(providers).filter(p => p.isAvailable());
}

/**
 * Reload configuration from file.
 * Useful for runtime config updates without restart.
 */
function reloadConfig() {
  config = loadConfig();
  initializeProviders();
}

/**
 * Get model for a scenario.
 * If scenario doesn't specify model explicitly, use provider's defaultModel.
 * @param {string} scenario - Scenario name
 * @returns {string} - Model ID to use
 */
function getModelForScenario(scenario) {
  if (!config) {
    initializeProviders();
  }

  const scenarioConfig = config.scenarios[scenario] || config.fallback;
  const providerId = scenarioConfig.provider || 'anthropic';

  // If scenario explicitly specifies model, use it
  if (scenarioConfig.model) {
    return scenarioConfig.model;
  }

  // Otherwise, use provider's defaultModel
  const providerConfig = config.providers[providerId];
  return providerConfig?.defaultModel || 'claude-haiku-4-5-20251001';
}

/**
 * Get current configuration.
 * @returns {object}
 */
function getConfig() {
  if (!config) {
    initializeProviders();
  }
  return config;
}

module.exports = {
  getProvider,
  getProviderForScenario,
  getModelForScenario,
  getAllProviders,
  providers,
  reloadConfig,
  getConfig,
  getConfigPath,
};