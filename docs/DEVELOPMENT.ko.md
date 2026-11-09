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

실행 파일은 `src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe`, NSIS 패키지는 같은 release 아래 `bundle/nsis/TexyPaper_0.0.12_x64-setup.exe`에 생성하도록 구성되어 있습니다. `CARGO_TARGET_DIR`을 지정하면 그 경로를 사용합니다. 실제 생성 여부와 설치 결과는 별도로 확인해야 합니다.

```powershell
$app = (Resolve-Path 'src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe').Path
& $app --data-dir 'C:\TexyPaperData\isolated-session' --open 'C:\Papers\my-paper'
```

`--data-dir`은 설정·복구·WebView2·Codex 로그인까지 분리합니다. 다른 data-dir에서 로그인했다고 현재 저장소가 인증된 것은 아닙니다. `--open`은 로컬 프로젝트를 실제 production 경로 검증을 거쳐 엽니다.

배포 빌드 시 `TEXYPAPER_UPDATE_FEED_URL` 환경 변수로 기본 업데이트 피드를 넣을 수 있습니다. 이는 **컴파일 시점** 설정이며, 저장된 `updates.feedUrl`이 있으면 그 값이 우선합니다. 저장된 빈 문자열도 자동으로 운영 주소가 되지 않습니다.

### 지속적 통합(CI)

`.github/workflows/ci.yml`은 `main` 대상 push·pull request에서 실행됩니다. 저장소 권한은 읽기 전용이며 비밀 값 없이 실행하고, action은 전체 commit SHA로 고정합니다. Ubuntu 프런트엔드 job은 Node 24와 `packageManager`의 정확한 pnpm 버전을 사용하며 store를 캐시하고 frozen lockfile 설치 후 `pnpm typecheck`·`pnpm test`를 실행합니다. Windows job은 stable MSVC Rust와 rustfmt·clippy를 설치하고 Cargo 다운로드·빌드 결과를 캐시하며 `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`를 실행합니다. 현재 별도 `rust-toolchain` 파일은 없습니다.

외부 도구와 플랫폼 조건은 다음처럼 처리합니다. 누락된 환경을 다른 테스트로 조용히 대체하지 않습니다.

| 테스트 / 검증 범위 | CI 처리 |
| --- | --- |
| `execution::tests::{pending_deny_duplicate_and_epoch_authority, output_nonzero_timeout_and_cancel_are_actual, deny_and_close_stop_the_owned_descendant_tree, pending_queue_is_bounded_and_only_one_immutable_request_runs}` | Windows에 Python 3.12를 설치하고 실제 자식 프로세스·Windows Job Object를 검사합니다. |
| `storage_migration::windows_junction_metadata_and_profile_locations_are_refused` | Windows 기본 `cmd.exe /c mklink /J`를 사용하며 실패하면 job도 실패합니다. |
| `spell::tests::selected_engine_returns_utf16_spans` | Windows 영어 사전이 있으면 해당 엔진, 없으면 실제 내장 사전을 사용합니다. 강제 내장 엔진 테스트도 모두 실행하며, 이것만으로 Windows 사전 엔진을 검사했다고 주장하지 않습니다. |
| `synctex_prose::observed_cp949_input_paths_decode_strictly_on_cp949_windows` | ANSI 코드 페이지 949가 필요하므로 이름을 지정한 `--skip`과 이유를 job 로그에 명시합니다. hosted 이미지의 OS 로캘은 변경하지 않습니다. |
| 모든 `src-tauri/tests/remote_*.py`(현재 `remote_assets.py`, `remote_execution.py`, `remote_project_replace.py`, `remote_proposal.py`) | 별도 Ubuntu Python 3.12 job에서 각각 `python3 -I -B`와 verbose 출력으로 실행합니다. POSIX 디렉터리 descriptor·symlink·프로세스 그룹을 실제 사용하며 이 회귀 테스트에는 WSL이나 TeX가 필요하지 않습니다. |
| Rust `#[cfg(unix)]` symlink 테스트 | Windows job에서는 컴파일하지 않습니다. POSIX worker 검사가 Unix native Rust 검사를 대신한다는 뜻은 아닙니다. |
| `smoke:desktop`, `smoke:preferences`, `smoke:usability`, `smoke:features`, `smoke:ssh`, `smoke:agents`, `smoke:chat`, `smoke:tray`, `measure:memory` | CI 제외 사실과 이유를 로그에 명시합니다. 허가받은 대화형 데스크톱·WebView2가 필요하며 일부는 인증도 필요합니다. 로컬 TeX smoke에는 latexmk·pdfLaTeX·SyncTeX가 포함된 Windows TeX Live, SSH smoke에는 OpenSSH·WSL·POSIX Python/TeX가 필요합니다. 배포 전 해당 실제 앱 suite를 별도로 실행해야 합니다. |

