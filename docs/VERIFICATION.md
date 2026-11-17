# Verification — TexyPaper

Evidence is generated under ignored `artifacts/` directories. The scripts use isolated synthetic papers or disposable copies of immutable snapshots, with separate app-data; no original user paper is a writable fixture. A passing unit suite is not presented as proof of a desktop, SSH, model or installer interaction.

## 0.0.13 release checks

Observed on Windows x64, 2026-11-18: Node 24.14.0, pnpm 12.16.1, frozen dependency installation with lifecycle scripts disabled, **659 frontend tests**, production TypeScript/Vite build, `cargo fmt --check`, all-target Clippy with warnings denied, and **176 Rust tests** passed. The locale-specific CP949 case was explicitly skipped, matching CI's documented exclusion.

The feature/latency qualification below used private builds labelled 0.0.12 before the release-version increment; those original executable hashes and measurements are preserved. Version 0.0.13 does not relabel those measurements as a fresh benchmark.

## 0.0.13 qualification — irregular input / fresh CorTeX comparison

Observed on Windows x64, 2026-11-17, experiment **R01/E07**. The actual [CorTeX website](https://cortex.corca.ai/#features) and the optimized TexyPaper/WebView2 executable received identical synthetic one-page and thirty-page projects: `main.tex`, an included `body.tex`, a bibliography and a cross-reference. No original paper or user profile was used or uploaded.

Each document received seven warm edits followed by 24 cumulative irregular inputs. Requested gaps ranged from 25 to 3,500 ms, including both sides of the 1,000 ms native-build threshold and resumed input during full builds. The endpoint is trusted `beforeinput` to matching changed text in a rendered PDF canvas, not a worker reply. Saved source, captured PDF bytes, visible word geometry and the final full PDF were checked separately. Explicit adjacent-line hyphenation is recognized without treating clipped or unrelated fragments as visible text.

| Physical pages | TexyPaper warm median (ms) | CorTeX warm median (ms) | TexyPaper irregular median (ms) | CorTeX irregular median (ms) | TexyPaper irregular maximum (ms) | CorTeX irregular maximum (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 136.1 | 927.2 | 123.85 | 643.80 | 219.5 | 1,100.3 |
| 30 | 123.9 | 568.3 | 120.25 | 622.75 | 176.5 | 1,147.4 |

The irregular median was **5.20× / 5.18× faster in these two cases**. Both warm medians passed the predeclared ≤1.10× CorTeX threshold. This is a scoped measurement, not a general performance ranking.

### Correctness and fixes

- All 48 TexyPaper irregular inputs survived exact saved-source and final full-PDF verification. The final PDFs retained the expected one/thirty physical pages. Nineteen and twenty inputs respectively arrived during native builds; no forced-overlap substitute was needed.
- Both products had **zero visible prefix regressions** in the final comparison. TexyPaper's irregular p95 was 166.6 / 172.8 ms.
- Earlier native attempts exposed a real stall after native publication: a `mappingReady:false` manifest incorrectly rejected otherwise verified immutable input snapshots and destroyed the warm worker. Local and POSIX input authorization now remains independent of native mapping proof; identity, path, size and content checks remain.
- A subsequent complete thirty-page run still showed two regressions from `IRREG019` back to `IRREG017`, with a 1,503.5 ms maximum. The controller now retains already displayed immutable frames while reconciling a new bundle. The renderer retains authorized partial canvases while renewing the native backdrop, rather than rejecting a previously accepted frame or stopping its page work. Newly completed obsolete frames remain fenced.
- Compatible native turnover no longer discards resident checkpoints. Removed or changed non-TeX inputs still require a full SDK pass. Unverified bundles, cancellation, conflict and scope changes retain their invalidation guards.
- Targeted checks passed: **46 controller tests**, **6 partial-page tests**, **4 Rust preview-input tests**, Rust formatting, production TypeScript/frontend compilation and the optimized Windows build. A real POSIX worker check served original immutable bytes with `mappingReady:false` and rejected foreign workspace, missing root, foreign-generation snapshot and missing snapshot inputs. This was not an SSH-network latency measurement.
- Final native and CorTeX split screenshots were inspected. CorTeX performed actual partial PDF compilation followed by full reconciliation; it was not merely replacing source text with HTML.

### Conditions and limits

Both renderers used a 2036×982 CSS viewport at DPR 1.25, with file/AI sidebars closed. PDF-pane widths were not equal, and Chrome and WebView2 are different renderers. Requested schedules matched; actual inter-input gaps differed because of automation overhead: TexyPaper 45.5–3,513.3 / 29.7–3,510.2 ms, CorTeX 61.8–3,522.8 / 61.3–3,537.8 ms. This does not establish cold-start, arbitrary-paper, SSH-network, IME or all possible cadence guarantees.

Evidence under `artifacts/4-irregular-comparison/`: `0-protocol.json`, `0-matched-viewport.json`, `0-comparison.json`, `11-cortex/verified-results.json`, `15-texypaper/verified-results.json`, captured PDFs and screenshots. Earlier incomplete runs and the regressing `13-texypaper` run are retained, not substituted into the final comparison.

Lab runs: CorTeX `20261117-044453-desktopdo7eho9-b613`; final TexyPaper `20261117-051344-desktopdo7eho9-e323`. Hidden verification executable: `14-hidden/texypaper.exe`, SHA-256 `3a72f4505bd43597b509c74191c23f36fb21480b5baffb34eb701dbdf4d13e16`.

Reproduce native measurement through `lab run -e R01/E07 --by <agent> -- python scripts/measure-irregular.py --kind texypaper --binary <hidden-start.exe> --protocol <0-protocol.json> --comparison <0-matched-viewport.json> --output <new-directory>`. CorTeX uses the same wrapper with `--kind cortex --script <fresh ego-browser task entrypoint>`; fixture changes are untimed and wait for the actual editable CodeMirror model. `--validate-only` rechecks complete existing raw data without running UI input or overwriting raw evidence.

### Local installation

The normal visible-startup **0.0.12** executable and NSIS/portable packages were rebuilt separately from the hidden measurement executable. Packaging verified all **732 payload files**, license/source companions, archive contents and exclusion of the hidden executable. Packages are unsigned and were not published to GitHub.

The installer exited 0 and updated `C:\Users\ADMIN\AppData\Local\TexyPaper\texypaper.exe`. Installation required no running TexyPaper process and the exact previous installed hash; no user process was terminated. Every installed payload matched the verified portable package, allowing only Tauri's three-byte `NSS` versus `UNK` executable bundle marker. Installed executable SHA-256: `9580aa3fc57339555beecd164197742c65657988a55b2f2075b57a9b369734b5`.

An isolated-app-data launch of that installed executable confirmed a visible native window, rendered home screen and the exact verified PDF-renderer asset hash. The screenshot was inspected and only the smoke-owned process tree was closed. Evidence: `16-package/package-proof.json`, `17-installed-payload.json`, and `18-installed-startup/installed-startup-proof.json` under the same experiment artifact directory.

## 0.0.13 qualification — page-priority refresh / 현재 쪽 우선 갱신

Observed on Windows x64, 2026-11-17. E06 reused E05's immutable, hash-checked 47-input CAS paper snapshot in separate disposable local copies. Both runs used basic/pdfLaTeX, fresh app-data, a 1440×900 source/PDF split with the file tree retained, and five warm body-text edits. No original paper/profile was modified, and no paper was uploaded.

| Measurement | Prior installed logic, measured again | Page-priority candidate |
| --- | ---: | ---: |
| Input → visible changed PDF, median | 786.1 ms | 195.3 ms |
| Input → visible changed PDF, maximum | 9,520.1 ms | 260.9 ms |
| First-visible frames from the resident engine | 4 / 5 | 5 / 5 |
| First-visible partial frames | 0 / 5 | 5 / 5 |
| Intermediate frames during 60 uninterrupted inputs | 7 | 49 |
| Authoritative native PDF completion, median | 4,936.1 ms | 5,775.8 ms |

Warm visible-refresh latency fell **75.2% (4.03×)** in this case. All five candidate samples were 182.9–260.9 ms. The baseline's native-fallback outlier is retained, not discarded. The initial local document has **32 physical pages**; edits on page 6 produced an actual partial PDF covering pages 1–7, while the viewer retained the full document's page navigation. This is checkpoint reuse plus bounded-prefix compilation, not a claim that arbitrary TeX pages can be compiled independently.

Automatic full builds now wait for **1,000 ms of input inactivity** where resident preview is eligible. Durable autosave is unchanged; explicit builds, first builds and unsupported profiles are not delayed by this queue. The tradeoff is visible in the longer authoritative completion above. Export remains unavailable on provisional frames and returns on the verified native PDF.

### Correctness evidence

- All five edits and the 60-input burst preserved the exact expected saved source. The burst produced 49 intermediate frames and **zero native build starts during typing**.
- Canonical and partial PDFs passed bidirectional source/PDF navigation, cross-file navigation, visible click/line markers, focus preservation, drag selection and double-click selection.
- Navigating beyond the fresh page-7 boundary to physical page 9 requested an expanded partial PDF; its actual coverage reached page 10 without changing the source. Pages outside the accepted partial span retain the previous full result, are marked stale, and cannot supply current search or source-mapping results.
- A preamble edit refused the unsafe partial path and produced a successful full resident PDF before the authoritative native PDF. A deliberately invalid command preserved the last good frame; repairing it restored a canonical PDF and exact saved bytes.
- The affected source-only suite passed **57 tests**: 37 resident-controller, 10 live-mapping, 6 partial-page and 4 automatic-build tests. The production TypeScript/frontend and hidden Windows release build passed. No Rust code changed in this increment.
- Screenshots of partial forward navigation, expanded coverage and recovered canonical output were inspected. The changed-surface UI detector exited 0 with no findings.

Evidence: `artifacts/3-page-preview/1-baseline/live-project-results.json`, `3-candidate/live-project-results.json`, and `3-candidate/{live-forward,live-inverse,expanded-partial,final-project}.png`. Lab runs: baseline `20261117-015934-desktopdo7eho9-d5db`, candidate `20261117-020603-desktopdo7eho9-f4e6`. Hidden verification executable: `2-hidden/texypaper.exe`, SHA-256 `b7d0318c5676d37648d929946cc6588a4d44c93e43d6c2dba65dc6b1852ecbab`.

Reproduce through `lab run -e R01/E06 --by <agent> -- python scripts/measure-live-project.py --binary <hidden-start.exe> --snapshot <authorized-immutable-snapshot> --headless <actual-bundled-headless-module> --output <new-directory> --variant page-priority --mode page-priority`.

**Limits:** five warm samples from this local paper are not a latency guarantee for arbitrary documents, cold initialization or the user's real SSH transport. The fresh-app scenario took 26.1 s to reach full resident readiness; this is not time to the first native PDF and is not claimed as improved startup. CorTeX was not measured on this same paper. Checkpoint retention observed in the baseline was approximately 43–46 MiB with no budget refusals; restoring the SDK's default 320 MiB retained-checkpoint ceiling provides headroom, not an evidenced explanation for this speedup or a total-RAM limit.

### Local installation

The normal-start Windows x64 NSIS build passed and was installed locally, retaining version **0.0.12**. No GitHub release or live CI run is claimed.

- Packaging verified **732 payload files**, normal-start identity, corresponding-source companions and exclusion of the hidden verification executable. The installer is 188,898,926 bytes; installer and portable package remain unsigned.
- Immediately before installation, no TexyPaper process was running and the installed executable matched the E05 baseline. The installer exited **0**; no user process was terminated.
- All **732 installed payload files** matched the verified portable ZIP, allowing only Tauri's expected unique `UNK`→`NSS` executable bundle marker. Installed path: `C:/Users/ADMIN/AppData/Local/TexyPaper/texypaper.exe`; SHA-256 `c6b8f6358c6c400b3aad0868a71c864808218e23e13da834ca09ca66a05ee150`.
- The installed executable opened a visible, responsive window with disposable app-data. Settings opened and closed, the bundled manifest had the expected derived engine identity, and the offline legal frame exposed both source archive and patch links. This did not use a user project/profile or native download/save dialog.

Evidence: `artifacts/3-page-preview/4-package/{release-manifest,package-proof}.json`, `5-installed-payload.json`, and `6-installed-startup/installed-startup-proof.json` plus screenshots. A relative import typo in the one-off startup probe failed before app launch; correcting the probe alone produced the passing startup check. The one-off probe was removed after verification.

E06 concluded **supported** for the stated warm, local workload. `lab ls --pending` reported **164** human-review records across the research history, with no unexplained configuration differences shown. No reviews were approved automatically.


## 0.0.13 qualification — actual-paper refresh and click locations / 실제 논문 갱신·위치 표시

Observed on Windows x64, 2026-11-16. The user's reported slowness was reproduced with a read-only, hash-checked copy of the 47 published inputs of the real CAS-class paper, not dismissed using the earlier synthetic benchmark. All edits were confined to a new disposable local copy. No paper was uploaded to CorTeX or a cloud compiler.

### Matched actual-paper result

Both executables used the same immutable input snapshot, basic/pdfLaTeX profile, fresh app-data, 1440×900 source/PDF split with the file tree retained and AI pane closed, and five warm body-text edits. The endpoint is actual `beforeinput` to the changed PDF text/canvas being visible in the viewport. The prior installed logic is retained in a hidden-start baseline binary; the final candidate also uses hidden startup solely to avoid disturbing the user's desktop.

| Measurement | Prior installed logic | Final candidate |
| --- | ---: | ---: |
| Input → visible changed PDF, median | 5,150.4 ms | 774.5 ms |
| Input → visible changed PDF, maximum | 9,829.8 ms | 808.9 ms |
| Warm samples that displayed resident PDFs | 0 / 5 | 5 / 5 |
| Intermediate resident frames during 60 uninterrupted inputs | 0 | 7 |
| Authoritative native PDF completion, median | 5,150.4 ms | 5,184.5 ms |

Visible-refresh latency fell **85.0% (6.65×)** for this case. This is not a faster final native build: export still waits for the authoritative PDF. Both local engines produced the complete **32-page** document. The original remote TeX Live 2023 publication has 30 pages; these local TeX Live 2026 measurements neither establish identical remote layout nor measure the user's real SSH transport. The earlier synthetic CorTeX comparison below is a different workload; no same-paper CorTeX comparison is claimed.

### Failures found and verified corrections

- CAS package thumbnails such as `thumbnails/cas-email.jpeg` were rejected by both the native provider and the upstream worker, silently leaving the preview on the slower native path. Safe relative package resources now work locally, without forwarding relative paths to a cloud mirror. Bounded installed filename databases avoid repeated `kpsewhich` startup for unambiguous lookups; ambiguous/unsupported lookups retain native resolution.
- Continuous input previously invalidated every completed resident result. Completed immutable frames now publish monotonically within the current native generation while newer edits coalesce.
- The first continuous-input check caught reordered characters: PDF replacement cleared the document-global DOM selection and reset CodeMirror's caret. Selection clearing is now restricted to selections wholly inside the PDF pane. The same exact-saved-text assertion passed after the fix; it was not weakened.
- Plain PDF clicks show a point marker and highlight the corresponding source line; plain source clicks show the matching PDF rectangle. Actual canonical **and** resident frames passed cross-file navigation, pane-focus preservation, drag selection and double-click selection checks. Mapping uses the displayed frame's own SyncTeX and matching immutable inputs; pending or invalidated mappings show status instead of stale coordinates.

The five edits and the 60-input burst preserved the exact expected saved source. The original snapshot remained read-only. Screenshots of the final live forward/inverse navigation were inspected, including the correctly ordered burst text and visible location markers.

| Check | Observed result |
| --- | --- |
| Current-source unit tests | 51 passed: 24 buffer, 19 resident-controller, 8 live-mapping tests; archived copies are excluded from this count |
| Native provider tests | 2 passed |
| Worker source-patch tests | 3 passed, including local resource caching and rejection of traversal/cloud-relative requests |
| Types, production frontend and Rust | TypeScript and hidden-start release build passed; strict library Clippy passed with `-D warnings` |
| Engine integrity | Derived asset verification passed; applying the shipped patch to the upstream archive's controller reproduces the modified generated worker byte-for-byte |
| Actual desktop | Canonical/resident bidirectional clicks, focus, text selection, uninterrupted input order, complete PDF pages and canonical-only export passed |

Evidence under `artifacts/2-live-interaction/`: `5-baseline/live-project-results.json`, `6-candidate/live-project-results.json`, `6-candidate/live-{forward,inverse}.png`, and `source-binding-proof.json`. Lab runs: baseline `20261116-114236-desktopdo7eho9-44ca`, final candidate `20261116-115338-desktopdo7eho9-bc53`. The failed `4-candidate` run is retained as evidence of the caret bug, not counted as a pass. Final hidden verification executable: `caret-fixed-hidden/texypaper.exe`, SHA-256 `6707b3ee855605377a9467aaed07a3d1645244b7390f32f48ba2da0ed7cc345d`.

Reproduction requires an authorized immutable input snapshot: `lab run -e R01/E05 --by <agent> -- python scripts/measure-live-project.py --binary <hidden-start.exe> --snapshot <snapshot> --headless <actual-bundled-headless-module> --output <new-directory> --variant <name> --mode candidate`. The current scenario targets the included methodology file of this snapshot; it is not a general-purpose arbitrary-paper benchmark.

### Local installation

The normal-start Windows x64 NSIS build passed and was installed locally, retaining version **0.0.12**. These changes remain unreleased; no GitHub publication or live CI run is claimed.

- Packaging verified all **732 payload files**, normal-start identity, source/archive/patch hashes and exclusion of the hidden executable. The installer is 188,904,028 bytes; installer and portable distribution are unsigned. Both corresponding-source companions are supplied alongside the binaries.
- Immediately before installation, no TexyPaper process was running and the installed executable still matched the recorded baseline. The installer exited **0**; no user process was terminated.
- All **732 installed payload files** matched the verified portable package, allowing only Tauri's expected `UNK`→`NSS` executable bundle marker. Installed path: `C:/Users/ADMIN/AppData/Local/TexyPaper/texypaper.exe`; SHA-256 `430b996492425f351f63f533604ca3eb4997928ea5ad7e0af2a8e76aaa797309`.
- The installed executable opened a visible, responsive window using fresh disposable app-data. Settings opened and closed; its offline legal frame exposed both the source archive and local patch. The actual bundled manifest reported the expected locally patched release ID. No user project/profile or native download/save dialog was used for this startup check.

Evidence: `7-package/{release-manifest,package-proof}.json`, `8-installed-payload.json`, and `9-installed-startup/installed-startup-proof.json` plus screenshots. The first startup probe incorrectly expected the derived release ID in prose that names the upstream release; the corrected probe reads the identity from the actual bundled manifest and separately checks both offline links. No application change was needed.

E05 concluded **supported** for this stated warm, local actual-paper workload. `lab ls --pending` reported **145** human-review records across the research history, with no unexplained configuration differences remaining. No reviews were approved automatically. One-off diagnostic/startup scripts were removed after retaining their evidence; the repeatable real-project scenario remains documented above.


## Earlier synthetic comparison — source-to-PDF latency / 합성 문서 갱신 지연

Observed on Windows x64, 2026-11-16. The existing source/PDF split is unchanged; no second editing surface was added. CorTeX was measured at [cortex.corca.ai](https://cortex.corca.ai/), not the unrelated `mtybadger/cortex` repository. The resident engine uses the pinned public [WasmTex SDK](https://github.com/corca-ai/wasmtex/tree/b2930ab196d17594eed3beefa0fd00e4f5fb5257).

### Matched visible-refresh comparison

Same Windows machine, synthetic 1-page/30-page documents and seven warm source replacements per case; measured viewport 2036×982, DPR 1.25, source+PDF with side/AI panels closed. The endpoint is actual `beforeinput` to the newly rendered PDF canvas/text containing the changed marker, not a worker response or an HTML imitation. Panes were not claimed to have pixel-identical proportions.

| Document | CorTeX median | Native-only optimized TexyPaper median | Final resident TexyPaper median | Final resident maximum |
| --- | ---: | ---: | ---: | ---: |
| 1 page | 218.3 ms | 803.7 ms | 138.1 ms | 143.0 ms |
| 30 pages | 217.2 ms | 819.3 ms | 155.6 ms | 158.7 ms |

The predeclared visible-refresh threshold (both medians ≤1.10× CorTeX) passed. All 14 final samples displayed real resident PDFs; both provisional and canonical page counts matched the complete fixture. Every final source file matched the saved input bytes. Export was disabled on provisional frames and restored on the verified host PDF.

**Different endpoints:** CorTeX displays a compiled prefix before its final full PDF. Its observed 30-page final completion median was 719.5 ms. TexyPaper's final authoritative PDF medians were 826.4 ms/828.7 ms for 1/30 pages. The result above is faster visible refresh, **not** faster final authoritative export. Cold worker/package initialization, arbitrary papers, complex packages/fonts and total RAM were not benchmarked by this comparison.

Evidence: `artifacts/1-live-latency/19-final-matched/`; CorTeX `C:/Users/ADMIN/ego/cortex-latency-20261116/measured-8/`. Lab runs: CorTeX `20261116-024714-desktopdo7eho9-7e26`, native-only `20261116-024824-desktopdo7eho9-b4e7`, final resident `20261116-050017-desktopdo7eho9-b8b4`.

### Correctness and integration

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Source checks | 63 affected buffer/PDF tests passed; after adding error-vs-warning cases, all 8 resident-controller tests passed. TypeScript and production frontend build passed | Targeted Vitest runs; Tauri output |
| Native checks | 11 scheduler tests plus the preview-input and package-provider path tests passed; Rust format, strict library Clippy and Python worker syntax passed | Cargo/AST output |
| Local runtime | 8 safeguards passed: same-size/same-mtime external edit, bibliography change, error retention/recovery, rapid typing, edit/save during a build, cancellation retention/recovery | `15-resident-safe-guards/local-short/refresh-checks.json` |
| Reading position | After fast/native replacements, page 10 and 125% zoom remained selected; the saved source and newly compiled PDF were checked | `15-resident-safe-guards/local-long/reading-position-preserved.png` and its result entry |
| SSH runtime | All 8 safeguards passed using real OpenSSH, loopback SSH and the Python/TeX worker in WSL; 7 warm edits all displayed resident PDFs, median 149.4 ms at the separate 1440×900 correctness layout | `18-resident-ssh/latency-results.json` |
| Offline legal surface | The actual settings iframe exposed the pinned release and bundled corresponding-source link and closed normally; no native download/save dialog was exercised | `17-offline-notices/notices-proof.json` |
| Dependency installation | Frozen install with dependency lifecycle scripts disabled passed; the pinned SDK patch is recorded in the lockfile. Windows build-script syntax passed | `pnpm install --frozen-lockfile --ignore-scripts`; PowerShell parser |

Runtime evidence paths in this table are under `artifacts/1-live-latency/`. Together the local and SSH correctness runs passed **17 scenarios**. The final hidden verification executable is retained under `verified-hidden/`, SHA-256 `c006c8c2e227133a9badc27ec9d49f8787bad3e2e437f87c6a1aabdcb772ff38`; it is not a distribution binary.

The investigation caught and fixed three real integration failures: Windows verbatim executable paths prevented `kpsewhich` from locating TeX; SDK `success` plus a produced PDF could still contain TeX errors, so both progress and final error diagnostics are now rejected; the remote reader incorrectly expected hyphenated UUIDs even though the worker publishes 32-character hex IDs. Successful local cases were retained when only the failed SSH case was resumed. An initial notice probe counted the upstream mirror as a second offline source link; the corrected probe targets the actual `download` link.

Earlier native-only optimization at 1440×900 reduced medians from 3762.2→837.6 ms (local 1 page), 3760.1→827.9 ms (local 30 pages), and 2139.7→587.5 ms (SSH 1 page), with the original 17 safeguards passing. Those numbers use a different layout from the matched CorTeX comparison and are not mixed into its ratios.

**Limits:** Basic automatic preview needs compatible local TeX Live 2026 packages. Unsupported profiles, parent-directory inputs, unavailable packages/fonts or engine failures retain the verified native path. Fast previews do not grant export, comment-anchor or SyncTeX authority. Input and retained-checkpoint bounds are not total-RAM limits. No user paper/profile, clipboard, physical tray menu, native save dialog or cloud compiler was used for these tests; no public release or live GitHub CI run is claimed.

### Local distribution and installation

The normal-start Windows x64 build was packaged as version **0.0.12** and installed locally; these changes are still **unreleased**, not a new GitHub release. The hidden verification override was omitted. The installer and portable distribution are unsigned.

- Packaging verified all **731 payload files**, license/source hashes, normal-start identity and exclusion of the hidden binary. The 188,876,044-byte installer and portable ZIP include the pinned engine and complete corresponding source; the matching 154,968,364-byte source archive is also supplied beside them.
- The installer exited **0** after confirming no TexyPaper process was running; no running user instance was force-terminated.
- Installed at `C:/Users/ADMIN/AppData/Local/TexyPaper/texypaper.exe`. Every installed payload file was compared against the verified portable ZIP. The executable differs only by Tauri's expected three-byte `UNK`→`NSS` bundle marker; installed SHA-256: `088ec54ed0664484a9917bc99bd5ea7339f2077f3b5c404323840b5e0fbabcdc`.
- The **installed executable** was then launched with disposable app-data. The native window reported visible; settings, the bundled offline corresponding-source link and settings close worked. This did not open a real user paper or use the user's app profile. No source download/save dialog was tested.

Evidence under `artifacts/1-live-latency/`: `21-local-package/release-manifest.json`, `21-local-package/package-proof.json`, `22-installed-payload.json`, and `22-installed-startup/notices-proof.json` plus its screenshot. E04 concluded **supported** for the stated warm visible-refresh hypothesis; `lab ls --pending` reported **111** human-review items. No reviews were automatically approved.



## 0.0.13 qualification — paper workflow tools / 논문 작업 도구

Observed on Windows x64, 2026-11-16, before public release. Feature smoke checks used a hidden-start build, disposable local/SSH papers and separate app-data directories; no user paper, normal profile, clipboard, native file dialog or live AI provider was used as a test input. On the user's subsequent request, a normal-start build was installed locally with the version label remaining 0.0.12.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Source tests and types | TypeScript passed. The affected current source paths passed 339 tests in 24 files, including 103 new tests for bibliography/preflight, corpus boundaries, tables, review export and writing tasks | `pnpm typecheck`; targeted Vitest run |
| Production build | Frontend production build and Windows x64 release compilation passed for both hidden verification and normal-start NSIS builds | Tauri build output; `artifacts/paper-tools-check/hidden.json`; `artifacts/paper-tools-local-install/package/` |
| References | Both hosts found an unopened nested bibliography by title, excluded a hidden bibliography, inserted the selected citation, preserved CRLF and restored exact bytes with one undo; duplicate keys were disabled | `artifacts/paper-tools-run-02/paper-tools-results.json` |
| Tables | Both hosts rejected ragged input, escaped special characters and multiline cells, inserted/undid the table as one operation, and compiled an actual PDF. A separate valid 80,007-character input expanded past 1 MiB, was saved without truncation and undone exactly | Same result file; `local/compiled-table.png`, `ssh/compiled-table.png` |
| Preflight | Both hosts found missing citations/labels, duplicate keys/labels and TODOs; navigation placed the caret on the reported source line. After repairs and a build, findings cleared and the current build was recognized; later edits required a rebuild | Same result file; `local/preflight-findings.png` |
| Review report | Both hosts exported the saved original comment, reply, resolved status and source location. File content exactly matched the preview, an existing report was preserved, comment storage was unchanged, and Escape closed the dialog after saving | Same result file; `local/review-report.png` |
| Writing presets | All four presets appended without overwriting the draft or attachments and left the agent idle. A combined prompt over 65,536 characters was refused without truncation | Same result file; `local/academic-draft.png` |
| Safety and layout | Both hosts refused insertion after an external source change and into a read-only file, disclosed an incomplete scan and disabled citation insertion. Keyboard focus stayed in the dialog, which fit the 960×640 dark viewport | Same result file; `local/table-dark-960.png`, `local/workspace-dark-960.png` |
| Local installation | Verified all 655 package payload files, installed silently with exit code 0, matched the installed executable to the package and verified all 654 resource files. The old app was already closed; no forced termination or profile reads were performed by the installer script. The installed app opened a responsive visible window and remained running after the installer script exited. Version display remains 0.0.12; no GitHub release was created | `artifacts/paper-tools-local-install/local-installation.json`, `package/package-proof.json` |

Final desktop run: **14 scenarios passed, 0 failed**. The UI detector reported no findings for the changed surfaces. Screenshots were inspected for the reference dialog, generated PDF, report, AI draft and small-screen dark layout.

The first desktop run passed 6 of 12 scenarios. Its navigation assertion looked for a CodeMirror active-line extension this app does not install; it now checks the actual caret's source line. A product bug also left focus outside the report after the Save button became disabled, so Escape did not close it and blocked two subsequent scenarios per host. Saving now moves focus to the preview before disabling the button, and the smoke explicitly verifies closing. The first type check found case-insensitive module resolution collisions on Windows; pure helper modules were renamed to `delimitedTable.ts` and `reviewReport.ts`.

The targeted Vitest command also discovered archived source copies under ignored `artifacts/` directories; those additional passing tests are not counted above. Use `--dir src` when reproducing the source-only run. `pnpm smoke:paper-tools --binary <hidden-start-release.exe> --output <new-isolated-directory>` reproduces the desktop scenarios.

**Limits:** preflight is conservative static analysis, not TeX expansion, bibliographic fact checking or venue certification. AI verification covers draft preparation, not real model quality or provider transmission; the shared detached-window renderer is covered by component tests, not a newly opened native chat window. No public release, CI run, other desktop OS or physical display-scale change was exercised for these features.

## Current release — TexyPaper 0.0.12 / 현재 릴리스

Observed on Windows x64, 2026-11-09. This release permits a confirmed quit after an SSH disconnect without silently claiming that remote work stopped. Runtime checks used a hidden-start verification build, an isolated synthetic paper and profile, and a dedicated loopback SSH host; the user's project, clipboard and profile were not used.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend | TypeScript check passed; 479 tests across 36 files passed; production frontend build passed | `pnpm typecheck`, `pnpm test`, Tauri build output |
| Native build | Rust formatting check and hidden-start release build passed | `cargo fmt --check`, Tauri build output |
| SSH exit | Four scenarios passed: cancelling after a disconnect during a discard confirmation preserves the dirty buffer; confirmed offline quit keeps local recovery and exits; reconnect restores the unsaved content without overwriting the remote file; connected quit still honors discard | `artifacts/ssh-exit-012-01/ssh-exit-results.json` |
| Production package | Normal-start Windows installer and portable ZIP built with the release feed. Package verification checked all 655 payload files, executable versions and checksums; neither distribution contains the hidden verification executable. The release is unsigned | `artifacts/texypaper-release-0.0.12/release-manifest.json`, `package-proof.json`, `SHA256SUMS.txt` |

The SSH exit test injected the tray's quit event into the main window. It did **not** exercise a physical Windows tray menu, the user's SSH session, or the state of server processes during a real network partition. Older release limitations below still apply.

## Previous release — TexyPaper 0.0.11 / 이전 릴리스

Observed on Windows x64, 2026-11-09. This release removes the visual source/PDF divider grip, rounds the collapse controls and aligns the side-panel control. Runtime checks used a hidden-start verification build with isolated synthetic fixtures; the user's projects, clipboard and profile were not used.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend | TypeScript build passed; 479 frontend tests passed | `pnpm build`, `pnpm test` |
| Split controls in the real app | In light and dark themes, the split and single buttons have rounded corners and visible keyboard focus; the source/PDF divider has no grip. Hover help and resize cursor remain. Arrow key changed the source width 50 → 52%, dragging changed it to 37%, and double-click reset it to 50%. Both adjacent controls could be clicked independently with the source collapsed | `artifacts/pane-probe-011/run-1/` and `run-2/` |
| Renderer scaling | The split control was captured with device-scale emulation at 1×, 1.25× and 2×. The actual verification WebView reported approximately 1×; emulation is not a Windows display-scale change | `artifacts/pane-probe-011/run-1/split-dpr-*.png` |
| Usability suite | All 14 scenarios passed, including drag, keyboard, reset, both source/PDF collapse-and-restore paths and the adjacent side-panel button | `artifacts/usability-011-01/usability-results.json` |
| Production package | Normal-start Windows installer and portable ZIP built with the release feed. Package verification checked all 655 payload files, executable versions and checksums; neither distribution contains the hidden verification executable. The release is unsigned | `artifacts/texypaper-release-0.0.11/release-manifest.json`, `package-proof.json`, `SHA256SUMS.txt` |

**Not exercised for this change:** a real Windows display-scale change, other operating systems, or the user's real project and profile. The older release limitations below still apply.

## Previous release — TexyPaper 0.0.10 / 이전 릴리스

Observed on Windows x64, 2026-11-08 (KST). This release fixes concurrent atomic writes to one file on Windows. The 0.0.9 release commit's CI run failed once in `execution::tests::pending_deny_duplicate_and_epoch_authority`: reopening a project returned OS error 183 (“Cannot create a file when that file already exists”), and a second test then failed on the poisoned lock. Rerunning the same job passed, so it was a race. `replace` checked whether the target existed and then moved the temporary file without permission to replace; a second writer creating the target in between made the move fail. With that alone fixed, eight concurrent writers then hit OS error 5 from overlapping `ReplaceFileW` calls.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Regression test | `concurrent_writers_creating_the_same_file_all_succeed` (8 threads × 40 new files) failed with OS error 183 before the change, then with OS error 5 after only the retry was added, and passes with the per-target lock (3 consecutive runs) | Cargo output |
| Native and frontend | Formatting and strict Clippy passed; 162 Rust tests and 479 frontend tests passed | Cargo output, `pnpm test` |
| SSH suite | The first run failed at template creation: an automatic build from the preceding restore/undo started after the harness waited for builds to finish, and the suite did not answer the resulting **진행 중인 작업** dialog. The harness now answers it with **중지하고 계속**; the next 2 runs passed all 14 scenarios | `artifacts/ssh-010-01/` (failed, not counted), `ssh-010-02/`, `ssh-010-03/` |
| Feature, usability, desktop suites | All passed once: features 10, usability 14, desktop 22 (native save dialog not run) | `artifacts/features-010-01/`, `usability-010-01/`, `desktop-010-01/` |
| Production distribution and package integrity | Normal visible-start release and NSIS build with the production release feed, packaged by `pnpm package:release`; executable and installer report 0.0.10 and are unsigned. 655 payload files; license files match source in both distributions; the installer's executable differs from the normal one only in the three-byte bundle marker | `artifacts/texypaper-release-0.0.10/release-manifest.json`, `package-proof.json`, `SHA256SUMS.txt` |
| Local installation | The running 0.0.9 app was stopped on the user's standing request and 0.0.10 was installed silently. `settings.json` and the profile file list did not change during the install, the installed payload equals the portable payload apart from the bundle marker and `uninstall.exe`, and one 0.0.10 instance was launched afterwards | `artifacts/texypaper-release-0.0.10/local-installation.json` |

## Previous release — TexyPaper 0.0.9 / 이전 릴리스

Observed on Windows x64, 2026-11-08 (KST). This release only removes the AI cloud-transfer consent step (checkbox, remembered note, **Revoke consent**, the stored `aiDisclosureAccepted` setting and the native `disclosureAccepted` requirement). Runtime checks used a separately compiled hidden-start verification binary of the 0.0.9 source; the distributed binaries are normal-start builds. All fixtures and profiles were synthetic and isolated.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend | TypeScript check passed; 479 tests across 36 files passed. The composer test now requires an enabled **Send** with no checkbox for a ready account, and a disabled one without a prompt or subscription | `pnpm typecheck`, `pnpm test` |
| Native | Formatting and strict Clippy passed; 161 tests passed (the consent-setting test was removed; the relay tests now reject extra fields generically) | Cargo output |
| Composer in the real app | With both Codex and Claude selected, the composer had no checkbox and no consent text, and **Send** was present. An isolated profile seeded with `aiDisclosureAccepted` no longer contained it after the app's next settings write | `artifacts/consent-probe-01/run-1/probe.json`, `composer-codex.png`, `composer-claude.png` |
| Feature, usability, desktop, SSH suites | All passed once: features 10, usability 14, desktop 22 (native save dialog not run), SSH 14 | `artifacts/features-009-01/`, `usability-009-01/`, `desktop-009-01/`, `ssh-009-01/` |
| Production distribution and package integrity | Normal visible-start release and NSIS build with the production release feed, packaged by `pnpm package:release`; executable and installer report 0.0.9 and are unsigned. 655 payload files; license files match source in both distributions; the installer's executable differs from the normal one only in the three-byte bundle marker | `artifacts/texypaper-release-0.0.9/release-manifest.json`, `package-proof.json`, `SHA256SUMS.txt` |
| Local installation | The running 0.0.8 app was stopped on the user's standing request and 0.0.9 was installed silently. `settings.json` and the profile file list did not change during the install, the installed payload equals the portable payload apart from the bundle marker and `uninstall.exe`, and one 0.0.9 instance was launched afterwards | `artifacts/texypaper-release-0.0.9/local-installation.json` |

**Not exercised:** sending to a real provider (no signed-in provider account in the test profiles), so an `agent_start` without `disclosureAccepted` was not run end to end; the check was deleted from that command. The 0.0.8 limits below still apply.

## Earlier release — TexyPaper 0.0.8 / 이전 릴리스

Observed on Windows x64, 2026-11-08 (KST). This release adds line-number selection, automatic checkpoints, the **Sent to** record, adaptive SSH polling and one-diagnostic-per-error builds, fixes the COM apartment conflict behind “PDF export cancelled”, loads rarely used parts of the window on demand, and adds CI, a release packager and an optional signing path. Runtime checks used a separately compiled hidden-start verification binary of the final 0.0.8 source (no baked-in update feed); the distributed binaries are normal-start builds. All fixtures and profiles were synthetic and isolated; no real paper or normal account store was used.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend | TypeScript check passed; 483 tests across 36 files passed, including buffer ownership interleavings (8 of them fail on the 0.0.7 code), line-number selection, adaptive polling, transmission records and checkpoint filtering | `pnpm typecheck`, `pnpm test` |
| Native | Formatting and strict Clippy passed; 162 tests passed. `public_spell_ops_leave_calling_threads_free_for_sta_dialogs` failed on the old spell checker with `HRESULT(0x80010106)` (`RPC_E_CHANGED_MODE`, the apartment error that turned the save dialog into “cancelled”) and passes now; the dialog tests check a new thread per dialog, an MTA caller and that a dialog panic is `DIALOG_UNAVAILABLE`, not a cancellation | Cargo output |
| SSH worker | 45 Python tests passed in WSL Ubuntu 24.04: proposals 18, execution 7, project replace 10, asset import 6, and the new diagnostics 4 | `src-tauri/tests/remote_*.py` |
| Feature suite | All 10 scenarios passed in two runs in the real WebView2 app. New: clicking a line number selected the line with its break and dragging over numbers selected whole lines both ways; **Replace all** created an automatic checkpoint listing exactly the two changed files, which was restored and undone; the **Sent to** record listed an attachment as “아직 전송 안 됨” with its line range and size; **Ask AI about this error** showed a badge of 1 and only `broken.tex:3 Undefined control sequence` plus `BUILD_FAILED` (no TeX Live wrapper lines); and the Korean `article-ko` template compiled (kotex/xetexko, Un fonts) next to article, report and beamer | `artifacts/features-008-04/`, `features-008-05/` |
| Usability suite | All 14 scenarios passed in two runs | `artifacts/usability-008-03/`, `usability-008-04/` |
| Existing desktop suite | All 22 scenarios passed in two runs. The native PDF save-dialog scenario (the 23rd) was not run; see below | `artifacts/desktop-008-04/`, `desktop-008-05/` |
| SSH suite | All 14 scenarios passed in three runs on the final binary and three on the preceding candidate. The new idle scenario counted 6 `stat_many` + `list_dir` requests in 30 seconds after 15 seconds without input (limit 10; the 0.0.7 two-second cadence makes 15 checks per stream in that time) | `artifacts/ssh-008-06/` … `ssh-008-08/`, `ssh-008-03/` … `ssh-008-05/` |
| Startup bundle | Entry plus its static imports at startup: 963,046 bytes (313,021 gzip) instead of 1,475,108 (468,026). PDF.js and its viewer styles load with the first PDF panel, never for Home | `artifacts/appshell-split-01/paperdock-appshell-split-report.txt` |
| Signing mechanism | With a throwaway self-signed certificate, the app, the installer and the app inside the installer were signed with SHA-256 and DigiCert RFC 3161 timestamps; all three were untrusted, as expected (`UnknownError`). The certificate and key were deleted. The distributed 0.0.8 files are unsigned | `artifacts/signing-test-01/` |
| Whole-app memory (diagnostic) | Measured on 0.0.7 at this PC's 125% display scale, so not the standard 100% run: over 120 s of the standard workload the app and its WebView2 processes peaked at 312.41 MiB private working set (median 246.1 MiB; budget 300 MiB) and the same-state growth was 53.10 MiB (limit 20 MiB). **Both gates failed.** The app process itself peaked at 11.2 MB; the WebView2 processes account for the rest. The run's desktop workload also exited with code 1 | `artifacts/verify-memory-01/memory-results.json` |
| Production distribution | Normal visible-start release and NSIS build with the production release feed, packaged by `pnpm package:release`. Executable and installer report TexyPaper 0.0.8 and are unsigned | `artifacts/texypaper-release-0.0.8/release-manifest.json`, `SHA256SUMS.txt` |
| Package integrity | 655 files in the portable ZIP; every license/notices file matches source in both distributions and the ZIP executable equals the normal release executable. The executable inside the installer differs from it only in Tauri's three-byte bundle marker (`UNK` → `NSS`), confirmed by replacing the marker | `package-proof.json` |
| Local installation | On the user's request the running 0.0.7 app was stopped (`Stop-Process -Force`; no other TexyPaper or Paperdock process was running) and 0.0.8 was installed with the silent installer. `settings.json` and the profile file list did not change during the install (stopping the old app removed only WebView2's `lockfile` and `DIPS-wal`), the installed payload equals the portable payload apart from the bundle marker and `uninstall.exe`, and one 0.0.8 instance was launched afterwards | `artifacts/texypaper-release-0.0.8/local-installation.json` |

Defects found while verifying, fixed before release: moving dialogs and panels to on-demand loading also moved the styles of controls that are always visible (the shortcut button and the status bar layout, the Replace toggle, the Home template button), so they were briefly unstyled; those styles now load with the always-visible components. A usability run failed once when switching projects: after **모두 저장** in the switch dialogs the app reported `WORKSPACE_BUSY`. The probable cause, not confirmed, is an autosave that finished behind the dialogs and scheduled the automatic build, which then blocked closing the project; automatic builds are now refused while a switch is in progress. The failure did not recur in six later runs, two of them with the change, which does not prove the cause.

Harness changes and failures not counted as passes: the checkpoint steps counted the “Before restore” row once right after the file changed, but the panel reloads its list after the write, so one feature run failed; the feature and SSH suites now wait for the row. `ai-chat-zoom` failed in 2 of 4 parallel runs of an instrumented build (“Ctrl+minus shrinks the chat text” timed out) and passed in an isolated 8-round probe and the 6 runs after; its cause was not established, and the scenario now records the size, key and wheel timeline when it fails. The desktop SyncTeX comparison failed once waiting for the **텍스트 수정** button (the same failure was seen once on 0.0.7) and passed in the 4 later runs; cause not established.

Two incidents on the user's session: the desktop suite opened the real PDF save dialog on the user's screen (the hidden test app does not hide native dialogs), so that scenario now runs only with `--native-dialogs`; and a real clipboard paste check (a 136-byte PNG was pasted and stored byte for byte) replaced the user's clipboard and did not restore the text that was on it. Windows clipboard history is off, so the text could not be recovered. Clipboard checks are no longer run on the user's session.

**Not exercised:** the native PDF save dialog in the real app after the COM fix (needs the user's permission, because it appears on screen); a real Explorer drag (desktop automation was refused: “private file DACL grants an untrusted principal”); the **Sent to** record with a live provider, so the record written at the provider handoff is covered by native tests and the pending state by the app; the Windows English dictionary branch (this PC has only Korean); trusted signing (no certificate); memory at 100% scale; CI, which first runs on the release push. macOS, cloud accounts and real-time collaboration are not supplied.

## Earlier release — TexyPaper 0.0.7 / 이전 릴리스

Observed on Windows x64, 2026-11-08 (KST). This release only returns the editor's line numbers to the Overleaf rule (CodeMirror's own gutter: one number per source line on its first row, nothing on wrapped rows) and removes the `↳` rows added in 0.0.6. No native source changed. Runtime checks used a separately compiled hidden-start verification binary of the 0.0.7 source (no baked-in update feed); the distributed binaries are normal-start builds. All fixtures and profiles were synthetic and isolated; no real paper or normal account store was used.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend | TypeScript check passed; 446 tests across 33 files passed (the wrapped-gutter helper and its tests were removed with it) | `pnpm typecheck`, `pnpm test` |
| Feature suite | All 7 scenarios passed in the real WebView2 app. The line number scenario waits for CodeMirror's measured heights, then requires exactly `1`…`6` in the number column, source line 4 spanning three rows while every other line is one row, the same single number after the window is narrowed, a separate number-column background with a divider, and the Home button border only on hover | `artifacts/features-007-02/features-results.json`, `wrapped-line-numbers.png`, `home-button-hover.png` |
| Usability suite | All 14 scenarios passed | `artifacts/usability-007-01/usability-results.json` |
| Existing desktop suite | All 23 scenarios passed in two runs. Two earlier runs on the same binary did not: one lost its app window mid-run (“Target page, context or browser has been closed”) and one could not reach the native PDF save dialog (`NATIVE_DIALOG_UNAVAILABLE`); both use desktop automation that another window or process can disturb, and I did not establish what happened | `artifacts/desktop-007-03/`, `artifacts/desktop-007-04/` (passed); `desktop-007-01/`, `desktop-007-02/` (not counted) |
| SSH suite | 6 consecutive runs of all 13 scenarios passed | `artifacts/ssh-007-01/` … `ssh-007-06/` |
| Production distribution | Normal visible-start release and NSIS build with the production release feed. Executable and installer report TexyPaper 0.0.7 and are unsigned | `artifacts/texypaper-release-0.0.7/release-manifest.json`, `SHA256SUMS.txt` |
| Package integrity | 655 files in the portable ZIP; every license/notices file matches source in both distributions and the ZIP executable equals the normal release executable. The executable inside the installer differs from it only in Tauri's three-byte bundle marker (`UNK` → `NSS`), confirmed by replacing the marker | `package-proof.json` |

What Overleaf does, checked in its public source (`services/web/frontend/js/features/source-editor/extensions/line-numbers.ts`): it wraps CodeMirror's built-in `lineNumbers()` and only adds a gutter mouse handler that selects lines; it draws no marker on wrapped rows. TexyPaper does not copy that mouse handler.

**Not exercised:** the installed 0.0.7 app is exercised only by being launched on the user's profile; clicking a line number to select the line (Overleaf's gutter handler) is not implemented here; the 0.0.5 limits below (Windows English dictionary branch, real Explorer drag and clipboard paste, Korean template compile, whole-app memory, 100% scale, live provider inference, tray, uninstall) still apply. macOS, signing, cloud accounts and cross-device sync are not supplied.

## Earlier release — TexyPaper 0.0.6 / 이전 릴리스

Observed on Windows x64, 2026-11-08 (KST). This release changes the editor number column, the Home button and the "show in PDF" marker, and fixes two editor-state defects found while verifying 0.0.5. No native (Rust) source changed, so the 0.0.5 native results below still apply. Runtime checks used a separately compiled hidden-start verification binary of the 0.0.6 source (no baked-in update feed); the distributed binaries are normal-start builds. All fixtures and profiles were synthetic and isolated; no real paper or normal account store was used.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend | TypeScript check passed; 448 tests across 34 files passed, including the wrapped line number helpers and a test that starts two opens of one file and finishes them in the wrong order | `pnpm typecheck`, `pnpm test` |
| Feature suite | All 7 scenarios passed in the real WebView2 app. The new one checks that every source line keeps its own number (`1`…`6`), that only the wrapped line carries `↳` rows and their number follows a narrower window, that the active-line number stays a plain number, that the number column has its own background and a divider, and that the Home button has no border at rest and a border on hover. The other six are the 0.0.5 scenarios | `artifacts/features-006-05/features-results.json`, `wrapped-line-numbers.png`, `home-button-hover.png` |
| Usability suite | All 14 scenarios passed; the “show in PDF” scenario now also requires the marker to be removed again after it appeared | `artifacts/usability-006-04/usability-results.json` |
| Existing desktop suite | All 23 scenarios passed in two separate runs | `artifacts/desktop-006-08/`, `artifacts/desktop-006-09/` |
| SSH suite | 12 consecutive runs of all 13 scenarios passed over native OpenSSH to a loopback host and actual WSL Python/LaTeX | `artifacts/ssh-fin-01/` … `ssh-fin-12/` |
| Production distribution | Normal visible-start release and NSIS build with the production release feed. Executable and installer report TexyPaper 0.0.6 and are unsigned | `artifacts/texypaper-release-0.0.6/release-manifest.json`, `SHA256SUMS.txt` |
| Package integrity | 655 files in the portable ZIP; every license/notices file matches source in both distributions and the ZIP executable equals the normal release executable. The executable inside the installer differs from it only in Tauri's three-byte bundle marker (`UNK` → `NSS`), confirmed by replacing the marker | `package-proof.json` |

The two editor-state defects, both in code that shipped in 0.0.5: (1) after a file was reloaded from disk, the editor view could still deliver an update that wrote its old state back into the buffer, leaving old text on screen with the buffer marked clean at the new revision. A failing SSH run showed exactly that after an approved reload, and instrumented runs logged such stale updates in most SSH runs. (2) Two opens of one file could finish out of order, and the older one replaced the record the editor had installed. This one is inferred: the worker log shows two back-to-back reads of the same file after a double-click, and the first fix alone dropped a typed edit in 5 of roughly 37 SSH runs, at a record whose tracked state was empty. Both are fixed; 12 consecutive SSH runs and 2 desktop runs passed afterwards, which supports the second inference but is not a trace of the replacement itself.

Harness mistakes found and fixed, not counted as passes: the SSH conflict step wrote the outside change while a 2-second poll could reload the still-clean buffer in between, which turns a conflict test into a legitimate auto-reload (the step now starts right after a poll). The SSH `openFile` helper now also waits until the editor shows the opened file; my first guess that typing into an unbound editor explained the ProxyJump failures did not match the logs, which point to the record replacement above. A desktop run failed once at “displayed build identity advanced after approved prose edit” and passed in the next 7 runs; its cause was not established.

**Not exercised:** the fade itself was not inspected frame by frame (the suite checks that the marker is gone and the stylesheet defines the fade); the Home hover state was checked by computed style and one render, not on a high-contrast or forced-colors theme; the installed 0.0.6 app is exercised only by being launched on the user's profile; the 0.0.5 limits below (Windows English dictionary branch, real Explorer drag and clipboard paste, Korean template compile, whole-app memory, 100% scale, live provider inference, tray, uninstall) still apply. macOS, signing, cloud accounts and cross-device sync are not supplied.

## Earlier release — TexyPaper 0.0.5 / 이전 릴리스

Observed on Windows x64, 2026-11-07 (KST). This release adds English spell check and word count, a bundled English dictionary fallback, project-wide replace, drop/paste figure import, checkpoints, paper templates and “Ask AI about this error”. Runtime checks used a separately compiled hidden-start verification binary of the 0.0.5 source (no baked-in update feed); the distributed binaries are normal-start builds. All fixtures and profiles were synthetic and isolated; no real paper or normal account store was used.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend | TypeScript check passed; 445 tests across 33 files passed (prose ranges and word count, spelling, replace planning, checkpoints and diff, templates, asset import with a 3 MiB end-to-end hash, image paste) | `pnpm typecheck`, `pnpm test` |
| Native | Formatting and strict Clippy passed; 144 tests across 9 suites passed (spelling with the bundled engine forced, checkpoint storage limits and corruption, chunked asset import, user replacement bytes and undo, diagnostic path normalization) | Cargo command output |
| SSH worker | The Python worker tests passed in WSL Ubuntu 24.04: proposals 18, execution 7, asset import 6, project replace 10 | `src-tauri/tests/remote_*.py` |
| New feature suite | All 6 scenarios passed in the real WebView2 app: word count and spell check (the bundled dictionary flagged `sentense`, `mispeled`, `wrod`, `anoter` and none of the TeX commands, `amsmath` or math; a suggestion replaced a word; turning the setting off removed the underlines), ask-AI-about-build-error (chip and pre-filled question, nothing sent), project replace across 3 files with BOM and CRLF preserved byte for byte, undo restoring the exact bytes and the over-limit result refusing to apply, drop and paste import (byte-identical files, figure snippet inserted), checkpoints (create, compare, restore with a **Before restore** checkpoint, undo), and templates created in empty folders with the article, report and beamer papers compiled by the Windows TeX Live (the Korean template was only created and its settings checked) | `artifacts/features-005-04/features-results.json` and renders |
| Usability suite | All 14 scenarios passed | `artifacts/usability-005-03/usability-results.json` |
| Existing desktop suite | All 23 scenarios passed against a real 30-page local LaTeX build | `artifacts/desktop-005-03/desktop-results.json` |
| SSH suite | All 13 scenarios passed, twice, over native OpenSSH to a loopback host and actual WSL Python/LaTeX. The new scenario ran project replace and undo with BOM/CRLF bytes, a byte-identical binary drop import through the framed worker protocol with no temp file left, checkpoints with restore and undo, and a template created on the server before the original project was reopened | `artifacts/ssh-005-07/ssh.json`, `artifacts/ssh-005-08/ssh.json` |
| Bundled dictionary memory | Loading the dictionary on the first check increased a fresh release-profile process by about 3.04–3.05 MB of working set and 2.22 MB of private bytes in three runs; later checks added none. This measures the engine in isolation, not the whole app | measurement by the spell lane (throwaway, removed) |
| Production distribution | Normal visible-start release and NSIS build with the production release feed. Executable and installer report TexyPaper 0.0.5 and are unsigned | `artifacts/texypaper-release-0.0.5/release-manifest.json`, `SHA256SUMS.txt` |
| Package integrity | 655 files in the portable ZIP; every license/notices file matches source in both distributions and the ZIP executable equals the normal release executable. The executable inside the installer differs from it only in Tauri's three-byte bundle marker (`UNK` → `NSS`), confirmed by replacing the marker | `package-proof.json` |
| Local installation | The current user's TexyPaper was updated from 0.0.4 with the silent installer while no TexyPaper process was running; nothing was terminated and the app was not launched. `settings.json` and the profile file list were unchanged, and the installed payload matches source | `artifacts/texypaper-release-0.0.5/local-installation.json` |

Runtime checks found and fixed these defects in the new work: the Windows spell checker has no English dictionary on a Korean-only installation (this machine), so the feature was dead until the bundled fallback was added; the diagnostics of a **failed** build kept the TeX log's `./main.tex` spelling and the project path check refused them with `PATH_OUTSIDE_WORKSPACE`, so they are now normalized to project-relative paths; a descriptive note on the Home page contained the word “conflict” (충돌), and the desktop suite's text locator for the conflict dialog picked that hidden note first and waited on an invisible element, so the note was reworded. Earlier harness mistakes (a missing fixture file, the explorer left hidden by a previous scenario, a log panel toggled closed by the auto-open rule, starting a project switch while an autosave build was still running) are not counted as passes. One earlier SSH run failed the same-size conflict step and later runs passed; the worker log of the failed run shows a re-read of the changed file just before an accepted save, which is consistent with a race inside that step, but this was not proven further.

**Not exercised:** the Windows `ISpellChecker` branch with a real English dictionary (this PC has none, so only the bundled engine ran in the app; the Windows branch has no test that could run here because its unit test returns early without an English dictionary); a real Explorer file drag and a real clipboard image paste (both were simulated with `DataTransfer` events carrying a `File` inside the real WebView, with the native drop handler disabled as configured); the Korean template compiled with ko.TeX; memory aggregates of the whole app and a 100%-scale measurement; the installed 0.0.5 app was not launched; live Codex/Claude inference; detached-window chat zoom; physical tray Open/double-click/Exit; a visible (non-hidden) startup; uninstall or fresh-machine WebView2 bootstrap. macOS, signing, cloud accounts and cross-device sync are not supplied. The older limits below otherwise still apply.

## Earlier release — TexyPaper 0.0.4 / 이전 릴리스

Observed on Windows x64, 2026-11-07 (KST). This release changes only the explorer's folder icon artwork and name mapping. Runtime checks used a separately compiled hidden-start verification binary of the 0.0.4 source (no baked-in update feed); the distributed binaries are normal-start builds. All fixtures and profiles were synthetic and isolated; no real paper or normal account store was used.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend | TypeScript check passed; 284 tests across 24 files passed, including the folder-name mapping (case-insensitive, distinct open variants, no paper-evidence inference) | `pnpm typecheck`, `pnpm test` |
| Native | Formatting and strict Clippy passed; 118 tests across 6 suites passed (no native source changed in this release) | Cargo command output |
| Isolated icon render | The real icon component and app stylesheet were rendered for light and dark themes: unknown names gray-blue, eight role colors with glyphs, open variants, dimmed tool folders. From the palette values, glyph-to-fill contrast is at least 4.9:1 and the folder outline against the light sidebar at least 3.4:1 (the dimmed tool folders are lower by design) | `artifacts/icon-preview-01/` |
| Usability suite | All 14 scenarios passed in the real WebView2 app, including the explorer file/folder icon scenario (no duplicate DOM ids). Real-app renders in light and dark themes were inspected: role-colored folders beside the unchanged TeX badges | `artifacts/usability-004-01/usability-results.json`, `explorer-icons-light.png`, `explorer-icons-dark.png` |
| Existing desktop suite | All 23 scenarios passed against a real 30-page local LaTeX build | `artifacts/desktop-004-01/desktop-results.json` |
| SSH suite | All 12 scenarios passed over native OpenSSH to a loopback host and actual WSL Python/LaTeX | `artifacts/ssh-004-01/ssh.json` |
| Production distribution | Normal visible-start release and NSIS build with the production release feed. Executable and installer report TexyPaper 0.0.4 and are unsigned | `artifacts/texypaper-release-0.0.4/release-manifest.json`, `SHA256SUMS.txt` |
| Package integrity | 651 files in the portable ZIP; every license/notices file matches source in both distributions and the ZIP executable equals the normal release executable. The executable inside the installer differs from it only in Tauri's three-byte bundle marker (`UNK` → `NSS`), confirmed by replacing the marker | `package-proof.json` |
| Local installation | The current user's TexyPaper was updated from 0.0.3 with the silent installer while no TexyPaper process was running; nothing was terminated and the app was not launched. `settings.json` and the profile file list were unchanged, and the installed payload matches source | `artifacts/texypaper-release-0.0.4/local-installation.json` |

The README screenshot was retaken from the same usability run with the new icons; its lower update-notice strip (a verification-build artifact) is cropped.

**Not exercised:** forced-colors and 200%-zoom rendering of the new folder icons; the installed 0.0.4 app was not launched; detached-window chat zoom at runtime; live Codex/Claude inference (`smoke:agents` and `smoke:chat` require `--live` and an official login); physical tray Open/double-click/Exit; a visible (non-hidden) startup; memory aggregates; uninstall or fresh-machine WebView2 bootstrap. macOS, signing, cloud accounts and cross-device sync are not supplied. The 0.0.3 limits below otherwise still apply.

## Earlier release — TexyPaper 0.0.3 / 이전 릴리스

Observed on Windows x64, 2026-11-07 (KST). Runtime checks used a separately compiled hidden-start verification binary of the 0.0.3 source (no baked-in update feed); the distributed binaries are normal-start builds. All fixtures and profiles were synthetic and isolated; no real paper or normal account store was used.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend | TypeScript check passed; 284 tests across 24 files passed | `pnpm typecheck`, `pnpm test` |
| Native | Formatting and strict Clippy passed; 118 tests across 6 suites passed | Cargo command output |
| New usability suite | 14 scenarios passed in the real WebView2 app: TeX folder badges and file/folder icons (no duplicate DOM ids), outline numbering/indentation/click, fixed green commands in light and dark, Overleaf editing shortcuts (`Ctrl+D`, `Ctrl+/`, `Ctrl+B`, `Ctrl+Enter` compile event without a newline, go to line, `Ctrl+click` second cursor, fold gutter), Home round trip preserving an unsaved draft and epoch, Home project switching through the running-work and unsaved-file guards and back, divider keyboard/drag resize with collapse and ratio-preserving restore, independent `Ctrl+wheel`/`Ctrl+-` zoom of source, PDF and AI chat without changing the page zoom or root font, `Ctrl+Alt+J` highlight on the PDF page and PDF `Ctrl+click` landing on the source line, explicit AI attachments from the context menu, `Ctrl+L` and the PDF menu (chips, removal, no old shared-context block), and the categorized shortcut dialog with search | `scripts/smoke-usability.mjs`; `artifacts/usability-003-09/usability-results.json` and renders |
| Existing desktop suite | All 23 scenarios passed against a real 30-page local LaTeX build, including create/rename/trash, BOM/CRLF/IME, conflicts, PDF prose review, comments, SyncTeX comparison, stale-event isolation, crash recovery and restart persistence. The suite was updated for the Home page, the root selector inside build options, `Ctrl+Shift+C` and restored panel layout | `artifacts/desktop-003-06/desktop-results.json` |
| SSH suite | All 12 scenarios passed over native OpenSSH to a loopback host and actual WSL Python/LaTeX, including remote build, forward and inverse SyncTeX with project-relative path normalization, same-size conflict, disconnect/reconnect without replaying a committed write, ProxyJump, build interruption and host-key/auth refusals | `artifacts/ssh-003-04/ssh.json` |
| Production distribution | Normal visible-start release and NSIS build with the production release feed. Executable and installer report TexyPaper 0.0.3 and are unsigned | `artifacts/texypaper-release-0.0.3/release-manifest.json`, `SHA256SUMS.txt` |
| Package integrity | 651 files in the portable ZIP; every license/notices file matches source and the ZIP executable equals the normal release executable. After installation the installed executable differs from it only in Tauri's three-byte bundle marker | `package-proof.json` |
| Local installation | The current user's TexyPaper was updated from 0.0.2 with the silent installer while no TexyPaper process was running; nothing was terminated and the app was not launched. `settings.json` and the profile file list were unchanged, and the installed license payload matches source | `artifacts/texypaper-release-0.0.3/local-installation.json` |

Runtime and static checks found and fixed these defects in the new work: reconnecting a disconnected project asked to “save all” before it could reconnect (it now keeps edits through the recovery journal as 0.0.2 did); the hidden Home page duplicated the Settings control and error notices while a project was open; the Windows `\\?\` prefix leaked into displayed project paths; two label objects in the shortcut data lacked their `en` key, a syntax error caught by the type check. Earlier harness mistakes (stale selectors, a gutter class shared with the fold gutter, a pointer drag over the collapse arrows, a smoke step that switched projects before a slow running-work dialog appeared, checking a PDF scale before fit-width layout settled) are not counted as passes.

The SSH suite's real-mouse drag across the tiny PDF text spans does not extend a text selection in the 0.0.2 baseline either (a baseline binary was built from the release commit and traced), so that step now selects a real text-layer range and sends the same `pointerup` as the local suite. A real pointer drag over very small PDF text is therefore **not** proven by this suite.

**Not exercised:** detached-window chat zoom at runtime; the one-time cloud consent against a real provider (covered by unit and native tests only, and by the first-use checkbox in the real app); live Codex/Claude inference (`smoke:agents` and `smoke:chat` require `--live` and an official login); physical tray Open/double-click/Exit; a visible (non-hidden) startup; memory aggregates; uninstall or fresh-machine WebView2 bootstrap. macOS, signing, cloud accounts and cross-device sync are not supplied. Reduced-motion and forced-color behavior is styled but was not re-verified as an accessibility certification.

## Earlier release — TexyPaper 0.0.2

Observed on Windows x64, 2026-11-07 (KST). The normal distribution is separate from the hidden-start verification binary. No real paper or normal account store was used as a development fixture.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend behavior | 127 tests passed across 16 source files. Vitest now excludes ignored exported source-audit trees | `pnpm test` |
| Native checks | Formatting, 109 tests across 8 suites, and strict Clippy passed | Cargo command output |
| Actual native usability | All 9 final scenarios passed through the real application-owned WebView2, launched with `agent-desktop` without activation; inspected native windows remained hidden | `artifacts/usability-native-002-06/report.json` |
| Dashboard and close policy | Recent-first collapsed forms, keyboard focus return, first X → Cancel, refused unacknowledged hide, persisted background choice, later X, and fresh-profile first X → complete exit passed | Same runtime report and dashboard/close renders |
| Actual detached chat | Native child creation/docking preserved the unsent draft and archived message anchor across width changes, including a 360px child viewport. Child lifecycle authority was refused | Same report; `detached-chat-light.png`, `detached-chat-360.png` |
| Executable restart | Actual source selection and deep scroll, active file, 58% split, PDF zoom 75%/rotation 90°/deep page, archived message anchor, and explicit custom blue palette survived guarded exit and executable relaunch | Same report; `restored-workspace.png` |
| Guarded complete exit | `Ctrl+Shift+Q` → Cancel kept the process and unsaved file; a second request → Save all wrote the exact synthetic change before process exit | Same runtime report |
| Actual local and SSH work | Native local LaTeX rendered a 30-page fixture. Native OpenSSH reached the loopback server and actual WSL Python/LaTeX; reconnect restored the SSH file/layout without importing the local archive | Same runtime report and isolated SSH host events; `ssh-restored.png` |
| Appearance | Actual light/dark renders, English 200% UI, reduced-motion/forced-color media emulation, and custom-palette restart passed. At 1440×900 logical pixels the enlarged Send control remained within the viewport. Actual dark comment foreground/background contrast measured 6.74:1 | Same report and inspected renders |
| Icon | RGBA app artwork has transparent outer corners; generated small Windows icon and light/dark composites were inspected. Source artwork and banner were unchanged | `artifacts/texypaper-0.0.2/transparent-icon-preview.png`, native renders |
| Production distribution | Normal visible-start release/NSIS build passed with TexyPaper 0.0.2 version resources; the existing large-chunk warning remains. Both artifacts are unsigned | `artifacts/texypaper-release-0.0.2/release-manifest.json` |
| Package integrity | 651 payload files in each distribution. All license/notices hashes match source, the portable executable matches the normal binary, and the extracted installer executable differs only by Tauri's three-byte `UNK` → `NSS` bundle marker. Hidden executables and the temporary verification script were removed | Same directory: `package-proof.json`, `SHA256SUMS.txt` |

Runtime inspection exposed the dashboard Settings button's lost chrome selector, enlarged composer controls scrolling below the viewport, and fixed light-theme source colors on dark surfaces. These were corrected and exercised in the final native run. Earlier smoke attempts also exposed harness mistakes (a nonexistent Playwright focus helper, a guessed continuation selector, an exact wrapped-label match, and sampling layout before its debounced write); those failed attempts are not counted as passes.

The chat transcript in this run was explicitly seeded synthetic history, **not a live model response**. Current Claude account/model metadata was read, but no paid inference or background model probe was performed. Reduced-motion/forced-color emulation is not a Windows accessibility certification, and the application UI's 200% setting is not a change to OS display scale.

**Not re-exercised in this hidden run:** physical tray Open/double-click/Exit, active-build exit confirmation, live Codex/Claude inference, the full resource aggregate, uninstall or fresh-machine WebView2 bootstrap. macOS, signing, cloud accounts and cross-device settings sync are not supplied. Publication/package integrity and the explicitly requested local installation are separate checks; raw local evidence is not public source.

## Previous release — TexyPaper 0.0.1

Observed on Windows x64, 2026-11-06. Source and release: [HSoo-Kim/texypaper](https://github.com/HSoo-Kim/texypaper). The current observations below are separate from the pre-rebrand baseline.

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frontend behavior | 113 tests passed across 15 files | `pnpm test` |
| Native checks | Formatting and strict Clippy passed; 100 tests passed across 8 suites. After removing unnecessary profile-walk allocations, strict Clippy and all 17 affected storage-migration tests passed again | Cargo command output |
| Remote worker | 18 proposal/migration and 7 execution tests passed under actual WSL Python | `remote_proposal.py`, `remote_execution.py` command output |
| Default-profile migration | A synthetic legacy directory moved rather than copied: Win32 file identity and opaque credential bytes were preserved, as were custom settings. Exclusive locking, conflicting-profile preservation and explicit-profile bypass passed; no real user profile was accessed | `artifacts/texypaper-rebrand-01/profile-smoke-fixtures/report.json` |
| Actual native identity and project migration | Window title TexyPaper and supplied icon decoded; `.paperdock` metadata moved to `.texypaper`, while opaque bytes and manuscript prose containing the old name remained unchanged | `artifacts/texypaper-ui-01/report.json` |
| Actual appearance and persistence | Navy/raspberry defaults rendered in light and dark modes; system appearance changed; an explicit custom blue survived executable restart; reset restored the new default. Captured WebView renders were inspected | `artifacts/texypaper-ui-01/report.json`, `workspace-light.png`, `workspace-dark.png` |
| Actual local and SSH runtime | Native OpenSSH reached the loopback fixture and actual WSL Python worker. Both local and remote LaTeX produced rendered PDFs using the new protocol/private paths; local build also completed after native WM_CLOSE | `artifacts/texypaper-ui-01/report.json` |
| Actual Claude execution | Real Haiku 5.5 read evidence and proposed local and SSH Python commands. Files did not exist before explicit approval; afterward exact file bytes, stdout and successful completion were observed. The picker exposed only Opus, Sonnet and Haiku 5.5 | `artifacts/texypaper-ui-01/report.json`, `local-claude-execution.png`, `ssh-claude-execution.png` |
| Non-disruptive window verification | Two isolated native runs used a separately compiled startup override with `visible=false`, `focus=false`. All four native window inspections reported hidden windows; no activation, physical input or user-process termination was used. Temporary sources, launchers and hidden executables were removed after proof | `artifacts/texypaper-ui-01/report.json` |
| Production build and distribution | Normal production startup, not the hidden override. TypeScript/Vite and native release/NSIS build passed; the existing large-chunk warning remains. Both executable and installer report TexyPaper 0.0.1 and are unsigned | `artifacts/texypaper-release-0.0.1/release-manifest.json`, `windows-version-and-signature.json` |
| Package contents | Each distribution contains 651 payload files. MIT, third-party notices and every `licenses/` file match source hashes; portable executable matches the production binary. NSIS changes only Tauri's three-byte `UNK` → `NSS` bundle marker, verified against its upstream implementation; all other executable bytes match | `artifacts/texypaper-release-0.0.1/package-proof.json`, `SHA256SUMS.txt` |

The Windows migration smoke first exposed that an open child lock prevents renaming its directory. The fix probes the old exclusive lock, closes that child handle immediately before rename, and reacquires the moved lock while retaining a separate migration guard. The old app must remain fully closed throughout migration; no atomic cross-client migration guarantee is claimed.

**Not exercised for this release:** visible startup, physical tray Open/double-click/Exit, detached-window interaction, actual NSIS install/uninstall, fresh-machine WebView2 bootstrap, new memory aggregates or Codex inference. The hidden run verifies native commands and rendered app surfaces, not those physical-shell interactions. Startup failure dialogs were not displayed. macOS has not been built or validated; no cloud account/sync service is provided. Source-disclosure checks and public artifact publication are separate release gates; raw local evidence is not uploaded.

Historical artifact links and filenames below are retained as actual earlier identifiers, not renamed into nonexistent TexyPaper evidence.

## Pre-rebrand baseline — Paperdock (2026-11-06)

All observations, defects and unmet gates in the following three subsections describe the earlier product and captured binaries, **not TexyPaper v0.0.1**. References to “latest,” “new executable,” old profile names or absent remotes are relative to those runs.

### Observed results

| Exercise | Observed result | Evidence |
| --- | --- | --- |
| Frozen frontend dependency installation | Passed after aligning Tauri API/CLI 2.12.4 with native Tauri 2.12.5 | pnpm command output |
| Production frontend build | Passed; Vite reports a large main chunk warning, not suppressed | release build command output |
| Frontend behavioral tests | 109 passed across 15 files | Vitest command output |
| Native formatting, strict Clippy and tests | Formatting and `clippy -D warnings` passed; 83 native tests passed across 7 suites; 6 proposal and 6 command-execution worker tests passed under actual WSL Python | Cargo and WSL Python command output |
| Direct actual WSL worker protocol | Passed hello/open/create/read, stale-save rejection, real pdfLaTeX compilation and published PDF byte-range read | `artifacts/worker-direct-smoke.json` |
| Real native OpenSSH/WSL acceptance | 12/12 scenarios passed on the first chat/execution release, before the later composer-effort/tray amendments: alias/unknown-host approval, filesystem operations, actual host compile, Unicode SyncTeX, conflicts, lost-reply journal resolution without replay, ProxyJump, disconnect cleanup and authentication failures | `artifacts/ssh-release-15/ssh.json` |
| Integrated desktop acceptance | 24/24 scenarios passed on that first chat/execution release, not a full rerun after the composer-effort/tray amendments: explorer/discovery, real PDF and three LaTeX engines, native export, cancellation, filesystem operations, encoding/conflicts, proven prose edits, comments, Unicode SyncTeX, appearance/accessibility, workspace isolation, recovery, preferences and update notice | `artifacts/desktop-release-22/desktop-results.json` |
| Release packaging and actual NSIS installation | Claude-5.5-only production executable and 10.79 MiB NSIS setup built successfully. Installation, real compilation from the installed executable and isolated uninstall passed on the earlier chat/execution release. Latest installer was not launched after the user prohibited visible tests. Installer unsigned; tested existing WebView2 runtime 156.0.4314.58 | Latest files in `artifacts/claude55-release-01/`; prior `installed-executable-compiles-real-fixture` scenario in `artifacts/desktop-release-22/desktop-results.json` |
| Real release preferences | Passed Korean/English × light/dark, system appearance, custom accents and background, invalid/low-contrast rejection, restart persistence, reset, disabled-update persistence, actual HTTPS release response and persistent bottom notice after restart | `artifacts/preferences-release-08/preferences-results.json` |
| Claude local and SSH workflows | Earlier release: both backends passed real evidence reading, approval-before-write, Apply into real TeX and a newly compiled PDF, Reject immutability, stale-proposal rejection, cancellation with no remaining provider/MCP children, and conversation resume | Claude rows in `artifacts/agents-release-08/agents.json` |
| Earlier resource baseline (not the new detached-chat/tray build) | App+WebView2 maximum 282.7 MiB; same-state median growth 12.0 MiB; 119 samples in 120 s. Combined footprint with live Claude peaked at 421.3 MiB. Measured at 125% Windows scale. Neither this result nor its thresholds are claimed for the latest two-window build | `artifacts/memory-release-16/memory-results.json`, `memory-samples.jsonl` |
| Overleaf-style compile over real SSH | Project with only `TR-C/main.tex` two folders down: before opening a file the build button was disabled; the nested main document appeared in the main-document list and an explicit choice persisted to the remote `.paperdock/project.json`; opening a chapter enabled the button and `Ctrl+S` produced a published PDF containing the chapter text. Desktop 24/24 and SSH 12/12 were rerun on this build | `artifacts/ssh-overleaf-flow-01/report.json`, `artifacts/desktop-release-21/desktop-results.json`, `artifacts/ssh-release-14/ssh.json` |
| Duplicate launch on one profile | A second instance shows an explained dialog and exits 0 while the first keeps running (previously an opaque WebView2 creation panic) | `artifacts/single-instance-02/single-instance.json` |
| Thirty-page ranged PDF | Actual first-page text, image and canvas rendering passed after the range-reader fix | `artifacts/local-pdf-inspect-02/local-pdf-surface.png` |
| Proven PDF source edit | Exact source bytes remained unchanged until Apply, one intended literal replacement committed, a new actual PDF displayed it, and an external-change stale proof was refused without overwrite | `artifacts/proven-edit-inspect-02/proven-edit-results.json` |
| Physical source comment interval | Before-fix Ctrl+Shift+A selected the entire source; after-fix the actual first-line selection remained bytes 3–20 including BOM handling | `artifacts/source-selection-inspect-03/selection.json` |
| PDF comment restart/marker | Actual PDF hash/page/rectangles persisted across executable restart; marker opened the same saved thread | `artifacts/pdf-comment-inspect-01/pdf-comment-results.json` |
| Native PDF Save dialog | Actual owned Windows filename/Save controls exported PDF bytes matching the immutable manifest SHA-256 | `artifacts/pdf-export-inspect-03/pdf-export-results.json` |
| Actual native chat and approved code execution | First chat/execution release passed independent right-side layout, draft-preserving native detach/dock/child close, child role denial, theme/locale/compact layout, real Claude local and SSH commands, approval/rejection, session permission/revocation, and workspace permission reset. Its old main-close-exits assertion is superseded by tray behavior | `artifacts/chat-release-02/chat-results.json` and rendered screenshots |
| Pre-correction model and reasoning metadata | Claude 2.1.300 and Codex 0.153.2 returned versioned account/CLI metadata. The old picker retained only Claude Opus/Sonnet/Haiku 5.5 and Fable 5.1; Codex exposed GPT-6 Astra. Old GPT-5.6 variants were excluded. Claude advertised low/medium/high/xhigh/max; Codex also advertised ultra and default medium. A real Codex thread-start accepted high; this is not a live Codex inference pass | `artifacts/model-catalog-01/provider-metadata.json`, `official-current-lineup.json`, `reasoning-metadata.json` |
| Composer/tray release native close-to-background | The composer/tray production binary received real main-window WM_CLOSE; both original main/chat HWNDs remained alive with Visible=false and the native tray owner still existed. The subsequent physical tray-menu attempt failed and is not a pass | `artifacts/tray-release-02/native-04-hidden-owned-windows.json`; `tray-report.json` |
| Composer/tray release non-disruptive runtime acceptance | Passed using a separately compiled native startup override (`visible=false`, `focus=false`) launched through `agent-desktop` without activation, then the app-owned WebView2 CDP client. Actual footer geometry and Build-options selection passed. Real LaTeX compilation and approved local/SSH Python commands completed after WM_CLOSE while the same HWND stayed hidden. Real Claude low/high arguments were observed on six owned CLI launches; approval, rejection, acknowledged session permission and revocation all passed. Captured WebView renders were inspected; no app window appeared in desktop inventory. This is not a physical tray restore/exit test | `artifacts/headless-runtime-03/report.json`, `agent-desktop-launch.json`, `agent-desktop-final-inventory.json`, `local-hidden-render.png`, `ssh-hidden-render.png` |
| Physical-test safety gate | `node scripts/smoke-tray.mjs` now refuses before creating fixtures or launching an app unless explicit `--headed` permission is supplied. Native helper actions that raise shell surfaces or move input also require `-Headed`; read-only window inspection does not restore/move the cursor | Observed `HEADED_PERMISSION_REQUIRED` refusal |
| Earlier full-version catalog, before latest-per-family policy | The production normalizer at that release accepted five Codex and seven Claude choices from real CLI metadata plus published model IDs. The GPT version-preservation policy is superseded by the latest-per-family check below; the captured output remains historical evidence | `artifacts/model-series-01/codex-all-models.json`, `normalized-models.json` |
| Codex exact model routing and account restriction, before latest-per-family policy | The normal Paperdock Codex store reported an authenticated subscription. Five isolated ephemeral thread-start requests echoed the five then-listed IDs exactly; this does not prove inference access. An actual `gpt-6.1-sol` turn failed with HTTP 400 `model_not_found`: this model is not supported when using Codex with a ChatGPT account. No replacement model or API-billing fallback was used | `artifacts/model-series-01/codex-selected-requests.json` |
| Earlier full-series native Claude picker and inference | Before the 5.5-only restriction, a uniquely named hidden verification executable was launched through `agent-desktop` without activation. All seven then-listed Claude versions were selectable; explicit Sonnet 5 survived connection refresh. The owned CLI received `--model claude-haiku-5-5` and the actual assistant replied `MODEL_SERIES_CLAUDE_OK`. The same native HWND remained hidden before and after the run. This older selection policy is superseded below | `artifacts/model-series-ui-01/report.json`, `agent-desktop-launch-02.json`, `sonnet-5-selected.png`, `haiku-5-5-response.png` |
| GPT latest-per-family amendment | Strict Clippy and all 83 native tests passed. The actual production normalizer and selection validator were run against the previously captured real CLI metadata: Astra 6, Luna 6, Sol 6.1 and Terra 6.1 are selectable; Sol 6 is rejected. Regression cases cover a newer official version replacing an older CLI default, a newer CLI version replacing the official fallback, numeric 7.10 > 7.9 ordering, distinct variants, and retained per-model reasoning capabilities. Claude and the UI were unchanged in that amendment; no window was launched | `artifacts/latest-model-series-01/normalized-models.json`; Cargo command output. Temporary native smoke source removed after use |
| Claude 5.5-only native picker and inference | Strict Clippy, 83 native tests and 109 frontend tests passed. The hidden native app exposed exactly Opus 5.5, Sonnet 5.5 and Haiku 5.5, with no Fable, older version or custom-ID option. All three were selectable and Opus 5.5 survived connection refresh. The owned CLI received `--model claude-haiku-5-5`; the actual assistant replied `CLAUDE_55_OK`. Native tests reject excluded families/releases and custom IDs before inference. Both inspected WebView renders came from the same hidden HWND. Only the isolated verification process was stopped; temporary sources and hidden launchers were removed afterward | `artifacts/claude55-ui-01/report.json`, `agent-desktop-launch.json`, `opus-5-5-selected.png`, `haiku-5-5-response.png` |

The update fixture is GitHub CLI's public release feed, used only in an isolated profile to exercise the real HTTPS notification path. It is **not a Paperdock production feed** or a claim that Paperdock 2.103.3 exists. No default user profile is configured with that test feed.

The new executable and installer use normal production startup visibility, not the hidden verification override. Their SHA-256 values and paths are recorded in `artifacts/claude55-release-01/release-manifest.json`. Both original delivery paths under `src-tauri/target/x86_64-pc-windows-msvc/release/` were updated and hash-verified, as were the fresh copies in `artifacts/claude55-release-01/`. No user process was terminated and no installer was launched. Save work and exit any running copy through the tray before installing an update. Verification-only launchers and temporary smoke sources were removed after use.

### Defects exposed by actual execution

- The first native suite exposed a Windows accepted-socket nonblocking inheritance defect in the MCP broker. Accepted broker and askpass sockets now explicitly enter blocking mode while retaining timeouts; the native suite then passed.
- Initial packaging rejected mismatched Tauri minor releases. Frontend API/CLI were aligned to 2.12 and the frozen install and release package build succeeded.
- Initial local LaTeX execution passed Win32 verbatim namespace paths to TeX. Failed `.fdb_latexmk` files contained `//?/C:/...` names. The corrected external-tool boundary passed actual local builds/rendering with all three installed engines.
- Initial broad desktop smoke exposed an oversized diagnostics overlay and zero-height AI history viewport, plus editor/discovery harness timing assumptions. Those initial scenario failures are retained under `artifacts/desktop-release-01/` and are not counted as acceptance passes.
- Actual SSH fixture investigation found that this WSL environment removes idle `/tmp` fixtures. UUID-scoped owner-only fixtures now use the user's Paperdock cache instead; the test never changes global WSL cleanup policy. Evidence: `artifacts/wsl-fixture-lifetime-investigation.json`.
- Native Windows canonical paths contain `\\?\`; local harness identity checks now resolve actual filesystem identity rather than comparing display spellings.
- After an approved AI proposal was applied and compiled, the new PDF stayed marked stale because a reload bumped the client's source counter mid-build (observed build status `stale` with all 41 manifest sources matching disk). Staleness is now decided by the native manifest-versus-disk comparison.
- A second launch on the same profile aborted with a WebView2 creation error; it now explains the running instance and exits.
- A build's own pre-build save scheduled a second, redundant build 800 ms later, which kept the workspace busy and blocked a project switch in the aggregate run. The flush's saves are now treated as part of the running build.
- The desktop harness could select text in the previous document's text layer while the new PDF was loading. The preview now exposes the displayed build and text-layer readiness, and the harness waits for both.
- Memory: the first twenty-cycle runs measured 375 MiB maximum and +132 MiB growth (`artifacts/memory-release-02/`). Real allocator dumps, IPC timelines and garbage-inclusive allocation sampling then attributed it to: DevTools network instrumentation retaining response bodies and per-request metadata for every IPC call (harness side; the CDP wrapper now disables network tracking), per-entry regex allocation in main-document candidate filtering (~180 MiB cumulative per run), rebuilding a 20,000-entry filename map per discovery batch, full-text re-reads of open files every 2 s, repainting retained canvases on visibility changes, installing editor state for every restored tab, a per-activation global TeX language registration, and an idle 80 ms agent-panel timer. Each was fixed at its source; no forced GC, purge or feature removal. Evidence: `artifacts/idle-allocation-diagnose-02/`, `artifacts/burst-allocation-profile-01/`, `artifacts/retained-owners-diagnose-01/`.
- The WMI-based memory sampler took ~1 s per sample and could not keep a 1 s cadence (109 of 120 samples). It now reads `PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize` natively; spot checks matched the `Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate` counter byte-for-byte. A protected `csrss.exe` carrying a stale parent PID reused by an owned process is resolved with a one-time CIM creation-time lookup instead of aborting the run.
- Oversized JSON-escaped chat history could lose the entire newest message; the bounded tail now accounts for serialized escapes and UTF-8/UTF-16 boundaries. A failing-before/passing-after regression covers the user-visible retained tail.
- Actual worker shutdown could classify a cancelled child as failed if process exit won the polling race. Cancellation is checked first; actual WSL execution tests passed afterward.
- The physical tray harness failed to expose an owned Paperdock menu. Its captured icon region did not match Paperdock's bundled icon, so this is not evidence of a product tray-menu failure. Physical input was stopped at the user's request and gated behind explicit permission; no repeated click was attempted.
- Hidden-runtime harness failures 01/02 were test assumptions: it waited for `running` instead of the actual build phase `building`, then sampled the Claude process before model validation had launched it. Run 03 waits for the actual phase and an owned provider child; it passed without changing production code.

### Explicit unverified gates and prerequisites

- Tray Open, tray double-click, and the explicit Exit menu's dirty-buffer/active-work dialogs remain unverified through the physical Windows tray. Headless `agent-desktop` cannot perform that tray right-click/closed-overflow interaction, and the user explicitly prohibited visible windows, cursor movement and foreground changes. Do not substitute direct internal event injection for those menu gates.
- Latest detached-window memory, latest full installer interaction and the complete desktop aggregate after the composer-effort/tray and full-model-series amendments have not been rerun. Earlier passing evidence above is labeled by its scope.
- The memory run used the explicit `-AllowNonstandardDisplayScale` diagnostic: this machine's Windows scale is 125 % (owned-window DPI 120; renderer DPR 1.0). Standard acceptance requires 100 % scale, so the `standardDisplayScale` gate reports false. The OS setting was not changed; a 100 % rerun on a machine at that scale is required to claim the standard gate.
- Codex reports `AUTH_REQUIRED` in the isolated GUI verification profile; no existing tokens are copied and no authorization browser is opened under the non-disruption restriction. The normal Paperdock store is authenticated and was used for the exact-ID and account-restriction checks above. Full Codex local/SSH acceptance remains unexercised; Claude local/SSH passed. Published model IDs are not evidence that a ChatGPT subscription can run them.
- Authenticode signing, interactive SmartScreen behavior and fresh-machine WebView2 bootstrap are not inferred from the isolated silent installer test.
- At the time of this pre-rebrand baseline there was no official Paperdock release URL/remote or signing infrastructure. The configurable notification path was exercised, but those results do not establish a TexyPaper production announcement or published release. There is no automatic installer execution.

## Current harness reproduction

These are **current TexyPaper command examples, not newly executed results**. Run from the repository root. Every output directory must be new. The desktop/SSH/agent/preferences/memory commands below launch visible windows and require user authorization; do not run them during a background-only user request. `smoke:tray` additionally requires explicit physical-input permission and `--headed`; the historical physical-menu gate remains unresolved. Use isolated profiles, never normal user data; do not copy credential files.

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis -- --locked
$app = 'src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe'
pnpm smoke:preferences --binary $app --output artifacts/preferences-new
pnpm smoke:desktop --binary $app --output artifacts/desktop-new --installer 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/TexyPaper_0.0.1_x64-setup.exe'
pnpm smoke:ssh --binary $app --output artifacts/ssh-new
pnpm smoke:agents --binary $app --output artifacts/agents-new --data-dir artifacts/dedicated-smoke-auth --live --auth-timeout-seconds 300
pnpm measure:memory -AppPath $app -OutputDirectory artifacts/memory-new -DurationSeconds 120 -Provider claude -AuthenticationDataDirectory artifacts/dedicated-smoke-auth
```

`--update-feed` requires `--update-version` for a known real HTTPS test release. Without that argument, the preferences suite still tests honest unconfigured/disabled states but reports the available-release path as not exercised. A CDP-emulated 2× renderer is not equivalent to changing Windows display scale.
