// Test configLoader module - environment variable resolution, config loading, merging.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  resolveEnvVar,
  resolveEnvVars,
  getConfigPath,
  loadConfig,
  mergeProviders,
  mergeScenarios,
  validateConfig,
} = require('../server/src/models/configLoader');
const defaults = require('../server/src/models/defaults');

// Test helper: create temp config file
function createTempConfigFile(content) {
  const tmpdir = fs.mkdtempSync(path.join('/tmp', 'configLoader-test-'));
  const configPath = path.join(tmpdir, 'models.json');
  fs.writeFileSync(configPath, JSON.stringify(content, null, 2));
  return { tmpdir, configPath };
}

// Test helper: cleanup temp directory
function cleanupTempDir(tmpdir) {
  fs.rmSync(tmpdir, { recursive: true, force: true });
}

// === resolveEnvVar tests ===

function test_resolveEnvVar_direct_value() {
  // Direct value (no env var syntax) should pass through unchanged
  const result = resolveEnvVar('https://api.anthropic.com/v1');
  assert.strictEqual(result, 'https://api.anthropic.com/v1');
  console.log('✓ resolveEnvVar: direct value unchanged');
}

function test_resolveEnvVar_env_var_found() {
  // ${ENV_VAR} should resolve to process.env value
  process.env.TEST_API_KEY = 'test-key-123';
  const result = resolveEnvVar('${TEST_API_KEY}');
  assert.strictEqual(result, 'test-key-123');
  delete process.env.TEST_API_KEY;
  console.log('✓ resolveEnvVar: ${ENV_VAR} resolves to env value');
}

function test_resolveEnvVar_env_var_with_default() {
  // ${ENV_VAR:default} should use default when env var not set
  const result = resolveEnvVar('${MISSING_VAR:http://localhost:11434}');
  assert.strictEqual(result, 'http://localhost:11434');
  console.log('✓ resolveEnvVar: ${VAR:default} uses default when missing');
}

function test_resolveEnvVar_env_var_set_overrides_default() {
  // ${ENV_VAR:default} should use env value when set
  process.env.TEST_ENDPOINT = 'https://custom.endpoint';
  const result = resolveEnvVar('${TEST_ENDPOINT:http://localhost}');
  assert.strictEqual(result, 'https://custom.endpoint');
  delete process.env.TEST_ENDPOINT;
  console.log('✓ resolveEnvVar: ${VAR:default} prefers env over default');
}

function test_resolveEnvVar_multiple_env_vars() {
  // Multiple ${VAR} in same string should all resolve
  process.env.HOST = 'api.example.com';
  process.env.PORT = '8080';
  const result = resolveEnvVar('${HOST}:${PORT}');
  assert.strictEqual(result, 'api.example.com:8080');
  delete process.env.HOST;
  delete process.env.PORT;
  console.log('✓ resolveEnvVar: multiple ${VAR} resolved');
}

function test_resolveEnvVar_empty_string() {
  // Empty string should pass through
  const result = resolveEnvVar('');
  assert.strictEqual(result, '');
  console.log('✓ resolveEnvVar: empty string unchanged');
}

function test_resolveEnvVar_null_undefined() {
  // null/undefined should pass through
  assert.strictEqual(resolveEnvVar(null), null);
  assert.strictEqual(resolveEnvVar(undefined), undefined);
  console.log('✓ resolveEnvVar: null/undefined unchanged');
}

function test_resolveEnvVar_non_string() {
  // Non-string values should pass through unchanged
  assert.strictEqual(resolveEnvVar(123), 123);
  assert.deepStrictEqual(resolveEnvVar({ foo: 'bar' }), { foo: 'bar' });
  console.log('✓ resolveEnvVar: non-string unchanged');
}

// === resolveEnvVars tests ===

function test_resolveEnvVars_flat_object() {
  process.env.KEY1 = 'value1';
  process.env.KEY2 = 'value2';
  const obj = {
    apiKey: '${KEY1}',
    baseUrl: '${KEY2}',
    model: 'gpt-4',
  };
  resolveEnvVars(obj);
  assert.deepStrictEqual(obj, {
    apiKey: 'value1',
    baseUrl: 'value2',
    model: 'gpt-4',
  });
  delete process.env.KEY1;
  delete process.env.KEY2;
  console.log('✓ resolveEnvVars: flat object resolved');
}

function test_resolveEnvVars_nested_object() {
  process.env.API_KEY = 'nested-key';
  const obj = {
    providers: {
      anthropic: {
        apiKey: '${API_KEY}',
        sampling: {
          temperature: 0.2,
        },
      },
    },
  };
  resolveEnvVars(obj);
  assert.strictEqual(obj.providers.anthropic.apiKey, 'nested-key');
  assert.strictEqual(obj.providers.anthropic.sampling.temperature, 0.2);
  delete process.env.API_KEY;
  console.log('✓ resolveEnvVars: nested object resolved');
}

// === mergeProviders tests ===