Rust의 parser·prose·diagnostic 테스트는 설치된 TeX 엔진 대신 합성 SyncTeX·로그 레코드를 사용합니다. CI 성공은 설치 프로그램·실제 TeX·실제 provider·디스플레이 배율·실제 앱 smoke의 성공 증거가 아닙니다. workflow 변경은 로컬에서 `actionlint .github/workflows/ci.yml`로 검사하세요. CI는 배포를 발행하지 않습니다.

### 재현 가능한 배포 패키지

`pnpm package:release`는 **이미 빌드하고 검증한** 일반 production exe와 대응 NSIS 설치 프로그램을 패키징합니다. Windows·Node 24에서 실행하며 PowerShell로 Windows 버전·서명 정보를 읽고, 7-Zip으로 NSIS를 추출하되 앱을 설치하지 않습니다.

```powershell
$version = '0.0.7'
$release = 'src-tauri/artifacts/cargo-target/x86_64-pc-windows-msvc/release'
$hiddenSha = 'e97e8129527ecc5a346923be8a1584c9e57f613b45d92e5a8a7f39dc1c9cc5e7'
pnpm package:release --version $version --release-dir $release --output "artifacts/release-$version-new" --hidden-sha $hiddenSha
```

위 경로·해시는 과거 0.0.7 입력을 재현하는 예시입니다. 현재 release 폴더와 별도로 검증한 hidden 빌드의 실제 SHA-256으로 바꾸세요. production exe 위치에 hidden 바이너리를 넣으면 안 됩니다. 기존 출력 디렉터리는 거부하고, 실패 시 이번 실행이 만든 새 출력만 제거합니다. 설치 프로그램·portable ZIP·`release-manifest.json`·`package-proof.json`·`SHA256SUMS.txt`를 생성하며 0.0.7의 필드 이름을 유지합니다. 체크섬과 파일 이름 사이는 공백 한 칸입니다.

기본 7-Zip은 `artifacts/publication-tools/sevenzip/usr/lib/7zip/7z`이며 `wsl.exe -d Ubuntu-24.04 --exec`로 실행하므로 미리 준비되어 있어야 합니다. `--sevenzip 'C:\Program Files\7-Zip\7z.exe'`는 WSL 없이 native 7-Zip을 사용하고, 다른 Linux 7z 경로를 지정하면 같은 WSL 배포판에서 실행합니다. 패키징 스크립트가 도구를 다운로드하지는 않습니다.

ZIP은 `LICENSE`·`THIRD_PARTY_NOTICES.md`·`texypaper.exe` 뒤에 `licenses/`의 모든 파일을 전체 경로 ordinal 순으로 넣습니다. DOS host·0644 파일 모드, 고정 시각 2026-11-08 00:00:00, raw deflate level 9를 사용하며 디렉터리 항목은 없습니다. Node/zlib 버전이 달라지면 압축 바이트도 달라질 수 있으므로 배포 증거에 패키징 runtime 버전을 보관하세요. 스크립트는 완성 ZIP을 다시 열어 모든 파일을 압축 해제하고 CRC·크기·SHA-256을 확인하며, 설치 프로그램의 라이선스 파일 목록과 해시도 소스와 대조합니다. 미서명 빌드의 추출 exe는 일반 exe와 `__TAURI_BUNDLE_TYPE_VAR_UNK` → `__TAURI_BUNDLE_TYPE_VAR_NSS`의 세 바이트만 달라야 합니다.

