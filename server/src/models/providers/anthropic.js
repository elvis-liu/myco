// Anthropic Messages API provider - raw HTTPS implementation (no SDK).
//
// Migrated from server/src/anthropic.js. Supports custom baseUrl and
// ${ENV_VAR} syntax for API key. Uses the same error handling strategy:
// returns null on any failure for graceful degradation.

const https = require('https');
const { ModelProvider } = require('../provider');

class AnthropicProvider extends ModelProvider {
  constructor(config = {}) {
    super({
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: config.baseUrl || 'https://api.anthropic.com/v1',
      defaultModel: config.defaultModel || 'claude-haiku-4-5-20251001',
      apiKey: config.apiKey || '${ANTHROPIC_API_KEY}',
      ...config,
    });
    this.apiVersion = config.apiVersion || '2023-06-01';
    this.defaultTimeoutMs = config.defaultTimeoutMs || 30000;
    this.defaultMaxTokens = config.defaultMaxTokens || 200;
  }

  isAvailable() {
    return !!this.apiKey;
  }

  async call(prompt, systemInstruction = '', opts = {}) {
    if (!this.isAvailable()) return null;
    if (!prompt) return null;

    const model = opts.model || this.defaultModel;
    const maxTokens = opts.maxTokens || this.defaultMaxTokens;
    const timeoutMs = opts.timeoutMs || this.defaultTimeoutMs;
    const endpoint = `${this.baseUrl}/messages`;

    return new Promise((resolve) => {
      const body = JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemInstruction,
        messages: [{ role: 'user', content: prompt }],
      });

      const req = https.request(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
      }, (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              console.error(`[${this.id}] api error: ${parsed.error.type || ''} ${parsed.error.message || data.slice(0, 200)}`);
              return resolve(null);
            }
            const text = parsed.content && parsed.content[0] && parsed.content[0].text;
            resolve(text || null);
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        console.error(`[${this.id}] request error: ${err.message}`);
        resolve(null);
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(null);
      });

      req.write(body);
      req.end();
    });
  }
}

function createAnthropicProvider(config = {}) {
  return new AnthropicProvider(config);
}

module.exports = { AnthropicProvider, createAnthropicProvider };