<div align="center">

<img src="assets/brand/texypaper-icon.png" width="96" alt="TexyPaper icon">

# TexyPaper

**The Sexy LaTeX Editor. Edit local and SSH papers where they live, compile on the host, and review every AI change before it touches your source.**

<p>
  <a href="https://github.com/HSoo-Kim/texypaper/releases/latest"><img src="https://img.shields.io/badge/Download-Windows%20x64-000000?style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAgMGgxMS4zNzd2MTEuMzcySDB6bTEyLjYyMyAwSDI0djExLjM3MkgxMi42MjN6TTAgMTIuNjIzaDExLjM3N1YyNEgwem0xMi42MjMgMEgyNFYyNEgxMi42MjN6Ii8%2BPC9zdmc%2B" alt="Download TexyPaper for Windows" /></a>
  <a href="https://github.com/HSoo-Kim/texypaper/releases/latest"><img src="https://img.shields.io/github/v/release/HSoo-Kim/texypaper?style=for-the-badge&label=Release&color=007ec6" alt="Latest release" /></a>
  <a href="https://github.com/HSoo-Kim/texypaper/releases"><img src="https://img.shields.io/github/downloads/HSoo-Kim/texypaper/total?style=for-the-badge&label=Downloads&color=1E90FF" alt="Total downloads" /></a>
  <a href="https://github.com/HSoo-Kim/texypaper/stargazers"><img src="https://img.shields.io/github/stars/HSoo-Kim/texypaper?style=for-the-badge&label=Stars&logo=github&logoColor=white&color=000000" alt="GitHub Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=for-the-badge" alt="License MIT" /></a>
</p>

<p>
  <b>English</b> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a>
</p>

<img src="docs/screenshots/workspace-light.png" alt="TexyPaper showing the file explorer, the compiled PDF and the AI panel in the light theme" width="100%">

</div>

A Windows desktop LaTeX editor built with Tauri 2, Rust, React and CodeMirror. It opens a paper folder on this PC or on an SSH server, edits and compiles it where it lives, and shows the PDF beside the source.

## Key Capabilities

