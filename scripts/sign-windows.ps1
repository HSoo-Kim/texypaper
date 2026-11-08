[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$FilePath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Tauri calls this separately for its patched application, NSIS uninstaller and installer.
# Never import a PFX into a certificate store or print signing arguments/secrets.
$file = (Resolve-Path -LiteralPath $FilePath -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Signing input must be a file.' }
$timestampUrl = $env:TEXYPAPER_SIGN_TIMESTAMP_URL
if (-not $timestampUrl) { $timestampUrl = 'http://timestamp.digicert.com' }
$timestampUri = $null
if (-not [Uri]::TryCreate($timestampUrl, [UriKind]::Absolute, [ref]$timestampUri) -or $timestampUri.Scheme -notin @('http', 'https')) {
    throw 'TEXYPAPER_SIGN_TIMESTAMP_URL must be an absolute HTTP(S) RFC 3161 timestamp URL.'
}

if ($env:TEXYPAPER_SIGN_PROVIDER_SCRIPT) {
    if ($env:TEXYPAPER_SIGN_PFX) { throw 'Select either a provider script or a PFX, not both.' }
    $provider = (Resolve-Path -LiteralPath $env:TEXYPAPER_SIGN_PROVIDER_SCRIPT -ErrorAction Stop).Path
    # A separate process gives the hook an unambiguous exit status, including native tools.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $provider -FilePath $file -TimestampUrl $timestampUrl -DigestAlgorithm SHA256
    if ($LASTEXITCODE -ne 0) { throw "Signing provider failed with exit code $LASTEXITCODE." }
} else {
    if (-not $env:TEXYPAPER_SIGN_PFX -or -not $env:TEXYPAPER_SIGN_PASSWORD) {
        throw 'Signing requires TEXYPAPER_SIGN_PFX and TEXYPAPER_SIGN_PASSWORD, or TEXYPAPER_SIGN_PROVIDER_SCRIPT. Unsigned builds must omit the signing overlay.'
    }
    $pfx = (Resolve-Path -LiteralPath $env:TEXYPAPER_SIGN_PFX -ErrorAction Stop).Path
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $tools = @(Get-ChildItem -Path (Join-Path $sdkRoot '*\x64\signtool.exe') -File -ErrorAction SilentlyContinue | Sort-Object { [version]$_.Directory.Parent.Name } -Descending)
    if ($tools.Count -eq 0) { throw 'signtool.exe not found in C:\Program Files (x86)\Windows Kits\10\bin\*\x64. Install the Windows SDK signing tools.' }
    $arguments = @('sign', '/fd', 'SHA256', '/f', $pfx, '/p', $env:TEXYPAPER_SIGN_PASSWORD, '/tr', $timestampUrl, '/td', 'SHA256', $file)
    # Native stderr may be an ErrorRecord in Windows PowerShell. Capture it without
    # allowing error formatting to expose the invocation; redact before reporting.
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = & $tools[0].FullName @arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedPreference
        $arguments = $null
    }
    if ($exitCode -ne 0) {
        $detail = ($result | Out-String).Replace($env:TEXYPAPER_SIGN_PASSWORD, '[REDACTED]')
        throw "SignTool signing/timestamping failed with exit code ${exitCode}: $detail"
    }
}

$signature = Get-AuthenticodeSignature -LiteralPath $file
if (-not $signature.SignerCertificate -or $signature.Status -in @('NotSigned', 'HashMismatch') -or -not $signature.TimeStamperCertificate) {
    throw 'Signing did not produce an intact Authenticode signature with a timestamp. Do not publish this artifact.'
}
Write-Host ('Signed and timestamped: ' + [IO.Path]::GetFileName($file))
# Trust is deliberately checked by release verification, not by importing certificates here.
