$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$BuildRoot = Join-Path $ProjectRoot '.build-cache'
$SdkRoot = Join-Path $BuildRoot 'sdk'
$env:ANDROID_USER_HOME = Join-Path $BuildRoot 'android-user'
$DownloadRoot = Join-Path $BuildRoot 'downloads'
$GradleVersion = '8.11.1'
$CommandToolsZip = Join-Path $DownloadRoot 'commandlinetools-win.zip'
$GradleZip = Join-Path $DownloadRoot "gradle-$GradleVersion-bin.zip"

New-Item -ItemType Directory -Force -Path $DownloadRoot | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'))) {
    $toolsUrl = 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip'
    Invoke-WebRequest -Uri $toolsUrl -OutFile $CommandToolsZip
    $toolsHash = (Get-FileHash -LiteralPath $CommandToolsZip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($toolsHash -ne '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a') {
        throw "Android command-line tools SHA-256 did not match Google's published checksum."
    }
    $unpackRoot = Join-Path $BuildRoot 'tools-unpacked'
    Expand-Archive -LiteralPath $CommandToolsZip -DestinationPath $unpackRoot -Force
    $latestRoot = Join-Path $SdkRoot 'cmdline-tools\latest'
    New-Item -ItemType Directory -Force -Path $latestRoot | Out-Null
    Copy-Item -Path (Join-Path $unpackRoot 'cmdline-tools\*') -Destination $latestRoot -Recurse -Force
}

if (-not (Test-Path -LiteralPath (Join-Path $BuildRoot "gradle-$GradleVersion\bin\gradle.bat"))) {
    $gradleUrl = "https://services.gradle.org/distributions/gradle-$GradleVersion-bin.zip"
    if (-not (Test-Path -LiteralPath $GradleZip) -or (Get-Item -LiteralPath $GradleZip).Length -eq 0) {
        Invoke-WebRequest -Uri $gradleUrl -OutFile $GradleZip
    }
    $gradleHashFile = Join-Path $DownloadRoot "gradle-$GradleVersion-bin.zip.sha256"
    if (-not (Test-Path -LiteralPath $gradleHashFile)) { Invoke-WebRequest -Uri "$gradleUrl.sha256" -OutFile $gradleHashFile }
    $expectedGradleHash = (Get-Content -LiteralPath $gradleHashFile -Raw).Trim().ToLowerInvariant()
    $actualGradleHash = (Get-FileHash -LiteralPath $GradleZip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualGradleHash -ne $expectedGradleHash) { throw "Gradle distribution SHA-256 did not match Gradle's published checksum." }
    Expand-Archive -LiteralPath $GradleZip -DestinationPath $BuildRoot -Force
}

$sdkmanager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
$licenseAnswers = 1..60 | ForEach-Object { 'y' }
$licenseAnswers | & $sdkmanager "--sdk_root=$SdkRoot" --licenses
if ($LASTEXITCODE -ne 0) { throw 'Android SDK license setup failed.' }

& $sdkmanager "--sdk_root=$SdkRoot" 'platforms;android-35' 'build-tools;35.0.0'
if ($LASTEXITCODE -ne 0) { throw 'Android SDK platform/build-tools installation failed.' }

$sdkPathForProperties = $SdkRoot.Replace('\', '\\')
Set-Content -LiteralPath (Join-Path $ProjectRoot 'local.properties') -Value "sdk.dir=$sdkPathForProperties" -Encoding ascii
$gradle = Join-Path $BuildRoot "gradle-$GradleVersion\bin\gradle.bat"
Push-Location $ProjectRoot
try {
    if (-not (Test-Path -LiteralPath '.\gradlew.bat')) {
        & $gradle wrapper --gradle-version $GradleVersion --distribution-type bin --no-validate-url
        if ($LASTEXITCODE -ne 0) { throw 'Gradle wrapper generation failed.' }
    }
    $env:GRADLE_USER_HOME = Join-Path $BuildRoot 'gradle-home'
    & $gradle --no-daemon assembleDebug
    if ($LASTEXITCODE -ne 0) { throw 'Android APK build failed.' }
} finally { Pop-Location }

$apk = Join-Path $ProjectRoot 'app\build\outputs\apk\debug\app-debug.apk'
$delivery = Join-Path (Split-Path -Parent $ProjectRoot) 'Liuyibi-Android.apk'
$apksigner = Join-Path $SdkRoot 'build-tools\35.0.0\apksigner.bat'
& $apksigner verify --verbose $apk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
Copy-Item -LiteralPath $apk -Destination $delivery -Force
Write-Output "APK ready: $delivery"
