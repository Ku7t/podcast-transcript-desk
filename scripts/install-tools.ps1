$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BinDir = Join-Path $ProjectRoot ".tools\bin"
$YtDlpExe = Join-Path $BinDir "yt-dlp.exe"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Write-Host "Installing yt-dlp to $YtDlpExe"
Invoke-WebRequest `
  -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" `
  -OutFile $YtDlpExe `
  -UseBasicParsing

if (-not (Test-Path (Join-Path $ProjectRoot "node_modules\ffmpeg-static"))) {
  Write-Host "Installing ffmpeg-static into node_modules"
  Push-Location $ProjectRoot
  try {
    npm install
  } finally {
    Pop-Location
  }
}

Write-Host "Verifying local tools"
& $YtDlpExe --version
node (Join-Path $ProjectRoot "scripts\check-tools.js")
