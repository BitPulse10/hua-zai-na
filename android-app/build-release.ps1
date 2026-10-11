param([switch]$Offline)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$cacheRoot = Join-Path $projectRoot '.build-cache'
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

$signingConfig = Join-Path $projectRoot 'signing.properties'
$externalSigningReady = @(
    $env:LIUYIBI_RELEASE_STORE_FILE,
    $env:LIUYIBI_RELEASE_STORE_PASSWORD,
    $env:LIUYIBI_RELEASE_KEY_ALIAS,
    $env:LIUYIBI_RELEASE_KEY_PASSWORD
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
if (-not (Test-Path -LiteralPath $signingConfig) -and $externalSigningReady.Count -ne 4) {
    & (Join-Path $projectRoot 'setup-release-signing.ps1')
    if (-not (Test-Path -LiteralPath $signingConfig)) { throw 'Release signing setup failed.' }
}

$gradle = Join-Path $cacheRoot 'gradle-8.11.1\bin\gradle.bat'
if (-not (Test-Path -LiteralPath $gradle)) { $gradle = Join-Path $projectRoot 'gradlew.bat' }
if (-not (Test-Path -LiteralPath $gradle)) { throw 'Gradle was not found. Run the Android project wrapper setup first.' }

$env:ANDROID_USER_HOME = Join-Path $cacheRoot 'android-user'
$env:GRADLE_USER_HOME = Join-Path $cacheRoot 'gradle-home'
$buildTools = Get-ChildItem -LiteralPath (Join-Path $androidSdk 'build-tools') -Directory -ErrorAction SilentlyContinue |
    Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'aapt2.exe') } |
    Select-Object -First 1

$gradleArguments = @('--no-daemon')
if ($Offline) { $gradleArguments += '--offline' }
if ($buildTools) {
    $gradleArguments += "-Pandroid.aapt2FromMavenOverride=$(Join-Path $buildTools.FullName 'aapt2.exe')"
}
$gradleArguments += 'assembleRelease'
Push-Location $projectRoot
try {
    & $gradle @gradleArguments
    if ($LASTEXITCODE -ne 0) { throw 'Release APK build failed.' }
} finally {
    Pop-Location
}

$apk = Join-Path $projectRoot 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path -LiteralPath $apk)) { throw 'Gradle completed without creating app-release.apk.' }
$signer = Get-ChildItem -LiteralPath (Join-Path $androidSdk 'build-tools') -Directory |
    Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending |
    ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if (-not $signer) { throw 'apksigner was not found in the configured Android SDK build-tools.' }

$verification = & $signer verify --verbose --print-certs $apk 2>&1
if ($LASTEXITCODE -ne 0) {
    $verification | ForEach-Object { Write-Output $_ }
    throw 'Release APK signature verification failed.'
}

$delivery = Join-Path (Split-Path -Parent $projectRoot) 'delivery'
New-Item -ItemType Directory -Force -Path $delivery | Out-Null
$destination = Join-Path $delivery 'hua-zai-na-2.0.2.apk'
Copy-Item -LiteralPath $apk -Destination $destination -Force
Write-Output "Signed release APK ready: $destination"
$verification | ForEach-Object { Write-Output $_ }
