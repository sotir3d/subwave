[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Subwave\EchoTTS'),
    [string]$PythonLauncher = 'py'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $env:LOCALAPPDATA -and $InstallRoot -like '*Subwave*EchoTTS*') {
    throw 'LOCALAPPDATA is unavailable; pass an explicit -InstallRoot.'
}

$echoRoot = Join-Path $InstallRoot 'echo-tts'
$venvRoot = Join-Path $InstallRoot 'venv'
$venvPython = Join-Path $venvRoot 'Scripts\python.exe'
$voiceRoot = Join-Path $InstallRoot 'voices'
$cacheRoot = Join-Path $InstallRoot 'hf-cache'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is required and was not found on PATH.'
}
if (-not (Get-Command $PythonLauncher -ErrorAction SilentlyContinue)) {
    throw "Python launcher '$PythonLauncher' was not found. Install Python 3.11 first."
}

$launcherName = [System.IO.Path]::GetFileNameWithoutExtension($PythonLauncher)
$launcherArgs = if ($launcherName -eq 'py') { @('-3.11') } else { @() }
$pythonVersion = & $PythonLauncher @launcherArgs -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ($LASTEXITCODE -ne 0) {
    throw 'Python 3.11 could not be started. Install it and re-run setup.'
}
if ($pythonVersion.Trim() -ne '3.11') {
    throw "Echo-TTS must use the dedicated Python 3.11 environment; found $($pythonVersion.Trim())."
}

New-Item -ItemType Directory -Force -Path $InstallRoot, $voiceRoot, $cacheRoot | Out-Null

if (-not (Test-Path -LiteralPath $echoRoot)) {
    Write-Host 'Cloning the official Echo-TTS inference repository...'
    & git clone --depth 1 https://github.com/jordandare/echo-tts.git $echoRoot
    if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
} elseif (-not (Test-Path -LiteralPath (Join-Path $echoRoot 'inference.py'))) {
    throw "The existing directory is not an Echo-TTS checkout: $echoRoot"
} else {
    Write-Host "Using the existing Echo-TTS checkout at $echoRoot"
    Write-Host 'It was not updated automatically; run git pull there when you intentionally want an upstream update.'
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host 'Creating a Python 3.11 virtual environment...'
    & $PythonLauncher @launcherArgs -m venv $venvRoot
    if ($LASTEXITCODE -ne 0) { throw 'Python virtual-environment creation failed' }
}

Write-Host 'Installing Echo-TTS dependencies. This can download several gigabytes...'
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'pip upgrade failed' }
& $venvPython -m pip install -r (Join-Path $echoRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Echo-TTS dependency installation failed' }

Write-Host ''
Write-Host 'Echo-TTS environment installed.'
Write-Host "Reference voices: $voiceRoot"
Write-Host 'Copy a clean 5-15 second narrator WAV there, then start the bridge with:'
Write-Host '  powershell -ExecutionPolicy Bypass -File .\run.ps1 -DefaultVoice narrator.wav -CudaDevice 1'
Write-Host 'The Echo model weights download into the persistent cache on first launch.'
