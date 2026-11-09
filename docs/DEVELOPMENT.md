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

The executable is configured to land at `src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe` and the NSIS package at `bundle/nsis/TexyPaper_0.0.12_x64-setup.exe` under the same release folder (a set `CARGO_TARGET_DIR` takes precedence). Whether they were actually produced, and how the installer behaves, must be checked separately.

```powershell
$app = (Resolve-Path 'src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe').Path
& $app --data-dir 'C:\TexyPaperData\isolated-session' --open 'C:\Papers\my-paper'
```

`--data-dir` separates settings, recovery, WebView2 and the Codex sign-in. Signing in under a different data directory does not authenticate the current store. `--open` opens a local project through the same validation as a production open.

A release build can bake in the default update feed through the `TEXYPAPER_UPDATE_FEED_URL` environment variable. This is a **compile-time** setting; a stored `updates.feedUrl` takes precedence, and a stored empty string never falls back to the production address on its own.

### Continuous integration

`.github/workflows/ci.yml` runs on pushes and pull requests to `main`, with read-only repository permissions, no secrets and commit-SHA-pinned actions. The Ubuntu frontend job uses Node 24 and the exact pnpm version in `packageManager`, caches the pnpm store, installs the frozen lockfile, then runs `pnpm typecheck` and `pnpm test`. The Windows job installs stable MSVC Rust with rustfmt/clippy, caches Cargo downloads/build output and runs `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked`. No `rust-toolchain` override is currently checked in.

External/platform dependencies are deliberate, not silent substitutes:

| Tests / coverage | CI treatment |
| --- | --- |
| `execution::tests::{pending_deny_duplicate_and_epoch_authority, output_nonzero_timeout_and_cancel_are_actual, deny_and_close_stop_the_owned_descendant_tree, pending_queue_is_bounded_and_only_one_immutable_request_runs}` | Python 3.12 is installed on Windows; real child processes and Windows Job Objects run. |
| `storage_migration::windows_junction_metadata_and_profile_locations_are_refused` | Uses the hosted Windows `cmd.exe /c mklink /J`; a failure fails the job. |
| `spell::tests::selected_engine_returns_utf16_spans` | Uses Windows English spelling when available, otherwise the real bundled dictionary. All forced bundled-engine tests also run; this is not a claim that the Windows dictionary engine was exercised. |
| `synctex_prose::observed_cp949_input_paths_decode_strictly_on_cp949_windows` | Explicit named `--skip`, announced in the job log: requires Windows ANSI code page 949, unlike the hosted image. CI does not change the OS locale. |
| Every `src-tauri/tests/remote_*.py` (currently `remote_assets.py`, `remote_execution.py`, `remote_project_replace.py`, `remote_proposal.py`) | Separate Ubuntu Python 3.12 job runs each with `python3 -I -B` and verbose output. POSIX directory descriptors, symlinks and process groups are real; WSL and TeX are not required by these regressions. |
| Rust `#[cfg(unix)]` symlink tests | Not compiled by the Windows job; POSIX worker coverage above is not a substitute for running Unix-native Rust tests. |
| `smoke:desktop`, `smoke:preferences`, `smoke:usability`, `smoke:features`, `smoke:ssh`, `smoke:agents`, `smoke:chat`, `smoke:tray`, `measure:memory` | Explicitly excluded and announced in the log. These require an approved interactive desktop/WebView2, and some require authentication. Local TeX smoke needs Windows TeX Live with latexmk, pdfLaTeX and SyncTeX; SSH smoke needs OpenSSH, WSL and POSIX Python/TeX. Run the applicable real-app suites separately before release. |

The parser/prose/diagnostic Rust tests use synthetic SyncTeX and log records, not an installed TeX engine. A green CI run is not installer, real-TeX, live-provider, desktop-scale or real-app smoke evidence. Validate workflow edits locally with `actionlint .github/workflows/ci.yml`; CI itself does not publish releases.

### Reproducible release assets

`pnpm package:release` packages an **already built and verified** normal production exe and its NSIS installer. Run it on Windows with Node 24; it reads Windows version/signature metadata with PowerShell and extracts NSIS with 7-Zip without installing the app.