| Feature | What it does |
|---|---|
| **Local and SSH projects** | Open a folder on this PC, or a real POSIX path on a server through your own OpenSSH setup. Files are read and written in place; nothing is mirrored to Windows. [Details](#open-a-project) |
| **`Ctrl+S`, then PDF** | Saving compiles with latexmk on the machine that holds the paper. The main document is found from `% !TeX root`, your choice or `\documentclass`, so there is usually nothing to configure. [Details](#compile-and-read-the-pdf) |
| **Source and PDF side by side** | `Ctrl+click` the PDF to jump to the source line; `Ctrl+Alt+J` highlights the matching PDF spot (SyncTeX). Drag the divider, and zoom the source, the PDF and the chat independently. |
| **Overleaf-style editing** | Overleaf's default shortcuts (`Ctrl+D` delete line, `Ctrl+/` comment, multiple cursors, folding), a numbered section outline, and citation and label completion. |
| **Spelling and word count** | English spell check for prose only, so TeX commands, math, comments and citation keys are never flagged, with suggestions on click or `Alt+F8`. The status bar shows the word count, or the count of the selection. [Details](#spelling-and-word-count) |
| **Project-wide replace** | Preview every changed line per file, then replace across up to 16 files as one undoable save. [Details](#project-wide-replace) |
| **Figures by drop or paste** | Drop an image or PDF on the explorer, or paste a screenshot into the source: the file is copied into the project and a ready-to-fill figure block is inserted. [Details](#figures-from-drop-or-paste) |
| **Checkpoints** | Named snapshots of the project's text files, a per-file diff against the current state and a restore that can be undone. [Details](#checkpoints) |
| **New paper from template** | Start from an English article, Korean article, slide deck or chapter-based report in an existing folder, local or over SSH. [Details](#start-from-a-template) |
| **Edit text from the PDF** | Select rendered text and send a proven literal prose span to a before/after diff. Applying it is one undoable save followed by a rebuild. [Details](#fix-text-from-the-pdf) |
| **Comments** | Comment on a source or PDF selection. Threads live in `.texypaper/comments.json` and reattach by quote and context after edits. |
| **AI that proposes, you apply** | Codex and Claude run through their official CLIs on your own subscription. They can read the project and propose changes; nothing is written until you press **Apply changes**. [Details](#ai-codex-and-claude) |
| **Safe saving and recovery** | SHA-256 check before every write, a conflict dialog for outside edits, a recovery journal for unsaved text, and undo for the last save. |
| **Paper-aware explorer** | A **TeX** badge marks folders that contain TeX files before you expand them, with file-type icons and role-colored folder icons. |
| **Themes and languages** | Korean and English UI, light, dark or system theme, and your own accent, background, editor and sidebar colors. |
| **Update notice** | A persistent notice at the bottom when a newer release exists. It never installs anything by itself. |

[Full feature list](#features)

## Quick Start

1. Download `TexyPaper_<version>_x64-setup.exe` from the [latest release](https://github.com/HSoo-Kim/texypaper/releases/latest) (Windows x64, developed and tested on Windows 11; the Microsoft Edge WebView2 runtime is required). There is also a portable ZIP.
2. Run the installer. It installs for the current user and needs no administrator rights. For the ZIP, extract all of it and run `texypaper.exe`.
3. Press `Ctrl+O` for **Home**, choose **Open project**, pick your paper folder, open a `.tex` file and press `Ctrl+S`.

You also need a TeX distribution whose `latexmk` is on `PATH` (on the server, for SSH projects). The installer and the executable are not code-signed, so Windows may warn that it can't verify the publisher. To update, save your work, close TexyPaper completely (**File → Exit TexyPaper**, `Ctrl+Shift+Q`, or **Exit TexyPaper** in the tray), then run the new installer.

### Requirements

| For | You need |
|---|---|
| The desktop app | Windows x64 and the Microsoft Edge WebView2 runtime |
| Local TeX builds | `latexmk` on `PATH`, the engine you choose (`pdflatex`, `xelatex` or `lualatex`), and the TeX packages, fonts and BibTeX/Biber your paper needs |
| Source ⇄ PDF jumps | SyncTeX data from the build and `synctex` on the host |
| SSH editing | Windows OpenSSH `ssh.exe`, a Linux or macOS POSIX server with `python3` 3.9 or later, and write access to the project and a user cache folder |
| SSH builds | The above, plus latexmk, your engine, SyncTeX and your paper's dependencies installed **on the server** |
| AI | The official Codex or Claude Code CLI installed on Windows, a supported subscription sign-in for that provider, and an internet connection |

TeX, Python, SSH and the AI CLIs are not bundled, and TexyPaper never installs global or server packages for you. An SSH server needs no Codex, Claude, Node or always-on daemon. A server without TeX still allows file editing; builds fail with `TEX_TOOL_MISSING`.

## Open a project

**Home** (the Home button, `Ctrl+O`) is a full-page screen for choosing, adding and switching projects. Recent projects come first, and the open project has **Return to project**. While you are on Home, the open project's edits, builds and AI work keep running; switching to a different project is the only moment you are asked about unsaved files and running work.

**This computer:** choose **Open project → This computer → Browse folder**. The project is read and written directly in that directory. Open a `.tex` file from the file panel; the **File outline** below it shows `\section`, `\subsection` and `\subsubsection` numbered `1`, `1.1`, `1.1.1` with per-level indentation, and clicking an entry jumps to its line (numbers follow source order, so they can differ from the compiled numbering).

**SSH server:**

1. In **Add SSH environment**, give an OpenSSH alias or host name, plus a user, port, private key or a separate SSH config file if needed. Specific `Host` aliases and `Include` lines of your OpenSSH config are read; wildcards are not expanded into a server list.
2. Enter a **real POSIX path on the server**, such as `/home/user/paper`.
3. Accept the helper notice. For the connection, a small standard-library Python worker is started; the SHA-256-verified version is cached in `~/.cache/texypaper/worker/<sha256>/`. No pip, npm, root install or open port is used.
4. For a new server, confirm the full fingerprint OpenSSH presents. Passwords, key passphrases and keyboard-interactive answers are typed in the app's own authentication window; cancelling stops the connection.

Your existing keys, SSH agent and ProxyJump settings are used, but TexyPaper never starts the ssh-agent service or raises privileges. A **changed host key is an error**; the app does not clear `known_hosts` to get around it. If the connection drops, saves and builds are never reported as done: the last PDF and your unsaved edits are kept, and after **Reconnect** you check the original revision and any uncertain transaction. A failed write is not re-sent automatically.

## Compile and read the PDF

Builds always run on the host that holds the project; an SSH paper is never copied to Windows to be built. **`Ctrl+S` saves and compiles** (with **Build automatically after save** off in settings it only saves), and a pause in typing autosaves and then compiles. **Recompile** in the PDF pane, the top **Build** button and `Ctrl+Shift+B` do the same.

The main document is found without setup, in this order: `% !TeX root = ...` in the open file → the main document you chose → the open file if it has `\documentclass` → the nearest folder, from the open file's folder upward, that holds exactly one `\documentclass` file. If several candidates tie, TexyPaper asks instead of guessing: use **Build options → Main document** or the menu next to **Recompile**. A chosen main document is stored in `.texypaper/project.json`.

| Profile | Behavior |
|---|---|
| **Basic** | `latexmk -norc` with `-no-shell-escape`, SyncTeX and the recorder. This ignores latexmk rc files; it does not sandbox TeX itself. |
| **Project** | Uses your existing latexmk configuration, which can run commands, so it needs an explicit trust confirmation. The trust is stored in the client's app data, not in the project JSON. |

One build runs at a time, and overlapping saves collapse into the newest rebuild request. The default time limit is 120 seconds, and cancelling stops the process tree the app started. If a build fails, is cancelled or times out, the last good PDF stays visible marked as out of date. The number on the log button counts errors and warnings; the log opens by itself only when there is no PDF to show.

When a build fails and the log shows an error with a source location, **Ask AI about this error** attaches the source around the first error (20 lines either side) to the AI chat and fills in a question if the input box is empty. Nothing is sent until you press send.

The PDF pane has page navigation, fit width, actual size, zoom, 90° rotation, per-page text search and PDF export. A reference PDF you opened separately is never replaced by a rebuild of the main document; **Return to built PDF** returns to it. PNG, JPEG, WebP and non-executing SVG files preview in place.

### Fix text from the PDF

1. Select rendered PDF text and choose **View source / Edit text / Edit with AI / Comment**.
2. **Edit text** checks the current PDF, its SyncTeX data, the source snapshot taken at compile time and the current source hash together. It never guesses a character offset from a SyncTeX position alone.
3. Only a literal prose span that is proven unique inside one source paragraph goes to the before/after review. Input is plain text and TeX special characters are escaped; edit raw TeX in the source editor.
4. Applying re-checks the hash, saves as one undoable transaction and rebuilds. If the source changed or the selection expired it is refused with `PDF_STALE`; rebuild and select again.

Repeated sentences, macros, math, citations, tables, selections across files or paragraph boundaries, non-contiguous multi-column selections, ambiguous ligatures or hyphens, and coordinates that can't be verified are never replaced automatically. Jump to the candidate source and fix it explicitly, or use a reviewable AI proposal.

### Comments

Create a comment from a source or PDF selection, then reply, edit, delete, resolve or reopen it. Comments are stored in `.texypaper/comments.json` on the project's real host; they are never inserted as TeX `%` comments. App edits move the byte anchor; after outside edits a comment reattaches only when its quote and surrounding context match uniquely in the same file, otherwise it shows as **Orphaned** so you can reselect it. A PDF-only comment belongs to that PDF's hash and is not moved to the same page number of a new PDF.

## Write and revise

### Spelling and word count

Turn **Spell check (English)** on or off under **Settings → Source editing** (on by default). Misspelled words in the visible part of the source get a wavy underline; hover or click one, or put the cursor on it and press `Alt+F8`, to see up to five suggestions and **Ignore word**.

- **What is checked:** only rendered prose. TeX commands and their option arguments, math, comments, verbatim text, labels and citation keys are skipped, and so are words with digits, all-capital acronyms, camelCase and hyphen/underscore identifiers. Text in other scripts, such as Korean, is not checked. Matches are marked only after you stop typing for a moment.
- **Dictionary:** the English (US or UK) dictionary of Windows is used when the PC has one. A Windows PC with only another language installed, as is common with a Korean-only setup, has no English dictionary, so TexyPaper falls back to a built-in English dictionary (SCOWL, about 0.5 MB, loaded on the first check only; about 3 MB of extra working set was measured for loading it). **Settings** shows which one is in use.
- **Ignored words:** **Ignore word** saves the word in TexyPaper's own settings (up to 500; **Clear ignored words** empties the list). The Windows custom dictionary is never modified.
- **Word count:** the status bar shows the words and characters of the prose, not of TeX commands, math or comments, and the count of the selection while text is selected. A run of Hangul or other CJK characters counts as one word because no segmentation is attempted, a contraction or hyphenated word counts once, and standalone numbers do not count. Characters include the spaces and punctuation of prose. It is an estimate of the source and does not expand macros.

### Project-wide replace

Open the **Project search** panel in the left rail, enter the text to find and open **Replace**. **Preview** lists every file with its changed lines before and after, and **Replace all** applies them.

- **Scope:** UTF-8 text files only. Files over 4 MiB, binary files, non-UTF-8 files and the app's private metadata are listed as skipped and left alone. **Match case** and **Whole word** are available.
- **Limits:** at most 16 files and 2,000 matches at a time. A bigger result is refused with a message and nothing is written, so narrow the search first.
- **One undoable save:** the application re-reads every file and checks its SHA-256 against the preview, saves open editors first, and writes all files as one transaction with the same BOM and line endings. If any file changed after the preview, nothing is written. **Undo** next to the result restores the previous content of every file.
- Works for local and SSH projects alike.

### Figures from drop or paste

Drop PNG, JPEG, GIF, WebP, SVG, PDF or EPS files on the file tree (a folder row chooses that folder; anywhere else uses the `figures` folder when there is one, otherwise the project root), or drop them or paste a clipboard image into the source editor. Files dropped on the explorer are only copied; a drop or paste in the editor also inserts a `\begin{figure}` block with `\includegraphics`, an empty caption and a label at the cursor, with the path relative to the open file.

- **Safe copy:** at most 20 MiB per file and only the extensions above. The name is made filesystem-safe, an existing file is never overwritten (a number is added instead), the content hash is verified after the transfer, and the file appears atomically. A folder on a file system without hard links therefore fails with an error instead of being written half-way.
- A pasted image is saved as `pasted-image-<date>-<time>.png` (a non-PNG clipboard image is converted to PNG first). Whether LaTeX can include a format depends on your engine; pdfLaTeX takes PNG, JPEG and PDF. Local and SSH projects both work, and for SSH the bytes go over the existing connection.

### Checkpoints

The **Checkpoints** item in the left rail keeps named snapshots of the project's text files, a lighter safety net than a version-control repository and independent of it.

- **Create checkpoint** saves open files first, then stores the project's source-type text files in TexyPaper's app data, not in your project: UTF-8, writable `.tex`, `.ltx`, `.bib`, `.bst`, `.cls`, `.sty`, `.bbx`, `.cbx`, `.dtx`, `.ins`, `.md`, `.txt`, `.csv`, `.tsv`, `.json`, `.yaml`, `.yml`, `.toml`, `.py`, `.r`, `.m`, `.jl` and `.sh` files. Hidden files and folders (such as `.git` and `.texypaper`), `node_modules`, `venv`, `__pycache__`, `build`, `dist` and `target` are left out, as are files that cannot be read as UTF-8 text.
- **Limits:** a file over 1 MiB, read-only or not UTF-8 is skipped and listed; a checkpoint holds at most 400 files and 8 MiB in total, and a project over that is refused with an explanation instead of being saved partly. At most 50 checkpoints are kept and the oldest are pruned.
- **Compare** lists changed, added and removed files against the current project and shows a line diff for each.
- **Restore** can bring back all changed files, selected files or one file, up to 16 at a time. It asks first, creates a **Before restore** checkpoint, writes the files as one transaction and offers **Undo**. Files added after the checkpoint are never deleted.

### Start from a template

On Home, **New paper from template** creates a starter paper in a folder that already exists and is best empty. Choose a computer or SSH environment, the folder, and one of **English article**, **Korean article** (XeLaTeX with ko.TeX), **Presentation slides** (Beamer) or **Chapter-based report**, then **Create and open**.

TexyPaper only creates new files; if any of the template's files or folders already exists, nothing is created and the paths are listed. The main document and engine are saved in `.texypaper/project.json` and the paper opens ready to compile.

## AI: Codex and Claude

Open **Settings** at the top of the AI chat, choose a provider and press **Refresh connection** to check the official CLI and account. The supported protocol baseline is **Codex 0.153.2 / Claude Code 2.1.300**. The model, reasoning level and execution permission sit beside the send button. Version mismatches, unavailable models, limits, authentication and network failures are shown as they are; TexyPaper never switches to a different paid API.

- **Codex:** finish the ChatGPT sign-in under **Official sign-in → Open authorization page**. TexyPaper uses its own official store (`CODEX_HOME=<app-data>/providers/codex`), so you may need to sign in once more even if Codex was signed in elsewhere. Existing tokens and global settings are never copied.
- **Claude:** uses the `claude.ai` subscription account of the official CLI; run `claude auth login` in a terminal if needed, then refresh. Console/API keys and third-party logins are not treated as a subscription.

The model picker shows the newest version per family from GPT-6 up, and only Claude Opus, Sonnet and Haiku 5.5. The current defaults are **GPT-6 Astra and Luna, GPT-6.1 Sol and Terra**, and **Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5** ([OpenAI models](https://developers.openai.com/api/docs/guides/latest-model), [Claude models](https://platform.claude.com/docs/en/models/overview)). An official model missing from a CLI's short list can still be chosen; the model-access note describes it as an official catalog choice not reported by the current CLI, and the ID is sent as typed. If your subscription refuses it you get the provider's error, not another model. Reasoning levels come only from the selected model's CLI metadata; without it the provider default is used.

Both CLIs run **only on the Windows client**, never with an SSH URI as their working directory. They reach the selected local or SSH project through a private control directory and seven MCP tools: `list_files`, `read_text`, `search_text`, `get_build_status`, `propose_changes`, `propose_command` and `get_command_status`. The providers' own shell and direct file-write tools are disabled.

**Attaching and consent.** Only text you explicitly attach with `Ctrl+L` or right-click → **Attach to AI chat** (from the source or the PDF) becomes a chip in the input box; merely selecting text shares nothing. The cloud-transfer consent is a checkbox **once per provider** (OpenAI, Anthropic) that is remembered, with a note and **Revoke consent** left in the input box. Relevant source, code and result excerpts are then sent to the provider you chose. The default read tools exclude secrets, `.env*`, credentials and the app's own auth and recovery stores, and `propose_changes` may only write TeX, Bib and style files.

**A model reply or a proposal is not a save.** `propose_changes` only creates a proposal and leaves it **Awaiting approval**. Review the diff and its evidence files and lines, then press **Apply changes** to write. Rejecting or cancelling leaves the source untouched, every base hash is re-checked at apply time, and on a conflict the proposal is kept so it can be rewritten against the new source. Applied proposals can be undone. Only one AI task runs at a time, processes start only when needed, and the session ID is kept to resume a conversation; no model server stays on.

### Running project code

The AI proposes commands through `propose_command`; they run on the project's real host (this PC for a local project, the server for an SSH project). The model cannot change permissions or approve its own command.

| Execution permission | Behavior |
|---|---|
| **Deny** | Blocks new proposals, rejects pending ones and stops a running command |
| **Ask each time** (default) | Shows the environment, working folder, exact argv and time limit for each command to approve or reject |
| **Allow session** | After a risk notice and a checkbox, runs later commands for the current project connection without individual approval |

A session permission resets when you switch project, reconnect or really quit (hiding to the tray is not quitting). You can return to **Ask each time** or **Deny** at any time. The command card shows stdout/stderr, the exit code and whether output was truncated, and each command can be stopped. One command runs at a time with a 120-second default limit, and no shell string is run implicitly: the approved argv runs exactly, interpreter included.

**The working-folder limit is not an OS sandbox.** An approved command runs with that local or SSH account's rights and can affect files, the network and the system outside the project. Side effects are not undone automatically, and an approved command isn't bound by the file-read and file-write limits above.

### Chat window and tray

- **Detach chat window** detaches the chat and **Dock in main window** brings it back. The conversation, draft, reading position, running work and pending approvals stay with the main controller, and closing the detached window returns the chat to the main window. New replies don't pull the view to the end while you read or select older messages.
- The main window's **first X** asks **Keep running in tray / Exit completely / Cancel**. After you accept the tray, X hides the main window and the detached chat together while AI, commands and builds keep going.
- **File → Exit TexyPaper**, `Ctrl+Shift+Q` and the tray's **Exit TexyPaper** confirm stopping work and unsaved content, then quit. The tray's **Open TexyPaper**, a double-click on the icon, or starting TexyPaper again with the same Windows user and profile restores the existing window; a different `--data-dir` is a separate instance. No Windows autostart is configured.

The Claude subscription link is meant for personal use. Before distributing to others, re-read the [official subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and the [Agent SDK policy](https://code.claude.com/docs/en/agent-sdk/overview).

## Features

### Editor and saving
- **Editing:** TeX syntax highlighting, bracket matching, indentation, line numbers, find/replace, and citation and label completion from the loaded TeX/Bib files. LaTeX commands such as `\section` and `\centering` are always green, whatever the palette. Code files lazy-load their language mode, unknown text opens as plain text, and no language server is started.
- **Overleaf defaults:** `Ctrl+D` delete line, `Ctrl+/` toggle comment, `Ctrl+B` / `Ctrl+I`, case changes, move and copy lines, folding, `Ctrl+click` for multiple cursors and `Alt`+drag for rectangular selection. `Ctrl+Enter` and `Ctrl+.` compile, `Ctrl+J` toggles the comments panel and `Ctrl+Shift+C` comments on a selection.
- **Line numbers:** the number column has its own background next to the text. A line that soft-wraps keeps its source line number on the first row and shows a muted `↳` on each further row, so build errors and SyncTeX quote the numbers you see.
- **Autosave:** 700 ms after you stop typing, deferred during IME composition. `Ctrl+S` saves pending source immediately and compiles; the automatic build after an autosave has its own 800 ms debounce.
- **Safe writes:** the SHA-256 is compared right before writing, a temp file on the same filesystem is flushed and swapped in, and the UTF-8 BOM and existing line endings are kept. File size or modified time alone never decides a conflict.
- **Conflicts:** a file changed outside is reloaded if the buffer is clean; with unsaved edits you see `FILE_CONFLICT` and choose **Compare / Reload / Save copy** (reloading discards your changes and asks first). This is optimistic conflict detection; outside editors don't follow TexyPaper's locking.
- **Recovery:** unsaved text goes to an app-owned recovery record, and on restart or reconnect the original hash and the transaction state are checked together. On `TRANSACTION_PARTIAL`, look at the affected paths and the preserved journal rather than re-running the same action. **Undo last save** is journal-based and refuses to overwrite a result file that changed afterwards.
- **Guards:** switching project or quitting asks to save, discard or cancel unsaved content and whether to stop running work; a failed save never lets you move on. Files over 4 MiB open read-only until you explicitly allow editing after a memory warning, and non-UTF-8 files are never converted silently (**Save converted copy** may replace unreadable bytes and keeps the original).
- **Session restore:** per project, the open tabs, active file, source cursor, selection and scroll, the source/PDF split and panel widths, the PDF page, zoom and rotation, and the reading position in the chat history. A PDF position is reused only for the **same build and file hash**. It is stored in this computer's app data for local and SSH projects alike, and is not synced to other PCs. Run permission and cloud-transfer consent are never restored from it.

### Explorer
- **File types and folders:** colored file-type icons (TeX, bib, PDF, images, code and more), and folder icons whose color and glyph follow the name. Common names such as `docs`, `src`, `tests`, `results`, `figures`, `sections`, `paper` and `references` get their own color and glyph, unknown names stay a blue-gray default, and tool folders such as `node_modules` and `.git` are dimmed. The folder color is cosmetic and is not evidence that a paper is inside. The icons are original SVG artwork.
- **TeX badge:** a folder that directly contains `.tex`, `.ltx`, `.bib`, `.cls`, `.sty`, `.bst`, `.bbx` or `.cbx` files shows a bold name, an amber band and a **TeX** badge; a folder with such files only deeper down gets a dim **TeX** badge. They show before you expand a folder and never come from the folder name. The main TeX file carries a `Main` badge, and a lone PDF does not make a LaTeX project.
- **Search scope:** automatic discovery skips `.git`, `.texypaper`, `node_modules`, `.venv`, `venv` and `__pycache__`; the list is visible in settings and you can open those folders explicitly. It scans up to 20,000 items at a time and continues with **Continue discovery**.
- **File operations:** create, rename, move and delete. Delete asks first and moves the file into the project's `.texypaper/trash/`, from where the project trash can restore it.

### Panes, zoom and navigation
- **Home:** `Ctrl+O` opens it; the open project stays alive underneath.
- **Panes:** the divider between source and PDF drags with the pointer or moves with the arrow keys (double-click for a 50/50 split), and the middle arrows collapse a side. The same edge arrow then restores the previous ratio. Small windows use one center pane plus overlay side panels.
- **Zoom:** `Ctrl+wheel` or `Ctrl`+`+`/`-` resizes the source text, the PDF scale or the AI chat text under the pointer or in the selected pane, each saved on its own. App-wide zoom is the UI zoom setting (100–200%); the PDF itself is never edited.
- **Source ⇄ PDF:** `Ctrl+click` in the PDF opens the matching source line (a PDF older than the source is flagged as approximate); `Ctrl+Alt+J` or the editor toolbar button scrolls to the PDF spot and highlights it for about three seconds. Source `Ctrl+click` stays Overleaf's multiple cursors.
- **Quick open and search:** `Ctrl+P` opens a file by name; start with `>` to search the project text.
- **Shortcut help:** the **Shortcuts** button at the lower right of the status bar (upper right on Home) and the Help menu list every shortcut by category with search.

### Appearance
- **Language and theme:** Korean or English UI, and system, light or dark. Only the UI language changes; your paper and the AI's output language are not translated.
- **Palette:** a navy chrome with restrained burgundy and rose accents, a warm off-white day theme and a low-saturation navy night theme. For light and dark separately you can set the **accent, background, editor and sidebar** colors by HEX or a color picker, with presets, the last eight palettes and a reset. A palette that fails the text-contrast or error/warning distinction check is not applied. The PDF paper stays white and error, warning and paper-folder marks keep their meaning.
- **Accessibility:** reduced motion, high contrast and low-power or transparency-off settings are honored.

### Updates
- **Notice only:** **Update notifications** in settings only tell you a new version exists. TexyPaper never downloads or runs an installer or replaces the app itself; **View release** opens the HTTPS page when you click it.
- **Feed:** release builds bake in the [HSoo-Kim/texypaper](https://github.com/HSoo-Kim/texypaper) feed. Giving a GitHub repository URL reads its `/releases/latest` metadata; a plain HTTPS JSON feed of the form `{ "version": "1.2.3", "url": "https://example.org/releases/1.2.3", "notes": "optional" }` also works (that is a format example, not a real address). Versions compare as SemVer and only newer stable versions are announced; URLs must be HTTPS without credentials, query or fragment, and redirects aren't followed.
- **Timing:** automatic checks are at least **24 hours** apart. **Check now** bypasses that interval but not a turned-off notice, and a failure is kept as a state without erasing an earlier new-version notice.

## Usage

1. Press `Ctrl+O`, open a project and open a `.tex` file.
2. Press `Ctrl+S` to save and compile; the PDF appears beside the source.
3. `Ctrl+click` the PDF to jump to the source, or select PDF text to edit it, comment on it or ask the AI.
4. Open the AI panel from the left rail, attach a selection with `Ctrl+L`, and review any proposal before pressing **Apply changes**.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+O` | Home: choose, add or switch a project |
| `Ctrl+P` | Quick open a file; start with `>` to search project text |
| `Ctrl+S` / `Ctrl+Enter` / `Ctrl+.` | Save and compile (save only if **Build automatically after save** is off). In the AI input, `Ctrl+Enter` sends |
| `Ctrl+Shift+B` | Build now |
| `Ctrl+Alt+J` | Go from the source position to the PDF and highlight it (also a source toolbar button) |
| `Ctrl+click` in the PDF | Jump to the clicked spot's source. `Ctrl+click` in the source adds a cursor, as in Overleaf |
| `Ctrl+L` | Attach the selection (or the current line) to the AI chat |
| `Ctrl+J` | Open or close the comments panel |
| `Ctrl+Shift+C` | Comment on the selection (the earlier `Ctrl+Shift+A` was removed because it clashes with Overleaf's track-changes shortcut) |
| `Ctrl+wheel` / `Ctrl`+`+` / `Ctrl`+`-` | Zoom the source, PDF or AI chat under the pointer or in the selected pane |
| `Ctrl+Shift+Q` | Confirm work and unsaved changes, then quit completely |
| `Alt+F8` | Open spelling suggestions for the underlined word at the cursor |
| `Escape` | Close a popup or selection; cancel an open SSH prompt |

Source editing shortcuts follow Overleaf's defaults; the in-app help lists them all.

## Data and compatibility

- **App data:** the per-user directory is `%APPDATA%\dev.texypaper.desktop` (override with `--data-dir`). It can hold settings, recent projects, recovery content, checkpoints, the visible AI conversation and the Codex account the CLI owns, so don't share it wholesale. Nothing is synced to other PCs.
- **Project data:** `.texypaper/comments.json` and `project.json` travel with the project. `build`, `transactions` and `trash` are generated or recovery records; check for unfinished work before deleting them.
- **Portable:** the portable ZIP saves to the same `%APPDATA%` location; moving the executable keeps the same Windows account's settings.
- **From Paperdock:** the first start renames an old `%APPDATA%\dev.paperdock.desktop` profile and a project's `.paperdock` folder to the new names without reading or copying credentials. Conflicts stop with an explicit error and nothing is merged or deleted. See [the migration notes](docs/DEVELOPMENT.md#one-time-migration-from-paperdock-data).
- **Network:** the app's own HTTP client is used only for the update notice, which reads the latest release information when you or the schedule ask. Other traffic comes from your SSH connections and the AI CLIs you run.
- **Verification:** what has actually been exercised, with evidence, is recorded in [docs/VERIFICATION.md](docs/VERIFICATION.md), and the internal boundaries and storage layout in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Building from source

Requirements: Windows x64, Node.js with `pnpm`, an MSVC Rust toolchain (edition 2024), the Visual Studio C++ Build Tools / Windows SDK and WebView2.

```powershell
pnpm install --frozen-lockfile
pnpm dev -- -- --data-dir "$env:TEMP\texypaper-dev-isolated"   # visible app window, isolated profile
pnpm test                                                      # front-end tests
pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

Output: `src-tauri/target/x86_64-pc-windows-msvc/release/texypaper.exe` and `bundle/nsis/TexyPaper_<version>_x64-setup.exe`. The full build script, the real-app smoke suites, memory measurement and the migration notes are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Project layout

```text
src/                         React front end
  ui/                        App shell, toolbar, Home, themes, shortcut help
  editor/                    CodeMirror editor, TeX shortcuts, folding, buffers, spelling, word count, image paste
  pdf/                       PDF.js viewer, text layer, range transport
  features/
    explorer/                File tree, paper index, outline, file icons
    ai/                      Chat, proposals, command review, chat history
    comments/                Comment threads and anchors
    search/                  Project-wide replace plan and review
    templates/               Paper templates and create-only project start
    assets/                  Figure import (drop and paste)
    history/                 Checkpoints, diff and restore
    pdf-edit/                Selection actions and the source-edit review
  state/                     Workspace and reading-position state
src-tauri/
  src/
    workspace/               Local and SSH workspaces, transactions, SSH config
    spell.rs                 English spell check (Windows dictionary, built-in fallback)
    checkpoints.rs           Checkpoint storage in app data
    latex/                   latexmk scheduler, diagnostics, SyncTeX, prose mapping
    ai/                      Codex/Claude adapters, MCP broker, proposals, model catalog
    execution.rs             Approved command execution
    comments.rs              Comment storage and anchors
    migration.rs             One-time Paperdock data migration
    updates.rs  tray.rs  chat_window.rs  process.rs  state.rs
  resources/remote_worker.py SSH worker (Python standard library only)
  tests/                     Native integration tests
scripts/                     Windows build, smoke suites, memory measurement
docs/                        ARCHITECTURE, VERIFICATION, DEVELOPMENT
```

## License

[MIT License](LICENSE). Third-party components keep their own licenses and copyright notices ([`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), [`licenses/`](licenses/)). The code license and third-party notices do not grant trademark rights to product names or logos. The official CLIs, TeX distributions, WebView2 and cloud services follow their own providers' licenses, terms and account limits.