서명 배포는 내장 앱·설치 프로그램·독립 exe까지 서명을 마친 뒤에만 `--signed`를 추가합니다(Code signing 절 참고). 세 바이너리 모두 timestamp가 있는 `Valid` Authenticode 서명과 동일한 signer subject·issuer가 필요합니다. 단기 인증서에서는 달라질 수 있는 thumbprint도 각각 기록합니다. 서명 proof는 `signedExecutableVerification`에 세 서명 주체·상태를 저장하고 `installerExecutableDiffersOnlyByTauriBundleType`은 `null`로 둡니다. 이는 서명 검증이지 바이트 동등성 검증은 아닙니다.

배포 체크리스트:

1. 버전·라이선스 고지를 맞추고 두 lockfile 기준 의존성을 설치한 뒤 CI 검사를 실행합니다.
2. 합성 프로젝트·격리 profile만 사용해 해당 실제 앱 smoke를 실행하고 증거와 검증한 hidden exe의 SHA-256을 보관합니다.
3. 원하는 compile-time 업데이트 피드로 일반 visible/focused production exe와 대응 NSIS를 빌드합니다. hidden smoke 빌드는 배포하지 않습니다.
4. 서명한다면 NSIS 패키징 후 독립 exe 서명까지 명시적 절차를 완료합니다. 미서명 배포를 서명 배포라고 하거나 자체 서명 테스트 인증서를 신뢰된 production 인증서라고 하지 않습니다.
5. 새 디렉터리로 `package:release`를 실행합니다. manifest·payload 개수·라이선스 proof·Windows metadata·SHA256SUMS를 검토하고 Python `zipfile`이나 7-Zip으로 ZIP을 별도 검증합니다.
6. 허가받은 환경에서 설치·portable 시작도 별도로 검증한 뒤 검사한 파일과 체크섬 그대로 발행합니다. 패키징 runtime·smoke 증거를 보관하세요. 패키징 스크립트는 업로드·태그 생성을 하지 않습니다.

## 실제 앱 smoke와 메모리 측정

**사용자 논문을 테스트 입력으로 쓰지 마세요. 아래 smoke·메모리 명령은 실제로 보이는 앱 창을 실행하며, 실행 전에 사용자의 명시적 허가가 필요합니다. 백그라운드 전용 작업에서는 실행하지 마세요.** 트레이·마우스 자동화는 기존 `--headed`/`-Headed` 안전 게이트도 통과해야 합니다. 일반 suite는 headless 도구가 아닙니다. 스크립트는 합성 fixture를 만들며 실제 release exe와 WebView2 CDP에 연결합니다. 매 실행마다 기존 결과가 없는 새로운 **ASCII 경로**를 `--output`에 지정하세요. fixture 생성기를 smoke 출력 폴더에 미리 실행하지 마세요. smoke가 자체 fixture 하위 폴더를 생성합니다.

```powershell
$app = (Resolve-Path 'src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe').Path
$run = Join-Path $env:TEMP ('texypaper-evidence-' + [guid]::NewGuid().ToString('N'))

pnpm smoke:preferences --binary $app --output (Join-Path $run 'preferences')
pnpm smoke:usability --binary $app --output (Join-Path $run 'usability')
pnpm smoke:features --binary $app --output (Join-Path $run 'features')
pnpm smoke:desktop --binary $app --output (Join-Path $run 'desktop')
pnpm smoke:ssh --binary $app --output (Join-Path $run 'ssh')
pnpm smoke:ssh-exit --binary $app --output (Join-Path $run 'ssh-exit')
pnpm smoke:agents --binary $app --live --auth-timeout-seconds 600 --output (Join-Path $run 'agents')
pnpm measure:memory -AppPath $app -DurationSeconds 120 -Provider codex -AuthenticationTimeoutSeconds 600 -OutputDirectory (Join-Path $run 'memory')
```

메모리의 `-OutputDirectory`는 **존재하지 않는 디렉터리**여야 합니다. `--live` 없이 에이전트 성공으로 처리하지 않으며 로그인 대기 시간은 로그인을 대신하지 않습니다. 필요한 공식 인증 창을 직접 완료하세요. 재사용할 인증 데이터가 필요하면 정상 사용자 app-data가 아닌 smoke 전용 저장소를 쓰세요. 에이전트 smoke는 `--data-dir`, 메모리 측정은 `-AuthenticationDataDirectory`를 받습니다.
SSH 종료 smoke는 전용 loopback SSH 호스트를 사용하고 트레이의 종료 이벤트를 메인 창에 주입합니다. 실제 트레이 메뉴 조작은 검증하지 않습니다.