```powershell
$version = '0.0.7'
$release = 'src-tauri/artifacts/cargo-target/x86_64-pc-windows-msvc/release'
$hiddenSha = 'e97e8129527ecc5a346923be8a1584c9e57f613b45d92e5a8a7f39dc1c9cc5e7'
pnpm package:release --version $version --release-dir $release --output "artifacts/release-$version-new" --hidden-sha $hiddenSha
```

The paths/hash above reproduce the historical 0.0.7 input; replace them with the current release folder and the actual SHA-256 of the separately verified hidden build. Never pass a hidden binary as the production exe. The command refuses an existing output directory and removes only its own new output on failure. It creates the installer, portable ZIP, `release-manifest.json`, `package-proof.json` and `SHA256SUMS.txt`, preserving the 0.0.7 field names. Checksums use one space between hash and asset name.

By default 7-Zip is `artifacts/publication-tools/sevenzip/usr/lib/7zip/7z`, invoked through `wsl.exe -d Ubuntu-24.04 --exec`; it must already exist. Pass `--sevenzip 'C:\Program Files\7-Zip\7z.exe'` to use native 7-Zip without WSL, or pass another Linux 7z path for that distribution. No tools are downloaded by the packager.

The ZIP contains `LICENSE`, `THIRD_PARTY_NOTICES.md`, `texypaper.exe`, then all `licenses/` files in ordinal full-path order. Headers use DOS host/0644 file mode and a fixed 2026-11-08 00:00:00 timestamp, with raw deflate level 9 and no directory entries. Node/zlib versions can change compressed bytes: retain the packaging runtime version with release evidence. The script reopens the ZIP, inflates every member and checks its CRC, size and SHA-256, then checks the exact installer license file set/hashes against source. Unsigned builds additionally require the extracted exe to differ from the normal exe by exactly the three bytes in `__TAURI_BUNDLE_TYPE_VAR_UNK` → `__TAURI_BUNDLE_TYPE_VAR_NSS`.

For signed releases add `--signed` only after signing the embedded app, installer **and** standalone exe (see Code signing). Every binary must have a `Valid`, timestamped Authenticode signature and matching signer subject/issuer; individual thumbprints are recorded and may differ with short-lived certificates. The signed proof records all three identities/statuses under `signedExecutableVerification` and sets `installerExecutableDiffersOnlyByTauriBundleType` to `null`: signature validation is not a claim of byte equivalence.

Release checklist:

1. Align release versions and license notices; install both locked dependency sets and run CI checks.
2. Run the applicable real-app smoke suites using only synthetic projects and isolated profiles; retain evidence and the verified hidden executable's SHA-256.
3. Build the normal visible/focused production exe and matching NSIS installer with the intended compile-time update feed; never distribute the hidden smoke build.
4. If signing, complete the explicit signing flow, including standalone signing after NSIS bundling. Unsigned releases remain unsigned; never describe a self-signed test certificate as trusted production signing.
5. Run `package:release` into a fresh directory. Review its manifest, payload count, license proofs, Windows metadata and SHA256SUMS; verify the ZIP independently with Python `zipfile` or 7-Zip.
6. Verify installation and portable startup separately with permission, then publish exactly the checked assets and checksums. Keep packaging/runtime and smoke evidence with the release; the packager does not upload or tag anything.

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
pnpm smoke:ssh-exit --binary $app --output (Join-Path $run 'ssh-exit')
pnpm smoke:agents --binary $app --live --auth-timeout-seconds 600 --output (Join-Path $run 'agents')
pnpm measure:memory -AppPath $app -DurationSeconds 120 -Provider codex -AuthenticationTimeoutSeconds 600 -OutputDirectory (Join-Path $run 'memory')
```

The memory `-OutputDirectory` must be a **directory that doesn't exist yet**. An agent run without `--live` is never reported as a success, and the sign-in wait does not sign in for you: complete the official authentication window yourself. If you need reusable authentication data, use a smoke-only store rather than your normal app data. The agent smoke takes `--data-dir`; the memory measurement takes `-AuthenticationDataDirectory`.
The SSH exit smoke injects the tray's quit event into the main window and uses its own loopback SSH host; it does **not** test the physical tray menu.

The standard memory verdict is taken at a real Windows display scale of 100%. To collect diagnostic numbers without changing your scale, pass `-AllowNonstandardDisplayScale`. It changes no OS setting, and if the real scale isn't 100% the standard verdict and the overall result stay failed even when the rest of the measurement finishes. A CDP 2× renderer emulation is never reported as a real Windows scale measurement.

To also check installation, name the NSIS executable you built exactly. If a TexyPaper installation already exists, the isolated install check refuses rather than overwrite it.

```powershell
pnpm smoke:desktop --binary $app --installer 'C:\Builds\TexyPaper_0.0.12_x64-setup.exe' --output (Join-Path $run 'installer-desktop')
```

The installer path above is an example input you must replace with the file you actually built. The integrated run below also opens visible windows and needs the user's permission; it requires the installed tools and an NSIS artifact named exactly `TexyPaper_0.0.12_x64-setup.exe`. The desktop suite opens the native PDF save dialog only with `--native-dialogs`, because that dialog appears on the screen even for the hidden test app.

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

## Code signing

Signing is **opt-in**. Normal builds remain unsigned; only pass `src-tauri/tauri.signing.conf.json` when credentials exist. No signing account has been opened, application submitted, payment made or production certificate obtained by this project change.

### Provider choice (reviewed 2026-11-08)

| Option | Eligibility, cost and maintainer action |
| --- | --- |
| **SignPath Foundation — recommended first application** | Free service and Foundation-owned certificate for accepted OSS projects. Requires an actively maintained, already released, documented project with OSI-approved licensing, no proprietary components/commercial dual licensing, verifiable reputation and repository control. Acceptance is discretionary, not automatic for a new project. Publish a **Code signing policy** on the homepage/releases with the prescribed SignPath credit, named authors/reviewers/approvers and an accurate privacy policy (including optional AI/network services); enable MFA on GitHub and SignPath; apply at [SignPath](https://signpath.org/apply). Each release needs manual approval. The key stays in SignPath's HSM. [Conditions](https://signpath.org/terms), [service](https://signpath.org/). |
| **Azure Artifact Signing (formerly Trusted Signing)** | Basic starts at **US$9.99/month**, with 5,000 signatures/month; local taxes/overage and current regional pricing must be checked. Public Trust **individuals are limited to the US/Canada**: a South Korean individual is currently ineligible. South Korean **organizations** are supported; do not assume an individual/sole proprietor qualifies as an organization without Microsoft's confirmation. Requires Azure subscription/Entra tenant, identity validation, account/profile and signer-role access; no token required. Billing starts when the account is created, even before signing. [Eligibility](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart), [starting cost](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation), [quota/billing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/). |
| **Certum Open Source Code Signing — low-cost fallback** | Issued **only to individuals** for noncommercial OSS; name includes “Open Source Developer”. Store starting prices: **€49 cloud**, **€69 card+reader set**, **€25 activation with an existing compatible card** (confirm chosen term, tax, delivery and checkout total). SimplySign uses a cloud HSM, mobile authorization app and Desktop middleware; the card option needs physical cryptographic hardware. Identity/passport verification, utility bill and a public project clearly connected to the applicant are required. The published documents do not state a US/EU-only restriction, but do **not** establish guaranteed South Korean acceptance: obtain written confirmation of Korean ID/address support before paying. [Products/prices](https://shop.certum.eu/code-signing.html), [cloud requirements](https://shop.certum.eu/open-source-code-signing-on-simplysign.html), [validation/noncommercial restrictions](https://support.certum.eu/en/code-signing-required-documents/). |
| **Other individual certificate example: SSL.com IV** | No business registration required; **US$129/year** certificate, plus key storage: eSigner Tier 1 **US$180/year** (240 signatures) or **US$20/month** (20 signatures), or a listed **US$379 YubiKey**. Thus certificate+annual cloud plan is about **US$309/year**, not US$129 all-in. Hardware/HSM storage is mandatory for publicly trusted certificates; an exportable PFX is not the normal new public-certificate product. Ask the vendor about Korean validation and applicable trade restrictions before ordering; no country-specific acceptance was established here. [Certificate](https://www.ssl.com/products/software-integrity/code-signing/iv/), [subscription/key requirements](https://www.ssl.com/guide/esigner-pricing-for-code-signing/). |

For this maintainer: establish the GitHub-hosted release build, licensing/privacy disclosures and signing roles, then apply for SignPath. If declined or a personal publisher identity is needed, ask Certum to confirm South Korean individual verification and the total €49-cloud offer. Azure is not the personal Korean route today. Do not buy EV merely to remove warnings.

**SmartScreen is not a signing-success test.** Microsoft's [current behavior](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) and [2024 change notice](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/distribution-feature-status#smartscreen-reputation-ev-certificates-no-longer-grant-instant-bypass) supersede older vendor claims: neither OV nor EV guarantees immediate reputation. Newly signed downloads can still warn; clean downloads and a consistent signing identity build reputation. Unsigned files must rebuild hash reputation for each new version. Self-signed certificates have no public trust. Enterprise policy and Smart App Control can be stricter; never ask users to disable protections.

### Opt-in build

Supply `TEXYPAPER_SIGN_PFX` (absolute PFX path) and `TEXYPAPER_SIGN_PASSWORD` through the calling process/CI secret environment, not command-line literals, checked-in files or transcripts. The script never imports a certificate into a Windows store, prints a password or records signing arguments. SignTool necessarily receives the PFX password in its child-process arguments, so use an isolated trusted signing runner; a cloud/HSM provider avoids exporting the production key. The script finds the newest x64 `signtool.exe` under `C:\Program Files (x86)\Windows Kits\10\bin\*\x64`; missing SDK tools are a hard error, not an unsigned fallback.

```powershell
# Set the two credential environment variables securely before this command.
pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis --config src-tauri/tauri.signing.conf.json -- --locked
# Tauri restores the original standalone exe after bundling: sign it separately.
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'src-tauri/target' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/sign-windows.ps1 -FilePath "$target/x86_64-pc-windows-msvc/release/texypaper.exe"
```

The script uses `/fd SHA256 /tr <RFC3161 URL> /td SHA256`; the default TSA is `http://timestamp.digicert.com`, overridable with `TEXYPAPER_SIGN_TIMESTAMP_URL`. Signing/timestamp failures stop the build. The script requires a signer and timestamp but does not turn an untrusted test root into a trusted root. Release verification must require `Get-AuthenticodeSignature` **Valid**, signer and timestamp on the standalone exe, installer **and extracted installed exe**, with consistent signer subject/issuer. Record leaf thumbprints, but allow a provider such as Azure to rotate its short-lived leaf certificate. Never distribute self-signed proofs.

