# TexyPaper 구조와 신뢰 경계

이 문서는 사용자용 기능 설명을 반복하기보다 **누가 파일을 바꿀 수 있는가, 어떤 버전의 PDF가 어떤 소스를 증명하는가, 어디에서 리소스를 제한하는가**를 설명합니다. 실행·설치·실제 공급자·메모리의 통과 여부는 별도 `docs/VERIFICATION.md`의 실행 증거로 판단해야 합니다. 여기에 적힌 상수와 코드 경로는 측정 결과를 의미하지 않습니다.

현재 제품/패키지 버전은 **TexyPaper 0.0.1**, machine name은 `texypaper`, Rust library는 `texypaper_lib`, Tauri 식별자는 `dev.texypaper.desktop`입니다. 내부 artifact scheme은 `texypaper` / `http://texypaper.localhost`, 앱 이벤트는 `texypaper:...`, 자체 환경 변수는 `TEXYPAPER_...`를 사용합니다. 지원 데스크톱은 Windows x64이며 macOS 빌드·검증이나 자체 클라우드 로그인·실시간 협업은 이 범위에 없습니다.

## 1. 프로세스와 권한

```text
Windows / TexyPaper
  Tauri Rust native process — app state, workspace authority, owned children
    ├─ main WebView2 window
    │    React shell / CodeMirror / bundled PDF.js document + worker
    │    └─ typed invoke + workspaceId/epoch, scoped artifact byte ranges
    ├─ optional chat-only WebView2 → sequenced UI intents → main controller
    ├─ local Workspace backend → canonical project root
    ├─ ssh.exe → one persistent stdio → POSIX Python worker → remote root
    └─ on-demand Codex or Claude CLI (one task)
         └─ texypaper.exe --mcp-stdio
              → authenticated loopback broker → scoped Workspace tools
```

React는 파일시스템·임의 shell 권한을 갖지 않습니다. `src/api.ts`와 `src/contracts.ts`의 호출은 `src-tauri/src/lib.rs`의 명시적 Tauri 명령으로 들어갑니다. Rust의 `AppState`, `WorkspaceManager`와 실제 backend가 경로·revision·작업 상태를 다시 검증합니다. 프런트엔드 타입과 capability allowlist는 편의와 공격면 축소 수단이지 native 검증의 대체물이 아닙니다.

`main.rs`는 `--mcp-stdio`와 `--ssh-askpass`를 Tauri 초기화 전에 분기합니다. 도움 프로세스에 별도 WebView를 띄우지 않습니다. 정상 실행은 메인 창 하나와 전용 WebView2 profile을 만들고, 요청할 때만 같은 profile에 고정 label `chat`인 전용 채팅 창을 추가합니다. `--data-dir <path>`는 그 profile과 앱 데이터까지 격리하고 `--open <local-root>`는 실제 workspace 열기 경로를 사용합니다.

`process.rs`는 앱 소유 자식의 수명과 취소를 관리합니다. Windows에서는 Job Object로 하위 프로세스를 소유하고 원격 Python은 새 POSIX session/process group으로 빌드 자식을 관리합니다. 종료는 앱이 만든 트리를 대상으로 하며 같은 이름의 사용자 프로세스를 전역 종료하지 않습니다.

`chat_window.rs`와 `chatWindow.ts`의 메인 컨트롤러가 대화·초안·작업·승인 상태를 소유합니다. 분리 창은 순서가 있는 session/workspace/epoch별 UI intent만 보내고 제한된 상태 패치를 받습니다. 긴 응답은 기존 문자열을 재전송하지 않고 추가 text와 제거할 prefix를 전달합니다. 분리 창에는 editor/PDF/provider 컨트롤러를 만들지 않습니다. 메인 이외의 WebView는 `chat_window_ready`, `chat_window_action` 외 앱 command를 호출할 수 없습니다.

읽기 위치는 메인 소유 `ChatReadingPosition`으로 동기화합니다. `reading-position` intent와 native workspace metadata는 동일한 bounded validator로 검증하며 provider/history leaf/message anchor/scroll만 허용합니다. 권한·동의·session 키는 복원 payload에서 거부합니다. 메인이 숨겨져 있는 동안 생성한 분리 창도 숨김 상태를 유지합니다.

`tray.rs`는 첫 메인 X를 막고 main-only `texypaper:tray-close-requested`로 설명을 요청합니다. main-only `app_hide_to_tray({acknowledge:true})`가 원자적으로 `trayCloseExplained`를 저장한 뒤 창들을 숨기며 일반 settings API로는 이를 설정할 수 없습니다. 이후 X는 메인·분리 창을 보존해 숨기므로 작업과 권한 epoch가 유지됩니다. 파일 메뉴·단축키·트레이의 명시적 종료는 같은 UI 저장/버리기/취소와 작업 중지 확인 뒤 main-only `app_quit`으로 진행합니다. native 종료 중에는 새 앱 작업을 막고, 실제 소유 프로세스·변경 작업의 종료를 확인한 뒤 workspace와 창을 닫습니다. 정리를 확인하지 못하면 앱을 유지하고 오류를 반환합니다.

Windows의 `activation.rs`는 같은 사용자 SID와 canonical profile 경로의 hash로 이름을 만든 restore-only event를 사용합니다. 현재 사용자만 접근할 수 있는 DACL을 적용하고 어떤 파일 경로나 명령 payload도 받지 않습니다. exclusive profile lock의 `PROFILE_IN_USE`일 때만 기존 인스턴스에 복원을 요청합니다. 초기화 전 요청은 큐에 남고 종료 중 요청은 창을 다시 만들지 않습니다. 다른 profile과 migration conflict는 우회하지 않습니다.


### 주요 코드 경로

