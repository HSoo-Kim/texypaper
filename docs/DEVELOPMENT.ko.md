# 개발 가이드

[English](DEVELOPMENT.md) · **한국어**

소스에서 빌드하고, 검증 스크립트를 실행하고, 이전 Paperdock 데이터를 옮기는 방법을 정리한 문서입니다. 사용 방법은 [README](../README.ko.md), 내부 구조는 [ARCHITECTURE.md](ARCHITECTURE.md), 실행으로 확인한 범위는 [VERIFICATION.md](VERIFICATION.md)를 보세요.

## 준비물

Windows PowerShell에서 저장소 루트를 작업 디렉터리로 사용합니다. Node.js(이 구현 환경의 기준은 24.x), `pnpm@12.16.1`, Rust edition 2024를 지원하는 MSVC 도구체인, Visual Studio C++ Build Tools/Windows SDK와 WebView2가 필요합니다. 정확한 JS/Rust 의존성은 두 lockfile이 기준입니다. 아래 명령은 도구가 이미 준비되었다는 전제이며 전역 설치 명령을 포함하지 않습니다.

```powershell
pnpm install --frozen-lockfile
pnpm dev -- -- --data-dir "$env:TEMP\texypaper-dev-isolated"
```

위 개발 실행은 보이는 앱 창을 엽니다. 사용자의 허가 없이 백그라운드 작업에서 실행하지 마세요. Debug 실행은 기본 사용자 profile을 열지 못하며 명시적 `--data-dir`이 필요합니다. 개발용 경로에는 실제 사용자 설정·계정 저장소를 지정하지 마세요. `pnpm dev:web`은 프런트엔드 개발 서버만 실행합니다. 브라우저 탭만 열어서는 native 파일/SSH/프로세스 명령을 사용할 수 없습니다.

## 빌드와 패키징

개별 검사와 Windows x64 NSIS 빌드:

```powershell
pnpm build
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

`pnpm typecheck`는 타입 검사만 합니다. 전체 빌드 스크립트는 외부 명령마다 종료 코드를 확인하며 실패 시 중단합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-build.ps1
```

실행 파일은 `src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe`, NSIS 패키지는 같은 release 아래 `bundle/nsis/TexyPaper_0.0.4_x64-setup.exe`에 생성하도록 구성되어 있습니다. `CARGO_TARGET_DIR`을 지정하면 그 경로를 사용합니다. 실제 생성 여부와 설치 결과는 별도로 확인해야 합니다.

```powershell
$app = (Resolve-Path 'src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe').Path
& $app --data-dir 'C:\TexyPaperData\isolated-session' --open 'C:\Papers\my-paper'
```

`--data-dir`은 설정·복구·WebView2·Codex 로그인까지 분리합니다. 다른 data-dir에서 로그인했다고 현재 저장소가 인증된 것은 아닙니다. `--open`은 로컬 프로젝트를 실제 production 경로 검증을 거쳐 엽니다.

배포 빌드 시 `TEXYPAPER_UPDATE_FEED_URL` 환경 변수로 기본 업데이트 피드를 넣을 수 있습니다. 이는 **컴파일 시점** 설정이며, 저장된 `updates.feedUrl`이 있으면 그 값이 우선합니다. 저장된 빈 문자열도 자동으로 운영 주소가 되지 않습니다.

## 실제 앱 smoke와 메모리 측정

**사용자 논문을 테스트 입력으로 쓰지 마세요. 아래 smoke·메모리 명령은 실제로 보이는 앱 창을 실행하며, 실행 전에 사용자의 명시적 허가가 필요합니다. 백그라운드 전용 작업에서는 실행하지 마세요.** 트레이·마우스 자동화는 기존 `--headed`/`-Headed` 안전 게이트도 통과해야 합니다. 일반 suite는 headless 도구가 아닙니다. 스크립트는 합성 fixture를 만들며 실제 release exe와 WebView2 CDP에 연결합니다. 매 실행마다 기존 결과가 없는 새로운 **ASCII 경로**를 `--output`에 지정하세요. fixture 생성기를 smoke 출력 폴더에 미리 실행하지 마세요. smoke가 자체 fixture 하위 폴더를 생성합니다.

