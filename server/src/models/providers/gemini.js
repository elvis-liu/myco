// Gemini API provider - GoogleGenAI SDK wrapper.
//
// Migrated from server/src/critics/gemini.js. Supports custom baseUrl,
// ${ENV_VAR} syntax for API key, and configurable sampling parameters.
// The sampling defaults are tuned for adversarial code review (low temperature).

const { ModelProvider } = require('../provider');

// Lazy-load GoogleGenAI (ES Module package)
let _GoogleGenAI = null;
async function getGoogleGenAI() {
  if (!_GoogleGenAI) {
    const genai = await import('@google/genai');
    _GoogleGenAI = genai.GoogleGenAI;
  }
  return _GoogleGenAI;
}

const DEFAULT_SAMPLING = {
  temperature: 0.2,
  topP: 0.8,
  maxOutputTokens: 8192,
};

class GeminiProvider extends ModelProvider {
  constructor(config = {}) {
    super({
      id: 'gemini',
      name: 'Gemini',
      baseUrl: config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: config.defaultModel || 'gemini-2.5-pro',
      apiKey: config.apiKey || '${GEMINI_API_KEY}',
      ...config,
    });
    this.sampling = config.sampling || DEFAULT_SAMPLING;
    // Support fallback env var (API_KEY) via config
    if (!this.apiKey && config.fallbackEnvVar) {
      this.apiKey = this._resolveEnvVar(`\${${config.fallbackEnvVar}}`);
    }
  }

  isAvailable() {
    // Gemini also supports API_KEY as fallback env var
    return !!this.apiKey || !!process.env.API_KEY;
  }

  async call(prompt, systemInstruction = '', opts = {}) {
    // Get API key with fallback support
    let apiKey = this.apiKey;
    if (!apiKey) {
      apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    }

    if (!apiKey) {
      return '(Gemini API key missing; please set GEMINI_API_KEY or API_KEY in your environment)';
    }

    const model = opts.model || this.defaultModel;
    const sampling = {
      ...this.sampling,
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      ...(opts.temperature ? { temperature: opts.temperature } : {}),
      ...(opts.topP ? { topP: opts.topP } : {}),
    };

    try {
      const GoogleGenAI = await getGoogleGenAI();
      const ai = new GoogleGenAI({ apiKey });
      const config = {
        ...sampling,
        ...(systemInstruction ? { systemInstruction } : {}),
      };
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config,
      });
      return response.text.trim();
    } catch (err) {
      return `(Gemini call failed: ${err.message})`;
    }
  }
}

function createGeminiProvider(config = {}) {
  return new GeminiProvider(config);
}

module.exports = { GeminiProvider, createGeminiProvider };