| 경로 | 책임 |
| --- | --- |
| `src/ui/AppShell.tsx`, `src/state/workspace.ts` | 단일 작업 화면, 전환/저장 guard, build debounce, 이벤트 소비 |
| `src/editor/buffers.ts`, `SourceEditor.tsx` | 단일 EditorView, source state, IME와 저장·복구·cache |
| `src/features/explorer/` | 가상화 tree, 검증된 파일명 증거와 Main 표식 |
| `src/pdf/` | range transport, 제한된 canvas/text layer, 선택 좌표 |
| `src/features/pdf-edit/`, `comments/`, `ai/` | 검토 UI, 댓글, 공급자/제안 UI |
| `src-tauri/src/state.rs`, `contracts.rs`, `lib.rs` | 앱 상태, command dispatch, epoch, artifact grant, project trust |
| `src-tauri/src/workspace/` | local/SSH parity, 경로, transaction, 탐색 index |
| `src-tauri/resources/remote_worker.py` | 서버 파일·빌드·SyncTeX 작업, bounded protocol |
| `src-tauri/src/latex/` | scheduler, diagnostics, immutable artifacts, mapping proof |
| `src-tauri/src/comments.rs` | sidecar revision과 anchor 이동/재연결 |
| `src-tauri/src/spell.rs`, `src/editor/spelling.ts`, `proseRanges.ts` | 영어 맞춤법: Windows `ISpellChecker` 우선(전용 MTA 스레드 하나), 없으면 내장 SCOWL 사전; 산문 범위만 검사 |
| `src-tauri/src/dialogs.rs` | 파일 열기/저장 대화상자를 호출마다 새 STA 스레드에서 실행 |
| `src-tauri/src/checkpoints.rs`, `src/features/history/` | app-data 수동·자동 체크포인트 저장·검증과 비교·복원 UI |
| `src/features/search/`, `assets/`, `templates/` | 프로젝트 바꾸기 계획, 그림 가져오기, 템플릿 생성(모두 기존 transaction/create 경로 재사용) |
| `src-tauri/src/ai/` | 공식 CLI, broker/MCP, 읽기 정책과 staged proposal |
| `src-tauri/src/execution.rs` | 사용자 명령 권한, 불변 승인 요청, 호스트 실행·출력·취소 |
| `src-tauri/src/chat_window.rs`, `tray.rs` | 분리 창 역할 경계, 숨김·복원, 보호된 앱 종료 |
| `src-tauri/src/updates.rs`, `src/ui/Updates.tsx` | 알림 전용 HTTPS 업데이트 확인 |
| `scripts/` | 격리 합성 fixture와 release/SSH/live-agent/memory 실행 도구 |

## 2. Workspace identity와 경로

공유 직렬화는 camelCase 필드, `kind` discriminator와 `AppError {code,message,path?,retryable,...}`를 사용합니다. 핵심 신원은 다음과 같습니다.

- `WorkspaceRef {id, environmentId, root, epoch}`: 환경과 canonical root, 현재 열기 시도.
- `FileRef {workspaceId,path}`: `/` 구분자를 사용하는 workspace 상대 경로.
- `Revision {sha256,byteLength,modifiedNs}`: 내용 hash가 authoritative revision이며 metadata는 힌트입니다.
- `AppEvent {workspaceId,epoch,sequence,kind,payload}`: 예전 workspace/연결의 늦은 이벤트는 현재 화면에 적용하지 않습니다.

`WorkspaceManager`에는 활성 workspace 하나만 있습니다. 열기/재연결은 epoch를 갱신합니다. 긴 mutation/build/AI 작업이 있으면 native도 전환을 거부하며 UI는 저장/버리기/취소와 작업 중지 선택을 먼저 받습니다. 전환 시 artifact/media grant를 지웁니다. 탭·최근 프로젝트 기록은 metadata이지 숨겨진 live workspace가 아닙니다.

파일 API 경로는 NUL·절대 경로·drive/UNC·`..`·Windows alternate data stream을 거부합니다. 기존 대상은 canonical 경로, 새 파일은 canonical한 기존 부모를 기준으로 root 포함 여부를 검사합니다. 밖으로 나가는 symlink/부모는 허용하지 않습니다. symlink는 표시하지만 재귀 스캔하지 않습니다. 이 규칙은 GUI와 MCP 파일 도구·댓글·RPC에 적용됩니다. 사용자 승인 명령에는 cwd의 root 포함 여부를 검사하지만, 실행 프로세스의 전체 파일시스템 권한을 이 규칙으로 제한하는 것은 아닙니다. POSIX 파일명을 Windows basename으로 축약해 맞추지 않습니다.

## 3. 소스 저장과 복구의 정확한 보장

`BufferStore`는 editor state를 React 전체 소스 state와 매 keystroke 동기화하지 않습니다. 단일 CodeMirror view를 바꾸어 사용합니다. 파일은 UTF-8을 엄격히 해석하고 BOM·LF/CRLF/mixed를 구분합니다. byte anchor와 CodeMirror UTF-16 인덱스는 명시적으로 변환합니다. mixed line ending 편집은 raw text와 변경 집합을 사용해 영향 없는 구간을 보존합니다.

### 저장 흐름

1. 입력 변경은 dirty로 표시하고 복구 기록을 debounce합니다. IME composition이 끝나기 전에는 저장하지 않습니다.
2. 700ms idle 또는 명시적 flush가 `file_save`를 요청합니다. client recovery에는 text·base hash·transaction ID를 기록합니다.
3. workspace mutation lock으로 앱 소유 변경을 직렬화합니다. native/worker는 대상 경로와 현재 SHA-256을 검사합니다.
4. `.texypaper/transactions/<id>/`에 journal과 원본 bytes를 기록하고 변경을 stage합니다. 같은 파일시스템의 sibling temp 파일을 flush하고 기존 권한을 보존해 교체합니다.
5. 성공 응답 revision을 받은 후 해당 버전의 recovery를 지웁니다. 응답을 기다리는 동안 새 입력이 생겼다면 버퍼는 계속 dirty입니다.

외부 수정은 hash로 검출합니다. 깨끗한 버퍼는 reload하고 dirty 버퍼는 `FILE_CONFLICT`와 외부 버전을 보존합니다. UI는 비교/다시 불러오기/복사본 저장을 제공하며 overwrite 확인 없이 덮지 않습니다. 4MiB 초과는 우선 read-only이며 사용자가 메모리 경고 후 허용할 수 있습니다. legacy encoding은 원본 자동 변환 대신 손실 가능성을 고지한 UTF-8 복사본 저장 경로를 제공합니다.

### 트랜잭션 caveat

