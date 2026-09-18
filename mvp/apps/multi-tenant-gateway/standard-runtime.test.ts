import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStandardDriverConfiguration as build, type StandardRuntimeConfig } from './standard-runtime.ts';
import type { EffectiveProfile } from '../../packages/tenant-control/index.ts';

const nativeCli = { codexHome: '/home/dsh/.codex', claudeHome: '/home/dsh/.claude', codex: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY', wireApi: 'responses' as const }, claude: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' } };
const daemon = (id: string) => ({
  home: '/home/dsh', daemonId: id, serverUrl: 'https://multica.example.com', workspaceId: 'workspace', token: 'token',
  workspacesRoot: '/home/dsh/workspaces', maxConcurrentTasks: 4, binaryLocalPath: '/srv/multica',
  expectedDaemonVersion: 'd', expectedCodexVersion: 'c', expectedClaudeVersion: 'a', nativeCli, secrets: {},
});

function config(overrides?: StandardRuntimeConfig['userOverrides']): StandardRuntimeConfig {
  return { daytona: { apiUrl: 'http://daytona', apiKey: 'key', target: 'local', snapshot: 'snapshot' },
    multica: { localApiUrl: 'http://multica', token: 'shared-token', workspaceId: 'shared-workspace' }, daemonTemplate: daemon('default'), userOverrides: overrides };
}

const profile: EffectiveProfile = { userId: 'alice', version: 1, plugins: [], skills: [], defaultRuntime: 'codex', maxConcurrentSessions: 8, maxConcurrentTasks: 2, updatedAt: new Date().toISOString(), systemPlugins: [], systemSkills: [], daemons: [], loadMode: { plugins: 'host-start', skills: 'next-task' } };

test('standard multi-tenant runtime refuses accidental shared Multica workspace', () => {
  assert.throws(() => build({ standardRuntime: config() } as any, { userId: 'alice', profile, sandboxId: 'sandbox', runtimeDirectory: '/state/alice', skillsFile: '/state/alice/skills.json' }), /private Multica workspace credentials/);
});

test('standard runtime accepts an explicit per-user workspace override', () => {
  const override = { alice: { multica: { localApiUrl: 'http://multica', token: 'alice-token', workspaceId: 'alice-workspace' }, daemonTemplate: { ...daemon('alice-daemon'), workspaceId: 'alice-workspace', token: 'alice-token' } } };
  const result = build({ stateDirectory: '/state', standardRuntime: config(override) } as any, { userId: 'alice', profile, sandboxId: 'sandbox', runtimeDirectory: '/state/alice', skillsFile: '/state/alice/skills.json' });
  assert.equal(result.multica.workspaceId, 'alice-workspace');
  assert.equal(result.daemon.daemonId, 'alice-daemon-2bd806c97f0e00af');
});

test('standard runtime gives every tenant private Daemon and native CLI homes', () => {
  const catalogCli = { ...nativeCli, codex: { ...nativeCli.codex, modelCatalogPath: '/home/dsh/template/models.json' } };
  const aliceDaemon = { ...daemon('alice-daemon'), nativeCli: catalogCli, workspaceId: 'alice-workspace', token: 'alice-token' };
  const bobDaemon = { ...daemon('bob-daemon'), nativeCli: catalogCli, workspaceId: 'bob-workspace', token: 'bob-token' };
  const overrides = {
    alice: { multica: { localApiUrl: 'http://multica', token: 'alice-token', workspaceId: 'alice-workspace' }, daemonTemplate: aliceDaemon },
    bob: { multica: { localApiUrl: 'http://multica', token: 'bob-token', workspaceId: 'bob-workspace' }, daemonTemplate: bobDaemon },
  };
  const input = { stateDirectory: '/state', standardRuntime: config(overrides) } as any;
  const first = build(input, { userId: 'alice', profile, sandboxId: 'sandbox-a', runtimeDirectory: '/state/alice', skillsFile: '/state/alice/skills.json' });
  const second = build(input, { userId: 'bob', profile: { ...profile, userId: 'bob' }, sandboxId: 'sandbox-b', runtimeDirectory: '/state/bob', skillsFile: '/state/bob/skills.json' });

  assert.notEqual(first.daemon.home, second.daemon.home);
  assert.notEqual(first.daemon.nativeCli.codexHome, second.daemon.nativeCli.codexHome);
  assert.notEqual(first.daemon.nativeCli.claudeHome, second.daemon.nativeCli.claudeHome);
  assert.notEqual(first.daemon.nativeCli.codex.modelCatalogPath, second.daemon.nativeCli.codex.modelCatalogPath);
  assert.equal(first.daemon.nativeCli.codexHome, `${first.daemon.home}/codex`);
  assert.equal(first.daemon.nativeCli.claudeHome, `${first.daemon.home}/claude`);
  assert.equal(first.daemon.nativeCli.codex.modelCatalogPath, `${first.daemon.home}/codex/models.json`);
});

