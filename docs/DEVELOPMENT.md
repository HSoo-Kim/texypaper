# Development guide

**English** · [한국어](DEVELOPMENT.ko.md)

How to build from source, run the verification scripts and carry over data from the earlier Paperdock app. For using the app see the [README](../README.md); for internals see [ARCHITECTURE.md](ARCHITECTURE.md); for what has actually been exercised see [VERIFICATION.md](VERIFICATION.md).

## Prerequisites

Work from the repository root in Windows PowerShell. You need Node.js (24.x is the reference here), `pnpm@12.16.1`, an MSVC toolchain that supports Rust edition 2024, the Visual Studio C++ Build Tools / Windows SDK, and WebView2. The two lockfiles are the source of truth for exact JS and Rust dependencies. The commands below assume the tools are already installed and include no global installs.

```powershell
pnpm install --frozen-lockfile
pnpm dev -- -- --data-dir "$env:TEMP\texypaper-dev-isolated"
```

The dev run opens a visible app window, so don't start it from a background job without the user's permission. A debug run refuses to open the default user profile and requires an explicit `--data-dir`; never point it at real user settings or account stores. `pnpm dev:web` runs only the front-end dev server. A plain browser tab cannot use the native file, SSH or process commands.

## Build and package

Individual checks and the Windows x64 NSIS build:

```powershell
pnpm build
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

`pnpm typecheck` only type-checks. The full build script checks the exit code of every external command and stops on failure.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-build.ps1
```

The executable is configured to land at `src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe` and the NSIS package at `bundle/nsis/TexyPaper_0.0.5_x64-setup.exe` under the same release folder (a set `CARGO_TARGET_DIR` takes precedence). Whether they were actually produced, and how the installer behaves, must be checked separately.

```powershell
$app = (Resolve-Path 'src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe').Path
& $app --data-dir 'C:\TexyPaperData\isolated-session' --open 'C:\Papers\my-paper'
```

`--data-dir` separates settings, recovery, WebView2 and the Codex sign-in. Signing in under a different data directory does not authenticate the current store. `--open` opens a local project through the same validation as a production open.

A release build can bake in the default update feed through the `TEXYPAPER_UPDATE_FEED_URL` environment variable. This is a **compile-time** setting; a stored `updates.feedUrl` takes precedence, and a stored empty string never falls back to the production address on its own.

## Real-app smoke runs and memory measurement

**Never use a user's paper as a test input. The smoke and memory commands below launch real, visible app windows and need the user's explicit permission first; don't run them from a background-only job.** Tray and mouse automation must also pass the existing `--headed` / `-Headed` safety gate. The regular suites are not headless tools. The scripts build synthetic fixtures and attach to the real release exe over WebView2 CDP. Give `--output` a fresh **ASCII path** with no earlier results on every run, and don't run the fixture generator into a smoke output folder beforehand; the smoke creates its own fixture subfolder.

```powershell
$app = (Resolve-Path 'src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe').Path
$run = Join-Path $env:TEMP ('texypaper-evidence-' + [guid]::NewGuid().ToString('N'))

pnpm smoke:preferences --binary $app --output (Join-Path $run 'preferences')
pnpm smoke:usability --binary $app --output (Join-Path $run 'usability')
pnpm smoke:features --binary $app --output (Join-Path $run 'features')
pnpm smoke:desktop --binary $app --output (Join-Path $run 'desktop')
pnpm smoke:ssh --binary $app --output (Join-Path $run 'ssh')
pnpm smoke:agents --binary $app --live --auth-timeout-seconds 600 --output (Join-Path $run 'agents')
pnpm measure:memory -AppPath $app -DurationSeconds 120 -Provider codex -AuthenticationTimeoutSeconds 600 -OutputDirectory (Join-Path $run 'memory')
```

The memory `-OutputDirectory` must be a **directory that doesn't exist yet**. An agent run without `--live` is never reported as a success, and the sign-in wait does not sign in for you: complete the official authentication window yourself. If you need reusable authentication data, use a smoke-only store rather than your normal app data. The agent smoke takes `--data-dir`; the memory measurement takes `-AuthenticationDataDirectory`.

The standard memory verdict is taken at a real Windows display scale of 100%. To collect diagnostic numbers without changing your scale, pass `-AllowNonstandardDisplayScale`. It changes no OS setting, and if the real scale isn't 100% the standard verdict and the overall result stay failed even when the rest of the measurement finishes. A CDP 2× renderer emulation is never reported as a real Windows scale measurement.

