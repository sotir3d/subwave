[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Subwave\EchoTTS'),
    [string]$DefaultVoice = '',
    [int]$CudaDevice = 1,
    [int]$ListenPort = 5001,
    [string]$ListenAddress = '0.0.0.0'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $env:LOCALAPPDATA -and $InstallRoot -like '*Subwave*EchoTTS*') {
    throw 'LOCALAPPDATA is unavailable; pass an explicit -InstallRoot.'
}

$echoRoot = Join-Path $InstallRoot 'echo-tts'
$venvPython = Join-Path $InstallRoot 'venv\Scripts\python.exe'
$voiceRoot = Join-Path $InstallRoot 'voices'
$cacheRoot = Join-Path $InstallRoot 'hf-cache'
$bridge = Join-Path $PSScriptRoot 'server.py'

if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "Echo-TTS virtual environment is missing. Run setup.ps1 first: $venvPython"
}
if (-not (Test-Path -LiteralPath (Join-Path $echoRoot 'inference.py'))) {
    throw "Echo-TTS checkout is missing. Run setup.ps1 first: $echoRoot"
}
if (-not (Test-Path -LiteralPath $bridge)) {
    throw "SUB/WAVE Echo bridge is missing: $bridge"
}

New-Item -ItemType Directory -Force -Path $voiceRoot, $cacheRoot | Out-Null

# CUDA_VISIBLE_DEVICES makes the selected physical card logical cuda:0 inside
# this process, leaving the other 3090 available to llama.cpp.
$env:CUDA_VISIBLE_DEVICES = [string]$CudaDevice
$env:ECHO_TTS_DEVICE = 'cuda'
$env:ECHO_TTS_REPO = (Resolve-Path -LiteralPath $echoRoot).Path
$env:ECHO_TTS_VOICE_DIR = (Resolve-Path -LiteralPath $voiceRoot).Path
$env:ECHO_TTS_DEFAULT_VOICE = $DefaultVoice
$env:ECHO_TTS_LISTEN_ADDRESS = $ListenAddress
$env:ECHO_TTS_PORT = [string]$ListenPort
$env:HF_HOME = $cacheRoot

Write-Host "Starting Echo-TTS on physical CUDA device $CudaDevice"
Write-Host "Listening on http://${ListenAddress}:$ListenPort"
Write-Host "Voices: $voiceRoot"
if (-not $DefaultVoice) {
    Write-Host 'No default voice was supplied; /speak must name a voice unless exactly one voice file exists.'
}

& $venvPython $bridge
exit $LASTEXITCODE

