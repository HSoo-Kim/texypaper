# Changelog

## 0.0.6 — 2026-11-08

### Editor and PDF

- The marker that **show in PDF** (`Ctrl+Alt+J` or the editor toolbar button) draws on the PDF spot now fades out and is removed after about three seconds instead of staying on the page until the next build or navigation. With reduced motion it disappears without the fade.
- Soft-wrapped lines keep their source line number on the first row and show a muted `↳` on every further row, so each visible row of the editor has a mark in the number column while build errors and SyncTeX still quote the same line numbers.
- The number column has its own background (the sidebar color, so it follows custom palettes) and a thin divider from the text. The current line's number is highlighted with the selection color.
- The Home button has no border or fill at rest and shows its border on hover, like the other toolbar buttons.

### Fixes

- An editor view could write its stale state back after the file had been reloaded from disk, whether through an approved reload after a conflict or the automatic reload of a clean file that changed outside. The view then kept showing the old text while the buffer was marked clean at the new revision, so a later save could overwrite the outside change without a conflict. The new spell-check results made this reachable in 0.0.5 (in instrumented runs such stale updates arrived in most SSH smoke runs). A view update is now ignored unless it starts from the state the buffer currently tracks.
- Two opens of the same file at once (a double-click on a tree row, or restoring tabs while you click) could finish out of order, and the older one replaced the record that was already installed in the editor. Edits then went to a record the view did not show. The extra read is now dropped and the installed record is kept; a unit test starts two opens and finishes them in the wrong order.
- The usability suite asserts that the PDF marker is detached again after it appeared, and the features suite checks the line number marks, the gutter background and the Home button border.

## 0.0.5 — 2026-11-07

### Writing

- English spell check for rendered prose only: TeX commands and option arguments, math, comments, verbatim text, labels, citation keys, words with digits, acronyms and identifiers are skipped. Suggestions open on hover, click or `Alt+F8` and **Ignore word** keeps a bounded list (500) in TexyPaper's own settings; the Windows custom dictionary is never touched. It uses the Windows English (US/UK) dictionary through `ISpellChecker` and falls back to a bundled SCOWL en_US dictionary (about 0.5 MB, parsed on the first check only; about 3 MB of extra working set measured) when Windows has no English dictionary, as on a Korean-only installation. `spell_status`, `spell_check` and `spell_suggest` run on the Windows client for local and SSH projects alike. New settings: `spellCheck` (default on, `Spell check (English)`) and `spellIgnore`.
- The status bar shows the prose word and character count, and the count of the selection. Hangul and other CJK runs count once, contractions and hyphenated words count once, standalone numbers do not count.
- **Ask AI about this error** in the build log attaches the source around the first diagnostic (20 lines either side) as a chip and pre-fills a question when the composer is empty. It never sends anything by itself.
- **New paper from template** on Home creates an English article, Korean article (XeLaTeX with ko.TeX), Beamer presentation or chapter-based report in an existing folder, local or SSH. It only creates new files, refuses and lists the paths when any template file or folder already exists, records the main document and engine in `.texypaper/project.json` and opens the paper.

### Project

- Project-wide **Replace** in the project search panel: a preview of the changed lines per file, **Match case** and **Whole word**, then one transaction for up to 16 UTF-8 files and 2,000 matches with **Undo**. Every base SHA-256 is re-checked, open editors are saved first, BOM and line endings are preserved, and non-UTF-8, over-4-MiB, read-only and private files are skipped and listed. The native project search now honors case sensitivity and cursor pagination on local and SSH projects, and the generic `apply_proposal` path accepts user-driven edits of other UTF-8 text files (the AI path keeps its TeX/Bib/style restriction).
- Figures by drop or paste: dropping PNG, JPEG, GIF, WebP, SVG, PDF or EPS files on the file tree, or dropping or pasting an image into the editor, copies it into the project through a new chunked binary import (`asset_import_begin/chunk/commit/abort`; 20 MiB per file, extension allow-list, no overwrite, hash-verified, atomic publication, local and SSH). The editor also inserts a figure block with a relative `\includegraphics` path.
- **Checkpoints** rail item: named snapshots of source-type text files stored in the app data (at most 50 checkpoints, 400 files, 1 MiB per file, 8 MiB in total), a per-file line diff against the current project, and restore of all changed, selected or single files (up to 16 per transaction) that first creates a **Before restore** checkpoint, never deletes files added later and offers **Undo**.

