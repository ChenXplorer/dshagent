import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshHubClient, assertHubProfileTargetAvailable, requestProfileTransaction } from './index.ts';

test('DshHubClient uses the internal Hub paths and capability command schema', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let commandNumber = 0;
  const client = new DshHubClient({ baseUrl: 'http://hub.example.test', internalOperatorToken: 'internal-operator-token-with-at-least-32-characters', originSecret: 'origin-secret-123456789012345678901234567890', origin: 'http://hub.example.test',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const url = String(input);
      if (url.endsWith('/hub/v1/me')) return Response.json({ email: 'operator@example.com' });
      if (url.endsWith('/hub/v1/nodes')) return Response.json({ nodes: [{ nodeId: 'node-a', displayName: 'A' }], runtimes: [{ runtimeId: 'runtime-a' }] });
      if (url.endsWith('/hub/v1/commands')) {
        const body = JSON.parse(String(init?.body)); const commandId = `cmd-${String(++commandNumber)}`;
        return Response.json({ command: { commandId, nodeId: body.nodeId, runtimeId: body.runtimeId, capability: body.capability, operation: body.operation, status: 'pending' } }, { status: 202 });
      }
      const commandId = decodeURIComponent(url.split('/').pop()!);
      const body = commandId === 'cmd-1'
        ? { lockHash: 'a'.repeat(43), plugins: [] }
        : { lockHash: 'b'.repeat(43), plugin: { packageName: 'dsh-plugin', version: '1.0.0', enabled: true, healthy: true }, change: { changeId: 'change-dsh-plugin' } };
      return Response.json({ command: { commandId, nodeId: 'node-a', runtimeId: 'runtime-a', capability: 'dsh.plugins', operation: commandId === 'cmd-1' ? 'inventory' : 'apply', status: 'ok', result: body } });
    } });
  assert.equal((await client.me()).email, 'operator@example.com');
  assert.equal((await client.listNodes()).nodes[0]?.nodeId, 'node-a');
  const commands = await requestProfileTransaction(client, { nodeId: 'node-a', runtimeId: 'runtime-a', profileVersion: 2, plugins: [{ packageName: 'dsh-plugin', version: '1.0.0' }] });
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.commandId, 'cmd-2');
  const commandCalls = calls.filter(call => call.url.endsWith('/hub/v1/commands'));
  assert.equal(commandCalls.length, 2);
  const commandCall = commandCalls[1]!;
  assert.equal(commandCall.init.method, 'POST');
  assert.equal((commandCall.init.headers as Headers).get('x-dsh-internal-operator-token'), 'internal-operator-token-with-at-least-32-characters');
  assert.equal((commandCall.init.headers as Headers).get('x-dsh-origin-secret'), 'origin-secret-123456789012345678901234567890');
  assert.deepEqual(JSON.parse(String(commandCall.init.body)), { nodeId: 'node-a', runtimeId: 'runtime-a', capability: 'dsh.plugins', capabilityVersion: '3.0.0', operation: 'apply', payload: { clientMutationId: 'dsh-profile-2-0-dsh-plugin', packageName: 'dsh-plugin', version: '1.0.0', expectedLockHash: 'a'.repeat(43) } });
  assert.equal(calls.filter(call => /\/hub\/v1\/commands\/cmd-[12]$/u.test(call.url) && call.init.method === 'POST').length, 2);
});

test('DshHubClient rejects identifiers outside the official Hub grammar', async () => {
  const client = new DshHubClient({ baseUrl: 'http://hub.example.test', internalOperatorToken: 'internal-operator-token-with-at-least-32-characters', originSecret: 'origin-secret-123456789012345678901234567890',
    fetchImpl: async input => String(input).endsWith('/nodes')
      ? Response.json({ nodes: [{ nodeId: 'Node-A', displayName: 'Invalid' }], runtimes: [] })
      : Response.json({ command: { commandId: 'cmd-1', nodeId: 'node-a', runtimeId: 'default', capability: 'dsh.plugins', operation: 'inventory', status: 'pending' } }, { status: 202 }) });
  await assert.rejects(client.listNodes(), /valid DSH Hub identifier/);
  await assert.rejects(client.enqueueCommand({ nodeId: 'node/a', runtimeId: 'default', capability: 'dsh.plugins', capabilityVersion: '3.0.0', operation: 'inventory', payload: {} }), /valid DSH Hub identifier/);
});

