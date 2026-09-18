import { posix } from 'node:path';

export interface ModelEndpoint {
  /** API base, not /responses, /messages or /chat/completions. */
  baseUrl: string;
  model: string;
  /** Name only. Secret values must never enter this configuration object. */
  apiKeyEnv: string;
}

export interface NativeCliConfigurationInput {
  /** Absolute paths inside the user's Linux Daytona. */
  codexHome: string;
  claudeHome: string;
  codex: ModelEndpoint & {
    wireApi: 'responses';
    /** Optional externally sourced, version-pinned native model catalog. */
    modelCatalogPath?: string;
    reasoningEffort?: 'low' | 'high';
  };
  claude: ModelEndpoint & {
    smallModel?: string;
    effort?: 'low' | 'high' | 'max';
  };
}

export interface NativeCliConfiguration {
  /** Secret-free native config files. Sandbox provisioning owns writing them. */
  files: Array<{ path: string; contents: string; mode: 0o600 }>;
  /** Inject into the official Daemon process, not the user's global shell. */
  environment: Record<string, string>;
  /** Resolve these from the sandbox secret source at process launch. Never log values. */
  secretBindings: Array<{ sourceEnv: string; targetEnv: string }>;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a non-empty, single-line string`);
  }
  return value;
}

function sandboxPath(value: string, label: string): string {
  textValue(value, label);
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || posix.normalize(value) !== value || value === '/') {
    throw new Error(`${label} must be a normalized absolute Linux sandbox path`);
  }
  return value;
}

function endpoint(value: string, label: string): string {
  textValue(value, label);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute HTTPS API base URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must use HTTPS without credentials, query parameters or fragment`);
  }
  if (/\/(responses|messages|chat\/completions)\/?$/u.test(url.pathname)) {
    throw new Error(`${label} must be an API base URL, not a request endpoint`);
  }
  return url.toString().replace(/\/$/u, '');
}

function keyVariable(value: string): string {
  if (!/^[A-Z][A-Z0-9_]*(?:KEY|TOKEN)$/u.test(value) || value === 'ANTHROPIC_AUTH_TOKEN') {
    throw new Error('apiKeyEnv must name a dedicated KEY or TOKEN environment variable (not ANTHROPIC_AUTH_TOKEN)');
  }
  return value;
}

/**
 * Generates only native CLI configuration. It neither calls a model nor launches
 * a task, and makes no claim that the selected remote model has passed acceptance.
 */
export function buildNativeCliConfiguration(input: NativeCliConfigurationInput): NativeCliConfiguration {
  const codexHome = sandboxPath(input.codexHome, 'codexHome');
  const claudeHome = sandboxPath(input.claudeHome, 'claudeHome');
  if (codexHome === claudeHome || codexHome.startsWith(`${claudeHome}/`) || claudeHome.startsWith(`${codexHome}/`)) {
    throw new Error('CLI configuration homes must be separate, non-nested directories');
  }
  if (input.codex.wireApi !== 'responses') {
    throw new Error('Codex requires native Responses API; chat/completions is not a supported fallback');
  }
  const codexBase = endpoint(input.codex.baseUrl, 'codex.baseUrl');
  const claudeBase = endpoint(input.claude.baseUrl, 'claude.baseUrl');
  const codexModel = textValue(input.codex.model, 'codex.model');
  const claudeModel = textValue(input.claude.model, 'claude.model');
  const smallModel = textValue(input.claude.smallModel ?? claudeModel, 'claude.smallModel');
  const codexKey = keyVariable(input.codex.apiKeyEnv);
  const claudeKey = keyVariable(input.claude.apiKeyEnv);
  if (input.codex.reasoningEffort !== undefined && !['low', 'high'].includes(input.codex.reasoningEffort)) {
    throw new Error('codex.reasoningEffort must be low or high for the verified configuration subset');
  }
  if (input.claude.effort !== undefined && !['low', 'high', 'max'].includes(input.claude.effort)) {
    throw new Error('claude.effort must be low, high or max');
  }
  // JSON-quoted strings are valid TOML basic strings after control chars are rejected.
  const lines = [
    `model = ${JSON.stringify(codexModel)}`,
    'model_provider = "deepseek"',
    'web_search = "disabled"',
  ];
  if (input.codex.modelCatalogPath !== undefined) {
    lines.push(`model_catalog_json = ${JSON.stringify(sandboxPath(input.codex.modelCatalogPath, 'modelCatalogPath'))}`);
  }
  if (input.codex.reasoningEffort !== undefined) lines.push(`model_reasoning_effort = ${JSON.stringify(input.codex.reasoningEffort)}`);
  lines.push('', '[model_providers.deepseek]', 'name = "DeepSeek"', `base_url = ${JSON.stringify(codexBase)}`,
    'wire_api = "responses"', `env_key = ${JSON.stringify(codexKey)}`, 'requires_openai_auth = false', 'supports_websockets = false', '');

  const claudeEnvironment: Record<string, string> = {
    ANTHROPIC_BASE_URL: claudeBase,
    ANTHROPIC_MODEL: claudeModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: claudeModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: claudeModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel,
    CLAUDE_CODE_SUBAGENT_MODEL: smallModel,
  };
  if (input.claude.effort !== undefined) claudeEnvironment.CLAUDE_CODE_EFFORT_LEVEL = input.claude.effort;
  return {
    files: [
      { path: posix.join(codexHome, 'config.toml'), contents: lines.join('\n'), mode: 0o600 },
      { path: posix.join(claudeHome, 'settings.json'), contents: `${JSON.stringify({ env: claudeEnvironment }, null, 2)}\n`, mode: 0o600 },
    ],
    environment: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, ...claudeEnvironment },
    secretBindings: [
      { sourceEnv: codexKey, targetEnv: codexKey },
      { sourceEnv: claudeKey, targetEnv: 'ANTHROPIC_AUTH_TOKEN' },
    ],
  };
}

/** Fails before Daemon start. Error text contains variable names only. */
export function assertCliSecretsPresent(configuration: NativeCliConfiguration, secrets: Readonly<Record<string, string | undefined>>): void {
  for (const { sourceEnv } of configuration.secretBindings) {
    const value = secrets[sourceEnv];
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value || /[\r\n\u0000]/u.test(value)) {
      throw new Error(`Missing or invalid CLI secret: ${sourceEnv}`);
    }
  }
}