이것은 **외부 writer와의 낙관적 충돌 검출**입니다. 앱 잠금은 외부 편집기를 잠그지 않으므로 hash 재검사와 rename/replace 사이의 race를 없애는 파일시스템 CAS가 아닙니다. 여러 파일의 적용 역시 복구 가능한 앱 트랜잭션이지 모든 파일의 동시 원자 교체가 아닙니다.

중간 실패 시 이미 쓴 파일은 현재 hash가 이 트랜잭션의 결과와 같을 때만 복원합니다. 더 나중의 편집이 있으면 덮지 않고 `TRANSACTION_PARTIAL`, 영향 경로, journal을 남깁니다. undo도 모든 관련 결과 hash를 확인하고 후속 인간 편집을 우선합니다. 완료 기록은 제한해 보관하지만 미해결 복구 자료는 유지합니다.

연결 단절/재시작 후에는 transaction ID로 상태를 조회합니다. committed/result 일치인지 확인하고 불확실한 작업을 자동 replay하지 않습니다. UI의 복구 선택이 원본 revision을 우회하지 않습니다. 소스 저장이 성공하고 anchor 갱신만 실패한 경우에는 성공한 소스 저장을 거짓 실패로 표현하지 않고 별도 경고를 반환합니다.

## 4. 탐색기와 검색

직접 증거는 확장자 목록만으로 분류합니다. 폴더 강조를 위해 파일 본문을 열지 않습니다. `direct`는 굵기+황색 label band와 **TeX** 배지, `descendant`는 흐린 **TeX** 배지(디렉터리 목록의 검증된 하위 증거는 폴더를 펼치기 전에도 전파), `unknown`은 미검색 상태입니다. 폴더 이름만으로 논문 폴더를 추측하지 않습니다. 선택 강조는 사용자 accent와 읽기 가능한 텍스트로 표현하고 논문 의미 표식은 유지합니다. Main은 실제 선택된 root TeX에만 붙습니다. 파일·폴더 아이콘(`fileIcons.tsx`)은 확장자·정확한 파일명·폴더 별칭 표로 정하는 순수 함수이며 논문 증거 판정과 독립입니다. 아이콘은 이 프로젝트의 원본 SVG이고 제3자 아이콘 세트를 포함하지 않습니다.

index와 scan frontier는 디스크에 저장하며 한 sweep의 20,000 항목 제한이 깊이 제한으로 바뀌지 않습니다. 256개 단위 결과와 250ms yield를 사용하고 열린/보이는 디렉터리를 우선합니다. excluded 디렉터리를 명시적으로 펼치는 것은 별개입니다. local notify와 active polling은 관련 경로를 무효화하고 모든 서버 파일 내용을 cache하지 않습니다. SSH 열린 파일 검사는 창이 보이는 동안 2초 간격이고, 10초 동안 입력이나 바뀐 파일이 없으면 10초, 창이 숨겨지면 15초로 늘어납니다. 각 간격은 앞 검사가 끝난 뒤 시작하므로 느린 SSH에서도 검사가 겹치지 않습니다. 창 focus 때와 SSH 저장 직전에는 바로 검사합니다. 탐색기가 닫혀 있으면 SSH 디렉터리 목록 검사는 건너뜁니다.

`% !TeX root`는 순환 검출·최대 16 hop·root 경계 검사 후 사용합니다. 여러 `\documentclass` 후보 중 알파벳순 첫 파일을 임의 선택하지 않습니다. 프로젝트 검색·quick-open은 제한된 결과와 continuation으로 동작합니다.

## 5. SSH: OpenSSH 한 연결과 Python worker

`workspace/ssh_config.rs`는 구체적 positive `Host` 별칭과 bounded `Include`를 읽습니다. 모든 별칭에 대해 `ssh -G`를 자동 실행하지 않습니다. 실제 선택한 연결은 native OpenSSH의 config/agent/ProxyJump 해석을 따릅니다. `sshConfigFile`이 있으면 `ssh.exe -F <path>`를 사용하여 smoke가 사용자 설정을 고치지 않도록 합니다.

`ssh.exe`는 `-T`, 연결 제한 시간, keepalive, `StrictHostKeyChecking=ask`, `UpdateHostKeys=no`, `ForwardAgent=no`, `PermitLocalCommand=no` 등 개별 argv로 실행합니다. Windows ControlMaster를 가정하지 않으며 sftp의 사람이 읽는 listing을 파싱하지 않습니다. bootstrap은 고정 코드이며 프로젝트 경로/본문을 shell 문자열에 보간하지 않습니다.

### 부트스트랩과 인증

고정 `python3 -I -u -c ...` loader가 길이 제한 source payload의 SHA-256을 검증하고 owner-only 버전 cache에 저장합니다. worker는 SSH EOF에 종료하고 자신의 process group만 중지합니다. 공개 listener, root 설치, pip/npm dependency, 영구 시작 서비스는 없습니다.

`SSH_ASKPASS`는 같은 exe의 `--ssh-askpass`입니다. 별도의 단기 authenticated loopback broker가 한 prompt의 응답만 전달합니다. 암호를 argv나 SSH stdin protocol에 섞지 않습니다. unknown-host 지문은 native prompt 그대로 확인받고 변경된 키는 `SSH_HOST_KEY_CHANGED`로 실패합니다. askpass capability는 MCP 파일 도구 capability가 아닙니다.

### Protocol v1

```text
TEXYPAPER/1\n
u32be headerLength
UTF-8 JSON header
u32be payloadLength
raw payload
```

- marker 앞 login banner preamble은 최대 8KiB입니다.
- header는 최대 64KiB, payload는 최대 1MiB이며 길이를 확인한 뒤 할당합니다.
- request: `{v:1,id,workspaceId,epoch,op,args}`; reply: `{v:1,id,ok,result,error?}`.
- 최대 8개 in-flight 요청을 허용하며 일반 요청은 7개까지만 점유해 cancel/close/ping 제어 여유를 둡니다. 가득 차면 backpressure와 deadline을 적용합니다.
- stdout의 frame과 stderr 진단은 분리합니다. 요청별 bounded reply channel과 ID 매칭을 사용합니다.

worker는 hello/open_root, directory/stat/scan/search, text/range read, hash-checked save/create/rename/trash/restore, transaction status/undo, build/cancel, SyncTeX와 close 등 app-owned 작업을 처리합니다. 각각 등록 root와 canonical path를 재검증합니다. 파일 텍스트·PDF가 shell 인자나 base64 JSON 배열이 되지 않습니다.

