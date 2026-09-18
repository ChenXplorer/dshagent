import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasEnhancedHealthEvidence, validateDaemonHealth, shellArgument, type DaemonBootstrapConfiguration, type DaemonHealth } from './bootstrap.ts';

const config = { daemonId: 'expected', serverUrl: 'http://windows:18382', expectedDaemonVersion: 'dshtrace1' } as DaemonBootstrapConfiguration;
const health: DaemonHealth = { status: 'running', daemon_id: 'expected', profile: '', server_url: 'http://windows:18382', cli_version: 'dshtrace1',
  os: 'linux', pid: 42, active_task_ids: [], claims_in_flight: 0, transcript_pending_by_task: {}, transcript_outbox_error: false };
test('bootstrap unit: missing patched evidence and wrong daemon identity fail closed', () => {
  assert.doesNotThrow(() => validateDaemonHealth(health, config));
  assert.throws(() => validateDaemonHealth({ ...health, daemon_id: 'other' }, config), /identity/u);
  assert.throws(() => validateDaemonHealth({ ...health, transcript_outbox_error: undefined } as unknown as DaemonHealth, config), /evidence/u);
  assert.throws(() => validateDaemonHealth({ ...health, transcript_pending_by_task: { task: -1 } }, config), /evidence/u);
});
test('bootstrap unit: official unmodified health is accepted unless enhanced evidence is explicitly required', () => {
  // Official /health omits the enhanced fields (the runtime parser accepts
  // this wire shape; the public type keeps legacy callers source-compatible).
  const official = { status: 'running', daemon_id: 'expected', server_url: 'http://windows:18382', cli_version: 'dsh-official', os: 'linux', pid: 42 } as unknown as DaemonHealth;
  assert.equal(hasEnhancedHealthEvidence(official), false);
  assert.doesNotThrow(() => validateDaemonHealth(official, { ...config, expectedDaemonVersion: 'dsh-official' }));
  assert.throws(() => validateDaemonHealth(official, { ...config, expectedDaemonVersion: 'dsh-official', requireEnhancedHealth: true }), /enhanced/u);
});
test('bootstrap unit: shell argument quoting preserves literal substitution and apostrophes', () => {
  assert.equal(shellArgument('$(printf unsafe)'), "'$(printf unsafe)'");
  assert.equal(shellArgument("a'b"), "'a'\"'\"'b'");
});
