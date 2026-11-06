# Third-party notices — TexyPaper 0.0.1

Full applicable license texts and copyright notices are supplied in the relative
`licenses/` paths below. These notices do not replace those texts, grant trademark
rights, choose a license for independently authored TexyPaper code, or certify a
release for public distribution.

Independently authored TexyPaper code is licensed under the root
[`LICENSE`](LICENSE) (MIT, copyright 2026 HSoo-Kim). Third-party terms below remain
applicable to their respective materials; no trademark permission is implied for
the TexyPaper name, logo or third-party names.

## Scope and provenance

Versions come from actual installed package manifests, `pnpm-lock.yaml`,
`src-tauri/Cargo.lock`, and Cargo's locked Windows x64 dependency resolution.
[`licenses/DEPENDENCIES.tsv`](licenses/DEPENDENCIES.tsv) records exact versions,
declared license expressions, retained license files and exact-version source
URLs for 338 Cargo packages in the normal/build closure and 35 installed npm
production-tree packages. The inventory deliberately includes build dependencies
and optional Node support; it does not assert that every entry is linked/emitted.
[`licenses/ORIGINS.txt`](licenses/ORIGINS.txt) explains collection and pinned
upstream sources used when a crate omitted its own root license file.

This is a collection of concrete known notices, **not an exhaustive legal audit**
of all source-level notices, compiler runtimes, installer components or future
changes. Implementation owners report no OpenPaper code copied; reference patterns
were consulted only. No OpenPaper/Sionic AI license is claimed for independently
authored code.

## Derived and generated code

### SyncTeX parser — MIT