function test_mergeProviders_empty_file_config() {
  const merged = mergeProviders(null, defaults.providers);
  assert.deepStrictEqual(merged, defaults.providers);
  console.log('✓ mergeProviders: empty file config uses defaults');
}

function test_mergeProviders_override_apiKey() {
  const fileProviders = {
    anthropic: {
      apiKey: 'file-key',
    },
  };
  const merged = mergeProviders(fileProviders, defaults.providers);
  assert.strictEqual(merged.anthropic.apiKey, 'file-key');
  assert.strictEqual(merged.anthropic.baseUrl, defaults.providers.anthropic.baseUrl);
  console.log('✓ mergeProviders: apiKey override preserves other fields');
}

function test_mergeProviders_add_new_provider() {
  const fileProviders = {
    azure: {
      apiKey: 'azure-key',
      baseUrl: 'https://azure.example.com',
      defaultModel: 'gpt-4',
    },
  };
  const merged = mergeProviders(fileProviders, defaults.providers);
  assert.ok(merged.azure);
  assert.strictEqual(merged.azure.apiKey, 'azure-key');
  console.log('✓ mergeProviders: new provider added');
}

function test_mergeProviders_sampling_merge() {
  const fileProviders = {
    gemini: {
      sampling: {
        temperature: 0.5,
        topK: 40,
      },
    },
  };
  const merged = mergeProviders(fileProviders, defaults.providers);
  assert.strictEqual(merged.gemini.sampling.temperature, 0.5);
  assert.strictEqual(merged.gemini.sampling.topK, 40);
  // Preserve defaults not overridden
  assert.strictEqual(merged.gemini.sampling.topP, defaults.providers.gemini.sampling.topP);
  console.log('✓ mergeProviders: sampling object deep merged');
}

// === mergeScenarios tests ===

function test_mergeScenarios_empty_file_config() {
  const merged = mergeScenarios(null, defaults.scenarios);
  assert.deepStrictEqual(merged, defaults.scenarios);
  console.log('✓ mergeScenarios: empty file config uses defaults');
}

function test_mergeScenarios_override_provider() {
  const fileScenarios = {
    critic: {
      provider: 'openai',
      model: 'gpt-4o',
    },
  };
  const merged = mergeScenarios(fileScenarios, defaults.scenarios);
  assert.strictEqual(merged.critic.provider, 'openai');
  assert.strictEqual(merged.critic.model, 'gpt-4o');
  // Other scenarios unchanged
  assert.strictEqual(merged.agent.provider, defaults.scenarios.agent.provider);
  console.log('✓ mergeScenarios: scenario provider override');
}

function test_mergeScenarios_add_new_scenario() {
  const fileScenarios = {
    custom_scenario: {
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    },
  };
  const merged = mergeScenarios(fileScenarios, defaults.scenarios);
  assert.ok(merged.custom_scenario);
  console.log('✓ mergeScenarios: new scenario added');
}

// === loadConfig tests ===

function test_loadConfig_file_not_exists() {
  // When file doesn't exist, should return defaults
  const originalPath = process.env.MYCO_MODELS_CONFIG_PATH;
  process.env.MYCO_MODELS_CONFIG_PATH = '/tmp/nonexistent/models.json';
  const config = loadConfig();
  assert.deepStrictEqual(config, defaults);
  process.env.MYCO_MODELS_CONFIG_PATH = originalPath;
  console.log('✓ loadConfig: file not exists returns defaults');
}

function test_loadConfig_file_exists() {
  const { tmpdir, configPath } = createTempConfigFile({
    providers: {
      anthropic: {
        apiKey: 'test-key',
      },
    },
    scenarios: {
      critic: {
        provider: 'openai',
      },
    },
  });

  const originalPath = process.env.MYCO_MODELS_CONFIG_PATH;
  process.env.MYCO_MODELS_CONFIG_PATH = configPath;

  const config = loadConfig();

  // Should merge with defaults
  assert.strictEqual(config.providers.anthropic.apiKey, 'test-key');
  assert.strictEqual(config.providers.anthropic.baseUrl, defaults.providers.anthropic.baseUrl);
  assert.strictEqual(config.scenarios.critic.provider, 'openai');

  process.env.MYCO_MODELS_CONFIG_PATH = originalPath;
  cleanupTempDir(tmpdir);
  console.log('✓ loadConfig: file exists merges with defaults');
}

function test_loadConfig_env_var_resolution() {
  process.env.MYCO_API_KEY = 'resolved-key';
  const { tmpdir, configPath } = createTempConfigFile({
    providers: {
      anthropic: {
        apiKey: '${MYCO_API_KEY}',
      },
    },
    scenarios: {},
  });

  const originalPath = process.env.MYCO_MODELS_CONFIG_PATH;
  process.env.MYCO_MODELS_CONFIG_PATH = configPath;

  const config = loadConfig();
  assert.strictEqual(config.providers.anthropic.apiKey, 'resolved-key');

  process.env.MYCO_MODELS_CONFIG_PATH = originalPath;
  delete process.env.MYCO_API_KEY;
  cleanupTempDir(tmpdir);
  console.log('✓ loadConfig: ${ENV_VAR} resolved in file');
}