서버 Python ≥3.9와 쓰기 가능한 프로젝트/cache가 없으면 `REMOTE_RUNTIME_UNAVAILABLE`을 반환합니다. TeX는 원격 빌드에만 필요합니다. 단절 시 마지막 성공 PDF와 클라이언트 복구 버퍼를 보존하되 저장/빌드는 막고 새로운 epoch로 명시적 재연결을 받습니다. 원격 원본을 로컬 복사본으로 바꿔치기하지 않습니다.

## 6. 빌드와 immutable artifact

`latex/scheduler.rs`와 원격 worker는 프로젝트 호스트에서 `latexmk`를 실행합니다. root TeX의 부모를 cwd로 두고 파일명·출력 경로를 각각 argv로 전달합니다. `basic`은 `-norc`와 engine `-no-shell-escape` override, `project`는 명시적 trust 후 사용자 latexmk 설정을 사용합니다. trust는 app-data에 환경+root 신원으로 보관하며 프로젝트가 JSON을 바꿔 스스로 신뢰받을 수 없습니다. Basic도 OS sandbox를 주장하지 않습니다.

작업은 하나이며 최신 대기 요청으로 coalesce합니다. 저장 후 800ms debounce, 명시적 build는 즉시 요청, 기본 deadline은 120초입니다. `latexmk -pvc`를 상주시킬 필요가 없습니다. stdout/stderr와 log/blg를 제한해 읽고 file:line·classic TeX error·warning을 진단으로 변환합니다. 위치가 추론된 경우 정확한 column으로 꾸미지 않습니다.

```text
<project>/.texypaper/build/<rootId>/
  work/                       mutable compiler output
  published/<buildId>/        immutable PDF / SyncTeX / fls / manifest / snapshots
```

시도 전 알려진 workspace text input을 stream-copy하고 SHA-256을 기록합니다. `.fls`로 실제 의존성을 확인하고 새 입력이 있으면 완전한 snapshot을 갖춘 강제 안정화 빌드를 제한된 횟수만 수행합니다. 빌드 중 파일 변경 또는 불안정한 입력은 PDF를 읽을 수 있더라도 `mappingReady:false`로 남길 수 있습니다. 성공 exit 없이 이전 PDF만 있다는 것은 성공이 아닙니다.

manifest에는 workspace/build/root/engine/cwd/jobName/시각, PDF·SyncTeX hash, source path/hash/snapshot path와 `mappingReady`가 있습니다. PDF와 정확히 대응하는 SyncTeX 및 manifest가 준비된 후 publish합니다. root별 마지막 두 성공 세대를 유지합니다. 실패·취소는 마지막 성공 세대를 stale 상태로 유지하고 journal/recovery와 렌더 cache는 별도 수명으로 관리합니다.

## 7. PDF 전달과 메모리 경계

`lib.rs` artifact grant는 workspace+epoch+build와 임의 토큰에 묶인 endpoint입니다. webview가 임의 disk path를 URL로 요청할 수 없습니다. native는 HEAD/단일 Range, 206/Content-Range/길이, 범위 밖 416을 처리하고 unbounded GET은 `RANGE_REQUIRED`로 거부합니다. 한 응답은 최대 1MiB입니다. Export PDF는 별도 native disk-streaming 동작입니다.

SSH artifact는 native 디스크 cache로 chunk 단위 전송하고 hash를 확인합니다. renderer에 full PDF를 base64 IPC·React 배열·중복 JSON buffer로 전달하지 않습니다. `artifactTransport.ts`는 첫 ≤64KiB와 `PDFDataRangeTransport`, 64KiB 후속 요청, 동시 fetch 2개와 제한 queue를 사용합니다. `disableAutoFetch:true`, `disableStream:true`로 무제한 초기 다운로드를 피합니다.

`pdfjs-dist@6.5.438`의 worker/cmaps/fonts/WASM은 같은 앱 번들에서 로드합니다. optional 별도 renderer worker를 시작하지 않습니다. 한 live document와 parser worker를 사용하며 XFA를 켜지 않습니다. PDF의 action을 실행하는 브라우저/frame을 열지 않습니다. 외부 링크는 사용자가 명시적으로 요청하고 native URL 정책을 거칩니다. CSP는 원격 script/frame을 허용하지 않고 CodeMirror/PDF 배치에 필요한 style과 bundled WASM을 제한적으로 허용합니다.

| 대상 | 구현된 경계 |
| --- | --- |
| source | 단일 mounted EditorView; 비활성 clean state 최대 8개, cache 약 8MiB; dirty 미강제 폐기 |
| PDF canvas | 현재 페이지와 앞뒤 이웃, 최대 3개, 추정 RGBA 48MiB; DPI/zoom에 따라 backing ratio 제한 |
| PDF text | 보이는 페이지의 text layer; 검색은 페이지별·취소 가능, 결과 최대 200개 |
| range 전송 | 첫 64KiB, 후속 bounded chunk; teardown 시 fetch abort |
| build | 하나의 활성 compiler와 최신 pending 요청; log tail 256KiB |
| AI | 하나의 작업, 프로세스 on demand, JSON line 1MiB 제한, stderr 64KiB, 20분 deadline |
| 승인 명령 | 활성 1개, 승인 대기 8개, 완료 기록 20개, stdout/stderr 각각 16KiB tail, 기본 120초·최대 1200초 |
| history/UI | 디스크 history paging, 렌더 이벤트 수/bytes 제한, 가상화 tree/comment/history |

PDF 교체는 선택 무효화 → 진행 render/text 작업 cancel 및 대기 → canvas backing store/DOM 제거 → 이전 `loadingTask.destroy()` → 새 document 활성화 순서로 정리합니다. page cleanup은 해당 render가 멈춘 뒤 수행합니다. 물리 페이지·zoom·페이지 내 scroll fraction은 유지합니다. 참고 PDF와 빌드 PDF는 한 live viewer를 공유합니다.