test('DshHubClient requires the upstream Hub origin guard secret', () => {
  assert.throws(() => new DshHubClient({ baseUrl: 'http://hub.example.test', internalOperatorToken: 'internal-operator-token-with-at-least-32-characters', originSecret: 'too-short' }), /at least 32 characters/);
  assert.throws(() => new DshHubClient({ baseUrl: 'http://hub.example.test', internalOperatorToken: 'internal-operator-token-with-at-least-32-characters', originSecret: 'origin-secret-123456789012345678901234567890', timeoutMs: 30_000, commandTimeoutMs: 10_000 }), /commandTimeoutMs must be at least timeoutMs/);
});

test('DshHubClient uses a private server-to-server Hub token', async () => {
  let seen: Headers | undefined;
  const client = new DshHubClient({
    baseUrl: 'http://127.0.0.1:19091',
    internalOperatorToken: 'internal-operator-token-with-at-least-32-characters',
    originSecret: 'origin-secret-123456789012345678901234567890',
    fetchImpl: async (_input, init) => {
      seen = new Headers(init?.headers);
      return Response.json({ email: 'operator@example.com' });
    },
  });
  await client.me();
  assert.equal(seen?.get('x-dsh-internal-operator-token'), 'internal-operator-token-with-at-least-32-characters');
});

test('DshHubClient exposes official node enrollment and revocation paths', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const client = new DshHubClient({ baseUrl: 'http://hub.example.test', internalOperatorToken: 'internal-operator-token-with-at-least-32-characters', originSecret: 'origin-secret-123456789012345678901234567890',
    fetchImpl: async (input, init) => {
      const url = String(input); calls.push({ url, method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: String(init.body) }) });
      if (url.endsWith('/hub/v1/enrollments') && (init?.method ?? 'GET') === 'GET') return Response.json({ enrollments: [{ nodeId: 'node-a', displayName: 'A', expiresAt: 1000, createdAt: 900 }] });
      if (url.endsWith('/hub/v1/enrollments') && init?.method === 'POST') return Response.json({ nodeId: 'node-a', displayName: 'A', code: 'one-time', expiresAt: 1000, createdAt: 900 }, { status: 201 });
      return Response.json({ ok: true });
    } });
  assert.deepEqual(await client.listEnrollments(), [{ nodeId: 'node-a', displayName: 'A', expiresAt: 1000, createdAt: 900 }]);
  assert.equal((await client.createEnrollment({ nodeId: 'node-a', displayName: 'A', expiresInSeconds: 600 })).code, 'one-time');
  await client.cancelEnrollment('node-a'); await client.revokeNode('node-a');
  assert.deepEqual(calls.map(call => [call.url.replace('http://hub.example.test', ''), call.method]), [
    ['/hub/v1/enrollments', 'GET'], ['/hub/v1/enrollments', 'POST'],
    ['/hub/v1/enrollments/node-a/cancel', 'POST'], ['/hub/v1/nodes/node-a/revoke', 'POST'],
  ]);
});

test('Profile target validation allows an offline Runtime while its Node Agent can manage dsh.plugins', async () => {
  let nodes: Array<Record<string, unknown>> = [{ nodeId: 'node-a', displayName: 'A', status: 'active', online: true }];
  let runtimes: Array<Record<string, unknown>> = [{
    nodeId: 'node-a', runtimeId: 'tenant-user-001', online: false,
    capabilities: [{ name: 'dsh.plugins', version: '3.0.0' }],
  }];
  const client = new DshHubClient({
    baseUrl: 'http://hub.example.test', internalOperatorToken: 'internal-operator-token-with-at-least-32-characters',
    originSecret: 'origin-secret-123456789012345678901234567890',
    fetchImpl: async () => Response.json({
      nodes, runtimes,
    }),
  });
  await assert.doesNotReject(assertHubProfileTargetAvailable(client, { nodeId: 'node-a', runtimeId: 'tenant-user-001' }));
  nodes = [{ ...nodes[0], online: false }];
  await assert.rejects(assertHubProfileTargetAvailable(client, { nodeId: 'node-a', runtimeId: 'tenant-user-001' }), /offline/);
  nodes = [{ ...nodes[0], online: true }];
  runtimes = [{ ...runtimes[0], capabilities: [{ name: 'dsh.web' }] }];
  await assert.rejects(assertHubProfileTargetAvailable(client, { nodeId: 'node-a', runtimeId: 'tenant-user-001' }), /does not expose dsh.plugins/);
  runtimes = [];
  await assert.rejects(assertHubProfileTargetAvailable(client, { nodeId: 'node-a', runtimeId: 'tenant-user-001' }), /runtime .* is not registered/);
});

