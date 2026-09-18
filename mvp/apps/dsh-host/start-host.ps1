param(
    [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '../../../.runtime/dsh'),
    [string]$DriverConfiguration = (Join-Path $PSScriptRoot '../../../.runtime/driver/config.json'),
    [int]$WebPort = 3080,
    [int]$GatewayPort = 3380
)
$ErrorActionPreference = 'Stop'
$DriverConfiguration = (Resolve-Path -LiteralPath $DriverConfiguration).Path
$driverConfig = Get-Content -Raw -LiteralPath $DriverConfiguration | ConvertFrom-Json
if (-not $driverConfig.userId) { throw 'Deployment configuration must have the fixed userId' }
New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
$RuntimeDirectory = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$nativeHome = Join-Path $RuntimeDirectory 'home'
$hostWorkspace = Join-Path $RuntimeDirectory 'workspace'
New-Item -ItemType Directory -Path $nativeHome, $hostWorkspace -Force | Out-Null
$profile = Join-Path $RuntimeDirectory 'mvp.cordis.json'
$node = (Get-Command node).Source
if (-not (Test-Path -LiteralPath $profile)) {
    & $node (Join-Path $PSScriptRoot 'create-profile.mjs') $profile (Join-Path $RuntimeDirectory 'sessions')
    if ($LASTEXITCODE -ne 0) { throw 'Native DSH profile generation failed' }
}
& $node (Join-Path $PSScriptRoot 'enable-runtime-ui.mjs') $profile
if ($LASTEXITCODE -ne 0) { throw 'Runtime UI profile update failed' }
$tokenFile = Join-Path $RuntimeDirectory 'gateway.token'
if (-not (Test-Path -LiteralPath $tokenFile)) {
    [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) | Set-Content -LiteralPath $tokenFile -NoNewline
}
$pidFile = Join-Path $RuntimeDirectory 'host.pid'
if (Test-Path -LiteralPath $pidFile) {
    $priorPid = [int](Get-Content -Raw -LiteralPath $pidFile)
    if (Get-Process -Id $priorPid -ErrorAction SilentlyContinue) { throw "Recorded host process $priorPid still exists; inspect it before starting another" }
}
$environment = @{
    DSH_HOME = $nativeHome
    DSH_MVP_PROFILE_PATCH = $profile
    DSH_MVP_DRIVER_MODULE = Join-Path $PSScriptRoot 'create-driver.ts'
    DSH_MVP_CONFIG = $DriverConfiguration
    DSH_MVP_USER_ID = $driverConfig.userId
    DSH_MVP_HOST_WORKSPACE = $hostWorkspace
    DSH_MVP_GATEWAY_TOKEN = (Get-Content -Raw -LiteralPath $tokenFile).Trim()
    DSH_MVP_GATEWAY_PORT = "$GatewayPort"
}
$arguments = @('"' + (Join-Path $PSScriptRoot 'start.mjs') + '"', '--host', '127.0.0.1', '--port', "$WebPort")
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $hostWorkspace -Environment $environment `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $RuntimeDirectory 'host.stdout.log') `
    -RedirectStandardError (Join-Path $RuntimeDirectory 'host.stderr.log')
$process.Id | Set-Content -LiteralPath $pidFile
Write-Output "Official DSH launcher started, PID $($process.Id); check Gateway and Web health before submitting work."