이 수치들은 총 RAM 상한이 아닙니다. 목표는 표준 release workload에서 TexyPaper+전용 WebView2+앱 도움 프로세스의 **private working set 최대 300MiB**입니다. `resources.rs`와 `measure-memory.ps1`는 앱·WebView2·SSH·TeX·AI 및 전체 비용을 구분합니다. commit과 private working set은 다른 metric입니다. 원격 worker/TeX 비용은 원격이라고 표시해야 하며 Windows 측 0을 전체 비용 0으로 해석하면 안 됩니다. 실제 달성 여부는 20초 warm-up 후 120초 이상 표본·반복 전환·high-DPI·실제 AI 실행 증거가 있어야 합니다.

## 8. PDF prose edit의 증명 범위

`selection.ts`는 선택 방향·text item offset·visual line rectangle과 페이지 viewport를 고정합니다. 회전·page origin·UserUnit을 고려해 역변환하며 지원하지 않는 geometry를 zoom 나눗셈으로 추측하지 않습니다.

`latex/prose_map.rs`는 다음을 결합합니다.

1. 선택의 build ID·PDF SHA-256과 현재 manifest/source hash 일치.
2. 선택의 처음/끝/중간 줄에서 inverse SyncTeX 후보를 보존하고 한 파일·연속 문단으로 제한.
3. 후보 주변 source의 보수적인 TeX lexer. literal prose와 허용 formatting argument만 대상으로 하고 command/math/comment/verbatim·문단·인용·파일 경계를 넘지 않음.
4. NFC·공백·완전한 ligature·줄 끝 하이픈에 대한 역추적 가능한 projection. 선택 전체와 문맥이 유일한 source interval에 대응해야 함.
5. forward SyncTeX로 페이지/사각형 이웃 일치 확인. SyncTeX는 문자 오프셋의 단독 증거가 아님.

결과는 `exact`, `ambiguous`, `unavailable` 중 하나입니다. `exact`의 `proofId`는 workspace/epoch, immutable manifest, source revision, 정확한 byte interval에 묶인 5분짜리 native 기록입니다. 최대 32개로 제한하고 적용 시 전체 관련 소스와 대상 hash를 다시 확인합니다. UI가 원하는 임의 경로/offset의 쓰기 권한으로 바꿀 수 없습니다.

일반 텍스트는 TeX 특수 문자를 escape한 뒤 공통 transaction 경로를 사용합니다. 재빌드 전의 선택은 새 PDF에 옮겨 붙이지 않습니다. ambiguous/unsupported/stale는 원본 무변경이며 원문 후보 탐색·명시적 source editing·사람이 승인하는 AI proposal이 대체 경로입니다. 단독 PDF 댓글은 source edit proof가 아닙니다.

`latex/synctex.rs`는 native CLI 결과 구간과 모든 record를 파싱하고 Windows drive colon·unknown column을 보존합니다. Unicode 대체 구현 `synctex_parser.rs`는 MIT notice를 가진 독립 parser adaptation입니다. native ASCII와 동등 fixture 및 Unicode 검증 게이트 없이 edit-grade mapping에 사용하지 않습니다. 이 게이트가 존재한다는 것과 특정 PC에서 통과했다는 것은 별개입니다.

소스↔PDF 이동은 편집 권한을 만들지 않습니다. `sync_inverse`의 각 record는 native가 빌드 manifest의 `cwd` 기준으로 프로젝트 상대 `path`로 정규화하고, 이 빌드의 source 목록에 없거나 작업 공간 밖이면 `path`를 붙이지 않아 UI가 열지 못합니다. UI는 요청 시점의 workspace epoch·build ID를 다시 확인하고, PDF가 현재 소스보다 오래되면 줄이 어긋날 수 있음을 알립니다. 소스의 `Ctrl+클릭`은 Overleaf 호환 다중 커서이며 동기화는 도구 막대와 `Ctrl+Alt+J`가 맡습니다.

## 9. 댓글의 identity

`.texypaper/comments.json`은 version/revision/threads를 가지며 실제 project host에 저장합니다. 소스 anchor는 path·byte range·base hash·quote와 앞뒤 문맥, PDF anchor는 build ID·PDF hash·page·rects를 사용합니다. message author는 단일 사용자 `me`이며 협업 presence를 만들지 않습니다.

sidecar는 revision-checked transaction으로 저장합니다. 외부 변경을 last-writer-wins로 덮지 않습니다. 앱 소유 소스 변경은 anchor를 변환하고 외부 변경은 같은 파일에서 quote+문맥이 유일하게 일치할 때만 갱신합니다. 삭제/모호함은 orphaned이며 사용자가 재연결합니다. PDF placement는 source-backed 댓글을 현재 immutable build의 forward mapping으로 갱신하고 PDF-only anchor는 본래 hash에 남깁니다. 텍스트는 HTML/Markdown 실행 없이 표시합니다.

## 10. 공식 CLI와 MCP 승인 경계

공급자는 모두 Windows에서 실행하며 private control cwd는 `<app-data>/agent-workspaces/<workspaceId>/`입니다. SSH 프로젝트를 가짜 local cwd로 흉내 내지 않습니다. workspace 내용은 app tools가 필요한 부분만 읽어 전달합니다.

`ai/auth.rs`는 명시적 실행 파일 → 설치된 네이티브 경로 → 알려진 npm entrypoint/PATH 순서로 찾습니다. `.cmd`에 프롬프트를 shell 보간하지 않고 알려진 wrapper는 Node+entrypoint로 실행합니다. provider child environment는 OS/profile/PATH allowlist이고 API-key·alternate endpoint 변수를 전달하지 않습니다.