test('Profile transactions validate the official plugin SemVer before enqueueing apply', async () => {
  let applyQueued = false;
  const client = new DshHubClient({ baseUrl: 'http://hub.example.test', internalOperatorToken: 'internal-operator-token-with-at-least-32-characters', originSecret: 'origin-secret-123456789012345678901234567890',
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/hub/v1/commands')) {
        const body = JSON.parse(String(init?.body)) as { operation: string };
        if (body.operation === 'apply') applyQueued = true;
        return Response.json({ command: { commandId: 'cmd-1', nodeId: 'node-a', runtimeId: 'runtime-a', capability: 'dsh.plugins', operation: body.operation, status: 'pending' } }, { status: 202 });
      }
      return Response.json({ command: { commandId: 'cmd-1', nodeId: 'node-a', runtimeId: 'runtime-a', capability: 'dsh.plugins', operation: 'inventory', status: 'ok', result: { lockHash: 'a'.repeat(43), plugins: [] } } });
    } });
  await assert.rejects(requestProfileTransaction(client, { nodeId: 'node-a', runtimeId: 'runtime-a', profileVersion: 2, plugins: [{ packageName: 'dsh-plugin', version: 'latest' }] }), /valid SemVer/);
  assert.equal(applyQueued, false);
});

test('Profile transactions retry an official rollback before removing a Hub Plugin', async () => {
  const calls: Array<{ operation: string; payload: any }> = [];
  const client = new DshHubClient({ baseUrl: 'http://hub.example.test', internalOperatorToken: 'internal-operator-token-with-at-least-32-characters', originSecret: 'origin-secret-123456789012345678901234567890',
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/hub/v1/commands')) {
        const payload = JSON.parse(String(init?.body)); calls.push({ operation: payload.operation, payload: payload.payload });
        return Response.json({ command: { commandId: `cmd-${String(calls.length)}`, nodeId: payload.nodeId, runtimeId: payload.runtimeId, capability: payload.capability, operation: payload.operation, status: 'pending' } }, { status: 202 });
      }
      const commandId = decodeURIComponent(url.split('/').pop()!);
      const call = calls[Number(commandId.slice(4)) - 1]!;
      if (call.operation === 'inventory') {
        return Response.json({ command: { commandId, nodeId: 'node-a', runtimeId: 'runtime-a', capability: 'dsh.plugins', operation: 'inventory', status: 'ok', result: { lockHash: 'a'.repeat(43), plugins: [{ packageName: 'old-plugin', version: '1.0.0', enabled: true, healthy: true }] } } });
      }
      if (call.operation === 'history') {
        return Response.json({ command: { commandId, nodeId: 'node-a', runtimeId: 'runtime-a', capability: 'dsh.plugins', operation: 'history', status: 'ok', result: { changes: [{ changeId: 'change-old', packageName: 'old-plugin', toVersion: '1.0.0', artifactHash: 'hash', beforeLockHash: 'b'.repeat(43), afterLockHash: 'a'.repeat(43), createdAt: 1, status: 'rollback-failed' }] } } });
      }
      return Response.json({ command: { commandId, nodeId: 'node-a', runtimeId: 'runtime-a', capability: 'dsh.plugins', operation: 'rollback', status: 'ok', result: { lockHash: 'b'.repeat(43), plugins: [], change: { changeId: 'change-old', packageName: 'old-plugin', toVersion: '1.0.0', artifactHash: 'hash', beforeLockHash: 'b'.repeat(43), afterLockHash: 'a'.repeat(43), createdAt: 1, status: 'rolled-back' } } } });
    } });
  const commands = await requestProfileTransaction(client, { nodeId: 'node-a', runtimeId: 'runtime-a', profileVersion: 3, plugins: [] });
  assert.equal(commands.length, 1);
  assert.equal(calls.map(call => call.operation).join(','), 'inventory,history,rollback');
  assert.equal(calls[2]?.payload.changeId, 'change-old');
  assert.equal(calls[2]?.payload.expectedLockHash, 'a'.repeat(43));
});

