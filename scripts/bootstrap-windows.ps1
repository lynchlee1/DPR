$ToolsDir = Join-Path $ProjectDir ".tools"
$UvVersion = "0.12.1"
$NodeVersion = "22.23.2"
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

$UvExe = Join-Path $ToolsDir "uv\uv.exe"
if (-not (Test-Path $UvExe)) {
    Write-Host "내장 Python 관리 도구를 내려받는 중입니다..."
    $env:UV_UNMANAGED_INSTALL = Join-Path $ToolsDir "uv"
    $env:UV_NO_MODIFY_PATH = "1"
    $Installer = Invoke-RestMethod "https://astral.sh/uv/$UvVersion/install.ps1"
    Invoke-Expression $Installer
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $ToolsDir "python"
$env:UV_CACHE_DIR = Join-Path $ToolsDir "cache"

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($Architecture) {
    "X64" { $NodePlatform = "win-x64" }
    "Arm64" { $NodePlatform = "win-arm64" }
    default { throw "지원하지 않는 Windows CPU입니다: $Architecture" }
}

$NodeArchive = "node-v$NodeVersion-$NodePlatform.zip"
$NodeHome = Join-Path $ToolsDir "node-v$NodeVersion-$NodePlatform"
$NodeExe = Join-Path $NodeHome "node.exe"
if (-not (Test-Path $NodeExe)) {
    Write-Host "내장 프런트엔드 빌드 도구를 내려받는 중입니다..."
    $NodeDownload = Join-Path $ToolsDir $NodeArchive
    $Checksums = Join-Path $ToolsDir "SHASUMS256.txt"
    Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$NodeArchive" -OutFile $NodeDownload
    Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $Checksums

    $ChecksumLine = Get-Content $Checksums | Where-Object { $_ -match " $([regex]::Escape($NodeArchive))$" } | Select-Object -First 1
    if (-not $ChecksumLine) {
        throw "Node.js 체크섬 목록에서 다운로드 파일을 찾을 수 없습니다."
    }
    $ExpectedHash = ($ChecksumLine -split "\s+")[0]
    $ActualHash = (Get-FileHash -Algorithm SHA256 $NodeDownload).Hash
    if (-not $ExpectedHash -or $ActualHash -ne $ExpectedHash) {
        throw "Node.js 다운로드 파일의 SHA-256 검증에 실패했습니다."
    }
    Expand-Archive -Path $NodeDownload -DestinationPath $ToolsDir -Force
}

$env:PATH = "$NodeHome;$env:PATH"

function Initialize-PythonEnvironment {
    param(
        [Parameter(Mandatory = $true)][string]$EnvironmentDir,
        [Parameter(Mandatory = $true)][string]$RequirementsFile
    )

    & $UvExe python install 3.13 --no-bin
    $EnvironmentPython = Join-Path $EnvironmentDir "Scripts\python.exe"
    if (-not (Test-Path $EnvironmentPython)) {
        & $UvExe venv --python 3.13 $EnvironmentDir
    }
    & $UvExe pip install --quiet --python $EnvironmentPython --requirements $RequirementsFile
}