```powershell
$app = (Resolve-Path 'src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe').Path
$run = Join-Path $env:TEMP ('texypaper-evidence-' + [guid]::NewGuid().ToString('N'))

pnpm smoke:preferences --binary $app --output (Join-Path $run 'preferences')
pnpm smoke:usability --binary $app --output (Join-Path $run 'usability')
pnpm smoke:desktop --binary $app --output (Join-Path $run 'desktop')
pnpm smoke:ssh --binary $app --output (Join-Path $run 'ssh')
pnpm smoke:agents --binary $app --live --auth-timeout-seconds 600 --output (Join-Path $run 'agents')
pnpm measure:memory -AppPath $app -DurationSeconds 120 -Provider codex -AuthenticationTimeoutSeconds 600 -OutputDirectory (Join-Path $run 'memory')
```

메모리의 `-OutputDirectory`는 **존재하지 않는 디렉터리**여야 합니다. `--live` 없이 에이전트 성공으로 처리하지 않으며 로그인 대기 시간은 로그인을 대신하지 않습니다. 필요한 공식 인증 창을 직접 완료하세요. 재사용할 인증 데이터가 필요하면 정상 사용자 app-data가 아닌 smoke 전용 저장소를 쓰세요. 에이전트 smoke는 `--data-dir`, 메모리 측정은 `-AuthenticationDataDirectory`를 받습니다.

표준 메모리 판정은 실제 Windows 디스플레이 배율 100%에서 수행합니다. 현재 배율을 바꾸지 않고 진단 수치만 수집하려면 `-AllowNonstandardDisplayScale`을 명시하세요. 이 옵션은 OS 설정을 변경하지 않으며, 실제 배율이 100%가 아니면 나머지 측정이 끝나도 표준 판정과 전체 결과는 실패로 남습니다. CDP의 2× 렌더러 에뮬레이션은 실제 Windows 배율 측정으로 표시하지 않습니다.

설치까지 검사하려면 생성한 NSIS 실행 파일을 정확히 지정합니다. 기존 TexyPaper 설치가 있으면 격리 설치 검사는 덮어쓰지 않고 거부합니다.

```powershell
pnpm smoke:desktop --binary $app --installer 'C:\Builds\TexyPaper_0.0.4_x64-setup.exe' --output (Join-Path $run 'installer-desktop')
```

