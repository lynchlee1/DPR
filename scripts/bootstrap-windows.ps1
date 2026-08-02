$ToolsDir = Join-Path $ProjectDir ".tools"
$UvVersion = "0.12.1"
$NodeVersion = "22.23.2"
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($Architecture) {
    "X64" {
        $UvPlatform = "x86_64-pc-windows-msvc"
        $UvExpectedHash = "8fcb0cb46e1229065e344758980924e569bef5882ef45f46fada8fb24e06b74a"
        $NodePlatform = "win-x64"
        $NodeExpectedHash = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
    }
    "Arm64" {
        $UvPlatform = "aarch64-pc-windows-msvc"
        $UvExpectedHash = "9bc7c18e616230fa2dc6fb24bc3afde18a95c2b5c9433de747e9502c66041568"
        $NodePlatform = "win-arm64"
        $NodeExpectedHash = "fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3"
    }
    default { throw "지원하지 않는 Windows CPU입니다: $Architecture" }
}

$UvExe = Join-Path $ToolsDir "uv\uv.exe"
if (-not (Test-Path $UvExe)) {
    Write-Host "내장 Python 관리 도구를 내려받는 중입니다..."
    $UvArchive = "uv-$UvPlatform.zip"
    $UvDownload = Join-Path $ToolsDir $UvArchive
    Invoke-WebRequest "https://github.com/astral-sh/uv/releases/download/$UvVersion/$UvArchive" -OutFile $UvDownload
    $ActualHash = (Get-FileHash -Algorithm SHA256 $UvDownload).Hash
    if ($ActualHash -ne $UvExpectedHash) {
        throw "uv 다운로드 파일의 SHA-256 검증에 실패했습니다."
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $UvExe) | Out-Null
    Expand-Archive -Path $UvDownload -DestinationPath (Split-Path $UvExe) -Force
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $ToolsDir "python"
$env:UV_CACHE_DIR = Join-Path $ToolsDir "cache"

$NodeArchive = "node-v$NodeVersion-$NodePlatform.zip"
$NodeHome = Join-Path $ToolsDir "node-v$NodeVersion-$NodePlatform"
$NodeExe = Join-Path $NodeHome "node.exe"
if (-not (Test-Path $NodeExe)) {
    Write-Host "내장 프런트엔드 빌드 도구를 내려받는 중입니다..."
    $NodeDownload = Join-Path $ToolsDir $NodeArchive
    Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$NodeArchive" -OutFile $NodeDownload
    $ActualHash = (Get-FileHash -Algorithm SHA256 $NodeDownload).Hash
    if ($ActualHash -ne $NodeExpectedHash) {
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
