# Windows·macOS 빌드 안내

이 프로젝트는 React 프런트엔드를 먼저 정적 파일로 만든 뒤, Python 백엔드와 함께 PyInstaller 배포본으로 묶습니다. PyInstaller 결과물은 운영체제별이므로 macOS 앱은 macOS에서, Windows 실행 파일은 Windows에서 각각 빌드해야 합니다.

## 준비물

Python, Node.js, npm 또는 별도 패키지 관리자를 미리 설치할 필요가 없습니다. 실행·빌드 스크립트가 검증된 버전의 도구를 프로젝트 내부 `.tools`에 내려받고, Python 3.13 환경도 자동으로 준비합니다. 시스템 전역 프로그램이나 설정은 변경하지 않습니다.

최초 실행에는 인터넷 연결이 필요합니다. macOS는 운영체제에 포함된 셸과 `curl`, Windows는 PowerShell을 사용합니다. 이후에는 내려받은 도구를 재사용합니다.

경로에 한글이나 공백이 있어도 빌드 스크립트가 처리합니다. 저장소를 내려받은 뒤 프로젝트 루트에서 아래 명령을 실행합니다.

## macOS

개발용으로 바로 실행:

```bash
./run.command
```

배포 앱 빌드:

```bash
./scripts/build-macos.command
```

테스트와 프런트엔드 빌드가 모두 성공하면 `dist/PhotoSorter.app`과 배포용 `dist/PhotoSorter-macOS.zip`이 생성됩니다. ZIP을 푼 뒤 Finder에서 앱을 더블 클릭해 실행할 수 있습니다. ZIP은 앱의 실행 권한과 macOS 메타데이터를 보존합니다.

서명하지 않은 로컬 빌드를 다른 Mac으로 복사하면 Gatekeeper 경고가 나타날 수 있습니다. 개인 테스트라면 Finder에서 앱을 Control-클릭한 뒤 `열기`를 선택합니다. 외부 배포용이라면 Apple Developer ID로 코드 서명하고 공증해야 합니다.

Apple Silicon에서 만든 앱은 Apple Silicon용이고 Intel Mac에서 만든 앱은 Intel용입니다. 두 아키텍처를 모두 배포하려면 각 환경에서 별도로 빌드해 제공하는 것이 가장 확실합니다.

## Windows

개발용으로 바로 실행:

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1
```

배포 실행 파일 빌드:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
```

완료되면 `dist\PhotoSorter\PhotoSorter.exe`와 배포용 `dist\PhotoSorter-Windows.zip`이 생성됩니다. `PhotoSorter` 폴더 전체가 배포 단위이므로 `.exe`만 따로 옮기면 안 됩니다. 다른 PC에는 ZIP 전체를 전달하고 압축을 푼 뒤 실행합니다.

서명하지 않은 실행 파일은 다른 PC에서 Microsoft Defender SmartScreen 경고가 나타날 수 있습니다. 외부 배포용이라면 신뢰할 수 있는 코드 서명 인증서로 실행 파일에 서명해야 합니다.

## GitHub에서 설치 파일 바로 배포

`.github/workflows/build-desktop.yml`은 버전 태그(`v1.0.0` 같은 형식)를 푸시하면 macOS와 Windows 빌드를 각각 수행하고, GitHub Releases에 다음 파일을 자동 첨부합니다.

- `PhotoSorter-macOS.zip`
- `PhotoSorter-Windows.zip`

최종 사용자는 저장소의 **Releases** 페이지에서 운영체제에 맞는 ZIP만 받으면 됩니다. 프로젝트 코드, Python, Node.js를 내려받을 필요가 없습니다.

공개 저장소라면 GitHub 로그인 없이 받을 수 있습니다. 비공개 저장소라면 해당 저장소에 접근할 수 있는 GitHub 계정으로 로그인해야 합니다.

새 버전을 배포하는 명령은 다음과 같습니다.

```bash
git tag v1.0.0
git push origin v1.0.0
```

Actions 화면에서 수동 실행한 빌드는 공개 Release를 만들지 않고, 실행 화면의 Artifacts에만 결과를 남깁니다. 먼저 수동 빌드로 확인한 다음 버전 태그를 푸시할 수 있습니다.

워크플로는 코드 서명과 공증을 수행하지 않습니다. 공개 배포 시에는 인증서와 비밀키를 저장소의 Actions secrets에 등록한 뒤 별도 서명 단계를 추가해야 합니다.

## 빌드가 하는 일

1. 프로젝트 내부에 uv와 Node.js를 다운로드하고, 코드에 고정된 SHA-256으로 두 파일 검증
2. uv가 독립된 Python 3.13과 `.venv-build` 환경 준비
3. 고정된 Python 빌드 의존성 설치
4. `npm ci`로 잠금 파일과 정확히 일치하는 프런트엔드 의존성 설치
5. Python·npm 의존성의 알려진 보안 취약점 검사
6. 프런트엔드 프로덕션 빌드와 Python 테스트 실행
7. Python 런타임까지 포함한 데스크톱 배포본으로 패키징

생성된 `.tools`, `.venv-build`, `build`, `dist`는 Git 추적 대상이 아닙니다. 완전한 재빌드가 필요하면 이 폴더들을 지운 뒤 빌드 스크립트를 다시 실행하면 됩니다.

## 최종 사용자에게 필요한 것

최종 사용자는 Python이나 Node.js를 설치하지 않습니다.

- macOS: `PhotoSorter-macOS.zip`을 풀고 `PhotoSorter.app` 실행
- Windows: `PhotoSorter-Windows.zip`을 풀고 `PhotoSorter\PhotoSorter.exe` 실행

두 결과물 모두 Python 런타임과 앱 의존성을 포함합니다. 최초 앱 실행 자체에도 인터넷 연결은 필요하지 않습니다.
