import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNodeAgentConfig } from './render-node-agent-config.ts';

const base = {
  hubUrl: 'https://hub.example.test/', nodeId: 'tenant-node-a', accessClientId: 'client-id',
  accessClientSecret: 'x'.repeat(32), enrollmentCode: 'e'.repeat(24), hubPublicKey: 'k'.repeat(80),
  stateDirectory: '/var/lib/dsh-hub-node', ipcEndpoint: '/run/user/1000/dsh-hub/connector.sock',
  profiles: [{ runtimeId: 'tenant-user-001', profileDirectory: '/var/lib/dshagent/hosts/user-001/home/profiles/web' }],
};

test('renders the pinned upstream Node Agent management shape without losing profile identity', () => {
  const config = renderNodeAgentConfig(base) as any;
  assert.equal(config.hubUrl, 'https://hub.example.test');
  assert.equal(config.management.profiles[0].runtimeId, 'tenant-user-001');
  assert.equal(config.management.profiles[0].profileName, 'web');
  assert.deepEqual(config.management.profiles[0].snapshotPaths, []);
  assert.equal(config.enrollmentCode, base.enrollmentCode);
});

test('rejects a node with more than the official 64 management profiles or duplicate directories', () => {
  assert.throws(() => renderNodeAgentConfig({ ...base, profiles: Array.from({ length: 65 }, (_, index) => ({ runtimeId: `tenant-${String(index)}`, profileDirectory: `/var/lib/dsh/${String(index)}` })) }), /between 1 and 64/u);
  assert.throws(() => renderNodeAgentConfig({ ...base, profiles: [base.profiles[0]!, { runtimeId: 'tenant-user-002', profileDirectory: base.profiles[0]!.profileDirectory }] }), /profileDirectory values must be unique/u);
});

test('rejects insecure Hub URLs and non-absolute managed paths', () => {
  assert.throws(() => renderNodeAgentConfig({ ...base, hubUrl: 'http://hub.example.test' }), /HTTPS/u);
  assert.throws(() => renderNodeAgentConfig({ ...base, hubUrl: 'http://127.0.0.1:19190' }), /originSecret/u);
  assert.throws(() => renderNodeAgentConfig({ ...base, stateDirectory: 'relative/state' }), /stateDirectory must be absolute/u);
});

test('renders the explicit private loopback Hub configuration used by the no-login MVP', () => {
  const originSecret = 'o'.repeat(32);
  const pem = `-----BEGIN PUBLIC KEY-----\n${'A'.repeat(64)}\n-----END PUBLIC KEY-----\n`;
  const config = renderNodeAgentConfig({ ...base, hubUrl: 'http://127.0.0.1:19190', originSecret, hubPublicKey: pem }) as any;
  assert.equal(config.hubUrl, 'http://127.0.0.1:19190');
  assert.equal(config.originSecret, originSecret);
  assert.equal(config.hubPublicKey, pem);
  assert.throws(() => renderNodeAgentConfig({ ...base, originSecret }), /only for loopback HTTP/u);
});
