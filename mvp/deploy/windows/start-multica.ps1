param(
    [ValidateSet('start', 'migrate')][string]$Action = 'start',
    [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '../../../.runtime/multica'),
    [string]$BinaryDirectory = (Join-Path $PSScriptRoot '../../../../dshagent-upstream/build/multica'),
    [string]$SourceDirectory = (Join-Path $PSScriptRoot '../../../../dshagent-upstream/multica/server')
)
$ErrorActionPreference = 'Stop'
$RuntimeDirectory = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$BinaryDirectory = (Resolve-Path -LiteralPath $BinaryDirectory).Path
$SourceDirectory = (Resolve-Path -LiteralPath $SourceDirectory).Path
# Official binaries resolve the genuine SQL migration files relative to cwd.
Copy-Item -LiteralPath (Join-Path $SourceDirectory 'migrations') -Destination $RuntimeDirectory -Recurse -Force
$configuration = Get-Content -Raw -LiteralPath (Join-Path $RuntimeDirectory 'windows-env.json') | ConvertFrom-Json -AsHashtable
# This private development deployment uses official stdout-only local login.
$configuration.SMTP_HOST = ''
$configuration.RESEND_API_KEY = ''
foreach ($required in @('DATABASE_URL', 'JWT_SECRET', 'PORT', 'APP_ENV')) {
    if (-not $configuration[$required]) { throw "Missing runtime field: $required" }
}
if ($Action -eq 'migrate') {
    $previous = $env:DATABASE_URL
    Push-Location $RuntimeDirectory
    try {
        $env:DATABASE_URL = $configuration.DATABASE_URL
        & (Join-Path $BinaryDirectory 'multica-migrate.exe') up
        if ($LASTEXITCODE -ne 0) { throw 'Official Multica database migration failed' }
    } finally { $env:DATABASE_URL = $previous; Pop-Location }
    return
}
$pidFile = Join-Path $RuntimeDirectory 'server.pid'
if (Test-Path -LiteralPath $pidFile) {
    $priorPid = [int](Get-Content -Raw -LiteralPath $pidFile)
    $prior = Get-Process -Id $priorPid -ErrorAction SilentlyContinue
    if ($prior) { throw "Recorded server process $priorPid still exists; inspect it before starting another server" }
}
$process = Start-Process -FilePath (Join-Path $BinaryDirectory 'multica-server.exe') `
    -WorkingDirectory $RuntimeDirectory -Environment $configuration -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $RuntimeDirectory 'server.stdout.log') `
    -RedirectStandardError (Join-Path $RuntimeDirectory 'server.stderr.log')
$process.Id | Set-Content -LiteralPath $pidFile
Write-Output "Official Multica Server started, PID $($process.Id). Verify /health before using it."
