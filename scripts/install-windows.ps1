param(
  [switch]$Start,
  [switch]$SkipBrowser
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js was not found. Install Node.js 20+ for Windows first, then run this script again."
}

$platform = node -p "process.platform"
if ($platform -ne "win32") {
  throw "This installer is intended for Windows/PowerShell. In WSL/Linux, use: bash scripts/install-wsl.sh"
}

$nodeMajor = [int](node -p "Number(process.versions.node.split('.')[0])")
if ($nodeMajor -lt 20) {
  throw "Node.js 20+ is required. Current version: $(node -v)"
}

Write-Host ""
Write-Host "AgentProxy Windows quick install"
Write-Host "Project: $RootDir"
Write-Host ""

npm install

if (-not $SkipBrowser) {
  npx playwright install chromium
}

npm run build
npm link

Write-Host ""
Write-Host "AgentProxy installed for Windows/PowerShell."
Write-Host "Try: proxy status"
Write-Host "Config and browser profiles will live in: $env:USERPROFILE\.agentproxy"

if ($Start) {
  Write-Host ""
  Write-Host "Starting Hermes profile..."
  proxy hermes
}
