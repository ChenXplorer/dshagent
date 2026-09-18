import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCliSecretsPresent, buildNativeCliConfiguration, type NativeCliConfigurationInput } from './index.ts';

const valid = (): NativeCliConfigurationInput => ({
  codexHome: '/home/agent/.codex',
  claudeHome: '/home/agent/.claude',
  codex: { baseUrl: 'https://api.deepseek.com', model: 'deployment-selected-model', apiKeyEnv: 'DEEPSEEK_API_KEY', wireApi: 'responses' },
  claude: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deployment-selected-model', apiKeyEnv: 'DEEPSEEK_API_KEY' },
});

test('native settings point both CLIs and Claude subagents to explicit model without storing secrets', () => {
  const result = buildNativeCliConfiguration(valid());
  assert.match(result.files[0].contents, /wire_api = "responses"/u);
  assert.match(result.files[0].contents, /env_key = "DEEPSEEK_API_KEY"/u);
  assert.equal(JSON.parse(result.files[1].contents).env.CLAUDE_CODE_SUBAGENT_MODEL, 'deployment-selected-model');
  assert.deepEqual(result.secretBindings[1], { sourceEnv: 'DEEPSEEK_API_KEY', targetEnv: 'ANTHROPIC_AUTH_TOKEN' });
  assert.equal(result.environment.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(result.files.every(file => file.mode === 0o600), true);
});

test('rejects obsolete Chat Completions configuration rather than silently adapting', () => {
  const input = valid();
  input.codex.wireApi = 'chat' as 'responses';
  assert.throws(() => buildNativeCliConfiguration(input), /requires native Responses/u);
});

test('rejects credential-bearing and request URLs without echoing credentials', () => {
  for (const url of ['https://user:secret@example.test', 'https://example.test?key=secret', 'https://example.test/#secret', 'http://example.test', 'https://example.test/responses', 'https://example.test/chat/completions']) {
    const input = valid();
    input.codex.baseUrl = url;
    assert.throws(() => buildNativeCliConfiguration(input), (error: Error) => !error.message.includes('secret') && /baseUrl/u.test(error.message));
  }
});

test('rejects overlapping, relative and traversal CLI homes', () => {
  for (const path of ['/home/agent/.codex', '/home/agent/.codex/child', '/home/agent', 'relative', '/home/agent/../other', '/', 'C:\\cli']) {
    const input = valid();
    input.claudeHome = path;
    assert.throws(() => buildNativeCliConfiguration(input));
  }
});

test('quotes model data without letting it introduce TOML fields', () => {
  const input = valid();
  input.codex.model = 'model" # not TOML';
  assert.match(buildNativeCliConfiguration(input).files[0].contents, /^model = "model\\" # not TOML"\n/u);
  input.codex.model = 'model\napi_key = "secret"';
  assert.throws(() => buildNativeCliConfiguration(input), /single-line/u);
});

test('keeps catalog and effort explicit; does not invent model metadata', () => {
  const input = valid();
  input.codex.modelCatalogPath = '/home/agent/.codex/models.json';
  input.codex.reasoningEffort = 'high';
  input.claude.smallModel = 'explicit-small-model';
  const result = buildNativeCliConfiguration(input);
  assert.match(result.files[0].contents, /model_catalog_json = "\/home\/agent\/\.codex\/models.json"/u);
  assert.equal(result.environment.CLAUDE_CODE_SUBAGENT_MODEL, 'explicit-small-model');
  assert.equal(result.files.length, 2);
});

test('invalid or missing secrets fail without exposing values and presence checks do not mutate inputs', () => {
  const config = buildNativeCliConfiguration(valid());
  const original = JSON.stringify(config);
  assert.throws(() => assertCliSecretsPresent(config, {}), /DEEPSEEK_API_KEY/u);
  assert.throws(() => assertCliSecretsPresent(config, { DEEPSEEK_API_KEY: 'secret\nvalue' }), (error: Error) => !error.message.includes('secret\nvalue'));
  assertCliSecretsPresent(config, { DEEPSEEK_API_KEY: 'unit-test-placeholder' });
  assert.equal(JSON.stringify(config), original);
  assert.equal(original.includes('unit-test-placeholder'), false);
});

test('prevents mistaking a raw key or process configuration variable for the secret reference', () => {
  for (const name of ['sk-not-a-variable', 'HOME', 'CODEX_HOME', 'ANTHROPIC_AUTH_TOKEN', 'KEY\nVALUE']) {
    const input = valid();
    input.codex.apiKeyEnv = name;
    assert.throws(() => buildNativeCliConfiguration(input), /apiKeyEnv/u);
  }
});
