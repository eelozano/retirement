---
name: update-tax-figures
description: Move the app's built-in tax figures (`TaxFigures::built_in()`) to a new tax year from the IRS publications, and retype the publication-anchored tests that check them. Use when the user says "update the tax figures", when the yearly November reminder fires, or before a release that should ship a new tax year. Covers when the three documents are out, how to find and read them (the web fetcher cannot read IRS PDFs), which section feeds which field, what else breaks when the figures change, and what the release notes must say.
---

# Updating the built-in tax figures to a new tax year

`TaxFigures::built_in()` (`crates/engine/src/model/tax_figures.rs`) is the
set of yearly figures a *new* install's `tax-figures.yaml` is written from.
A user's existing file is never overwritten, so this changes nothing for an
install that already has one until its owner resets it under
**Settings → Tax figures**. This is release work, not a user-data change.

The tests that check the figures live in `crates/engine/tests/published/`
(#154). Every expected value there is typed from a publication and cited
beside it. **Retype them from the new document. Never copy the engine's
new output into them**, because that turns the suite into the kind of test
that let #142 through.

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

## 4. Update `TaxFigures::built_in()`

Set `tax_year` and retype every figure in it. Two serde defaults in the same
file need handling **before** the literals change:

- `additional_standard_deduction_65()` is both the serde default for a
  `tax-figures.yaml` written before that field existed *and* what
  `built_in()` uses.
- `built_in_hsa_family()` reads `built_in()` for the same purpose.

A file missing those fields has its own, older `tax_year`, so filling it
with the new year's amount mixes two years in one file. Pin both defaults to
the figures of the year they were introduced (2026: $1,650 / $2,050 and
$8,750), and give `built_in()` its own literals. This keeps the upgrade
invariant in `CLAUDE.md` intact. Do it in the first update after #154,
then this note can shrink to "they are pinned".

## 5. Retype the publication-anchored tests

Run `cargo test -p engine --test published`. The failures are the
checklist.

- `tax_figures.rs`: retype each value from the new document, and update the
  cited section and quoted wording, which shift between years.
- `worked_tax_years.rs`: the threshold tests take the tax at each threshold
  from the new Rev. Proc.'s "The Tax Is" column, which is the IRS's own
  cumulative sum. That column is the independent check on a mistyped
  bracket: an engine whose bracket ceiling is off disagrees with it. The
  other worked years are arithmetic in comments. Redo each one on paper with
  the new figures, keeping the scenario, and update both the comment and the
  expected value.
- `figures_are_for_2026` becomes the new year.
- `uniform_lifetime.rs`, `social_security.rs` and `analytic_floor.rs` should
  not fail. If they do, something other than the figures changed.

## 6. Fix the rest of the suite

The rest of the suite also breaks. A trial run (2026-10-03, moving the year
and five figures) failed about 45 tests in ten targets beyond `published/`.
Those tests use `TaxFigures::built_in()` as "some valid figures" while
asserting 2026-specific numbers:

- `strategies::tax` unit tests, which hand-compute against 2026 brackets
- `model::tax_figures` and `src-tauri` `tax_figures` unit tests
- `contributions`, `hsa_coverage`, `account_types` and `mid_year_start`
  limit tests
- `monte_carlo`, which has tuned success rates
- engine goldens: `UPDATE_GOLDEN=1 cargo test -p engine golden`
- demo golden projections:
  `UPDATE_GOLDEN=1 cargo test -p retirement --test demo_fixtures`

Ask the user before doing that by hand. The durable fix is to pin those
tests to a frozen `TaxFigures` for the year they were written against, so
that only `published/` and the goldens move when `built_in()` does. That is
its own change, and the user has not decided on it yet.

Regenerated goldens are the measurement the release notes need. Say by how
much the demo household's projections moved.

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
