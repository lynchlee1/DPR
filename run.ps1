$ErrorActionPreference = "Stop"

$ProjectDir = $PSScriptRoot
$AppUrl = "http://127.0.0.1:8765"
Set-Location $ProjectDir

try {
    $Health = Invoke-RestMethod -Uri "$AppUrl/api/health" -TimeoutSec 2
    if ($Health.ok) {
        Write-Host "PhotoSorter is already running. Opening the existing window."
        Start-Process $AppUrl
        exit 0
    }
} catch {
    # No existing app is listening; continue with startup.
}

. "$ProjectDir\scripts\bootstrap-windows.ps1"
Initialize-PythonEnvironment -EnvironmentDir "$ProjectDir\.venv" -RequirementsFile "$ProjectDir\requirements.txt"
Push-Location frontend
try {
    npm ci --silent
    npm run build --silent
} finally {
    Pop-Location
}

$env:PYTHONPATH = Join-Path $ProjectDir "src"
& "$ProjectDir\.venv\Scripts\python.exe" -m photo_sorter.server