Tauri's [custom command](https://v2.tauri.app/distribute/sign/windows/#custom-sign-command) accepts `%1`; the overlay uses the argument-array form to preserve paths containing spaces. `certificateThumbprint` instead selects an existing Windows-store certificate for Tauri's built-in signer; it is intentionally not set/imported here. Tauri [patches the bundle marker before signing](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle.rs), signs the NSIS payload, builds/signs its uninstaller and installer, then restores the original standalone executable. The standalone and extracted executable may differ (`UNK` versus `NSS`); independently verify both signatures rather than modifying a signed file or requiring byte equality. An outer installer signature alone does not sign its payload.

### Provider hook and optional CI outline

Instead of both PFX variables, set `TEXYPAPER_SIGN_PROVIDER_SCRIPT` to an absolute trusted `.ps1` path. It receives `-FilePath <absolute file> -TimestampUrl <URL> -DigestAlgorithm SHA256`, must sign that file **in place**, wait for completion/approval, preserve SHA-256/RFC3161 requirements and exit nonzero on failure. Never log tokens or secrets. No arbitrary command string is evaluated.

For Azure, the hook needs matched-architecture SDK SignTool and `Azure.CodeSigning.Dlib.dll` from the Artifact Signing client, .NET 8/runtime dependencies, an authenticated `DefaultAzureCredential` identity with Certificate Profile Signer role, and nonsecret metadata JSON containing `Endpoint`, `CodeSigningAccountName`, `CertificateProfileName`. Set the TSA environment to `http://timestamp.acs.microsoft.com`; inside the hook call SignTool `sign /fd SHA256 /tr $TimestampUrl /td SHA256 /dlib <dll> /dmdf <metadata> $FilePath` and explicitly propagate `$LASTEXITCODE`. Keep authentication in CI secrets/workload identity. [Microsoft integration guide](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations).

