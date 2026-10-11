param(
    [switch]$Offline,
    [string]$LegacyKeystore
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$pocketRoot = Split-Path -Parent $projectRoot
$oldApk = Join-Path $pocketRoot 'Liuyibi-Android.apk'
$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$candidateKeystores = @()
if ($LegacyKeystore) { $candidateKeystores += $LegacyKeystore }
else {
    $candidateKeystores += Join-Path $userProfile '.android\debug.keystore'
    $candidateKeystores += Join-Path $PSScriptRoot '.build-cache\android-user\debug.keystore'
}
$localProperties = Join-Path $projectRoot 'local.properties'
$androidSdk = $env:ANDROID_SDK_ROOT
if (-not $androidSdk) { $androidSdk = $env:ANDROID_HOME }
if (-not $androidSdk -and (Test-Path -LiteralPath $localProperties)) {
    $sdkLine = Get-Content -LiteralPath $localProperties | Where-Object { $_ -match '^sdk\.dir=' } | Select-Object -First 1
    if ($sdkLine) { $androidSdk = ($sdkLine -replace '^sdk\.dir=', '').Replace('\\', '\') }
}
if (-not $androidSdk -or -not (Test-Path -LiteralPath $androidSdk)) {
    throw 'Android SDK not found. Set ANDROID_SDK_ROOT or configure sdk.dir in android-app/local.properties.'
}
if (-not (Test-Path -LiteralPath $oldApk)) { throw 'The preserved legacy APK is required to verify the migration signing identity.' }
$cacheRoot = Join-Path $projectRoot '.build-cache'
$env:ANDROID_USER_HOME = Join-Path $cacheRoot 'android-user'
$env:GRADLE_USER_HOME = Join-Path $cacheRoot 'gradle-home'
$gradle = Join-Path $cacheRoot 'gradle-8.11.1\bin\gradle.bat'
if (-not (Test-Path -LiteralPath $gradle)) { $gradle = Join-Path $projectRoot 'gradlew.bat' }
if (-not (Test-Path -LiteralPath $gradle)) { throw 'Gradle was not found. Run the Android project wrapper setup first.' }
$buildTools = Get-ChildItem -LiteralPath (Join-Path $androidSdk 'build-tools') -Directory -ErrorAction SilentlyContinue |
    Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'aapt2.exe') } |
    Select-Object -First 1
$signer = Get-ChildItem -LiteralPath (Join-Path $androidSdk 'build-tools') -Directory |
    Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending |
    ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if (-not $signer) { throw 'apksigner was not found in the configured Android SDK build-tools.' }

function Get-CertificateDigest([string]$path, [string]$apksigner) {
    $result = & $apksigner verify --verbose --print-certs $path 2>&1
    if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed: $path" }
    $match = ($result | Out-String) -match '(?i)Signer #1 certificate SHA-256 digest: ([0-9a-f]+)'
    if (-not $match) { throw "APK signer certificate digest was not reported: $path" }
    return $Matches[1].ToLowerInvariant()
}

$oldDigest = Get-CertificateDigest $oldApk $signer
$keytoolCommand = Get-Command keytool.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$keytoolPath = if ($keytoolCommand) { $keytoolCommand.Source } else { $null }
if (-not $keytoolPath -and $env:JAVA_HOME) {
    $candidateKeytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
    if (Test-Path -LiteralPath $candidateKeytool) { $keytoolPath = $candidateKeytool }
}
if (-not $keytoolPath) { throw 'keytool was not found; unable to check the legacy signing certificate before building.' }

function Get-KeystoreCertificateDigest([string]$path, [string]$keytool) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $result = & $keytool -list -v -keystore $path -storepass android -alias androiddebugkey 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    $text = $result | Out-String
    $match = [regex]::Match($text, '(?im)^\s*SHA256:\s*([0-9a-f:]+)\s*$')
    if (-not $match.Success) { return $null }
    return ($match.Groups[1].Value -replace ':', '').ToLowerInvariant()
}

$legacyKeystore = $null
foreach ($candidate in ($candidateKeystores | Select-Object -Unique)) {
    $candidatePath = if ([System.IO.Path]::IsPathRooted($candidate)) { $candidate } else { Join-Path $projectRoot $candidate }
    $candidateDigest = Get-KeystoreCertificateDigest $candidatePath $keytoolPath
    if ($candidateDigest -and $candidateDigest -eq $oldDigest) {
        $legacyKeystore = (Resolve-Path -LiteralPath $candidatePath).Path
        break
    }
}
if (-not $legacyKeystore) {
    throw 'No matching legacy debug keystore was found. The migration APK was not built or delivered. Keep the old app installed and provide the original matching keystore before attempting migration.'
}

$gradleArguments = @('--no-daemon')
if ($Offline) { $gradleArguments += '--offline' }
if ($buildTools) { $gradleArguments += "-Pandroid.aapt2FromMavenOverride=$(Join-Path $buildTools.FullName 'aapt2.exe')" }
$gradleArguments += "-PliuyibiMigrationStoreFile=$legacyKeystore"
$gradleArguments += 'assembleUpgrade'
Push-Location $projectRoot
try {
    & $gradle @gradleArguments
    if ($LASTEXITCODE -ne 0) { throw 'Migration APK build failed.' }
} finally {
    Pop-Location
}

$apk = Join-Path $projectRoot 'app\build\outputs\apk\upgrade\app-upgrade.apk'
if (-not (Test-Path -LiteralPath $apk)) { throw 'Gradle completed without creating app-upgrade.apk.' }
$upgradeDigest = Get-CertificateDigest $apk $signer
if ($upgradeDigest -ne $oldDigest) {
    throw 'The migration APK signer does not match the preserved legacy APK. It was not copied for delivery.'
}

$delivery = Join-Path $pocketRoot 'delivery\migration'
New-Item -ItemType Directory -Force -Path $delivery | Out-Null
$destination = Join-Path $delivery '留一笔-2.0.0-旧debug版数据迁移.apk'
Copy-Item -LiteralPath $apk -Destination $destination -Force
Write-Output "Legacy data migration APK ready: $destination"
Write-Output "Verified matching legacy signer SHA-256: $upgradeDigest"
