param(
    [string]$SshHost = '192.168.3.146',
    [string]$SshUser = 'dev',
    [string]$IdentityFile = (Join-Path $PSScriptRoot '../../../.runtime/ssh/id_ed25519')
)
$ErrorActionPreference = 'Stop'
$IdentityFile = (Resolve-Path -LiteralPath $IdentityFile).Path
# Foreground: supervise this process alongside the Windows application services.
# The private key belongs in .runtime, never in this deployment directory.
& ssh -N -T -i $IdentityFile -o BatchMode=yes -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=20 -o ServerAliveCountMax=3 `
    -L 127.0.0.1:33000:127.0.0.1:33000 `
    -L 127.0.0.1:34000:127.0.0.1:34000 `
    -L 127.0.0.1:35556:127.0.0.1:35556 `
    -L 127.0.0.1:35432:127.0.0.1:35432 `
    -L 127.0.0.1:9000:127.0.0.1:39000 `
    -R 127.0.0.1:18381:127.0.0.1:18381 "${SshUser}@${SshHost}"
exit $LASTEXITCODE
