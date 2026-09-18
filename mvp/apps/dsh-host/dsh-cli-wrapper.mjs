#!/usr/bin/env node
/**
 * Executable adapter for the official DSH CLI when called by a DSH Hub Node
 * Agent.  The published ESM bin only self-dispatches when it is Node's entry
 * module; spawning its symlink from a supervisor can therefore exit 0 without
 * performing a command.  This wrapper explicitly invokes the public runCli()
 * export, gives the CLI the profile home expected by its official resolver, and
 * exposes the project-pinned pnpm binary required by `dsh plugin`. Plugin
 * packages default to the official npm registry; a deployment may explicitly
 * set DSH_PLUGIN_REGISTRY for its approved private registry.
 */
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePnpmBuildPolicy } from './dsh-plugin-build-policy.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(directory, '../..');
const pinnedBin = join(projectRoot, 'node_modules', '.bin');

process.env.PATH = process.env.PATH ? `${pinnedBin}${delimiter}${process.env.PATH}` : pinnedBin;
const pluginRegistry = process.env.DSH_PLUGIN_REGISTRY?.trim() || 'https://registry.npmjs.org/';
if (!/^https:\/\/[^/]+(?:\/.*)?$/u.test(pluginRegistry)) {
  throw new Error('DSH_PLUGIN_REGISTRY must be an HTTPS registry URL');
}
// pnpm gives this process environment setting precedence over a machine-wide
// .npmrc. That prevents an unrelated mirror setting from changing a user's
// Profile installation; private deployments opt in with DSH_PLUGIN_REGISTRY.
process.env.npm_config_registry = pluginRegistry;
// The Node Agent invokes us from <DSH_HOME>/profiles. Do not overwrite an
// explicit caller-provided home, which keeps the wrapper usable in other hosts.
if (!process.env.DSH_HOME) process.env.DSH_HOME = dirname(process.cwd());

const profileFlag = process.argv.indexOf('--profile');
const profileName = profileFlag >= 0 ? process.argv[profileFlag + 1] : undefined;
const isPluginMutation = process.argv[2] === 'plugin' && (process.argv.includes('add') || process.argv.includes('install'));
if (isPluginMutation) {
  if (!profileName || !/^[a-z0-9][a-z0-9_-]*$/u.test(profileName)) throw new Error('dsh plugin mutation requires a valid --profile name');
  await preparePnpmBuildPolicy(join(process.cwd(), profileName), process.env.DSH_PLUGIN_APPROVED_BUILD_PACKAGES);
}

const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js');
await runCli();
