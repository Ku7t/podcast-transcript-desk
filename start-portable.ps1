$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ProjectRoot ".env"
$ExampleFile = Join-Path $ProjectRoot ".env.example"

if (-not (Test-Path $EnvFile)) {
  Copy-Item -LiteralPath $ExampleFile -Destination $EnvFile
  Write-Host "Created .env from .env.example. Fill SILICONFLOW_API_KEY in .env, then run this script again."
  exit 1
}

Push-Location $ProjectRoot
try {
  npm start
} finally {
  Pop-Location
}
