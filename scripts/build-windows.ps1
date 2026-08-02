$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir
. "$PSScriptRoot\bootstrap-windows.ps1"

Initialize-PythonEnvironment -EnvironmentDir "$ProjectDir\.venv-build" -RequirementsFile "$ProjectDir\requirements-build.txt"
Push-Location frontend
try {
    npm ci --silent
    npm audit --audit-level=low
    npm run build --silent
} finally {
    Pop-Location
}

& $UvExe tool run pip-audit==2.10.1 --requirement requirements.txt
& ".venv-build\Scripts\python.exe" -m pytest -q
& ".venv-build\Scripts\python.exe" -m PyInstaller `
    --noconfirm `
    --clean `
    --windowed `
    --name PhotoSorter `
    --paths src `
    --add-data "frontend/dist;frontend/dist" `
    packaging/entrypoint.py

$ArchivePath = Join-Path $ProjectDir "dist\PhotoSorter-Windows.zip"
if (Test-Path $ArchivePath) {
    Remove-Item $ArchivePath
}
Compress-Archive -Path "dist\PhotoSorter" -DestinationPath $ArchivePath

Write-Host "Build complete: $ArchivePath"
