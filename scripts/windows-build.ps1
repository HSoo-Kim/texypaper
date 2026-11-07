[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [switch]$RunSmoke,
    [switch]$LiveAgents,
    [switch]$MeasureMemory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = Split-Path -Parent $PSScriptRoot
function Invoke-Checked {
    param([Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string[]]$Arguments)
    Write-Host ('> ' + $Executable + ' ' + ($Arguments -join ' '))
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed with exit code $LASTEXITCODE" }
}
if (($RunSmoke -or $LiveAgents -or $MeasureMemory) -and -not $OutputDirectory) {
    throw 'Smoke and memory runs require -OutputDirectory <new isolated evidence directory>.'
}
Push-Location $repository
try {
    $pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
    $cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
    Invoke-Checked $pnpm @('install', '--frozen-lockfile')
    Invoke-Checked $pnpm @('build')
    Invoke-Checked $pnpm @('test')
    Invoke-Checked $cargo @('fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--check')
    Invoke-Checked $cargo @('test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked')
    Invoke-Checked $cargo @('clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--all-targets', '--', '-D', 'warnings')
    Invoke-Checked $pnpm @('tauri', 'build', '--ci', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis', '--', '--locked')
    $app = Join-Path $repository 'src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe'
    if (-not (Test-Path -LiteralPath $app -PathType Leaf)) { throw "Build did not produce $app" }
    if ($OutputDirectory) { $OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory) }
    if ($RunSmoke) {
        $installers = @(Get-ChildItem -LiteralPath (Join-Path $repository 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis') -Filter 'TexyPaper_0.0.6_x64-setup.exe' -File)
        if ($installers.Count -ne 1) { throw 'Expected exactly one TexyPaper_0.0.6_x64-setup.exe NSIS installer; never select a stale or differently branded bundle.' }
        Invoke-Checked $pnpm @('smoke:desktop', '--binary', $app, '--installer', $installers[0].FullName, '--output', (Join-Path $OutputDirectory 'desktop'))
        Invoke-Checked $pnpm @('smoke:usability', '--binary', $app, '--output', (Join-Path $OutputDirectory 'usability'))
        Invoke-Checked $pnpm @('smoke:features', '--binary', $app, '--output', (Join-Path $OutputDirectory 'features'))
        Invoke-Checked $pnpm @('smoke:ssh', '--binary', $app, '--output', (Join-Path $OutputDirectory 'ssh'))
    }
    if ($LiveAgents) { Invoke-Checked $pnpm @('smoke:agents', '--binary', $app, '--live', '--output', (Join-Path $OutputDirectory 'agents')) }
    if ($MeasureMemory) {
        Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'measure-memory.ps1'), '-AppPath', $app, '-DurationSeconds', '120', '-OutputDirectory', (Join-Path $OutputDirectory 'memory'))
    }
}
finally { Pop-Location }
