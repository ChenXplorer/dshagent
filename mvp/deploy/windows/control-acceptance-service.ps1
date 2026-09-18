param(
    [Parameter(Mandatory)][ValidateSet('multica', 'dsh')][string]$Service,
    [Parameter(Mandatory)][ValidateSet('stop', 'start')][string]$Action,
    [string]$DriverConfiguration = (Join-Path $PSScriptRoot '../../../.runtime/driver/config.json'),
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
if ($Service -eq 'multica') {
    $runtime = Join-Path $project '.runtime/multica'
    $pidFile = Join-Path $runtime 'server.pid'
    $expectedExe = (Resolve-Path -LiteralPath (Join-Path $project '../dshagent-upstream/build/multica/multica-server.exe')).Path
    $settings = Get-Content -Raw -LiteralPath (Join-Path $runtime 'windows-env.json') | ConvertFrom-Json
    $port = [int]$settings.PORT
    $launcher = Join-Path $PSScriptRoot 'start-multica.ps1'
} else {
    $runtime = Join-Path $project '.runtime/dsh'
    $pidFile = Join-Path $runtime 'host.pid'
    $expectedExe = (Get-Command node).Source
    $port = 3380
    $launcher = Join-Path $project 'mvp/apps/dsh-host/start-host.ps1'
}
if ($Action -eq 'start') {
    if ($ValidateOnly) { throw 'ValidateOnly is supported for stop identity checks only' }
    if ($Service -eq 'multica') { & $launcher -Action start }
    else { & $launcher -DriverConfiguration $DriverConfiguration }
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Owned service launcher failed' }
    return
}
$ownedPid = [int](Get-Content -Raw -LiteralPath $pidFile)
$process = Get-Process -Id $ownedPid -ErrorAction Stop
if (-not [string]::Equals($process.Path, $expectedExe, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Recorded PID executable differs from the owned acceptance service; refusing stop'
}
$targets = @($process)
if ($Service -eq 'dsh') {
    $launcherSource = Join-Path $project 'mvp/apps/dsh-host/start.mjs'
    $nativeSource = Join-Path $project 'mvp/apps/dsh-host/bootstrap.mjs'
    $profilePath = Join-Path $runtime 'mvp.cordis.json'
    $recorded = Get-CimInstance Win32_Process -Filter "ProcessId=$ownedPid"
    $launcherPattern = '(?i)(?:^|\s|")' + [regex]::Escape($launcherSource) + '(?:"|\s|$)'
    if ($recorded.Name -ne 'node.exe' -or $recorded.CommandLine -notmatch $launcherPattern) {
        throw 'Node PID is not the owned DSH launcher; refusing stop'
    }
    # start.mjs records its own PID; the official bootstrap child owns both listeners.
    $listeners = @(Get-NetTCPConnection -LocalPort 3080,3380 -State Listen -ErrorAction Stop)
    $nativePids = @($listeners.OwningProcess | Sort-Object -Unique)
    if ($nativePids.Count -ne 1 -or @($listeners.LocalPort | Sort-Object -Unique).Count -ne 2) {
        throw 'The two DSH listeners do not have one common owner; refusing stop'
    }
    $nativePid = [int]$nativePids[0]
    $native = Get-Process -Id $nativePid -ErrorAction Stop
    $nativeCim = Get-CimInstance Win32_Process -Filter "ProcessId=$nativePid"
    $nativePattern = '(?i)(?:^|\s|")' + [regex]::Escape($nativeSource) + '(?:"|\s|$)'
    $profilePattern = '(?i)(?:^|\s|")' + [regex]::Escape($profilePath) + '(?:"|\s|$)'
    if (-not [string]::Equals($native.Path, $expectedExe, [StringComparison]::OrdinalIgnoreCase) -or
        $nativeCim.Name -ne 'node.exe' -or $nativeCim.ParentProcessId -ne $ownedPid -or
        $nativeCim.CommandLine -notmatch $nativePattern -or $nativeCim.CommandLine -notmatch $profilePattern) {
        throw 'Native listener lacks the exact owned bootstrap/executable/profile/direct-parent chain; refusing stop'
    }
    $targets = @($native, $process)
} else {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $ownedPid }
    if (-not $listener) { throw 'Recorded PID does not own the expected service listener; refusing stop' }
}
$identities = @($targets | ForEach-Object { [pscustomobject]@{ Id = $_.Id; Path = $_.Path; StartTime = $_.StartTime } })
if ($ValidateOnly) {
    Write-Output "$Service stop identities verified without stopping: $($targets.Id -join ', ')"
    return
}
# Stop the validated child before its launcher; never enumerate or kill arbitrary descendants.
foreach ($target in $identities) {
    $current = Get-Process -Id $target.Id -ErrorAction SilentlyContinue
    if (-not $current) { continue }
    if ($current.StartTime -ne $target.StartTime -or
        -not [string]::Equals($current.Path, $target.Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Validated PID identity changed before stop; refusing stop'
    }
    Stop-Process -Id $target.Id -Force -ErrorAction Stop
    Wait-Process -Id $target.Id -Timeout 15 -ErrorAction SilentlyContinue
    if (Get-Process -Id $target.Id -ErrorAction SilentlyContinue) { throw 'Owned service has not stopped' }
}
Write-Output "$Service acceptance service stopped; PID identity and listener were verified."
