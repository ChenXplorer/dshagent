param(
    [ValidateSet('start', 'stop', 'status', 'prepare')][string]$Action = 'start',
    [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '../../../.runtime/local-daemon'),
    [string]$MulticaAuth = (Join-Path $PSScriptRoot '../../../.runtime/multica/auth.json'),
    [string]$DriverMetadata = (Join-Path $PSScriptRoot '../../../.runtime/driver/local-daemon.json'),
    [string]$DriverConfig = '',
    [string]$BinaryPath = (Join-Path $PSScriptRoot '../../../../dshagent-upstream/build/multica-windows-official/multica.exe'),
    [string]$Profile = 'dshagent-local',
    [string]$ServerUrl = 'http://127.0.0.1:18381',
    [string]$ExpectedDaemonVersion = 'official'
)
$ErrorActionPreference = 'Stop'
$resolvedRuntime = Resolve-Path -LiteralPath $RuntimeDirectory -ErrorAction SilentlyContinue
if (-not $resolvedRuntime) {
    New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
    $resolvedRuntime = Resolve-Path -LiteralPath $RuntimeDirectory
}
$RuntimeDirectory = $resolvedRuntime.Path
$RuntimeDirectory = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$MulticaAuth = (Resolve-Path -LiteralPath $MulticaAuth).Path
if (-not [System.IO.Path]::IsPathRooted($DriverMetadata)) { $DriverMetadata = Join-Path (Get-Location) $DriverMetadata }
$DriverMetadata = [System.IO.Path]::GetFullPath($DriverMetadata)
$BinaryPath = (Resolve-Path -LiteralPath $BinaryPath).Path
$parsedServerUrl = $null
if (-not [uri]::TryCreate($ServerUrl, [System.UriKind]::Absolute, [ref]$parsedServerUrl) -or $parsedServerUrl.Scheme -notin @('http', 'https')) {
    throw 'ServerUrl must be an absolute HTTP(S) URL'
}
$ServerUrl = $ServerUrl.TrimEnd('/')
$versionOutput = (& $BinaryPath version 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch ('multica\s+' + [regex]::Escape($ExpectedDaemonVersion) + '\b')) {
    throw "Multica binary version does not match ExpectedDaemonVersion=$ExpectedDaemonVersion"
}
$pidFile = Join-Path $RuntimeDirectory 'daemon.pid'
$logFile = Join-Path $RuntimeDirectory 'daemon.log'
$errFile = Join-Path $RuntimeDirectory 'daemon.err.log'
$profileDir = Join-Path $env:USERPROFILE ('.multica\profiles\' + $Profile)
$profileConfig = Join-Path $profileDir 'config.json'
$workspacesRoot = Join-Path $RuntimeDirectory 'workspaces'
$codexHome = Join-Path $RuntimeDirectory 'codex'
$claudeHome = Join-Path $RuntimeDirectory 'claude'
New-Item -ItemType Directory -Force -Path $profileDir, $workspacesRoot | Out-Null

function Get-RecordedProcess {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $value = (Get-Content -Raw -LiteralPath $pidFile).Trim()
    if ($value -notmatch '^\d+$') { return $null }
    Get-Process -Id ([int]$value) -ErrorAction SilentlyContinue
}
function Stop-ProcessTree([int]$ProcessId) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) { Stop-ProcessTree ([int]$child.ProcessId) }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

if ($Action -eq 'stop') {
    $process = Get-RecordedProcess
    if ($process) { Stop-ProcessTree $process.Id }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Output 'Windows Multica Daemon stopped.'
    return
}
if ($Action -eq 'status') {
    $process = Get-RecordedProcess
    [pscustomobject]@{ profile = $Profile; pid = if ($process) { $process.Id } else { $null }; running = [bool]$process; profileConfig = $profileConfig; workspacesRoot = $workspacesRoot }
    return
}

$existing = Get-RecordedProcess
if ($existing) { throw "Recorded local Daemon process $($existing.Id) is still running; stop it before restarting" }
$auth = Get-Content -Raw -LiteralPath $MulticaAuth | ConvertFrom-Json
if (-not $auth.workspaceId -or -not $auth.token) { throw 'Multica auth.json must contain workspaceId and token' }
$daemonId = $null
if (Test-Path -LiteralPath $DriverMetadata) {
    try { $daemonId = (Get-Content -Raw -LiteralPath $DriverMetadata | ConvertFrom-Json).daemonId } catch { $daemonId = $null }
}
if (-not $daemonId) { $daemonId = [guid]::NewGuid().Guid }
$config = [ordered]@{
    server_url = $ServerUrl
    app_url = $ServerUrl
    workspace_id = [string]$auth.workspaceId
    token = [string]$auth.token
    device_name = 'Windows local'
    runtime_name = 'DSH local'
    workspaces_root = $workspacesRoot
    max_concurrent_tasks = 2
}
$config | ConvertTo-Json | Set-Content -LiteralPath $profileConfig -Encoding utf8
[System.IO.Directory]::CreateDirectory($codexHome) | Out-Null
[System.IO.Directory]::CreateDirectory($claudeHome) | Out-Null
@'
model = "deepseek-flash"
model_provider = "deepseek"
web_search = "disabled"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"
requires_openai_auth = false
supports_websockets = false
'@ | Set-Content -LiteralPath (Join-Path $codexHome 'config.toml') -Encoding utf8
@{
    env = [ordered]@{
        ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
        ANTHROPIC_MODEL = 'deepseek-flash'
        ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-flash'
        ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-flash'
        ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-flash'
        CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-flash'
    }
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $claudeHome 'settings.json') -Encoding utf8
[ordered]@{ daemonId = $daemonId; profile = $Profile; profileConfig = $profileConfig; workspacesRoot = $workspacesRoot; serverUrl = $ServerUrl; deviceName = 'Windows local'; runtimeName = 'DSH local'; daemonVersion = $ExpectedDaemonVersion } |
    ConvertTo-Json | Set-Content -LiteralPath $DriverMetadata -Encoding utf8
$driverConfigPath = if ($DriverConfig) { [System.IO.Path]::GetFullPath($DriverConfig) } else { Join-Path (Split-Path -Parent $DriverMetadata) 'config.json' }
if (-not (Test-Path -LiteralPath $driverConfigPath)) { throw 'Private driver config.json is required for the local CLI profile' }
if ($Action -eq 'prepare') {
    [pscustomobject]@{
        daemonId = $daemonId
        profile = $Profile
        profileConfig = $profileConfig
        workspacesRoot = $workspacesRoot
        serverUrl = $ServerUrl
        binaryPath = $BinaryPath
        driverConfig = $driverConfigPath
    }
    return
}
$launcher = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $launcher) { throw 'PowerShell 7 (pwsh) is required to launch the local CLI environment safely' }
$runner = Join-Path $PSScriptRoot 'run-local-daemon.ps1'
$runnerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-BinaryPath', $BinaryPath, '-Profile', $Profile,
    '-DaemonId', $daemonId, '-WorkspacesRoot', $workspacesRoot, '-DriverConfig', $driverConfigPath)
$process = Start-Process -FilePath $launcher -ArgumentList $runnerArgs -WorkingDirectory $RuntimeDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput $logFile -RedirectStandardError $errFile
$process.Id | Set-Content -LiteralPath $pidFile -NoNewline
Write-Output "Windows Multica Daemon started, PID $($process.Id), profile $Profile. Credentials stay in the private profile config."
