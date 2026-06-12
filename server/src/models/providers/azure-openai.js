// Azure OpenAI provider adapter.
//
// Implements ModelProvider interface for Azure OpenAI Service.
// Azure uses different auth headers ('api-key' instead of 'Authorization')
// and requires deployment name in the URL path.

const { ModelProvider } = require('../provider');

class AzureOpenAIProvider extends ModelProvider {
  constructor(config = {}) {
    super(config);
    this.apiVersion = config.apiVersion || '2024-02-15-preview';
    this.deploymentName = config.deploymentName || config.defaultModel || 'gpt-4';
  }

  async call(prompt, systemInstruction = '', opts = {}) {
    if (!this.isAvailable()) {
      return null;
    }

    const model = opts.model || this.defaultModel;
    const deployment = this.deploymentName || model;
    const temperature = opts.temperature || this.config.sampling?.temperature || 0.2;
    const maxTokens = opts.maxTokens || this.config.defaultMaxTokens || 200;

    const url = `${this.baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${this.apiVersion}`;

    const messages = [];
    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey, // Azure uses 'api-key' header, not Authorization
        },
        body: JSON.stringify({
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[azure] API error ${res.status}: ${errText}`);
        return null;
      }

      const data = await res.json();
      return data.choices?.[0]?.message?.content || null;
    } catch (err) {
      console.error(`[azure] Fetch failed: ${err.message}`);
      return null;
    }
  }

  getMetadata() {
    return {
      id: this.id,
      name: this.name || 'Azure OpenAI',
      model: this.defaultModel,
      deployment: this.deploymentName,
    };
  }
}

module.exports = { AzureOpenAIProvider };