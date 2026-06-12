// ModelProvider base class - unified interface for all model providers.
//
// All provider implementations (anthropic, gemini, openai, custom) extend
// this class and implement the call() method. The base class provides
// common utilities for environment variable resolution and availability
// checks.

class ModelProvider {
  constructor(config = {}) {
    this.config = config;
    this.id = config.id || 'unknown';
    this.name = config.name || 'Unknown Provider';
    this.baseUrl = config.baseUrl || '';
    this.defaultModel = config.defaultModel || '';
    this.apiKey = this._resolveEnvVar(config.apiKey);
  }

  /**
   * Resolve ${ENV_VAR} syntax to actual environment variable value.
   * @param {string} value - Value that may contain ${ENV_VAR} syntax
   * @returns {string|undefined} - Resolved value
   */
  _resolveEnvVar(value) {
    if (!value) return undefined;
    if (typeof value !== 'string') return value;

    // Handle ${ENV_VAR} syntax
    if (value.startsWith('${') && value.endsWith('}')) {
      const envVar = value.slice(2, -1);
      // Support ${VAR:default} syntax
      const [varName, defaultValue] = envVar.split(':');
      return process.env[varName] || defaultValue || undefined;
    }

    // Direct value (not env reference)
    return value;
  }

  /**
   * Invoke the model with a prompt.
   * @param {string} prompt - User prompt
   * @param {string} systemInstruction - System instruction (optional)
   * @param {object} opts - Additional options (model, maxTokens, temperature, etc.)
   * @returns {Promise<string|null>} - Model response or null on failure
   */
  async call(prompt, systemInstruction = '', opts = {}) {
    throw new Error('ModelProvider.call() must be implemented by subclass');
  }

  /**
   * Check if the provider is available (e.g., API key present).
   * @returns {boolean}
   */
  isAvailable() {
    return !!this.apiKey;
  }

  /**
   * Get provider metadata for logging/display.
   * @returns {{id: string, name: string, model: string}}
   */
  getMetadata() {
    return {
      id: this.id,
      name: this.name,
      model: this.defaultModel,
    };
  }
}

module.exports = { ModelProvider };