# Senate Intelligence Committee: Committee Study of the CIA's Detention and Interrogation Program (S. Rept. 113-288)

Committee Study of the Central Intelligence Agency's Detention and Interrogation Program, together with Foreword by Chairman Feinstein and Additional and Minority Views. Senate Select Committee on Intelligence, 113th Congress, Senate Report 113-288, ordered to be printed 9 December 2014 (712 pages). Served at https://reportsthatmatter.org/reports/us-senate-cia-torture-report.

## Scope: the whole printed report

One unit, `us-senate-cia-torture-report`: the letter of transmittal, the foreword, the Findings and Conclusions, the Executive Summary (pp. 1-499 with its appendices), the six additional views and the three minority views, all inside one printed and paginated Senate report. The full classified study (6,700+ pages) is not public.

## Source

`archive/CRPT-113srpt288.pdf`, govinfo package CRPT-113srpt288: <https://www.govinfo.gov/content/pkg/CRPT-113srpt288/pdf/CRPT-113srpt288.pdf>. SHA-256 `4989f2fb14509322dfb22d3e90ed5b569bc653aba25826da7adb8da7c8090bb3`, 45,626,300 bytes, 712 pages, untagged. ABBYY FineReader 10 (created 15 December 2014, modified by GPO with iText in November 2024): the GPO's typeset front pages (title, letter of transmittal, contents) and scanned pages of the declassified typescript with an OCR text layer.

Public domain: a work of the U.S. Government (17 U.S.C. 105). See `datapackage.json`.

## Build

`ingest.ts` declares how the report is turned into Markdown. Rebuild from the site repo with `pnpm ingest run us-senate-cia-torture-report`. It needs the `@rtm/ingest` release with source passes, `contentsOutline({ ocr: true, centredMinor: true })`, `noteFaceRunOver()` and `UNCODED_REDACTION` (ingest branch `lines-passes-1009`).

- `scripts/redaction-boxes.ts` reads the page images (`pdftoppm -gray`) and the text layer's word positions (`pdftotext -bbox-layout`) and writes `reference/redactions.json.gz`: line by line of the `pdftotext -layout` text, each solid black box as one mark (U+2588), the classification banners, portion markings, part page counters and GPO slugs taken out, note numbers the OCR lost or misread put back from each page's sequence, rows of one printed line that a skewed scan split rejoined, and the front matter's roman folios set from their place. Run `node scripts/redaction-boxes.ts` (about two minutes), then `scripts/pin-pack.sh` to pin its checksum in `ingest.ts`. Its output depends on the poppler version it records; an edit that no longer matches its line fails the build.
- `redactions.ts` is the report's source pass that applies the pack before the pipeline reads a page, writing each box as `[Redacted]` (the corpus's uncoded redaction marker; site docs/decisions, redactions).
- `golden.yaml`: five pages read off the page images (`pnpm ingest verify`).

## Materials

The source stack (stage 1, 2026-10-09; checklist in reportsthatmatter-gqsy.6):

| Layer | Source | Role |
| --- | --- | --- |
| Words | the govinfo PDF's OCR layer | served |
| Redactions | the PDF's page images (`reference/redactions.json.gz`) | served as `[Redacted]` |
| Blocks and headings | the OCR layer; headings from the GPO contents (PDF p.3) and the Executive Summary's contents (PDF pp.31-36) | served |
| Notes | page-foot notes in the OCR layer; numbers restored from each page's sequence | served |
| Page anchors | the GPO folios (roman, then arabic) | canonical citation target |

Renditions considered and rejected:

- **The Committee's own release of 9 December 2014** (`intelligence.senate.gov/study2014/sscistudy1.pdf`, 525 pp., executive summary; `findings-and-conclusions.pdf`, `foreword.pdf`, `minority-views.pdf` and the six additional views separately; Wayback captures 20141209-20141216): scans made with ScandAll PRO and OCR'd by Adobe's scan library, with OCR of similar quality ("obtainedfrom", "eases", "ovennled") and none of the GPO's pagination. The intelligence.senate.gov copy of CRPT-113srpt288.pdf (2015-2025 captures) is the govinfo PDF.
- **govinfo HTML**: images only.
- **Wikisource**: no transcription (searched 2026-10-09). **DocumentCloud and news organisations' copies**: OCR of the same scans. **Melville House's book edition (2014)**: commercial, not used.
