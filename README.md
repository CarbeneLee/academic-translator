# Academic Translator

A minimal, local-first desktop reader for explicit English-to-Simplified-
Chinese translation of selected academic PDF text. It targets macOS and Windows
with a Tauri 2 shell, React/PDF.js UI, and a trusted Rust core.

## MVP boundary

- Opens local, text-based PDFs read-only and supports continuous scroll, page
  jump, and zoom.
- A normal selection replaces the current selection. Holding Alt adds fragments
  across columns or pages in user-addition order.
- Translation is never automatic. Use the floating action or Cmd+Enter on macOS
  and Ctrl+Enter on Windows.
- Translation direction is fixed to English to Simplified Chinese. The MVP
  supports Youdao and DeepSeek V4 Flash.
- Scanned/image-only pages show an unsupported-text-layer state. There is no OCR,
  page translation, whole-document translation, PDF editing, chat, or notes.

The WebView owns presentation and interaction. Rust owns local document access,
normalization and limits, provider calls, strict response validation,
cancellation, credential persistence, and caching. The WebView never calls a
provider endpoint directly.

## Prerequisites

- [Node.js 24](https://nodejs.org/en/download) (the project currently accepts
  Node 24 through 26)
- [pnpm 11.19.0](https://pnpm.io/installation)
- [Stable Rust with rustfmt and clippy](https://www.rust-lang.org/tools/install)
- [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)

Install JavaScript dependencies from the committed lockfile:

```bash
pnpm install --frozen-lockfile
```

## Development

Start the desktop application with:

```bash
pnpm tauri dev
```

Generate the small, licensed PDF regression fixtures with:

```bash
pnpm fixtures:generate
```

Fixture descriptions, deterministic hashes, and Noto Serif/OFL provenance are
recorded in [`tests/fixtures/README.md`](tests/fixtures/README.md). Generation is
offline; it does not download the font or any document.

## Credentials and privacy

Save the DeepSeek API Key and Youdao App Secret in Settings. The trusted core
stores them in macOS Keychain or Windows Credential Manager. The WebView receives
only configured state and a masked hint, never a saved full secret. There is no
reveal action. Rust accepts at most 4096 Unicode scalar values per credential;
the password inputs mirror that limit with a 4096 UTF-16 code-unit boundary.

Do not put API keys or app secrets in source, logs, screenshots, environment
files, test fixtures, or commits. The application does not require an `.env`
file. Tests use bounded mock HTTP servers and synthetic values only: normal test
runs make no paid provider call and require no credential.

The local SQLite cache stores selection hashes and validated translations, not
PDF bytes, paths, credentials, provider envelopes, or raw English source text.
It uses a seven-day sliding TTL and a 100 MiB hard ceiling with least-recently-
used eviction.

## Quality gates

Run the complete local gate before handing off a change:

```bash
pnpm fixtures:generate
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
git diff --check
```

Rust provider integration tests bind only bounded loopback mock servers. They do
not contact DeepSeek or Youdao. Both provider adapters reject cumulative
response bodies above 262144 bytes, including chunked responses with no known
length.

## Unsigned internal packages

`pnpm tauri build` creates unsigned internal artifacts for the current platform:

- macOS: `src-tauri/target/release/bundle/macos/*.app` and
  `src-tauri/target/release/bundle/dmg/*.dmg`
- Windows: `src-tauri/target/release/bundle/msi/*.msi` and
  `src-tauri/target/release/bundle/nsis/*.exe`

These packages are not signed, notarized, store-published, or automatically
updated. Platform trust warnings are expected for internal testing.

GitHub Actions runs the frozen install, fixture regeneration proof, all quality
gates, and packaging separately on `macos-14` and `windows-2022`, then uploads
only that runner's bundle types. A macOS local build does not prove Windows
compilation or packaging; the Windows result remains pending until CI runs after
an explicitly authorized push.

Record real-platform package acceptance in
[`docs/testing/manual-mvp-smoke.md`](docs/testing/manual-mvp-smoke.md). The
checklist separates package interaction from mock-only provider, stale-response,
and fake-clock cache evidence, and never requires a real credential or paid
request.