test('Profile transactions compensate earlier Plugin changes when a later apply fails', async () => {
  const calls: Array<{ operation: string; payload: any }> = [];
  let inventoryCount = 0;
  const client = {
    async enqueueCommand(input: any) {
      calls.push({ operation: input.operation, payload: input.payload });
      return { commandId: `cmd-${String(calls.length)}`, ...input, status: 'pending' };
    },
    async waitForCommand(command: any) {
      if (command.operation === 'inventory') {
        inventoryCount++;
        return { ...command, status: 'ok', result: { lockHash: (inventoryCount === 1 ? 'a' : 'b').repeat(43), plugins: inventoryCount === 1 ? [] : [{ packageName: 'plugin-one', version: '1.0.0', enabled: true, healthy: true }] } };
      }
      if (command.operation === 'apply' && command.payload.packageName === 'plugin-one') {
        return { ...command, status: 'ok', result: {
          lockHash: 'b'.repeat(43),
          plugin: { packageName: 'plugin-one', version: '1.0.0', enabled: true, healthy: true },
          change: { changeId: 'change-one' },
        } };
      }
      if (command.operation === 'apply') throw new Error('second Plugin failed');
      if (command.operation === 'rollback') {
        assert.equal(command.payload.changeId, 'change-one');
        assert.equal(command.payload.expectedLockHash, 'b'.repeat(43));
        return { ...command, status: 'ok', result: { lockHash: 'a'.repeat(43), plugins: [], change: { changeId: 'change-one' } } };
      }
      throw new Error(`Unexpected operation ${String(command.operation)}`);
    },
  } as unknown as DshHubClient;

  await assert.rejects(requestProfileTransaction(client, {
    nodeId: 'node-a', runtimeId: 'runtime-a', profileVersion: 4,
    plugins: [{ packageName: 'plugin-one', version: '1.0.0' }, { packageName: 'plugin-two', version: '1.0.0' }],
  }), /second Plugin failed/);
  assert.deepEqual(calls.map(call => call.operation), ['inventory', 'apply', 'apply', 'inventory', 'rollback']);
  assert.match(calls[4]!.payload.clientMutationId, /compensate-0-rollback-change-one/);
});

test('Profile transactions reinstall a Plugin removed earlier in a failed transaction', async () => {
  const calls: Array<{ operation: string; payload: any }> = [];
  let inventoryCount = 0;
  const oldPlugin = { packageName: 'old-plugin', version: '1.0.0', enabled: true, healthy: true };
  const client = {
    async enqueueCommand(input: any) {
      calls.push({ operation: input.operation, payload: input.payload });
      return { commandId: `cmd-${String(calls.length)}`, ...input, status: 'pending' };
    },
    async waitForCommand(command: any) {
      if (command.operation === 'inventory') {
        inventoryCount++;
        return { ...command, status: 'ok', result: { lockHash: (inventoryCount === 1 ? 'a' : 'z').repeat(43), plugins: inventoryCount === 1 ? [oldPlugin] : [] } };
      }
      if (command.operation === 'history') return { ...command, status: 'ok', result: { changes: [{ changeId: 'change-old', packageName: 'old-plugin', toVersion: '1.0.0', beforeLockHash: 'z'.repeat(43), afterLockHash: 'a'.repeat(43), status: 'applied' }] } };
      if (command.operation === 'rollback') return { ...command, status: 'ok', result: { lockHash: 'z'.repeat(43), plugins: [], change: { changeId: 'change-old' } } };
      if (command.operation === 'apply' && command.payload.packageName === 'new-plugin') throw new Error('new Plugin failed');
      if (command.operation === 'apply' && command.payload.packageName === 'old-plugin') {
        assert.equal(command.payload.expectedLockHash, 'z'.repeat(43));
        return { ...command, status: 'ok', result: { lockHash: 'a'.repeat(43), plugin: oldPlugin, change: { changeId: 'change-old-restored' } } };
      }
      throw new Error(`Unexpected operation ${String(command.operation)}`);
    },
  } as unknown as DshHubClient;

  await assert.rejects(requestProfileTransaction(client, {
    nodeId: 'node-a', runtimeId: 'runtime-a', profileVersion: 5,
    plugins: [{ packageName: 'new-plugin', version: '1.0.0' }],
  }), /new Plugin failed/);
  assert.deepEqual(calls.map(call => call.operation), ['inventory', 'history', 'rollback', 'apply', 'inventory', 'apply']);
  assert.match(calls[5]!.payload.clientMutationId, /compensate-0-apply-old-plugin-1\.0\.0/);
});