위 설치 파일 경로는 사용자가 실제 생성한 파일로 바꾸어야 하는 입력 예시입니다. 다음 통합 실행도 보이는 앱 창을 실행하므로 사용자 허가가 필요하며, 설치된 도구와 이름이 정확히 `TexyPaper_0.0.4_x64-setup.exe`인 NSIS 산출물을 요구합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-build.ps1 -RunSmoke -LiveAgents -MeasureMemory -OutputDirectory (Join-Path $env:TEMP ('texypaper-full-' + [guid]::NewGuid().ToString('N')))
```

SSH smoke는 개발 전용 `ssh2`로 loopback SSH와 ProxyJump 호스트를 만들고 **WSL `Ubuntu-24.04`의 실제 Python/TeX worker**를 실행합니다. Windows `ssh.exe`·`ssh-keygen.exe`, WSL 배포판, Linux의 Python ≥3.9·latexmk·pdfLaTeX·SyncTeX가 필요합니다. 다른 등록 배포판은 `--distribution`으로 지정할 수 있습니다. 누락된 도구를 자동 설치하거나 로컬 빌드를 원격 빌드로 치환하지 않습니다. CDP가 보안 정책에 막히면 그 차단을 해결해야 하며 컴포넌트 테스트를 실제 UI 증거로 대체하지 않습니다.

fixture만 만들려면 별도의 새 디렉터리를 사용합니다.

```powershell
node scripts/create-smoke-fixtures.mjs --output (Join-Path $env:TEMP ('texypaper-fixtures-' + [guid]::NewGuid().ToString('N')))
```

저메모리 설계는 단일 editor·PDF document/worker, 최대 3개 canvas, 깨끗한 비활성 editor state 최대 8개/소스 cache 8MiB 등을 사용합니다. **앱+전용 WebView2의 private working set 최대 300MiB는 측정 목표이지 하드 한도가 아닙니다.** 리브랜딩 이전 개발 빌드의 Windows 배율 125% 측정에서는 표준 작업 최대 282.7MiB, 20회 전환 후 같은 상태 증가 12.0MiB였습니다. 이는 현재 TexyPaper나 분리 채팅 창을 포함한 최신 빌드의 측정값이 아니며, 100% 배율 표준 판정도 아닙니다([VERIFICATION.md](VERIFICATION.md)의 이전 기준선). 메모리 스크립트는 워밍업 후 120초 동안 1초 간격 표본, 반복 전환과 별도 high-DPI/실제 AI 단계를 수행하며 TeX·SSH·AI 프로세스를 별도 항목과 전체 합계로 보고합니다. commit을 private working set으로 바꾸어 보고하지 않으며 원격 호스트 비용을 0으로 간주하지 않습니다.

## Mac 개발자에게 소스 넘기기

같은 [저장소](https://github.com/HSoo-Kim/texypaper)의 소스와 두 lockfile, `THIRD_PARTY_NOTICES.md` 및 `licenses/`를 함께 전달하세요. 사용자 profile, 인증 정보, 논문·복구 내용이나 기존 smoke 산출물을 소스에 섞지 마세요. 소스의 Node/pnpm/Rust 버전을 맞춘 뒤 Windows 전용 프로세스·OpenSSH·WebView·트레이 경계부터 별도로 검토해야 합니다. `scripts/windows-build.ps1`과 Windows NSIS/exe는 Mac용 빌드 경로가 아닙니다. 현재 macOS 빌드 명령·성공 결과·DMG는 제공하지 않습니다.

## 이전 Paperdock 데이터의 일회성 이전

- 먼저 이전 앱을 **트레이의 종료**로 완전히 닫으세요. 이전 소프트웨어는 새 잠금 규약을 따르지 않으므로 두 앱이 같은 프로젝트를 동시에 쓰는 상황의 원자성을 보장하지 않습니다.
- 기본 사용자 profile은 `%APPDATA%\dev.paperdock.desktop`만 있고 새 `%APPDATA%\dev.texypaper.desktop`이 없을 때 디렉터리 자체를 이동합니다. 설정·최근 프로젝트·복구·대화·공급자 저장소를 개별 복사하지 않으며, 인증 파일이나 토큰 내용을 읽거나 복사하지 않습니다. 실행 중인 이전 profile 잠금, 양쪽 디렉터리의 동시 존재, symlink/reparse 경로는 명시적 오류로 중단합니다. 사용자가 `--data-dir`을 지정하면 이 기본 profile 이전을 수행하지 않습니다.
- 로컬 및 SSH 프로젝트는 새 `.texypaper`가 없을 때만 이전 `.paperdock` 디렉터리를 이름 변경합니다. 두 디렉터리가 함께 있으면 충돌로 중단하며 자동 병합·삭제하지 않습니다. symlink나 프로젝트 밖으로 이어지는 경로, 잘못된 복구/빌드 레코드도 무시하지 않고 오류로 남깁니다.
- 프로젝트 설정·댓글·journal·휴지통과 원본 파일을 보존하고 workspace identity를 바꾸지 않습니다. 인식한 복구/빌드 레코드의 내부 경로만 새 metadata 위치에 맞춥니다. 사용자 논문·댓글·메시지 본문의 이름은 일괄 치환하지 않습니다. 이전 PDF는 보존하지만 기존 SyncTeX의 비공개 경로가 남아 있으므로 새로 빌드하기 전에는 그 PDF로 소스 수정 권한을 얻지 못합니다.
- 충돌·경로 오류가 있으면 두 디렉터리를 그대로 보존하고 백업 후 원인을 해결하세요. 임의로 한쪽을 삭제하거나 복구 journal을 지우지 마세요. 이전 앱의 metadata 이름은 이후에도 자동 검색과 AI 파일 접근에서 보호 대상으로 남습니다.