### Fixes

- The diagnostics of a failed local build kept the TeX log's build-directory spelling (`./main.tex`), and the project path check rejected it with `PATH_OUTSIDE_WORKSPACE`. They are now normalized to project-relative paths like the diagnostics of a published build; entries outside the project are no longer clickable.

### Packaging and verification

- New `pnpm smoke:features` real-window scenario suite (word count and spell check, ask-AI-about-error, project replace with BOM/CRLF and the 16-file limit, drop and paste import, checkpoints, templates compiled with the Windows TeX Live), and a new SSH scenario for remote replace, binary import, checkpoints and template creation. `smoke:usability` and `smoke:features` now also run in `scripts/windows-build.ps1 -RunSmoke`. New native and worker tests cover spelling, checkpoints, asset import and project replace. Evidence and limits are in `docs/VERIFICATION.md`.
- New third-party components: the pure-Rust `spellbook` crate (MPL-2.0) and the SCOWL en_US dictionary data; their exact license texts and provenance are in `licenses/` and `THIRD_PARTY_NOTICES.md`.


### Documentation

- The README is restructured into the usual project-page layout (header and badges, Key Capabilities, Quick Start, requirements, deep dives, features, shortcuts, data and compatibility, build, layout, license) and is available in English, Korean, Simplified Chinese and Japanese (`README.md`, `README.ko.md`, `README.zh-CN.md`, `README.ja.md`). Comparisons with and statements about other tools were removed.
- Build, packaging, real-app smoke, memory measurement and the one-time Paperdock migration notes moved to `docs/DEVELOPMENT.md` (English) and `docs/DEVELOPMENT.ko.md` (Korean) without changing their content.

## 0.0.4 — 2026-11-07

### Explorer

- Folder icons now follow the name-driven convention instead of one blue folder: a neutral blue-gray default for unknown names, and a distinct color plus a small glyph for common roles (docs, source, tests, results, figures, sections, paper/TeX, references). More names map to those roles (`plots`, `tables`, `appendix`, `bibliography`, `notes`, `lib`, `tex` and others); `node_modules`, `.git`, `.vscode` and similar tool folders stay dimmed. The artwork is original; folder color is cosmetic and is never evidence that a folder holds a paper.

## 0.0.3 — 2026-11-07

### Home, panes and navigation