`src-tauri/src/latex/synctex_parser.rs` is a streaming Rust adaptation of the
standalone `parseSyncTex` and block-navigation algorithms from LaTeX Workshop's
`src/locate/synctex/synctexjs.ts` and `worker.ts`, pinned to
[commit 2f5a60a11a99f33013c1235f0499546cc831cfcb](https://github.com/James-Yu/LaTeX-Workshop/tree/2f5a60a11a99f33013c1235f0499546cc831cfcb/src/locate/synctex).
Changes include the language port, bounded streaming/indexes and native integration;
the VS Code extension is not shipped.

**Copyright (c) 2018 Thomas Durieux.** The full MIT permission notice and disclaimer
remain in the Rust header and are reproduced in
[`licenses/synctex-parser-MIT.txt`](licenses/synctex-parser-MIT.txt). Retain the
complete notice with source and binary redistributions of this adaptation.

### Codex app-server generated protocol — Apache-2.0

`src/generated/codex-0.153.2/` contains generated TypeScript declarations and JSON
schemas from official Codex app-server 0.153.2. Native code in
`src-tauri/src/ai/codex.rs` embeds selected JSON schemas from this same tree with
`include_str!`; compiled-in JSON remains third-party protocol material.
The inspected `src-tauri/resources/` contains `remote_worker.py`, not a separate
protocol-schema copy. Retain these notices if generated files are relocated there.

**OpenAI Codex — Copyright 2025 OpenAI.** Full upstream Apache-2.0 text, including
its OpenAI copyright application notice, is in
[`licenses/codex-0.153.2/LICENSE`](licenses/codex-0.153.2/LICENSE).
The original NOTICE is preserved at
[`licenses/codex-0.153.2/NOTICE`](licenses/codex-0.153.2/NOTICE), from the
[pinned upstream release](https://github.com/openai/codex/tree/rust-v0.153.2).
That project-wide NOTICE also mentions Ratatui; TexyPaper does not copy or bundle
Codex's terminal UI. Generator headers are retained. The Codex executable itself
is an external prerequisite, not bundled with these generated declarations.

### ssh2 server authentication example — MIT; development only

`scripts/ssh-smoke-host.mjs` adapts the installed **ssh2 1.17.0** README example
“Password and public key authentication and non-interactive (exec) command
execution.” **Copyright Brian White. All rights reserved.** Full MIT notice:
[`licenses/ssh2-1.17.0-MIT.txt`](licenses/ssh2-1.17.0-MIT.txt).
Upstream: [mscdex/ssh2](https://github.com/mscdex/ssh2); local original files are
`node_modules/ssh2/README.md` and `LICENSE`.

This script and npm dependency are development/smoke-test material, not the
production SSH transport (which uses external OpenSSH). Preserve the notice when
distributing the adapted script. Distributing all development dependencies would
require a separate inventory of their notices.

## PDF.js 6.5.438: code and actual redistributed assets

The browser library/worker are bundled, and the complete `cmaps/`, `standard_fonts/`
and `wasm/` directories are copied from **pdfjs-dist 6.5.438** into `dist/pdfjs/`.
The browser module header identifies build `0a4153349`, **Copyright 2024 Mozilla
Foundation**, under Apache-2.0. Full package license:
[`licenses/pdfjs-dist-6.5.438/LICENSE`](licenses/pdfjs-dist-6.5.438/LICENSE).
The package's Apache declaration does **not** replace the separate asset licenses.

All asset-license paths in the table are relative to `licenses/pdfjs-dist-6.5.438/`.

| Redistributed material | Exact applicable notice family | Full upstream text files |
| --- | --- | --- |
| PDF.js browser library/parser worker | Apache-2.0, Mozilla Foundation | `LICENSE` |
| Compressed CMaps (`*.bcmap`) | Adobe three-condition BSD-style terms; Copyright 1990–2009 Adobe Systems Incorporated | `cmaps/LICENSE` |
| Foxit `*.pfb` standard fonts | Three-clause BSD-style terms; Copyright 2014 PDFium Authors | `standard_fonts/LICENSE_FOXIT` |
| Four `LiberationSans-*.ttf`, version 1.07.4 | GPL version 2 with the exact Liberation exceptions/Red Hat terms; **not SIL OFL** | `standard_fonts/LICENSE_LIBERATION` |
| `openjpeg.wasm`, `openjpeg_nowasm_fallback.js` | OpenJPEG BSD-2-Clause and Mozilla wrapper BSD-2-Clause | `wasm/LICENSE_OPENJPEG`, `wasm/LICENSE_PDFJS_OPENJPEG` |
| `qcms_bg.wasm` | qcms MIT and PDF.js wrapper MIT | `wasm/LICENSE_QCMS`, `wasm/LICENSE_PDFJS_QCMS` |
| `jbig2.wasm`, `jbig2_nowasm_fallback.js` | Combined upstream PDFium BSD-style/Apache-2.0 notices; Mozilla wrapper Apache-2.0 | `wasm/LICENSE_JBIG2`, `wasm/LICENSE_PDFJS_JBIG2` |
| `quickjs-eval.js`, `quickjs-eval.wasm` | QuickJS MIT (Fabrice Bellard/Charlie Gordon); wrapper MIT (Mozilla Foundation) | `wasm/LICENSE_QUICKJS`, `wasm/LICENSE_PDFJS_QUICKJS` |

The complete WASM directory is copied, including QuickJS assets, regardless of
whether a document uses them. Their notices remain required; their presence is
not permission to enable PDF JavaScript. The PDF.js `iccs/` directory is not in
the copy list and is not represented as redistributed; review its separate
license before adding it.

### Liberation corresponding source is supplied

All four TTF SFNT name records identify **Version 1.07.4**.
[PDF.js release provenance](https://raw.githubusercontent.com/mozilla/pdf.js/v6.5.438/external/standard_fonts/README.md)
explicitly identifies the files as the unmodified upstream Liberation Sans 1.07.4
release. The complete corresponding upstream source release (SFD sources,
Makefile, scripts, README, AUTHORS, COPYING and License.txt) is supplied as
[`licenses/font-sources/fonts-liberation_1.07.4.orig.tar.gz`](licenses/font-sources/fonts-liberation_1.07.4.orig.tar.gz).

- Size: **2,937,949 bytes**.
- SHA-256: `ad98b7498dc2992f7f0868f79b65ce4a720a3acdb63ab3f1f1cb6881117a5406`.
- Origin, TTF hashes/name records and build/source instructions:
  [`licenses/font-sources/ORIGIN.txt`](licenses/font-sources/ORIGIN.txt).
- The digest matches the included archival `.dsc`; its PGP signature was not
  independently verified. No rebuilt-font reproducibility is claimed.

Recipients can extract, modify and rebuild the source with separately installed
FontForge and make, following its upstream instructions. Fonts were not modified.
The document-embedding exception is **not** used to excuse standalone-TTF
redistribution. Preserve both the full GPLv2/exception notice and source archive
in packages carrying these fonts. Do not substitute Liberation 2.x/OFL source.

## Other direct frontend dependencies

Resolved versions, not requested semver ranges, identify the installed code.
Full notices retain actual upstream copyright statements; names are not inferred.

| Package | Resolved version | Declared license | Full retained notice |
| --- | --- | --- | --- |
| `@codemirror/autocomplete` | 6.20.4 | MIT | `licenses/npm/@codemirror__autocomplete-6.20.4/LICENSE` |
| `@codemirror/commands` | 6.11.1 | MIT | `licenses/npm/@codemirror__commands-6.11.1/LICENSE` |
| `@codemirror/lang-javascript` | 6.2.5 | MIT | `licenses/npm/@codemirror__lang-javascript-6.2.5/LICENSE` |
| `@codemirror/lang-json` | 6.0.2 | MIT | `licenses/npm/@codemirror__lang-json-6.0.2/LICENSE` |
| `@codemirror/lang-markdown` | 6.5.2 | MIT | `licenses/npm/@codemirror__lang-markdown-6.5.2/LICENSE` |
| `@codemirror/lang-python` | 6.2.1 | MIT | `licenses/npm/@codemirror__lang-python-6.2.1/LICENSE` |
| `@codemirror/language` | 6.13.1 | MIT | `licenses/npm/@codemirror__language-6.13.1/LICENSE` |
| `@codemirror/legacy-modes` | 6.5.5 | MIT | `licenses/npm/@codemirror__legacy-modes-6.5.5/LICENSE` |
| `@codemirror/search` | 6.7.2 | MIT | `licenses/npm/@codemirror__search-6.7.2/LICENSE` |
| `@codemirror/state` | 6.7.6 | MIT | `licenses/npm/@codemirror__state-6.7.6/LICENSE` |
| `@codemirror/view` | 6.43.15 | MIT | `licenses/npm/@codemirror__view-6.43.15/LICENSE` |
| `@tauri-apps/api` | 2.12.4 | Apache-2.0 OR MIT | `licenses/npm/@tauri-apps__api-2.12.4/LICENSE.spdx` |
| `pdfjs-dist` | 6.5.438 | Apache-2.0 | `licenses/npm/pdfjs-dist-6.5.438/LICENSE` |
| `react` | 19.3.1 | MIT | `licenses/npm/react-19.3.1/LICENSE` |
| `react-dom` | 19.3.1 | MIT | `licenses/npm/react-dom-19.3.1/LICENSE` |

Transitive notices, including Lezer parsers, `style-mod`, `crelt`, `w3c-keyname`,
scheduler and `@marijn/find-cluster-break`, are retained under `licenses/npm/`
and indexed in `licenses/DEPENDENCIES.tsv`. Optional Node canvas packages appear
in the installed production tree; their native `.node` binary is not copied into
browser assets or shipped as a runtime. Its installed presence is not a claim
that the native graphics stack has been audited for redistribution.

## Direct native dependencies

| Crate | Resolved version | Manifest license expression | Retained full texts |
| --- | --- | --- | --- |
| `base64` | 0.22.1 | MIT OR Apache-2.0 | `licenses/rust/base64-0.22.1/` |
| `flate2` | 1.1.10 | MIT OR Apache-2.0 | `licenses/rust/flate2-1.1.10/` |
| `jsonschema` | 0.46.10 | MIT | `licenses/rust/jsonschema-0.46.10/` |
| `notify` | 8.2.1 | CC0-1.0 | `licenses/rust/notify-8.2.1/` |
| `rand` | 0.9.5 | MIT OR Apache-2.0 | `licenses/rust/rand-0.9.5/` |
| `regex` | 1.13.1 | MIT OR Apache-2.0 | `licenses/rust/regex-1.13.1/` |
| `reqwest` | 0.12.28 | MIT OR Apache-2.0 | `licenses/rust/reqwest-0.12.28/` |
| `rfd` | 0.15.4 | MIT | `licenses/rust/rfd-0.15.4/` |
| `rmcp` | 3.8.0 | Apache-2.0 | `licenses/rust/rmcp-3.8.0/` |
| `semver` | 1.0.28 | MIT OR Apache-2.0 | `licenses/rust/semver-1.0.28/` |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | `licenses/rust/serde-1.0.229/` |
| `serde_json` | 1.0.154 | MIT OR Apache-2.0 | `licenses/rust/serde_json-1.0.154/` |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | `licenses/rust/sha2-0.10.9/` |
| `tauri` | 2.12.5 | Apache-2.0 OR MIT | `licenses/rust/tauri-2.12.5/` |
| `tauri-build` | 2.7.4 | Apache-2.0 OR MIT | `licenses/rust/tauri-build-2.7.4/` |
| `tokio` | 1.54.1 | MIT | `licenses/rust/tokio-1.54.1/` |
| `unicode-normalization` | 0.1.26 | (MIT OR Apache-2.0) AND Unicode-3.0 | `licenses/rust/unicode-normalization-0.1.26/` |
| `unicode-segmentation` | 1.13.3 | MIT OR Apache-2.0 | `licenses/rust/unicode-segmentation-1.13.3/` |
| `uuid` | 1.29.0 | Apache-2.0 OR MIT | `licenses/rust/uuid-1.29.0/` |
| `windows` | 0.62.2 | MIT OR Apache-2.0 | `licenses/rust/windows-0.62.2/` |

`tauri-build` is a build dependency, not another runtime. Dual-license expressions
are recorded as declared, not rewritten into a new combined license.
`unicode-normalization` additionally requires Unicode-3.0; its `LICENSE-UNICODE`
is retained. Other resolved native notices, including Unicode data, rustls/webpki,
ring and platform crates, are under `licenses/rust/` and indexed in the inventory.

### Microsoft WebView2 loader

`webview2-com-sys 0.39.1` statically links the Microsoft WebView2 SDK
**1.0.3800.47** x64 loader for Windows MSVC. The crate's loader exactly matches the
SDK NuGet archive member by SHA-256. This material has a Microsoft three-clause
BSD-style license and third-party NOTICE, separate from the Rust wrapper's MIT
license. Preserve `LICENSE.txt`, `NOTICE.txt` and the provenance/hash `ORIGIN.txt`
in [`licenses/microsoft-webview2-sdk-1.0.3800.47/`](licenses/microsoft-webview2-sdk-1.0.3800.47/).
The separately installed Microsoft Edge WebView2 Runtime has its own Microsoft
terms; the SDK license is not a grant to redistribute an arbitrary browser runtime.

### MPL-2.0 source availability

The resolved Cargo closure includes the following MPL packages, some build-only.
Dependencies were not modified. Recipients can obtain exact-version source from:

- [cssparser 0.37.0](https://crates.io/api/v1/crates/cssparser/0.37.0/download)
- [cssparser-macros 0.7.1](https://crates.io/api/v1/crates/cssparser-macros/0.7.1/download)
- [dtoa-short 0.3.5](https://crates.io/api/v1/crates/dtoa-short/0.3.5/download)
- [option-ext 0.2.0](https://crates.io/api/v1/crates/option-ext/0.2.0/download)
- [selectors 0.38.0](https://crates.io/api/v1/crates/selectors/0.38.0/download)

Full MPL-2.0 text is retained in each applicable crate directory. For `selectors`,
whose crate omits it, the standard MPL text is supplied; see `licenses/ORIGINS.txt`.
Preserve these source-availability notices and make any future modifications to
covered source available under MPL-2.0. This does not assert MPL coverage over all
independently authored application files or guarantee permanent upstream hosting.

## Redistribution responsibilities and limits

1. **Ship this file, root `LICENSE` and the entire `licenses/` tree**, preserving
   relative paths, alongside the installed executable and inside portable ZIPs.
   Embedded frontend files do not by themselves expose the root notices/source
   archive. Native packaging must explicitly include these resources; this file
   does not claim that an already-built installer contains them.
2. Keep `cmaps/LICENSE`, both standard-font license files and all eight WASM
   license files with copied PDF assets. Include the separate PDF.js package
   Apache license as well. The Liberation source archive must remain supplied,
   not replaced by a written offer or merely a license name.
3. Review additional source-level notices, compiler/installer additions and newly
   redistributed binaries before publication. This is not a complete legal
   clearance. Independently authored TexyPaper code uses the separately supplied
   root MIT license; third-party licenses do not replace that choice or coverage.
4. OpenSSH, Python, TeX, Codex and Claude are external prerequisites, not bundled
   copies. Their installation, accounts, subscription rights and trademarks are
   not supplied by these notices. WebView2 runtime/bootstrap distribution must
   independently comply with Microsoft's applicable terms.
5. Personal subscription CLI use does not itself authorize distributing a
   third-party Claude login product. Recheck provider terms and obtain any
   required permission before distributing to others; do not silently switch
   billing or equate a logged-in account with distribution authorization.
6. These notices do not claim a signed installer, endorsement or authorized
   provider partnership. Release availability and exercised verification are
   documented separately in the README and `docs/VERIFICATION.md`.