- Codex는 `<app-data>/providers/codex`의 private `CODEX_HOME`, 공식 account/login API와 ChatGPT 로그인을 사용합니다. OAuth 파일을 읽거나 복사하지 않습니다. `app-server` JSONL은 versioned `src/generated/codex-0.153.2/` schema를 기준으로 해석합니다. private config와 read-only sandbox/approval never, native shell/plugin/skill 등 제한이 적용됩니다.
- Claude는 공식 기존 account store와 `claude auth status`를 사용합니다. `loggedIn`, `claude.ai` 방식과 first-party subscription을 확인합니다. restricted stream-json, built-in tools 비활성화, strict MCP config와 일곱 도구 allowlist를 매 resume에도 적용합니다. 예상 밖 관리 도구가 노출되면 중단합니다.
- `ai/model_catalog.rs`는 GPT-6+에서 CLI metadata와 공식 ID 목록을 합쳐 **각 계열의 최신 숫자 버전만** 남깁니다. Sol 6.1은 Sol 6을 대체하지만 Astra·Luna·Sol Mini 같은 다른 계열·변형을 제거하지 않습니다. CLI metadata에 더 최신 버전이 있으면 공식 보완 목록의 이전 버전도 숨깁니다. Claude는 **Opus·Sonnet·Haiku 5.5만** 허용하며 같은 release의 별칭·날짜 snapshot을 합칩니다. Fable·이전 버전·임의 모델 ID는 목록과 native 요청 검증에서 제외하고 `allowCustom=false`를 반환합니다. Codex `model/list(includeHidden=true)`의 `hidden`은 picker 표시 여부, `upgrade`는 권장 대체 모델일 뿐 그 자체로 제거 사유가 아닙니다. 공식 ID에는 출처와 검토 날짜를 명시하며, 보완 항목은 `catalogSource: "official"`로 구별하고 계정 사용 권한을 보장하지 않습니다. CLI metadata의 모델별 reasoning capability가 없는 항목은 명시적 effort를 허용하지 않고 공급자 기본값을 사용합니다. 목록 밖 모델 ID·미지원 추론 값은 전송 전에 거절하되, 공식 ID의 실제 계정 사용 가능 여부는 공급자가 판정합니다. 선택한 ID를 그대로 보내며 다른 모델로 치환하지 않습니다. Claude는 `--effort`, Codex는 thread start/resume의 `model_reasoning_effort`와 turn start의 `effort`에 명시적 선택을 전달합니다. 기본값은 effort를 생략합니다. 실패를 API billing이나 다른 공급자 성공으로 바꾸지 않습니다.

`ai/broker.rs`는 `127.0.0.1`의 random port와 256-bit random capability를 사용합니다. 이 capability는 child 환경으로 전달하고 workspace+epoch+task에 scope합니다. bounded length-framed IPC로 bridge handshake와 순서를 검사하며 task 종료 시 expire합니다. 공개 HTTP file server나 디스크 token 파일을 만들지 않습니다. 일반 사용자 코드의 OS 권한까지 격리하는 샌드박스라는 뜻은 아닙니다.

모델에 노출하는 도구는 다음 일곱 개뿐입니다.

| MCP tool | 범위 |
| --- | --- |
| `list_files` | ≤256 metadata 행/페이지, continuation |
| `read_text` | ≤64KiB 결과, 실제 hash·줄 범위·continuation |
| `search_text` | ≤200 일치/페이지 |
| `get_build_status` | build identity·diagnostics·bounded log |
| `propose_changes` | 최대 16파일/변경 text 1MiB, evidence와 base hash가 있는 staged diff |
| `propose_command` | 실제 provider/task가 귀속된 불변 argv·cwd·deadline 제안; UI/native 권한만 실행을 승인 |
| `get_command_status` | 기존 명령의 상태·제한된 실제 출력 조회; 실행·승인 권한 없음 |

MCP 파일 읽기는 private key·`.env*`·credential·`.git` 내부·auth/history/recovery를 제외합니다. `propose_changes`의 쓰기는 `.tex/.ltx/.bib/.sty/.cls/.bst/.bbx/.cbx`에 제한하며 code/results는 읽기 근거입니다. replacement는 명시한 base version에서 `oldText`가 유일하게 일치해야 합니다. model offset을 믿지 않습니다. 별도로 승인한 프로세스는 호스트 계정 권한으로 실행되므로 이 파일 API 정책을 OS 샌드박스로 해석하면 안 됩니다.

**`propose_changes`에는 apply 권한이 없습니다.** tool은 ID를 반환하고 파일이 그대로임을 알립니다. `proposal_decide`는 UI/native만 호출하며 사람이 Apply하면 모든 base hash를 재검사해 공통 journal transaction으로 적용합니다. reject/cancel은 무변경입니다. 모델의 성공 텍스트, provider completion, diff event는 authoritative 파일 적용 증거가 아닙니다.

`execution.rs`의 `deny|ask|session` 권한은 workspace ID+epoch에 묶인 메모리 상태이며 프로젝트 JSON이나 모델 인자로 설정할 수 없습니다. 기본값은 `ask`; `session`은 UI의 별도 위험 확인을 요구합니다. 승인 API는 staged ID만 받으며 argv를 바꾸거나 같은 ID를 재실행할 수 없습니다. 로컬은 Windows Job Object, 원격은 worker의 POSIX process group을 소유합니다. stdin은 닫고 stdout/stderr를 독립적으로 drain하며, 취소·권한 해제·종료는 실제 트리가 멈출 때까지 기다립니다. 원격 결과를 확인할 수 없는 전송 실패는 `COMMAND_REMOTE_UNCERTAIN`으로 표시하고 재실행하지 않습니다. 명령 상태 snapshot은 반복 출력 누적을 피하려고 대화 journal에 저장하지 않으며 현재 연결에서 제한된 결과를 다음 AI 턴에 전달합니다.


작업 전 UI는 저장을 flush하고 선택 문맥·공급자·모델을 고정합니다. 공식 CLI는 공급자 클라우드의 모델로 동작하므로 보내기 자체가 전송이며 별도 동의 단계는 없습니다(0.0.9에서 제거). 보이는 진행/답변만 제한된 history로 남기고 숨겨진 chain-of-thought는 저장하지 않습니다. 현재 실행은 턴 종료 시 transport를 닫고 session/thread ID를 저장해 다음 실행에서 resume하므로 idle prewarm 서버가 없습니다. 취소는 interrupt 후 2초 grace와 owned tree 종료를 사용합니다.

선택 문맥은 암묵적으로 공유되지 않습니다. 사용자가 우클릭이나 `Ctrl+L`로 첨부한 소스 구간(`sources`)과 PDF 인용(`pdfs`)만 `agent_start`의 `context`로 전달합니다(종류별 최대 8개, 전체 JSON 128KiB). native는 각 소스의 읽기 허용과 선택 텍스트의 현재 파일 포함 여부를 검증하고 소스별 base hash를 붙입니다. 복구·읽기 위치 기록과 분리 창 patch는 실행 권한을 만들거나 되살리지 못합니다.