- Added a **Home** button and a full-page project screen for choosing, adding and switching projects. Visiting Home keeps the open project's unsaved edits, undo history, selection, builds and AI work; **Return to project** resumes without reopening. Only an actual switch asks about running work and unsaved files, and rapid clicks cannot start two switches.
- Source and PDF panes have a wider, visible divider grip with pointer-capture drag, arrow/Home/End keys, double-click to reset and persisted ratios. A collapsed pane keeps an arrow at the same edge that restores the previous ratio.
- `Ctrl+wheel` and `Ctrl`+`+`/`-` zoom only the pane under the pointer or focus: source text size (persisted `editorFontSize`), PDF scale and AI chat text (persisted `chatFontSize`, docked and detached). Page-level WebView zoom is blocked everywhere else.
- Source ↔ PDF: `Ctrl+click` in the PDF opens the matching source line (native results are normalized to project-relative paths of that build, and a PDF older than the source is flagged as approximate); `Ctrl+Alt+J` or the new editor toolbar button highlights and scrolls to the corresponding PDF spot. Source `Ctrl+click` stays Overleaf's multiple cursors.
- The document outline numbers headings `1`, `1.1`, `1.1.1` with per-level indentation; starred headings stay unnumbered. Numbering follows source order and does not claim to reproduce compiled numbering.
- Folders that contain TeX/bib/style files are marked with a **TeX** badge before they are expanded; a dimmer badge marks ancestors with verified descendants. The explorer, open tabs and quick open show original colorful file-type and blue folder icons (TeX, bib, packages, PDF, images, code, data, archives, build artifacts and special folders). Paths shown in Home and tooltips no longer carry the Windows `\\?\` prefix.

### Editing and shortcuts

- Source editing follows Overleaf's default shortcuts: `Ctrl+D` deletes the line, `Ctrl+/` toggles `%` comments, `Ctrl+B`/`I`, upper/lower case, indent/outdent, move/copy/duplicate lines, go to line, find next/previous, folding (`F2`, `Alt+Shift+0/1`), cumulative cursors, `Ctrl+click` multi-cursor and `Alt`+drag rectangular selection. Conflicting CodeMirror defaults are removed rather than overridden; read-only buffers and IME composition are protected.
- `Ctrl+Enter` and `Ctrl+.` compile like `Ctrl+S`, `Ctrl+J` toggles the comments panel, and `Ctrl+Shift+C` comments on the selection. The former `Ctrl+Shift+A` is removed because Overleaf uses it for track changes.
- LaTeX commands such as `\centering` use a fixed, readable green in light and dark themes, independent of the accent palette.
- A categorized **Shortcuts** dialog with a vertical index, key caps and search opens from a corner button in the status bar and on Home.
- Source and PDF selections have a context menu (cut/copy, attach to AI, comment, show in PDF / view source, edit text).

### AI

- The always-visible “shared environment and selection” block is gone. Selections are shared only when attached explicitly with `Ctrl+L` or the context menu; attachments appear as removable, clickable chips (up to eight sources and eight PDF quotes), are validated natively for read access and freshness, and are cleared after sending.
- The cloud-transfer consent is remembered once per provider after the first explicit send and can be revoked from the composer. The native `agent_start` still refuses requests without `disclosureAccepted`; recovery data and detached-window patches cannot create consent.

### Packaging and verification

- Windows x64 NSIS and portable ZIP remain unsigned with the complete license/notices payload. New settings keys (`editorFontSize`, `chatFontSize`, `aiDisclosureAccepted`) are validated natively. File icons and other artwork are original; no third-party icon set was added.
- New `pnpm smoke:usability` scenario suite; the desktop smoke now targets the Home page, root selection in build options and `Ctrl+Shift+C`. Evidence and limits are in `docs/VERIFICATION.md`.

## 0.0.2 — 2026-11-07

### Continuity and window behavior

- Added **File → Exit TexyPaper** and `Ctrl+Shift+Q`, sharing the existing active-work and unsaved-change guards.
- The first main-window close explains background operation and offers keep running in tray, complete exit, or cancel. Only the acknowledged native hide command saves the policy; subsequent closes hide both windows.
- On Windows, another launch with the same user/profile restores the existing instance through a current-user-only, restore-only event. Exclusive profile locks and migration conflicts remain authoritative.
- Restore workspace-scoped editor selection/scroll, PDF page/zoom/rotation, source/PDF split, sidebar widths and conversation history/message positions. Metadata is bounded and serialized in the client profile, including for SSH projects; execution permission and transmission consent are never restored from reading state.
- Preserve chat reading anchors across native detach/dock and width reflow. A detached window created while its main owner is hidden stays hidden.

### Interface and identity

- Recent projects and Continue are primary on the start screen. Project and SSH forms expand on request, return keyboard focus when collapsed, and retain explicit SSH helper consent.
- Quieter porcelain/navy surfaces and burgundy/rose accents in light/dark modes; explicit custom palettes are unchanged.
- Removed the outer navy background from the supplied app icon and regenerated platform assets; the source artwork and banner are unchanged.
- More readable transcript width and spacing, compact composer controls, concise model family/version labels, and expandable model-access details. A previously selected model missing from the catalog is shown as unavailable rather than silently replaced.
- Source/PDF resizing keeps the pointer's grab offset. Pressed states avoid layout jumps and respect reduced-motion/contrast preferences.
- Fixed the dashboard Settings button's chrome contrast after adding the File menu.
- Keep composer controls visible within the enlarged UI's scrolling input area. Source syntax now uses theme-aware semantic colors instead of fixed light-theme colors, including readable comments on dark backgrounds.

### Packaging and verification

- Windows x64 NSIS and portable ZIP remain unsigned and include the complete license/notices payload. No macOS binary, cloud login/sync or automatic installer execution is added.
- Scope Vitest to `src` so ignored exported source-audit trees are not accidentally included in release test totals.
- Actual runtime checks and limitations are recorded separately in `docs/VERIFICATION.md`; historical 0.0.1 evidence is retained.

## 0.0.1 — 2026-11-06

### TexyPaper identity

- Renamed the product to **TexyPaper — The Sexy LaTeX Editor**, version 0.0.1, with public source at `https://github.com/HSoo-Kim/texypaper` and Windows NSIS/portable ZIP distributions. Exercised verification and remaining limits are recorded in `docs/VERIFICATION.md`.
- New machine name `texypaper`, Rust library `texypaper_lib`, bundle ID `dev.texypaper.desktop`, internal scheme/events/environment prefix, `TEXYPAPER/1` remote protocol, `.texypaper` project metadata and `~/.cache/texypaper` worker code cache.
- One-time legacy profile/project directory migration preserves settings, comments, recovery, trash and workspace identity; refuses conflicting metadata directories and unsafe links rather than merging/deleting. Profile migration renames the directory without reading/copying credential files; old app must be closed. Recognized private paths are adapted without replacing user prose, and legacy PDF source mapping requires a new build.
- Navy surfaces and reddish/pink brand accents; user palettes and semantic warning/paper-folder colors remain independent.
- Own code uses MIT; retained third-party notices and license resources remain separately applicable. Windows x64 is the supported desktop; no macOS build, cloud account or realtime collaboration is claimed.


