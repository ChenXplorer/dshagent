param(
    [Parameter(Mandatory = $true)][string]$BinaryPath,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$DaemonId,
    [Parameter(Mandatory = $true)][string]$WorkspacesRoot,
    [Parameter(Mandatory = $true)][string]$DriverConfig
)
$ErrorActionPreference = 'Stop'
$config = Get-Content -Raw -LiteralPath $DriverConfig | ConvertFrom-Json
$key = $config.daemon.secrets.DEEPSEEK_API_KEY
if (-not $key) { throw 'Private driver config must contain daemon.secrets.DEEPSEEK_API_KEY' }
$runtimeDirectory = Split-Path -Parent $WorkspacesRoot
$env:CODEX_HOME = Join-Path $runtimeDirectory 'codex'
$env:CLAUDE_CONFIG_DIR = Join-Path $runtimeDirectory 'claude'
$env:DEEPSEEK_API_KEY = [string]$key
$env:ANTHROPIC_AUTH_TOKEN = [string]$key
$env:ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
$env:ANTHROPIC_MODEL = 'deepseek-flash'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-flash'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-flash'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-flash'
$env:CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-flash'
$env:MULTICA_DAEMON_AUTO_UPDATE = 'false'
& $BinaryPath --profile $Profile daemon start --foreground --daemon-id $DaemonId --device-name 'Windows local' --runtime-name 'DSH local' --max-concurrent-tasks 2 --workspaces-root $WorkspacesRoot --no-auto-update --no-auto-reload
exit $LASTEXITCODE