// === validateConfig tests ===

function test_validateConfig_valid_default() {
  const result = validateConfig(defaults);
  assert.ok(result.valid);
  assert.strictEqual(result.errors.length, 0);
  console.log('✓ validateConfig: defaults are valid');
}

function test_validateConfig_missing_provider() {
  const result = validateConfig({ providers: {}, scenarios: {} });
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('No providers')));
  console.log('✓ validateConfig: missing provider detected');
}

function test_validateConfig_missing_apiKey() {
  const config = {
    providers: {
      anthropic: {
        baseUrl: 'https://api.anthropic.com',
        defaultModel: 'claude-3',
      },
    },
    scenarios: {},
  };
  const result = validateConfig(config);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('apiKey')));
  console.log('✓ validateConfig: missing apiKey detected');
}

function test_validateConfig_warnings() {
  const config = {
    providers: {
      anthropic: {
        apiKey: 'key',
        baseUrl: 'url',
        defaultModel: 'model',
      },
    },
    // No scenarios or fallback
  };
  const result = validateConfig(config);
  assert.ok(result.valid); // Still valid, just warnings
  assert.ok(result.warnings.length > 0);
  console.log('✓ validateConfig: warnings for missing optional fields');
}

// === getConfigPath tests ===

function test_getConfigPath_custom() {
  const originalPath = process.env.MYCO_MODELS_CONFIG_PATH;
  process.env.MYCO_MODELS_CONFIG_PATH = '/custom/path/models.json';
  const result = getConfigPath();
  assert.strictEqual(result, '/custom/path/models.json');
  process.env.MYCO_MODELS_CONFIG_PATH = originalPath;
  console.log('✓ getConfigPath: MYCO_MODELS_CONFIG_PATH override');
}

function test_getConfigPath_state_dir() {
  const originalStateDir = process.env.MYCO_STATE_DIR;
  const originalPath = process.env.MYCO_MODELS_CONFIG_PATH;
  delete process.env.MYCO_MODELS_CONFIG_PATH;
  process.env.MYCO_STATE_DIR = '/custom/state';
  const result = getConfigPath();
  assert.strictEqual(result, '/custom/state/models.json');
  process.env.MYCO_STATE_DIR = originalStateDir;
  if (originalPath) process.env.MYCO_MODELS_CONFIG_PATH = originalPath;
  console.log('✓ getConfigPath: MYCO_STATE_DIR default');
}

function test_getConfigPath_default() {
  const originalStateDir = process.env.MYCO_STATE_DIR;
  const originalPath = process.env.MYCO_MODELS_CONFIG_PATH;
  delete process.env.MYCO_MODELS_CONFIG_PATH;
  delete process.env.MYCO_STATE_DIR;
  const result = getConfigPath();
  assert.strictEqual(result, '/data/models.json');
  if (originalStateDir) process.env.MYCO_STATE_DIR = originalStateDir;
  if (originalPath) process.env.MYCO_MODELS_CONFIG_PATH = originalPath;
  console.log('✓ getConfigPath: /data default when env vars unset');
}

// === Run all tests ===

function runAllTests() {
  console.log('\n=== resolveEnvVar tests ===');
  test_resolveEnvVar_direct_value();
  test_resolveEnvVar_env_var_found();
  test_resolveEnvVar_env_var_with_default();
  test_resolveEnvVar_env_var_set_overrides_default();
  test_resolveEnvVar_multiple_env_vars();
  test_resolveEnvVar_empty_string();
  test_resolveEnvVar_null_undefined();
  test_resolveEnvVar_non_string();

  console.log('\n=== resolveEnvVars tests ===');
  test_resolveEnvVars_flat_object();
  test_resolveEnvVars_nested_object();

  console.log('\n=== mergeProviders tests ===');
  test_mergeProviders_empty_file_config();
  test_mergeProviders_override_apiKey();
  test_mergeProviders_add_new_provider();
  test_mergeProviders_sampling_merge();

  console.log('\n=== mergeScenarios tests ===');
  test_mergeScenarios_empty_file_config();
  test_mergeScenarios_override_provider();
  test_mergeScenarios_add_new_scenario();

  console.log('\n=== loadConfig tests ===');
  test_loadConfig_file_not_exists();
  test_loadConfig_file_exists();
  test_loadConfig_env_var_resolution();

  console.log('\n=== validateConfig tests ===');
  test_validateConfig_valid_default();
  test_validateConfig_missing_provider();
  test_validateConfig_missing_apiKey();
  test_validateConfig_warnings();

  console.log('\n=== getConfigPath tests ===');
  test_getConfigPath_custom();
  test_getConfigPath_state_dir();
  test_getConfigPath_default();

  console.log('\n✅ All configLoader tests passed!\n');
}

runAllTests();