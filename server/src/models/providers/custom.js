// Self-hosted/Ollama API provider - OpenAI-compatible endpoint.
//
// Migrated from server/src/critics/custom.js. Supports custom baseUrl,
// ${ENV_VAR} syntax for API key, and configurable sampling parameters.
// Designed for local models via Ollama or other OpenAI-compatible servers.

const { ModelProvider } = require('../provider');

const DEFAULT_SAMPLING = {
  temperature: 0.2,
};

class CustomProvider extends ModelProvider {
  constructor(config = {}) {
    super({
      id: 'custom',
      name: 'Self-Hosted Model',
      baseUrl: config.baseUrl || '${CUSTOM_CRITIC_ENDPOINT:http://localhost:11434/v1}',
      defaultModel: config.defaultModel || 'llama3',
      apiKey: config.apiKey || '${CUSTOM_CRITIC_KEY}',
      ...config,
    });
    this.sampling = config.sampling || DEFAULT_SAMPLING;
  }

  // Custom provider may not require API key (local Ollama)
  isAvailable() {
    return true;
  }

  async call(prompt, systemInstruction = '', opts = {}) {
    // Resolve baseUrl (may have env var reference)
    let endpoint = this.baseUrl;
    if (!endpoint) {
      endpoint = process.env.CUSTOM_CRITIC_ENDPOINT || 'http://localhost:11434/v1';
    }
    // Normalize endpoint URL
    endpoint = endpoint.replace(/\/+$/, '');
    const url = `${endpoint}/chat/completions`;

    const apiKey = this.apiKey || process.env.CUSTOM_CRITIC_KEY || '';
    const model = opts.model || this.defaultModel || process.env.CUSTOM_CRITIC_MODEL || 'llama3';
    const sampling = {
      ...this.sampling,
      ...(opts.temperature ? { temperature: opts.temperature } : {}),
    };

    try {
      const headers = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
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
      return data.choices?.[0]?.message?.content?.trim() || '(Local model returned no text)';
    } catch (err) {
      return `(Self-hosted call failed: ${err.message} on endpoint ${url})`;
    }
  }
}

function createCustomProvider(config = {}) {
  return new CustomProvider(config);
}

module.exports = { CustomProvider, createCustomProvider };