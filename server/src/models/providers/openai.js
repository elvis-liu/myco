// OpenAI API provider - fetch-based implementation.
//
// Migrated from server/src/critics/codex.js. Supports custom baseUrl,
// ${ENV_VAR} syntax for API key, and configurable sampling parameters.

const { ModelProvider } = require('../provider');

const DEFAULT_SAMPLING = {
  temperature: 0.2,
};

class OpenAIProvider extends ModelProvider {
  constructor(config = {}) {
    super({
      id: 'openai',
      name: 'OpenAI',
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      defaultModel: config.defaultModel || 'gpt-4o',
      apiKey: config.apiKey || '${OPENAI_API_KEY}',
      ...config,
    });
    this.sampling = config.sampling || DEFAULT_SAMPLING;
    // Support fallback env var (CODEX_API_KEY) via config
    this.fallbackApiKey = this._resolveEnvVar(config.fallbackApiKey || '${CODEX_API_KEY}');
  }

  isAvailable() {
    return !!this.apiKey || !!this.fallbackApiKey;
  }

  async call(prompt, systemInstruction = '', opts = {}) {
    // Get API key with fallback support
    let apiKey = this.apiKey;
    if (!apiKey) {
      apiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
    }

    if (!apiKey) {
      return '(OpenAI/Codex API key missing; please set OPENAI_API_KEY or CODEX_API_KEY in your environment)';
    }

    const model = opts.model || this.defaultModel;
    const endpoint = `${this.baseUrl}/chat/completions`;
    const sampling = {
      ...this.sampling,
      ...(opts.temperature ? { temperature: opts.temperature } : {}),
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
            { role: 'user', content: prompt },
          ],
          ...sampling,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || '(OpenAI returned no text)';
    } catch (err) {
      return `(OpenAI call failed: ${err.message})`;
    }
  }
}

function createOpenAIProvider(config = {}) {
  return new OpenAIProvider(config);
}

module.exports = { OpenAIProvider, createOpenAIProvider };