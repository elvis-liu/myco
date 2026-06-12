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
 * Implements precedence chain: runtime > session > file > env > default
 * @param {string} scenario - Scenario name ('agent', 'critic', 'summarizer', 'extractor', 'btw')
 * @param {object} opts - Override options
 *   - preferId: string - Preferred provider ID (used by critics to select specific model)
 *   - model: string - Model override
 *   - sessionModel: string - Session-level override (e.g., rec.criticModel format 'provider:model')
 * @returns {ModelProvider}
 */
function getProviderForScenario(scenario, opts = {}) {
  if (Object.keys(providers).length === 0) {
    initializeProviders();
  }

  // 1. Runtime override (highest priority)
  if (opts.preferId && providers[opts.preferId]) {
    return providers[opts.preferId];
  }

  // 2. Session-level override (e.g., rec.criticModel)
  if (opts.sessionModel) {
    const [providerId, model] = opts.sessionModel.split(':');
    if (providers[providerId]) {
      return providers[providerId];
    }
  }

  // 3. File config or defaults
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
  getAllProviders,
  providers,
  reloadConfig,
  getConfig,
  getConfigPath,
};