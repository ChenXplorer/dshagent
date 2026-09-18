import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHubConfiguration } from './start.ts';

test('production config fails closed when Hub is required but absent', () => {
  assert.throws(() => validateHubConfiguration({ requireHub: true }), /requires a DSH Hub configuration/);
});

test('production config requires a tenant-to-Hub Node/Runtime mapping', () => {
  const hub = { baseUrl: 'http://127.0.0.1:19091', internalOperatorToken: 'internal-operator-token-with-at-least-32-characters', originSecret: 'origin-secret-123456789012345678901234567890' };
  assert.throws(() => validateHubConfiguration({ requireHub: true, hub }), /requires hubProfileTargets, hubProfileTargetTemplate, hubProfileTargetShards or hubProfileTargetModule/);
  assert.doesNotThrow(() => validateHubConfiguration({ requireHub: true, hub, hubProfileTargets: {} }));
  assert.doesNotThrow(() => validateHubConfiguration({ requireHub: true, hub, hubProfileTargetModule: 'C:/srv/dshagent/hub-target.mjs' }));
  assert.doesNotThrow(() => validateHubConfiguration({ requireHub: true, hub, hubProfileTargetTemplate: { nodeId: 'tenant-{userId}', runtimeId: 'default' } }));
  assert.doesNotThrow(() => validateHubConfiguration({ requireHub: true, hub, hubProfileTargetShards: [{ nodeId: 'node-a', runtimeIdTemplate: 'tenant-{userId}' }, { nodeId: 'node-b', runtimeIdTemplate: 'tenant-{userId}' }] }));
  assert.throws(() => validateHubConfiguration({ requireHub: true, hub, hubProfileTargetShards: Array.from({ length: 65 }, (_, index) => ({ nodeId: `node-${String(index)}`, runtimeIdTemplate: 'tenant-{userId}' })) }), /between 1 and 64/);
  assert.throws(() => validateHubConfiguration({ requireHub: true, hub, hubProfileTargetShards: [{ nodeId: 'node-a', runtimeIdTemplate: 'web' }] }), /must include \{userId\}/u);
  assert.throws(() => validateHubConfiguration({ requireHub: true, hub, hubProfileTargetTemplate: { nodeId: '', runtimeId: 'default' } }), /hubProfileTargetTemplate.nodeId/);
  assert.throws(() => validateHubConfiguration({ requireHub: true, hub, hubProfileTargetTemplate: { nodeId: 'tenant/{userId}', runtimeId: 'default' } }), /invalid Hub identifier/);
  assert.throws(() => validateHubConfiguration({ requireHub: true, hub, hubProfileTargetTemplate: { nodeId: 'tenant-{userId}', runtimeId: 'Default' } }), /invalid Hub identifier/);
  assert.throws(() => validateHubConfiguration({ requireHub: true, hub, hubProfileTargets: {}, allowUnmanagedPluginPaths: true }), /allowUnmanagedPluginPaths/);
  assert.doesNotThrow(() => validateHubConfiguration({ requireHub: false }));
});

test('Hub-required deployment accepts internal loopback control authentication', () => {
  assert.doesNotThrow(() => validateHubConfiguration({
    requireHub: true,
    hub: {
      baseUrl: 'http://127.0.0.1:19091',
      internalOperatorToken: 'internal-operator-token-with-at-least-32-characters',
      originSecret: 'origin-secret-123456789012345678901234567890',
    },
    hubProfileTargets: {},
  }));
});
