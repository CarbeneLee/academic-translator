# Academic Translator MVP acceptance record

Use this record for an unsigned internal package built from the exact commit
under test. Complete one run on macOS and one on Windows before declaring an MVP
release ready. Attach screenshots or log excerpts by reference; do not paste PDF
text, translations, local paths, credentials, authorization headers, provider
bodies, or signatures into this document.

No checklist step authorizes a live DeepSeek or Youdao call. Provider, signing,
timeout, stale-response, and TTL cases marked **Automated mock** are satisfied by
the bounded mock/fake-clock test evidence from the same commit. Never enter a
real API credential for this checklist.

## Run metadata

| Field | macOS run | Windows run |
| --- | --- | --- |
| Operating system and version |  |  |
| Architecture |  |  |
| Commit SHA |  |  |
| Package filename |  |  |
| Tester |  |  |
| Date (ISO 8601) |  |  |
| Overall result (Pass/Fail/Blocked) |  |  |

## Acceptance checklist

For each platform, record `Pass`, `Fail`, or `Blocked` plus a concise evidence
reference. A package/manual row must be performed in the installed application.
An automated-mock row records the matching fresh test or CI run; it is not a
paid smoke test.

| ID | Gate type | Scenario and expected result | macOS result | macOS evidence | Windows result | Windows evidence |
| --- | --- | --- | --- | --- | --- | --- |
| P01 | Package/manual | Launch the unsigned internal build using the approved internal-test procedure. The main window opens; no signing or trust claim is made. |  |  |  |  |
| P02 | Package/manual | Open a PDF, cancel the picker, close the PDF, then replace an open PDF. Cancel preserves the old document; close/replacement clears its selection and result. |  |  |  |  |
| P03 | Package/manual | With `single-column.pdf` and `cross-page.pdf`, verify continuous scroll, page jump, zoom in, zoom out, and zoom reset. |  |  |  |  |
| S01 | Package/manual | A normal drag selection replaces the previous selection and its highlight. |  |  |  |  |
| S02 | Package/manual | Hold Alt to append fragments across the two columns and then across pages. Highlights preserve user-addition order without filling gaps. |  |  |  |  |
| S03 | Package/manual | Zoom and scroll a selected page out of view and back. Highlights survive zoom and page remount with the same fragments. |  |  |  |  |
| T01 | Package/manual | A stable non-empty selection shows the floating action but causes no automatic request. With no configured credential, the floating action and Cmd+Enter (macOS) or Ctrl+Enter (Windows) are the only manual starts and end in the safe missing-credential state. |  |  |  |  |
| T02 | Automated mock | Record fresh DeepSeek mocked-success and malformed structured-output tests. Exactly one bounded request occurs per explicit trigger; malformed/raw content is not rendered. |  |  |  |  |
| T03 | Automated mock | Record fresh Youdao mocked-success, v3 signing-vector, and signature-failure/auth mapping tests. No real credential, provider endpoint, or paid request is used. |  |  |  |  |
| E01 | Automated mock | Record fresh authentication, rate-limit, network-unavailable, timeout, provider-unavailable, selection-too-large, and malformed-response UI tests. Messages remain actionable and contain no raw provider detail. |  |  |  |  |
| C01 | Package/manual | Save, replace, and delete clearly synthetic test-only credential values. Inputs are password-masked, clear after save, never reveal the full value, and deletion removes the configured hint. Delete all synthetic vault records before ending the run. |  |  |  |  |
| A01 | Package/manual plus automated mock | Copy copies only the Chinese translation in the mocked UI test. Retry gets a new request ID; Cancel stops the active request; switching provider does not auto-start or clear fragments. Record the stale-response regression test. |  |  |  |  |
| K01 | Automated mock | Record the cache-hit test and seven-day sliding-TTL cleanup with a fake clock. Confirm the suite uses no real provider or credential. |  |  |  |  |
| K02 | Package/manual | Open Settings, record cache row/byte statistics, decline Clear once, then confirm Clear. The UI refreshes without exposing a database path. |  |  |  |  |
| U01 | Package/manual | Open `no-text-layer.pdf`. The page renders and shows the unsupported-text-layer message; there is no OCR action or fallback. |  |  |  |  |
| L01 | Package/manual | Review logs from this run. They contain none of: local PDF paths, source text, translation text, credentials, authorization headers, request/response bodies, or signatures. |  |  |  |  |

## Required automated evidence

Record the exact commit and result for each command. These commands use local
fixtures, bounded mocks, and fake clocks only.

| Command | Commit SHA | Result | Evidence reference |
| --- | --- | --- | --- |
| `pnpm fixtures:generate` followed by clean fixture diff |  |  |  |
| `pnpm lint` |  |  |  |
| `pnpm typecheck` |  |  |  |
| `pnpm test` |  |  |  |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` |  |  |  |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` |  |  |  |
| `cargo test --manifest-path src-tauri/Cargo.toml` |  |  |  |
| `pnpm tauri build` on the recorded platform |  |  |  |

## Sign-off

| Role | Name | Date | Decision | Notes/evidence reference |
| --- | --- | --- | --- | --- |
| macOS tester |  |  | Pass/Fail/Blocked |  |
| Windows tester |  |  | Pass/Fail/Blocked |  |
| Release reviewer |  |  | Pass/Fail/Blocked |  |