For SignPath, a local API submission is **not** sufficient Foundation provenance. The [GitHub connector](https://docs.signpath.io/trusted-build-systems/github) requires artifacts uploaded to GitHub Actions and **all jobs leading to signing on GitHub-hosted runners**. An optional future workflow should remain disabled (manual `workflow_dispatch` plus an explicit enable variable/environment approval) until acceptance/configuration:

1. Build from the approved public commit on a GitHub-hosted Windows runner using locked dependencies; upload unsigned inputs with `actions/upload-artifact`.
2. Use `signpath/github-action-submit-signing-request` (currently documented v3; pin an audited commit when enabling), a secret submitter token, organization/project/policy IDs and the uploaded `artifact-id`; wait for manual approval and download the returned signed artifacts.
3. Agree the artifact configuration with SignPath: sign **only project-owned binaries**; enforce product name/version. An NSIS-aware nested signing configuration must cover the inner executable before the outer installer, or use a coordinated two-stage pipeline with signing at Tauri's post-patch hook. Re-upload every stage for verified origin. Do not simply sign an already-built outer installer or re-patch a signed app.
4. Check the locked Tauri version's signing scope: NSIS can request signatures for copied upstream plugins/resources too. Foundation policy forbids signing upstream binaries under its certificate; obtain an approved project-only artifact configuration/provider dispatch rather than blindly forwarding every requested DLL.
5. Verify all three deliverables as above before `package-release.mjs --signed`. Configure secrets only in GitHub; no provider account, approval or live CI signing is provisioned by this repository.

### Local mechanism proof (not a trusted release)

On 2026-11-08, an isolated locked Windows x64 NSIS build with this overlay and the hidden-window test overlay completed successfully (Rust release compilation: 4m 50s). OpenSSL 3.0.13 in WSL generated a two-day RSA-3072 self-signed code-signing PFX; no Windows certificate-store import was used. SDK `10.0.26100.0` SignTool signed the patched embedded executable, NSIS uninstaller/installer, and then the restored standalone executable. A separate provider-hook probe also signed successfully, including file/hook paths with spaces; missing credentials were rejected.

WSL 7-Zip 23.01 extracted the installer without running it. Standalone `texypaper.exe`, `TexyPaper_0.0.7_x64-setup.exe` and the extracted `texypaper.exe` all had signer `CN=TexyPaper Throwaway Signing Test DO NOT DISTRIBUTE`, thumbprint `606FB04062F2E9120EA8CB203C0749BEBC3F8911`, SHA-256 signatures and DigiCert RFC3161 timestamps. The TSA was reachable. **All three were untrusted as expected**: `Get-AuthenticodeSignature` returned `UnknownError` with “terminated in a root certificate which is not trusted”; `signtool verify /pa /v` returned exit 1 with that same root-trust error while listing each signature and verified timestamp chain. This is mechanism evidence, not a `Valid` production-signature claim and not a SmartScreen test.

The PFX/private key, extracted files, test executables/installers, temporary provider scripts and isolated Cargo target directory were deleted after evidence collection. Only nonsecret build/signature logs under ignored `artifacts/signing-test-01/` remain for integration review. No app/installer was launched and no installed app or real user profile was modified.

This section is AI-assisted vendor-document research, not vendor eligibility approval or a price quote; recheck the linked primary sources before applying or purchasing.