### Application

- Standalone Windows x64 paper workspace built with Tauri, React and CodeMirror; no dependency on OpenPaper, Orca or VS Code.
- Local folders and native OpenSSH environments with a versioned, standard-library Python workspace helper. Workspace identity and epochs scope filesystem operations and late events.
- Paper-aware virtualized explorer, explicit main-document selection, on-demand source languages, project search and bibliography/label completion.
- Hash-checked saves, recoverable multi-file transactions, conflict comparison, private dirty-buffer recovery, project trash/restore and guarded undo. Saves preserve UTF-8 BOM and existing newline encoding.
- Host-side LaTeX compilation, explicit trusted-project mode, owned cancellation, immutable PDF/SyncTeX manifests and stale-document detection.
- Bounded PDF.js rendering, authenticated native byte ranges, PDF search/rotation/export and reference-document viewing. Conservative PDF prose edits require unique, current source proofs; unsupported mappings remain explicit source-edit operations.
- Portable source/PDF comments with replies, resolve/reopen and orphan handling.
- Official subscription-authenticated Codex and Claude integrations with scoped MCP evidence tools. Proposed changes are separate from source writes and require explicit application approval; no automatic API-billing fallback.
- User-controlled local/SSH command execution: deny, per-command approval by default, or explicitly acknowledged permission for the current workspace connection. Immutable command cards show the actual environment, cwd, argv, output and exit status; cancellation and permission revocation stop owned process trees. Commands are not OS-sandboxed.
- GPT-6/6.1 series selection keeps the newest numeric version within each family: Sol 6.1 replaces Sol 6, while Astra 6 and Luna 6 remain. Claude is limited to Opus, Sonnet and Haiku 5.5; Fable, older releases and custom-ID bypasses are excluded from both the picker and native request validation. Published model IDs supplement missing CLI entries with an explicit account-access notice; GPT-5.6 and duplicate aliases remain excluded. CLI-advertised reasoning levels are validated and passed to real requests, including resumed conversations; documented-only models use the provider default. No automatic model or billing fallback.
- Main-window close now hides the app and detached chat to the Windows system tray without stopping AI, commands or builds. Tray Open/double-click restores existing windows; explicit Exit retains work/dirty-buffer guards and waits for native cleanup. No Windows autostart configuration is added.
- External links (official sign-in, release pages) open through the Windows default URL handler; `explorer.exe` previously opened a folder window for long sign-in URLs.
- Saves retry briefly when a TeX engine, indexer or scanner holds the target file without delete sharing, instead of failing with `IO_ERROR` 1175.
- PDF pages render on hardware-composited canvases, removing a per-render compositor image copy measured in real allocator dumps.
- Switching AI providers no longer shows the previous provider's sign-in state while the new status is loading.
- A failed build keeps the last good PDF on screen as stale; the logs view opens automatically only when no PDF exists and closes after a successful build.
- After a build, the stale-PDF marker is decided from the native comparison of the published manifest with current files, so an applied AI proposal or a reload no longer leaves a freshly compiled PDF marked stale.
- A second launch on the same profile explains that TexyPaper is already running and exits cleanly instead of aborting with a WebView2 creation error.
- Open files are polled by native revision; their text is re-read only when the file actually changed.
- Lower renderer memory churn: retained PDF canvases are not repainted when only the visible page changes, the explorer merges discovery batches into one filename map, main-document candidates are computed once per listing, restoring tabs installs only the final active editor state, the TeX language is registered once, and the agent panel no longer wakes every 80 ms while idle.
- Saves performed by a build's own pre-build flush no longer queue a second, redundant build.
- The PDF preview exposes which build it is displaying and when a page's text layer is ready for selection mapping.
- Overleaf-style compiling: an open `.tex` file is enough to compile, and `Ctrl+S` saves and compiles (only saves when "build after save" is off). The main document is found from the opened file's `% !TeX root`, an explicit choice, the opened file's own `\documentclass`, or the nearest folder with exactly one `\documentclass` file; ambiguous folders ask instead of guessing.
- The main-document list now offers TeX files that discovery found inside unexpanded folders (for example `paper/TR-C/main.tex`); previously nested papers could not be chosen until their folders were expanded.