표준 메모리 판정은 실제 Windows 디스플레이 배율 100%에서 수행합니다. 현재 배율을 바꾸지 않고 진단 수치만 수집하려면 `-AllowNonstandardDisplayScale`을 명시하세요. 이 옵션은 OS 설정을 변경하지 않으며, 실제 배율이 100%가 아니면 나머지 측정이 끝나도 표준 판정과 전체 결과는 실패로 남습니다. CDP의 2× 렌더러 에뮬레이션은 실제 Windows 배율 측정으로 표시하지 않습니다.

설치까지 검사하려면 생성한 NSIS 실행 파일을 정확히 지정합니다. 기존 TexyPaper 설치가 있으면 격리 설치 검사는 덮어쓰지 않고 거부합니다.

```powershell
pnpm smoke:desktop --binary $app --installer 'C:\Builds\TexyPaper_0.0.12_x64-setup.exe' --output (Join-Path $run 'installer-desktop')
```

위 설치 파일 경로는 사용자가 실제 생성한 파일로 바꾸어야 하는 입력 예시입니다. 다음 통합 실행도 보이는 앱 창을 실행하므로 사용자 허가가 필요하며, 설치된 도구와 이름이 정확히 `TexyPaper_0.0.12_x64-setup.exe`인 NSIS 산출물을 요구합니다. 데스크톱 스위트는 `--native-dialogs`를 줄 때만 네이티브 PDF 저장 대화상자를 엽니다. 이 대화상자는 숨김 시험 앱이어도 화면에 나타나기 때문입니다.

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

## Code signing

서명은 **명시적으로 선택할 때만** 수행합니다. 기본 빌드는 unsigned 그대로이며, 인증 정보가 있을 때만 `src-tauri/tauri.signing.conf.json`을 추가하세요. 이번 변경으로 계정을 만들거나 신청·결제하지 않았으며 실제 배포용 인증서를 발급받은 것도 아닙니다.

### 서비스 선택 (2026-11-08 조사)

