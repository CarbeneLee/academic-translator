# PDF regression fixtures

These six PDFs are generated test assets. Their prose and graphics were written
for this project and do not reproduce text from a published paper. Run
`pnpm fixtures:generate` from the repository root to regenerate them; the
generator performs no network access and refuses an unexpected PDF filename in
this directory.

All pages use the fixed US Letter media box (612 x 792 points), deterministic
draw order, fixed 2026-08-31 UTC metadata dates, and PDF object streams disabled.
Text fixtures embed a subset of the licensed Noto Serif Regular font. The
graphics-only fixture embeds no font and contains no PDF text operators.

## Fixture inventory

| File | Pages | Regression purpose | SHA-256 |
| --- | ---: | --- | --- |
| `single-column.pdf` | 1 | Ordered selectable single-column academic prose | `545c7281d9b1f9668ecb074b19f5beaa024f6d4d4cb390160a266ab546777fc0` |
| `two-column.pdf` | 1 | Visually separated `LEFT-1`, `LEFT-2`, `RIGHT-1`, `RIGHT-2` selections | `15551c1e5b5909c2ef64dcacbc1f3771228d7fb545f77e934669b94b678a65f9` |
| `cross-page.pdf` | 2 | `PAGE-1-END` to `PAGE-2-CONTINUATION` page ordering | `30d8d40bad4abd9fe61febaeb2afb8fd5d0f77d9a086a41713f80f96e43ff41f` |
| `hyphenation-ligatures.pdf` | 1 | Physical line-wrap hyphenation and U+FB01/U+FB02 ligatures | `e98d897ccbdb73dc09278f06dd37d8ec15e3b384ab434899937bf0d88b4f1041` |
| `equations-citations.pdf` | 1 | Greek symbols, variables, units, citations, and references | `c73b278da3d06e30c5e5aefbcdfbf304b7c1fe8f19b0039d46369e9ed8822e12` |
| `no-text-layer.pdf` | 1 | Graphics-only unsupported-selection path with no OCR fallback | `5af996deb227d4508681a1c035a0fbda799bdbef6055eef97c39d0f32569f756` |

PDF.js applies compatibility normalization by default, so ordinary extraction
renders U+FB01 and U+FB02 as `fi` and `fl`. The fixture regression also extracts
with `disableNormalization: true` to prove that the original Unicode ligature
code points are present in the PDF text map.

## Font provenance and license

- Font: `tools/fixtures/fonts/NotoSerif-Regular.ttf`
- Family/style: Noto Serif Regular (confirmed with `fc-scan`)
- Upstream font URL:
  <https://github.com/notofonts/noto-fonts/raw/refs/heads/main/hinted/ttf/NotoSerif/NotoSerif-Regular.ttf>
- Font SHA-256:
  `c8f669ceb2c9c60ccf55198b305e08a997ffca79a38cc7eeb551e643cbe66505`
- License: SIL Open Font License 1.1, preserved verbatim as
  `tools/fixtures/fonts/OFL.txt`
- Upstream license URL:
  <https://raw.githubusercontent.com/notofonts/noto-fonts/main/LICENSE>
- License SHA-256:
  `0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb`
- Retrieved: 2026-09-01 from the official `notofonts/noto-fonts` repository,
  `main` commit `ffebf8c1ee449e544955a7e813c54f9b73848eac`.

The upstream repository is the official archived/static Noto distribution and
is used here for a stable, explicitly named Regular TTF. The current Google
Fonts family is variable-font based, so it is not renamed or substituted for
this fixture-only static asset. Neither the TTF nor its license is an application
runtime dependency.

## Verification

The regression suite loads the committed bytes through PDF.js, checks page
dimensions and metadata, text-item markers and order, raw ligature code points,
and the empty text layer. Before changing a fixture, also render every page with
Poppler and inspect the PNG output:

```bash
pnpm fixtures:generate
pnpm test -- src/features/pdf-viewer/pdfFixtures.test.ts
shasum -a 256 tests/fixtures/*.pdf tools/fixtures/fonts/NotoSerif-Regular.ttf tools/fixtures/fonts/OFL.txt
```

Intermediate renderings belong under `tmp/pdfs/` and must not be committed.
