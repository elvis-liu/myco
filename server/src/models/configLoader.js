// Model provider configuration loader.
//
// Loads models.json from $MYCO_STATE_DIR or custom path, resolves ${ENV_VAR}
// syntax throughout the config object, and merges with hardcoded defaults.
// Implements the precedence chain: runtime > session > file > env > default.

const fs = require('fs');
const path = require('path');
const defaults = require('./defaults');

/**
 * Resolve ${ENV_VAR} syntax in a value.
 * Supports ${VAR} and ${VAR:default} syntax.
 * @param {string|any} value - Value to resolve
 * @returns {string|any} - Resolved value
 */
function resolveEnvVar(value) {
  if (!value) return value;
  if (typeof value !== 'string') return value;

  // Handle ${ENV_VAR} syntax
  const envVarPattern = /\$\{([^}]+)\}/g;
  return value.replace(envVarPattern, (match, envVar) => {
    // Support ${VAR:default} syntax - find first colon that's part of VAR:default, not URL colon
    const colonIndex = envVar.indexOf(':');
    let varName, defaultValue;

    if (colonIndex === -1) {
      // No colon - simple ${VAR}
      varName = envVar;
      defaultValue = undefined;
    } else {
      // Split at first colon: VAR:rest
      // But need to check if this is a valid env var name
      varName = envVar.slice(0, colonIndex);
      defaultValue = envVar.slice(colonIndex + 1);
    }

    const envValue = process.env[varName];
    if (envValue !== undefined) return envValue;
    if (defaultValue !== undefined) return defaultValue;
    return ''; // Empty string if env var not found and no default
  });
}

/**
 * Recursively resolve ${ENV_VAR} syntax in an object.
 * @param {object} obj - Object to resolve
 * @returns {object} - Resolved object (mutated in place)
 */
function resolveEnvVars(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'string') {
      obj[key] = resolveEnvVar(value);
    } else if (typeof value === 'object' && value !== null) {
      resolveEnvVars(value);
    }
  }

  return obj;
}

/**
 * Get the configuration file path.
 * Priority: MYCO_MODELS_CONFIG_PATH > $MYCO_STATE_DIR/models.json > /data/models.json
 * @returns {string}
 */
function getConfigPath() {
  if (process.env.MYCO_MODELS_CONFIG_PATH) {
    return process.env.MYCO_MODELS_CONFIG_PATH;
  }

  const stateDir = process.env.MYCO_STATE_DIR || '/data';
  return path.join(stateDir, 'models.json');
}

/**
 * Load and parse the configuration file.
 * @returns {object|null} - Parsed config or null if file doesn't exist
 */
function loadConfigFile() {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    return resolveEnvVars(config);
  } catch (err) {
    console.error(`[models] Failed to load ${configPath}: ${err.message}`);
    return null;
  }
}

/**
 * Merge provider configs from file with defaults.
 * File config overrides defaults for specified providers.
 * @param {object} fileProviders - Providers from config file
 * @param {object} defaultProviders - Hardcoded defaults
 * @returns {object} - Merged providers config
 */
function mergeProviders(fileProviders, defaultProviders) {
  const merged = { ...defaultProviders };

  if (fileProviders) {
    for (const [id, config] of Object.entries(fileProviders)) {
      // Deep merge provider config
      merged[id] = {
        ...defaultProviders[id],
        ...config,
        // Preserve nested objects like sampling
        sampling: {
          ...(defaultProviders[id]?.sampling || {}),
          ...(config.sampling || {}),
        },
      };
    }
  }

  return merged;
}

/**
 * Merge scenario configs from file with defaults.
 * File config overrides defaults for specified providers, but
 * does NOT inherit default model (to allow provider.defaultModel fallback).
 * @param {object} fileScenarios - Scenarios from config file
 * @param {object} defaultScenarios - Hardcoded defaults
 * @returns {object} - Merged scenarios config
 */
function mergeScenarios(fileScenarios, defaultScenarios) {
  const merged = { ...defaultScenarios };

  if (fileScenarios) {
    for (const [scenario, config] of Object.entries(fileScenarios)) {
      // Only merge provider, not model - let provider.defaultModel be used if model not specified
      merged[scenario] = {
        provider: config.provider || defaultScenarios[scenario]?.provider,
        // Only include model if explicitly specified in file config
        ...(config.model ? { model: config.model } : {}),
      };
    }
  }

  return merged;
}

/**
 * Load the complete model provider configuration.
 * Implements precedence: file > default.
 * (runtime and session overrides are handled in index.js)
 * @returns {object} - Complete config with providers and scenarios
 */
function loadConfig() {
  const fileConfig = loadConfigFile();

  if (!fileConfig) {
    // File doesn't exist or failed to load - use defaults
    return defaults;
  }

  // Merge file config with defaults
  return {
    providers: mergeProviders(fileConfig.providers, defaults.providers),
    scenarios: mergeScenarios(fileConfig.scenarios, defaults.scenarios),
    fallback: fileConfig.fallback || defaults.fallback,
  };
}

/**
 * Validate a provider config.
 * @param {object} config - Provider config to validate
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateProviderConfig(config) {
  const errors = [];

  if (!config.apiKey) {
    errors.push('apiKey is required');
  }

  if (!config.baseUrl) {
    errors.push('baseUrl is required');
  }

  if (!config.defaultModel) {
    errors.push('defaultModel is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate the complete configuration.
 * @param {object} config - Complete config to validate
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
function validateConfig(config) {
  const errors = [];
  const warnings = [];

  // Validate providers
  if (!config.providers || Object.keys(config.providers).length === 0) {
    errors.push('No providers defined');
  } else {
    for (const [id, providerConfig] of Object.entries(config.providers)) {
      const result = validateProviderConfig(providerConfig);
      if (!result.valid) {
        errors.push(`Provider '${id}': ${result.errors.join(', ')}`);
      }
    }
  }

  // Validate scenarios
  if (!config.scenarios) {
    warnings.push('No scenarios defined, will use fallback');
  }

  // Validate fallback
  if (!config.fallback || !config.fallback.provider) {
    warnings.push('No fallback defined');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  resolveEnvVar,
  resolveEnvVars,
  getConfigPath,
  loadConfigFile,
  loadConfig,
  mergeProviders,
  mergeScenarios,
  validateProviderConfig,
  validateConfig,
};