test('standard runtime rejects a registered Daemon from another Multica workspace', () => {
  const override = { alice: { multica: { localApiUrl: 'http://multica', token: 'alice-token', workspaceId: 'alice-workspace' }, daemonTemplate: { ...daemon('alice-daemon'), workspaceId: 'alice-workspace', token: 'alice-token' } } };
  const profileWithForeignDaemon = { ...profile, daemons: [{ id: 'foreign', userId: 'alice', label: 'Foreign', daemonId: 'foreign-daemon', workspaceId: 'other-workspace', runtimeIds: ['runtime'], workspacesRoot: 'C:/work', executionMode: 'local' as const, managed: false, status: 'online' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] };
  assert.throws(() => build({ stateDirectory: '/state', standardRuntime: config(override) } as any, { userId: 'alice', profile: profileWithForeignDaemon, sandboxId: 'sandbox', runtimeDirectory: '/state/alice', skillsFile: '/state/alice/skills.json' }), /different Multica workspace/);
});

test('standard runtime carries the tenant daemon allowlist into the DSH Host', () => {
  const override = { alice: { multica: { localApiUrl: 'http://multica', token: 'alice-token', workspaceId: 'alice-workspace' }, daemonTemplate: { ...daemon('alice-daemon'), workspaceId: 'alice-workspace', token: 'alice-token' } } };
  const scopedProfile = { ...profile, daemons: [
    { id: 'sandbox', userId: 'alice', label: 'Platform', daemonId: 'alice-daemon-2bd806c97f0e00af', workspaceId: 'alice-workspace', runtimeIds: [], workspacesRoot: '/home/dsh/workspaces', executionMode: 'daytona' as const, managed: true, status: 'online' as const, createdAt: '', updatedAt: '' },
    { id: 'desktop', userId: 'alice', label: 'Desktop', daemonId: 'desktop-daemon', workspaceId: 'alice-workspace', runtimeIds: ['claude-id', 'codex-id'], workspacesRoot: 'C:/work', executionMode: 'local' as const, managed: false, status: 'online' as const, createdAt: '', updatedAt: '' },
    { id: 'revoked', userId: 'alice', label: 'Old', daemonId: 'old-daemon', workspaceId: 'alice-workspace', runtimeIds: ['old-id'], workspacesRoot: 'C:/old', executionMode: 'local' as const, managed: false, status: 'revoked' as const, createdAt: '', updatedAt: '' },
  ] };
  const result = build({ stateDirectory: '/state', standardRuntime: config(override) } as any, { userId: 'alice', profile: scopedProfile, sandboxId: 'sandbox', runtimeDirectory: '/state/alice', skillsFile: '/state/alice/skills.json' });
  assert.deepEqual(result.runtimeAllowlist, [
    { daemonId: 'alice-daemon-2bd806c97f0e00af', runtimeIds: [] },
    { daemonId: 'desktop-daemon', runtimeIds: ['claude-id', 'codex-id'] },
  ]);
});
