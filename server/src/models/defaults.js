// Default model provider configuration.
//
// Matches the structure from docs/model-provider-config-design.md.
// Phase 1 uses hardcoded defaults; Phase 2 will load from models.json.

module.exports = {
  providers: {
    anthropic: {
      apiKey: '${ANTHROPIC_API_KEY}',
      baseUrl: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-haiku-4-5-20251001',
      defaultTimeoutMs: 30000,
      defaultMaxTokens: 200,
    },
    gemini: {
      apiKey: '${GEMINI_API_KEY}',
      fallbackEnvVar: 'API_KEY',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: 'gemini-2.5-pro',
      sampling: {
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 8192,
      },
    },
    openai: {
      apiKey: '${OPENAI_API_KEY}',
      fallbackApiKey: '${CODEX_API_KEY}',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
      sampling: {
        temperature: 0.2,
      },
    },
    custom: {
      apiKey: '${CUSTOM_CRITIC_KEY}',
      baseUrl: '${CUSTOM_CRITIC_ENDPOINT:http://localhost:11434/v1}',
      defaultModel: 'llama3',
      sampling: {
        temperature: 0.2,
      },
    },
  },
  scenarios: {
    // Agent sessions use SDK-controlled model (config only for reference)
    agent: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    // Critic uses Gemini by default, alternatives available
    critic: {
      provider: 'gemini',
      model: 'gemini-2.5-pro',
    },
    // Summarizer uses lightweight Anthropic model
    summarizer: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    },
    // Extractor uses SDK (claude-cli.js) - config for reference
    extractor: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    },
    // BTW assistant uses SDK - config for reference
    btw: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    },
  },
  fallback: {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
  },
};