To also check installation, name the NSIS executable you built exactly. If a TexyPaper installation already exists, the isolated install check refuses rather than overwrite it.

```powershell
pnpm smoke:desktop --binary $app --installer 'C:\Builds\TexyPaper_0.0.5_x64-setup.exe' --output (Join-Path $run 'installer-desktop')
```

The installer path above is an example input you must replace with the file you actually built. The integrated run below also opens visible windows and needs the user's permission; it requires the installed tools and an NSIS artifact named exactly `TexyPaper_0.0.5_x64-setup.exe`.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-build.ps1 -RunSmoke -LiveAgents -MeasureMemory -OutputDirectory (Join-Path $env:TEMP ('texypaper-full-' + [guid]::NewGuid().ToString('N')))
```

The SSH smoke builds a loopback SSH host and a ProxyJump host with the dev-only `ssh2` package and runs the **real Python/TeX worker inside WSL `Ubuntu-24.04`**. It needs Windows `ssh.exe` and `ssh-keygen.exe`, a WSL distribution, and Python ≥ 3.9, latexmk, pdfLaTeX and SyncTeX in Linux. Another registered distribution can be chosen with `--distribution`. Missing tools are not installed for you, and a local build is never substituted for a remote one. If CDP is blocked by a security policy, that block has to be resolved; a component test is not accepted as real-UI evidence.

To generate fixtures only, use a separate fresh directory:

```powershell
node scripts/create-smoke-fixtures.mjs --output (Join-Path $env:TEMP ('texypaper-fixtures-' + [guid]::NewGuid().ToString('N')))
```

The low-memory design uses a single editor and PDF document/worker, at most three canvases, and at most eight clean inactive editor states with an 8 MiB source cache. **The 300 MiB private-working-set ceiling for the app plus its dedicated WebView2 is a measurement target, not a hard limit.** In a pre-rebrand development build measured at a Windows display scale of 125%, the standard-work maximum was 282.7 MiB and the same-state growth after 20 switches was 12.0 MiB. That is not a measurement of the current TexyPaper or of builds with the detached chat window, and it is not a 100%-scale standard verdict (see the earlier baseline in [VERIFICATION.md](VERIFICATION.md)). The memory script takes one-second samples for 120 seconds after a warm-up, runs repeated switching and separate high-DPI and real-AI phases, and reports TeX, SSH and AI processes as separate items plus a combined total. It never reports commit as private working set and never assumes the remote host costs nothing.

## Handing the source to a Mac developer

Pass the source from the same [repository](https://github.com/HSoo-Kim/texypaper) together with both lockfiles, `THIRD_PARTY_NOTICES.md` and `licenses/`. Don't mix in a user profile, credentials, paper or recovery content, or earlier smoke output. Match the Node, pnpm and Rust versions, then review the Windows-only process, OpenSSH, WebView and tray boundaries separately. `scripts/windows-build.ps1` and the Windows NSIS/exe are not a Mac build path, and there is currently no macOS build command, success result or DMG.

## One-time migration from Paperdock data

- First close the old app completely with the tray **Exit**. The old software doesn't follow the new locking convention, so atomicity isn't guaranteed if both apps write the same project at once.
- If only `%APPDATA%\dev.paperdock.desktop` exists and the new `%APPDATA%\dev.texypaper.desktop` doesn't, the directory itself is moved. Settings, recent projects, recovery, conversations and provider stores are not copied one by one, and credential files or token contents are never read or copied. A running old profile's lock, both directories existing at once, and symlink/reparse paths stop the move with an explicit error. If you pass `--data-dir`, this default-profile migration is skipped.
- A local or SSH project's old `.paperdock` directory is renamed only when no new `.texypaper` exists. If both exist it stops as a conflict and nothing is merged or deleted. A symlink, a path leading outside the project, or a malformed recovery/build record is reported as an error rather than ignored.
- Project settings, comments, the journal, the trash and your original files are preserved and the workspace identity doesn't change. Only the internal paths of recognized recovery/build records are adjusted to the new metadata location; names inside your papers, comments and message text are not bulk-replaced. The old PDF is kept, but its SyncTeX still points at a private path, so it can't grant source-edit rights until you build again.
- On a conflict or path error, both directories are left as they are: back them up and resolve the cause. Don't delete one side or the recovery journal by hand. The old app's metadata names stay protected from automatic search and AI file access.