### Workspace layout

- Overleaf-inspired layout: dark app bar with working File/Edit/View/Help menus and a centered project switcher; activity rail for Files, project Search, Comments and AI; Help and Settings at the bottom.
- Independent right-hand transcript-first AI panel, with resizable width and an on-demand native detached chat window. Main-owned state preserves drafts, streamed responses, active work and approvals across docking; the child has no direct workspace/provider/command authority.
- Compact model, reasoning and execution-permission controls sit to the left of Send/Stop. Provider sign-in and executable configuration remain in a separate settings view.
- File panel with a collapsible document outline from the open TeX buffer; editor tab strip with undo/redo, find and selection-wrapping TeX insert commands.
- PDF pane with a primary Recompile split button, main-document options, a diagnostics badge, an in-pane "Logs and output" view, export, page navigation and zoom.
- Project dashboard with real recent projects, and a sectioned settings sheet. Navy surfaces and reddish/pink accents are the defaults; alternate palettes remain available.
- Removed the always-visible main-document selector from the top bar. Automatic root detection remains primary; manual selection is available through Build options, including in source-only view.

### Language and appearance

- Persisted Korean and English interface selection. Source files and provider replies are not translated implicitly.
- System, light and dark themes, with independent accent/background/surface/sidebar palettes for day and night.
- Color presets, recent combinations, HEX/color-picker inputs, readable-contrast checks and reset. PDF paper remains white and paper-folder evidence retains its semantic color.
- Persistent bottom update notices and release-page actions. Automatic checks are throttled to once per 24 hours; manual checks and disabling notifications are supported.
- HTTPS GitHub release or custom JSON feeds are configurable. Production builds may inject the HSoo-Kim/texypaper feed through `TEXYPAPER_UPDATE_FEED_URL`; saved user settings retain precedence. No signing key or automatic installer execution is supplied.

### Packaging and evidence

- Per-user bilingual `TexyPaper_0.0.1_x64-setup.exe` NSIS installer and a portable ZIP containing `texypaper.exe`, root `LICENSE`, `THIRD_PARTY_NOTICES.md` and the full `licenses/` tree. The standalone exe is not a notices-free public release asset.
- Isolated real-WebView2 desktop, SSH, provider, preferences and private-working-set measurement harnesses. The memory sampler reads `PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize` natively (checked equal to the `WorkingSetPrivate` performance counter) so it can keep a one-second cadence. Consult `docs/VERIFICATION.md` for actually exercised results and missing prerequisites; implementation entries here do not assert that every acceptance gate passed.
- Physical tray automation now refuses by default; explicit headed permission is required before it can expose shell surfaces or move the cursor. Background-only verification uses a separate hidden-start configuration, never the delivered application's startup settings.
- Preserved upstream notices and corresponding Liberation font source in `licenses/`; resources are included in the installer.