| 선택지 | 자격·비용·유지보수자가 할 일 |
| --- | --- |
| **SignPath Foundation — 우선 신청 권장** | 승인받은 OSS에 서비스와 Foundation 명의 인증서를 무료 제공합니다. OSI 승인 라이선스, 독점 구성요소·상업적 이중 라이선스 없음, 활발한 유지보수, 기존 실행파일 배포와 기능 설명, 확인 가능한 프로젝트 평판·저장소 소유권이 필요합니다. 새 프로젝트라고 자동 승인되지는 않습니다. 홈페이지·릴리스에 **Code signing policy**와 지정된 SignPath 크레딧, 작성자·검토자·승인자 명단, AI 등 선택적 외부 서비스까지 반영한 실제 개인정보 정책을 공개하고 GitHub/SignPath MFA를 켠 뒤 [신청](https://signpath.org/apply)하세요. 매 릴리스는 사람의 승인이 필요하며 키는 SignPath HSM에 남습니다. [조건](https://signpath.org/terms), [무료 서비스](https://signpath.org/). |
| **Azure Artifact Signing (구 Trusted Signing)** | Basic은 **월 US$9.99부터**, 월 5,000회 서명입니다. 세금·초과분·지역별 가격은 구매 전에 확인하세요. 공개 신뢰 인증서의 **개인 신청은 미국·캐나다만 가능**하므로 한국 거주 개인에게는 현재 해당하지 않습니다. 한국 **조직**은 지원되지만 개인사업자의 조직 자격은 Microsoft 확인 없이 단정하면 안 됩니다. Azure 구독·Entra tenant·신원 검증·계정/인증서 profile·서명 역할이 필요하고 물리 토큰은 불필요합니다. 계정을 생성하는 순간부터 과금됩니다. [자격](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart), [시작 가격](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation), [수량·과금](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/). |
| **Certum Open Source Code Signing — 저비용 대안** | 비상업 OSS를 배포하는 **개인 전용**이며 이름에 “Open Source Developer”가 붙습니다. 상점 시작 가격은 **클라우드 €49**, **카드+리더 €69**, **기존 호환 카드용 활성화 €25**입니다. 선택 기간·세금·배송·최종 결제액은 별도 확인하세요. SimplySign은 클라우드 HSM·모바일 인증 앱·Desktop middleware가 필요하며 카드 방식은 물리 보안장치가 필요합니다. 신분증/여권 검증·본인 명의 공과금 고지서·신청자와의 관계가 드러나는 공개 프로젝트가 요구됩니다. 문서에 미국/EU 한정 조건은 없지만 **한국 신청 승인 보장은 확인되지 않았습니다**. 결제 전에 한국 신분증·주소 검증 가능 여부를 서면 확인하세요. [가격](https://shop.certum.eu/code-signing.html), [클라우드 요구사항](https://shop.certum.eu/open-source-code-signing-on-simplysign.html), [검증·비상업 조건](https://support.certum.eu/en/code-signing-required-documents/). |
| **다른 개인용 예: SSL.com IV** | 사업자 등록 없이 개인 명의로 발급합니다. 인증서 **연 US$129**에 키 보관 비용이 추가됩니다. eSigner Tier 1은 **연 US$180/240회** 또는 **월 US$20/20회**, 표시된 YubiKey는 **US$379**입니다. 따라서 인증서+연간 클라우드 요금은 약 **US$309/년**이지 US$129 총액이 아닙니다. 공개 신뢰 인증서는 하드웨어/HSM 키 보관이 필요하며 새 인증서를 일반 PFX로 다운로드하는 방식은 아닙니다. 한국 신원 검증·거래 제한은 판매사에 확인해야 하며 여기서는 국가별 승인을 확인하지 않았습니다. [인증서](https://www.ssl.com/products/software-integrity/code-signing/iv/), [구독·키 보관](https://www.ssl.com/guide/esigner-pricing-for-code-signing/). |

이 유지보수자에게는 GitHub-hosted 릴리스 빌드·라이선스/개인정보 공개·승인 역할을 마련한 뒤 SignPath에 신청하는 경로를 권합니다. 거절되거나 개인 publisher 명의가 필요하면 Certum에 한국 개인 검증과 €49 클라우드 상품 총액을 먼저 문의하세요. Azure는 현재 한국 개인의 경로가 아닙니다. 경고 제거만을 목적으로 EV를 구매하지 마세요.

**서명 성공과 SmartScreen 경고 제거는 다릅니다.** Microsoft의 [현재 설명](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)과 [2024년 변경 안내](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/distribution-feature-status#smartscreen-reputation-ev-certificates-no-longer-grant-instant-bypass)가 오래된 판매사 홍보보다 우선합니다. OV·EV 모두 즉시 평판을 보장하지 않으며 새 서명 앱도 경고가 날 수 있습니다. 깨끗한 다운로드와 일관된 서명 명의로 평판을 쌓고, unsigned는 새 버전/hash마다 다시 쌓습니다. 자체 서명 인증서는 공개 신뢰가 없습니다. 조직 정책·Smart App Control은 더 엄격할 수 있으며 사용자에게 보호 기능을 끄라고 안내하지 마세요.

### 명시적 서명 빌드

`TEXYPAPER_SIGN_PFX`에 PFX 절대 경로, `TEXYPAPER_SIGN_PASSWORD`에 암호를 호출 프로세스/CI secret 환경으로 전달하세요. 명령행 문자열·저장소 파일·transcript에 암호를 쓰지 마세요. 스크립트는 Windows 인증서 저장소에 import하지 않고 암호나 서명 인자를 출력·기록하지 않습니다. 다만 SignTool의 PFX 옵션 자체는 자식 프로세스 인자에 암호를 받으므로 격리된 신뢰 runner가 필요합니다. 클라우드/HSM은 배포용 개인 키 export를 피할 수 있습니다. 스크립트는 `C:\Program Files (x86)\Windows Kits\10\bin\*\x64`의 최신 `signtool.exe`를 찾으며 없으면 unsigned로 넘어가지 않고 실패합니다.

```powershell
# 두 인증 환경 변수는 이 명령 전에 안전하게 주입합니다.
pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis --config src-tauri/tauri.signing.conf.json -- --locked
# Tauri는 bundle 후 원본 standalone exe를 복원하므로 별도 서명이 필요합니다.
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'src-tauri/target' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/sign-windows.ps1 -FilePath "$target/x86_64-pc-windows-msvc/release/texypaper.exe"
```

`/fd SHA256 /tr <RFC3161 URL> /td SHA256`을 사용합니다. 기본 TSA는 `http://timestamp.digicert.com`이며 `TEXYPAPER_SIGN_TIMESTAMP_URL`로 바꿀 수 있습니다. 서명·timestamp 실패는 빌드를 중단합니다. 스크립트는 signer와 timestamp 존재를 요구하지만 테스트용 비신뢰 root를 신뢰하도록 바꾸지 않습니다. 실제 배포 검증은 standalone exe·installer·**추출한 설치 payload exe** 세 파일 모두 `Get-AuthenticodeSignature` **Valid**, signer·timestamp 존재, 동일 signer subject/issuer를 요구해야 합니다. thumbprint는 기록하되 Azure처럼 단기 leaf 인증서가 회전할 수 있음을 고려하세요. 자체 서명 검증 산출물은 절대 배포하지 마세요.

Tauri [custom command](https://v2.tauri.app/distribute/sign/windows/#custom-sign-command)의 `%1`을 argument-array로 전달해 공백 경로를 보존합니다. `certificateThumbprint`는 기존 Windows 저장소의 인증서를 지정하는 별도 내장 방식이며 여기서는 설정·import하지 않습니다. Tauri는 [bundle marker를 먼저 patch한 뒤 서명](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle.rs)하고 NSIS 내부 exe·uninstaller·installer를 만들고 서명한 뒤 원본 standalone exe를 복원합니다. standalone과 payload는 `UNK`/`NSS` 차이가 있을 수 있으므로 byte 일치 대신 두 서명을 독립 검증하세요. 서명 후 파일을 수정하면 안 되며 외부 installer 서명만으로 내부 exe가 서명되지는 않습니다.

### Provider hook과 선택적 CI 구성

PFX 변수 두 개 대신 `TEXYPAPER_SIGN_PROVIDER_SCRIPT`에 신뢰하는 `.ps1` 절대 경로를 지정할 수 있습니다. Hook은 `-FilePath <절대 경로> -TimestampUrl <URL> -DigestAlgorithm SHA256`을 받아 **같은 파일에** 서명하고 SHA-256/RFC3161 요건을 지키며 승인·다운로드 완료까지 기다려야 합니다. 실패 시 0이 아닌 종료 코드를 반환하고 secret/token을 출력하지 마세요. 임의 명령 문자열을 평가하는 방식은 사용하지 않습니다.

Azure hook에는 동일 아키텍처 SDK SignTool·Artifact Signing client의 `Azure.CodeSigning.Dlib.dll`, .NET 8 등 runtime, Certificate Profile Signer 역할의 인증된 `DefaultAzureCredential`, `Endpoint`·`CodeSigningAccountName`·`CertificateProfileName`을 담은 비밀이 아닌 metadata JSON이 필요합니다. TSA 환경은 `http://timestamp.acs.microsoft.com`으로 설정하세요. Hook 내부에서 SignTool `sign /fd SHA256 /tr $TimestampUrl /td SHA256 /dlib <dll> /dmdf <metadata> $FilePath`를 실행하고 `$LASTEXITCODE`를 명시적으로 반환합니다. 인증은 CI secret/workload identity로 관리하세요. [Microsoft 통합 안내](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations).

SignPath Foundation에는 로컬 API 제출만으로 충분하지 않습니다. [GitHub connector](https://docs.signpath.io/trusted-build-systems/github)는 GitHub Actions에 업로드된 artifact와 **서명까지의 모든 선행 job이 GitHub-hosted runner에서 실행됐다는 증명**을 요구합니다. 다음은 승인·설정 전까지 비활성으로 두어야 할 선택적 workflow 설계입니다(수동 `workflow_dispatch`와 명시적 enable 변수/환경 승인):

1. 승인된 공개 commit을 GitHub-hosted Windows runner에서 locked 의존성으로 빌드하고 `actions/upload-artifact`로 올립니다.
2. `signpath/github-action-submit-signing-request`(현재 문서 v3, 활성화할 때 검토한 commit SHA로 고정)에 secret submitter token·조직/project/policy ID·업로드 `artifact-id`를 전달합니다. 사람이 승인한 뒤 결과 다운로드까지 기다립니다.
3. SignPath와 artifact configuration을 합의해 **프로젝트 소유 binary만** 서명하고 제품명·버전을 제한합니다. NSIS 중첩 구성으로 내부 exe를 외부 installer보다 먼저 서명하거나 Tauri post-patch hook에서 승인된 2단계 pipeline을 구성해야 합니다. 각 단계는 provenance를 위해 다시 업로드하세요. 이미 만든 외부 installer만 서명하거나 서명 후 exe를 재-patch하면 안 됩니다.
4. 잠긴 Tauri 버전의 서명 범위를 확인하세요. NSIS가 복사한 upstream plugin/resource DLL에도 hook을 호출할 수 있습니다. Foundation 인증서로 upstream binary를 서명하는 것은 금지되므로 모든 DLL을 무조건 전달하지 말고 승인된 프로젝트 전용 artifact/provider dispatch가 필요합니다.
5. 세 파일의 공개 신뢰 서명을 확인한 뒤 `package-release.mjs --signed`를 사용하세요. secret은 GitHub에서만 설정합니다. 저장소 변경으로 공급자 계정·승인·실제 CI 서명이 준비된 것은 아닙니다.

### 로컬 동작 검증 (공개 신뢰 배포 아님)

2026-11-08에 이 overlay와 hidden-window 테스트 overlay를 함께 쓴 격리된 locked Windows x64 NSIS 빌드가 성공했습니다(Rust release 컴파일 4분 50초). WSL OpenSSL 3.0.13으로 유효기간 2일의 RSA-3072 자체 서명 code-signing PFX를 생성했으며 Windows 인증서 저장소에 import하지 않았습니다. SDK `10.0.26100.0` SignTool로 patch된 내부 exe·NSIS uninstaller/installer를 서명한 뒤 복원된 standalone exe를 별도로 서명했습니다. 공백이 있는 파일/hook 경로의 provider hook 서명도 성공했고 인증 정보가 없으면 실패했습니다.

WSL 7-Zip 23.01로 installer를 실행하지 않고 추출했습니다. standalone `texypaper.exe`·`TexyPaper_0.0.7_x64-setup.exe`·추출한 `texypaper.exe` 모두 signer가 `CN=TexyPaper Throwaway Signing Test DO NOT DISTRIBUTE`, thumbprint가 `606FB04062F2E9120EA8CB203C0749BEBC3F8911`이었고 SHA-256 서명·DigiCert RFC3161 timestamp가 있었습니다. TSA 연결도 성공했습니다. **세 파일 모두 예상대로 비신뢰 상태**였습니다. `Get-AuthenticodeSignature`는 “terminated in a root certificate which is not trusted” 메시지와 `UnknownError`를, `signtool verify /pa /v`는 같은 root 신뢰 오류로 종료 코드 1을 반환하면서 서명·검증된 timestamp 체인을 표시했습니다. 이는 동작 검증이지 배포용 `Valid` 서명이나 SmartScreen 검증이 아닙니다.

증거를 수집한 뒤 PFX·개인 키·추출 파일·테스트 exe/installer·임시 provider 스크립트·격리 Cargo target 디렉터리를 삭제했습니다. 통합 검토용 비밀이 아닌 build/signature 로그만 gitignored `artifacts/signing-test-01/`에 남겼습니다. 앱/installer를 실행하지 않았으며 설치된 앱·실제 사용자 profile은 변경하지 않았습니다.

이 절은 AI 도구로 판매사 1차 문서를 조사한 결과이며 자격 승인이나 견적이 아닙니다. 신청·구매 전에 링크의 최신 조건을 다시 확인하세요.
