$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$signingConfig = Join-Path $projectRoot 'signing.properties'
$signingDirectory = Join-Path $projectRoot 'local-signing'
$keystorePath = Join-Path $signingDirectory 'liuyibi-release.jks'

if (Test-Path -LiteralPath $signingConfig) {
    Write-Output 'Release signing is already configured.'
    return
}
if (Test-Path -LiteralPath $keystorePath) {
    throw 'A release keystore already exists but signing.properties is missing. Restore its original signing.properties; do not replace the key.'
}

$keytoolCommand = Get-Command keytool.exe, keytool -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $keytoolCommand) {
    $keytool = $keytoolCommand.Source
} elseif ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\keytool.exe'))) {
    $keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
} else {
    throw 'keytool was not found. Set JAVA_HOME to a JDK installation before creating the release key.'
}

$randomBytes = New-Object byte[] 36
$randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $randomGenerator.GetBytes($randomBytes) } finally { $randomGenerator.Dispose() }
$password = [Convert]::ToBase64String($randomBytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
New-Item -ItemType Directory -Force -Path $signingDirectory | Out-Null

$arguments = @(
    '-genkeypair', '-noprompt',
    '-alias', 'liuyibi-release',
    '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
    '-dname', 'CN=Liuyibi Offline Ledger, OU=Release, O=Liuyibi, C=CN',
    '-keystore', $keystorePath,
    '-storepass', $password, '-keypass', $password
)
$null = & $keytool @arguments 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Release keystore creation failed.' }

$properties = @(
    'storeFile=local-signing/liuyibi-release.jks'
    "storePassword=$password"
    'keyAlias=liuyibi-release'
    "keyPassword=$password"
) -join "`r`n"
Set-Content -LiteralPath $signingConfig -Value $properties -Encoding ascii
Write-Output 'Created a persistent release signing key and ignored signing.properties.'
Write-Output 'Back up android-app/local-signing and signing.properties together. Future APK updates require this same key.'
