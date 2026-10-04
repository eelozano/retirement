---
name: update-tax-figures
description: Move the app's built-in tax figures (`TaxFigures::built_in()`) to a new tax year from the IRS publications, by adding a frozen `tax_year_YYYY()` and its publication-anchored tests. Use when the user says "update the tax figures", when the yearly November reminder fires, or before a release that should ship a new tax year. Covers when the three documents are out, how to find and read them (the web fetcher cannot read IRS PDFs), which section feeds which field, how to add the year without touching the old one, and what the release notes must say.
---

# Updating the built-in tax figures to a new tax year

`TaxFigures::built_in()` (`crates/engine/src/model/tax_figures.rs`) is the
set of yearly figures a *new* install's `tax-figures.yaml` is written from.
A user's existing file is never overwritten, so this changes nothing for an
install that already has one until its owner resets it under
**Settings → Tax figures**. This is release work, not a user-data change.

The tests that check the figures live in `crates/engine/tests/published/`
(#154). Every expected value there is typed from a publication and cited
beside it. A new year is **added** next to the old ones, as a new frozen
`tax_year_YYYY()` with its own test files, and nothing already there is
retyped.

## 1. Wait until all three documents are out

`TaxFigures` has a single `tax_year`, so it moves in one step. Updating
before all three documents are out labels last year's numbers as the new
year.

| Document | Usually out | Carries |
|---|---|---|
| Rev. Proc. 20YY-NN, "inflation adjusted items" | October | brackets (§4.01 Tables 1 and 3), LTCG breakpoints (§4.03), standard deduction and the aged/blind amount (§4.14) |
| IRS Notice 20YY-NN, "cost-of-living adjustments … retirement plans" | late October / November | every contribution limit, plus the Roth catch-up wage threshold (not modelled) |
| Rev. Proc. 20YY-NN, "HSA inflation adjusted amounts" | May of the year before | HSA self-only and family limits (§2(1)) |

The tax year **2026** set was Rev. Proc. 2025-32, Notice 2025-67 and
Rev. Proc. 2025-19. The numbers are assigned as documents are issued, so
next year's cannot be predicted. If one of the three is missing, stop and
tell the user which; do not update a partial set.

## 2. Find them

Search the IRS newsroom for the press release, which links the document:

- `IRS releases tax inflation adjustments for tax year 2027`
- `401(k) limit increases to … for 2027` (the Notice's release title
  changes each year; search the year and "401(k) limit")
- `IRS 2027 HSA inflation adjusted amounts Rev. Proc.`

Documents land in the drop folder as
`https://www.irs.gov/pub/irs-drop/rp-YY-NN.pdf` (Rev. Proc.) and
`…/n-YY-NN.pdf` (Notice). Before using a document, check that its first page
names the target tax year. A search result can be last year's release.

## 3. Read them

`WebFetch` cannot parse these PDFs. It returns "not found", but it saves the
binary and prints the path. This Mac has no `pdftotext` or poppler, so the
Read tool's PDF mode fails too. Extract text with PDFKit, which ships with
macOS:

```swift
// pdf2txt.swift — usage: swift pdf2txt.swift in.pdf out.txt
import PDFKit
let a = CommandLine.arguments
guard let doc = PDFDocument(url: URL(fileURLWithPath: a[1])) else { print("cannot open"); exit(1) }
var out = ""
for i in 0..<doc.pageCount { out += "\n=== PAGE \(i+1) ===\n" + (doc.page(at: i)?.string ?? "") }
try! out.write(toFile: a[2], atomically: true, encoding: .utf8)
```

Write it and its output to the scratchpad, not the repo. `curl -sSL -o` on
the drop-folder URL works as well as WebFetch for the download. Then `grep`
the text for the section headings above and read the tables from there. In
the extracted text the Rev. Proc.'s tables sit one cell per line.

### What does not change yearly

None of these needs re-checking in an ordinary year. Check them only if the
law changed:

- **Pub 590-B, Table III (Uniform Lifetime):** `curl` the PDF from
  `irs.gov/pub/irs-pdf/p590b.pdf`. The table is in Appendix B.
- **SSA's FRA tables, reduction and delayed-credit rates:** ssa.gov returns
  403 to fetchers, even with a browser user agent. Read the regulation
  instead, from eCFR's API, which needs `--compressed`:
  `curl -sSL --compressed "https://www.ecfr.gov/api/versioner/v1/full/<YYYY-MM-DD>/title-20.xml?part=404&section=404.410"`
  (also `404.409` and `404.313`).

## 4. Add the new year beside the old one

Each tax year is a frozen function in `crates/engine/src/model/tax_figures.rs`:
`TaxFigures::tax_year_2026()` and so on. **Never edit an existing year.**
Add `tax_year_YYYY()` for the new year, typing every figure from the
documents with the section in a comment. Then repoint `built_in()` at it.
That one line is the whole change to what the app ships.

Nothing else in the engine changes. Tests outside `tests/published/` name
the year they were written against (`tax_year_2026()`), as do the goldens
and the demo golden projections. Two serde fallbacks
(`additional_standard_deduction_65_2026`, `hsa_family_2026`) fill an older
`tax-figures.yaml` that lacks those fields, and they are pinned to the year
each field arrived. A trial 2027 update on 2026-10-03 broke exactly one
test outside the new year's own files. If more break, something is reading
`built_in()` where it should name a year: fix that test rather than
retyping it.

The adapter's tests in `src-tauri/src/tax_figures.rs` that check "falls back
to the built-in figures" compare `built_in()` with itself on purpose and
keep passing.

## 5. Add the new year's publication tests

In `crates/engine/tests/published/`:

- Copy `tax_figures_2026.rs` to `tax_figures_YYYY.rs`. Point it at
  `tax_year_YYYY()` and retype every value, citation and quoted wording from
  the new documents. Sections and wording shift between years.
- Copy `worked_tax_years_2026.rs` to `worked_tax_years_YYYY.rs`. The
  threshold tests take the tax at each threshold from the new Rev. Proc.'s
  "The Tax Is" column, the IRS's own cumulative sum and the independent
  check on a mistyped bracket. Keep the other worked years' scenarios and
  redo their arithmetic on paper with the new figures, updating both the
  comment and the expected value.
- Add both as `mod` lines in `main.rs`, and move
  `the_built_in_figures_are_the_latest_checked_year` into the new year's
  file, asserting `built_in() == tax_year_YYYY()`.
- Leave the old year's files alone. They keep checking a frozen year
  against its own documents.
- Never fill in an expected value from what the engine prints. A figure
  copied from the engine is checked against itself, which is how #142's
  two errors got through.

`uniform_lifetime.rs`, `social_security.rs` and `analytic_floor.rs` are not
yearly and should not need touching.

## 6. Measure the change for the release notes

The goldens are pinned to 2026, so they do not measure the new figures.
Measure them directly instead. Compare the demo household's scenarios
projected with `tax_year_YYYY()` against the previous year, and report the
differences in ending net worth and success rate. A throwaway test or a
scratch binary is fine for this; do not commit it.

This change only reaches a new install, or a user who resets their file.
Existing installs keep their own `tax-figures.yaml`.

## 7. Docs and release notes

- `grep -rn "<old year>" README.md docs/ARCHITECTURE.md` for figures quoted
  as "for 2026" (the HSA family limit, the age-65 amounts, the deduction
  examples). Update the ones that describe the current built-ins. Leave the
  ones that record history, such as an issue's measured case.
- The release notes must say the built-in figures moved to the new year,
  and that **existing installs keep their own `tax-figures.yaml` until it is
  reset under Settings → Tax figures** (required by `CLAUDE.md`).
- `pnpm check`, then one PR with every figure in the body next to the
  sentence it was typed from, so review is reading quotes against numbers.
