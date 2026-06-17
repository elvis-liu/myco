// Test preferId 'config' behavior in getProviderForScenario
//
// Verifies that:
// 1. preferId='config' (default) uses scenario config's provider
// 2. preferId='gemini' forces gemini provider even if scenario config is custom
// 3. User manual selection (rec.criticModel set) forces specific provider

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { getProviderForScenario, reloadConfig, getConfig } = require('../server/src/models');

// Test helper: create temp config file with custom provider
function setupCustomCriticConfig() {
  const tmpdir = fs.mkdtempSync(path.join('/tmp', 'preferId-test-'));
  const configPath = path.join(tmpdir, 'models.json');

  const config = {
    providers: {
      custom: {
        apiKey: 'test-key',
        baseUrl: 'http://localhost:11434/v1',
        defaultModel: 'llama3'
      },
      gemini: {
        apiKey: 'test-gemini-key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModel: 'gemini-2.5-pro'
      }
    },
    scenarios: {
      critic: {
        provider: 'custom',
        model: 'llama3'
      }
    },
    fallback: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5'
    }
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Set env to make models use this temp config
  process.env.MYCO_MODELS_CONFIG_PATH = configPath;

  return { tmpdir, configPath };
}

function cleanup(tmpdir) {
  delete process.env.MYCO_MODELS_CONFIG_PATH;
  fs.rmSync(tmpdir, { recursive: true, force: true });
}

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

console.log('── preferId config behavior tests ──');

// Setup: create temp config with custom as critic provider
let setup;
try {
  setup = setupCustomCriticConfig();
  reloadConfig(); // Force reload with new config path
} catch (err) {
  console.log('  ✗ Setup failed — ' + err.message);
  process.exit(1);
}

t('preferId="config" uses scenario config provider (custom)', () => {
  const provider = getProviderForScenario('critic', { preferId: 'config' });
  assert.ok(provider, 'provider should exist');
  assert.strictEqual(provider.id, 'custom', 'should use custom provider from scenario config');
});

t('preferId=undefined defaults to "config" and uses scenario config provider', () => {
  const provider = getProviderForScenario('critic', {}); // no preferId
  assert.ok(provider, 'provider should exist');
  assert.strictEqual(provider.id, 'custom', 'should default to config and use custom provider');
});

t('preferId="gemini" forces gemini provider even when scenario config is custom', () => {
  const provider = getProviderForScenario('critic', { preferId: 'gemini' });
  assert.ok(provider, 'provider should exist');
  assert.strictEqual(provider.id, 'gemini', 'should force gemini provider');
});

t('preferId="custom" forces custom provider', () => {
  const provider = getProviderForScenario('critic', { preferId: 'custom' });
  assert.ok(provider, 'provider should exist');
  assert.strictEqual(provider.id, 'custom', 'should force custom provider');
});

t('getConfig returns loaded config with custom as critic provider', () => {
  const config = getConfig();
  assert.ok(config.scenarios.critic, 'critic scenario should exist');
  assert.strictEqual(config.scenarios.critic.provider, 'custom', 'scenario config should have custom as provider');
});

// Cleanup
cleanup(setup.tmpdir);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);