## 11. 설정, 색상과 업데이트

`theme.ts`의 설정은 `settings.json`에 저장합니다. locale `ko|en`, theme `system|light|dark`, light/dark별 palette, 최근 palette, UI zoom, lowPower와 sidebar 폭 등을 관리합니다. `ThemeColors.tsx`는 accent/canvas/surface/sidebar와 프리셋을 제공하며 hex·공통 text 4.5:1·accent 4.5:1·semantic 구분을 검사합니다. 최근 목록은 8개로 제한합니다. 초기화는 사용자 palette와 recents를 지웁니다. text/selection은 유도하고 PDF 종이와 오류·경고·paper mark 의미는 유지합니다.

업데이트는 `updates.rs`가 native HTTPS로 메타데이터를 조회하고 UI가 하단에 알림을 표시하는 기능입니다. 공개 배포 대상은 `https://github.com/HSoo-Kim/texypaper`이며, 저장소와 릴리스 게시 후 production 빌드에서 기본 피드를 주입합니다. 이 문서는 게시 완료나 현재 운영 피드의 응답 성공을 증명하지 않습니다.

- source는 저장된 `updates.feedUrl`, 없으면 compile-time `TEXYPAPER_UPDATE_FEED_URL`입니다. 저장된 빈 값은 fallback하지 않습니다.
- GitHub repository URL은 `/repos/<owner>/<repo>/releases/latest`로 해석합니다. 자체 피드는 `{version,url,notes?}`입니다.
- credentials/query/fragment 없는 HTTPS, stable SemVer, ≤64KiB response, timeout, redirect 거부를 적용합니다. notes는 표시 길이를 제한합니다.
- `updates.json` cache는 feed별 마지막 상태를 저장합니다. 자동 확인은 24시간 throttle이며 수동 force는 간격만 우회합니다. disabled는 네트워크 확인을 하지 않습니다.
- 새 버전의 release URL은 사용자 클릭으로만 열며 download/install/updater 실행은 없습니다. 서명이나 자동 업데이트 인프라를 주장하지 않습니다.

## 12. 디스크 데이터와 운영 전제

| 위치 | 내용과 소유권 |
| --- | --- |
| `%APPDATA%\dev.texypaper.desktop` 또는 `--data-dir` | 클라이언트 소유; 사용자별 격리 |
| `settings.json`, `updates.json` | UI/환경/최근 경로와 update 상태 |
| `webview/` | 해당 앱 세션의 전용 WebView2 profile |
| `workspaces/<id>/state.json` | 탭/view/trash, 파일별 커서·스크롤, PDF identity별 읽기 위치, 패널 layout, 대화 읽기 위치 |
| `workspaces/<id>/recovery/` | 미저장 source와 base hash/불확실한 transaction ID |
| app-data의 index/frontier/history/proposal/session 파일 | 필요한 부분만 읽는 cache·보이는 대화·승인/재개 기록 |
| `workspaces/<id>/agent-history/transmissions.json` | 공급자에게 실제로 넘긴 첨부의 메타데이터(시각·공급자·도구·경로·줄/쪽·바이트·글자 수), 최근 500개. 본문은 저장하지 않음 |
| `providers/codex/` | 공식 CLI 소유 private account/config store; 토큰 직접 처리 금지 |
| `workspaces/<id>/checkpoints/<uuid>.json` | 텍스트 스냅샷(수동 최대 50개, 자동 최대 20개·각 16파일 이하, 400파일·8MiB); 자동 체크포인트는 수동 체크포인트를 밀어내지 않음; 프로젝트에는 쓰지 않음 |
| `agent-workspaces/<id>/` | CLI control cwd와 앱 생성 MCP config |
| 프로젝트 `.texypaper/project.json`, `comments.json` | 실제 호스트의 이동 가능한 설정·댓글 |
| 프로젝트 `.texypaper/transactions/`, `trash/` | 복구/undo 원본, 명시적 삭제의 복원 자료 |
| 프로젝트 `.texypaper/build/`, 클라이언트 artifact cache | host build와 범위 전송용 생성물 |
| 서버 `~/.cache/texypaper/worker/<sha256>/` | 검증한 버전별 Python code; 상시 서비스 아님 |

`WorkspaceStateWriter`는 workspace epoch별로 하나만 두고 소량의 UI metadata를 합쳐 직렬 기록합니다(600ms debounce). 전환·종료 전에 flush하며 scroll마다 소스 전체를 복사하거나 AppShell을 다시 렌더하지 않습니다. native에서 키·범위·상한을 재검증하고 전체 64KiB, editor 64개, PDF 16개로 제한합니다. 로컬과 SSH 모두 위 클라이언트 저장소를 사용합니다. PDF identity는 참고 경로·build ID·SHA-256이고 다른 artifact에 이전 좌표를 적용하지 않습니다. 파일의 명시적 탐색은 복원보다 우선하며 편집 권한·실행 허용·전송 동의는 저장된 읽기 위치에서 복원하지 않습니다.

app-data에는 논문 일부·최근 서버 경로·대화·복구 내용·CLI 인증 상태가 포함될 수 있습니다. 문제 보고에 전체 디렉터리를 첨부하지 마세요. 설정 변경은 작은 JSON을 atomic write하며 프로젝트의 기존 `.gitignore`를 임의로 다시 쓰지 않습니다. 미해결 transaction/recovery를 일반 cache와 함께 삭제해서는 안 됩니다.

### 일회성 legacy migration

이전 Paperdock 앱은 먼저 완전히 종료해야 합니다. 기본 profile 이전은 설정·workspace manager·WebView를 열기 전에 `%APPDATA%\dev.paperdock.desktop`을 새 `%APPDATA%\dev.texypaper.desktop`으로 디렉터리 rename합니다. 새/이전 디렉터리가 함께 있으면 충돌이며, symlink/reparse 및 안전하지 않은 잠금 파일을 거부합니다. 이전 `instance.lock`의 배타적 handle로 사용 중인 profile을 거부하지만 이전 앱의 모든 동시 동작을 제어한다는 보장은 아닙니다. 개별 인증 파일은 열거나 복사하지 않습니다. 명시적 `--data-dir`은 기본 profile 이전을 건너뛰고 debug 실행은 격리 data-dir을 요구합니다.

Windows는 하위 파일 handle이 열린 디렉터리의 rename을 거부합니다. 따라서 상위 디렉터리의 migration guard를 유지한 채 이전 instance 잠금을 검사하고 닫은 다음 디렉터리를 이동하고 새 위치의 instance 잠금을 얻습니다. Unix에서는 이동 중에도 기존 잠금 handle을 유지합니다. 이전 앱을 이전 도중 다시 실행하지 않아야 하며, 이 절차를 서로 다른 클라이언트 전체의 동시 쓰기 잠금으로 간주하지 않습니다.

프로젝트는 local/remote 모두 root 등록 시 recovery보다 먼저 `.paperdock`에서 `.texypaper`로 이전합니다. 새 디렉터리가 없을 때만 rename하고 둘 다 있으면 병합·삭제 없이 거부합니다. 내부 symlink/escape와 잘못된 인식 레코드를 거부하며, 중단 후 다시 열었을 때 남은 인식 경로 보정은 재개할 수 있습니다. 인식한 journal/manifest의 private 경로만 바꾸고 소스·설정·댓글·message text·backup/trash bytes는 보존합니다. workspace identity 해시는 기존 프로젝트와 동일하게 유지합니다. 기존 PDF는 남기되 이전 metadata 경로를 포함할 수 있는 opaque SyncTeX/cache 때문에 `mappingReady`를 해제하고 새 빌드로 다시 증명하게 합니다. 두 metadata 이름은 모두 탐색 제외·AI private-data 보호 대상입니다.

이전 실패는 명시적인 오류로 남습니다. Native는 `MIGRATION_CONFLICT`, `MIGRATION_UNSAFE_PATH`, `MIGRATION_INVALID_RECORD`, 실행 중 profile에는 `PROFILE_IN_USE`를 사용합니다. 원격 worker의 대응 프로젝트 오류는 `METADATA_MIGRATION_CONFLICT`, `METADATA_MIGRATION_UNSAFE`, `METADATA_MIGRATION_INVALID`입니다. 트랜잭션의 `backup`/`stage`가 단순 basename인 형식은 경로가 아니므로 치환하지 않습니다.


Windows MSVC/WebView2, 로컬/원격 TeX와 글꼴, POSIX Python, OpenSSH 인증, 공식 provider 버전·구독 login, CDP 허용 정책은 외부 전제입니다. 일반 desktop/SSH/agent/preferences/memory suite는 보이는 앱 창을 실행하므로 사용자 허가가 필요하며 background/headless 검증에 사용하지 않습니다. 트레이 자동화의 기존 headed 안전 게이트도 유지합니다. smoke 도구는 `--output`/`-OutputDirectory`로 선택한 새 디렉터리에서 합성 fixture를 사용합니다. SSH smoke는 loopback SSH+WSL 실제 worker이며 live-agent gate는 실제 subscription inference가 필요합니다. 도구 누락이나 인증 실패는 nonzero/실패 기록으로 남겨야 합니다. 설치 파일 생성, 설치된 앱 실행, Unicode source mapping, host-key 처리, 접근성, 실제 모델의 local/SSH proposal, RAM 목표는 각각 별도 증거가 필요한 acceptance gate입니다.

## 13. 맞춤법·그림 가져오기·체크포인트·바꾸기

- **맞춤법:** 검사 대상은 `proseRanges.ts`가 TeX 명령·수식·주석·verbatim·키를 건너뛰고 뽑은 UTF-16 구간뿐입니다. `spell_status`는 Windows 팩토리에 en-US/en-GB 검사기가 있는지 보고, 없을 때만 내장 영어 사전(SCOWL en_US, `spellbook` crate)을 첫 검사 때 지연 로드합니다. 상태 조회는 사전을 파싱하지 않습니다. Windows COM 검사기는 전용 MTA 스레드 하나에서만 호출합니다(대기 8건, 15초 제한). 공용 blocking 스레드에서 COM을 MTA로 초기화하면 같은 스레드에서 나중에 여는 파일 대화상자가 `RPC_E_CHANGED_MODE`로 실패했기 때문입니다. 대화상자는 `dialogs.rs`가 호출마다 새 STA 스레드에서 열고, 실패하면 `DIALOG_UNAVAILABLE`을 돌려줍니다. 모든 검사는 Windows 클라이언트에서 실행하므로 SSH 프로젝트의 파일 내용이 서버 밖의 다른 서비스로 나가지 않습니다. 무시 목록은 앱 설정이며 Windows 사용자 사전은 수정하지 않습니다.
- **프로젝트 바꾸기:** 미리 보기는 읽기 전용이며 적용은 기존 `apply_proposal` 트랜잭션에 사용자 편집(`action:edit`)을 최대 16파일 보냅니다. 모든 base SHA-256이 쓰기 전에 다시 검사되고, AI 경로의 TeX/Bib/style 제한은 그대로입니다.
- **그림 가져오기:** 텍스트 전용 `create`를 쓰지 않고 `asset_import_begin/chunk/commit/abort`로 청크 업로드합니다(20MiB, 확장자 허용 목록, 덮어쓰기 금지, 해시 검증, 하드 링크 후 unlink로 원자적 공개). SSH는 base64 청크를 worker가 원본 바이트로 다시 씁니다.
- **체크포인트:** 저장은 `checkpoint_put/list/get/delete`가 app-data에서 검증합니다. 사용자가 만든 수동 체크포인트와 별도로, AI 제안 적용·프로젝트 바꾸기·PDF 원문 수정·복원 직전에 바뀔 파일만 담은 자동 체크포인트(`kind:auto`, `partial`, `reason`)를 만듭니다. PDF 원문 수정은 자동 체크포인트를 만들지 못하면 적용하지 않습니다. 복원은 먼저 바뀔 파일을 "복원 전" 자동 체크포인트로 저장한 뒤 `apply_proposal`로 한 트랜잭션(최대 16파일)을 쓰며 추가된 파일은 지우지 않습니다.
- **템플릿:** 존재하는 폴더에서 충돌을 먼저 확인하고 `file_create`/디렉터리 생성만 사용합니다. 덮어쓰기 경로가 없습니다.

