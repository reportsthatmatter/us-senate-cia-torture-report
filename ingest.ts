import { redactionBoxes } from "./redactions.ts";
import { layoutPageJoins, layoutMarkers, pageBreakContinuations, foliosInStep, pipeline, sequencedNoteOpenings, romanFolios, contentsOutline, escapeLeadingHash, noteFaceRunOver } from "@rtm/ingest";

/**
 * How this report is built. Owned by the report: every decision that shaped
 * its text is named here, and the passes it composes are library code.
 */
export default pipeline({
  id: "us-senate-cia-torture-report",
  title: "Committee Study of the Central Intelligence Agency's Detention and Interrogation Program",
  authors: "Senate Select Committee on Intelligence",
  published_at: "9 December 2014",
  source_url: "https://www.govinfo.gov/content/pkg/CRPT-113srpt288/pdf/CRPT-113srpt288.pdf",
  repo: ".",
  volumes: [
    { path: "archive/CRPT-113srpt288.pdf", sha256: "4989f2fb14509322dfb22d3e90ed5b569bc653aba25826da7adb8da7c8090bb3" },
  ],
  passes: [
    // The page images, read once (scripts/redaction-boxes.ts) and applied to the text layer before
    // anything reads a page: each printed black box is one redaction, written "[Redacted]", where the
    // OCR read garble ("Country |", "B I H I H") or nothing (PDF p.51); the struck classification banners,
    // portion markings "(TS//[box]//NF)", "Page 22 of 499" and GPO slugs come off (every page); note numbers
    // the OCR lost against a box or misread are put back from the page's sequence, checked against the
    // pages either side (p.54: 86, 88; p.48: "so" for 50; p.59: 123 read as junk; p.194: 1009-1013); rows of one printed line a skewed scan split are rejoined (p.75); the front matter's
    // roman folios are set from their place (p.4 "in" for iii).
    redactionBoxes({
      dir: import.meta.dirname,
      pack: { path: "reference/redactions.json.gz", sha256: "db3e3d6d892767ba0f063e4cb54917f8e1f86c416bfcdd37f9ee6424fe42b4a3" },
      pdfSha256: "4989f2fb14509322dfb22d3e90ed5b569bc653aba25826da7adb8da7c8090bb3",
    }),
    // A paragraph run over a page break joins when the layout says it runs on; the OCR layer sizes
    // consecutive lines a point apart (as Jack Smith's scan).
    layoutPageJoins({ scanned: true }),
    // The scan is skewed: a page's first line can be inset, and read as a quotation (p.75).
    pageBreakContinuations(),
    // A folio the OCR misread out of step with its neighbours is dropped and numbered from them.
    foliosInStep(),
    // Note markers are raised digits in the OCR layer's own size (p.40: "techniques.9").
    layoutMarkers(),
    // A note opening after a wide gap or on OCR junk starts its note (p.51 notes 61-68).
    sequencedNoteOpenings(),
    // The front matter is folioed i to xxviii (PDF pp.2-29).
    romanFolios(),
    // Headings from the two contents (the GPO's, PDF p.3, for the parts; the Executive Summary's, pp.31-36,
    // for its I./A./1. outline), both OCR'd and without leaders, matched by edit distance; an unlisted
    // centred heading (the minority views' "CONCLUSION") is a subhead.
    contentsOutline({ ocr: true, centredMinor: true }),
    // Single-spaced pages: a note's tail over a page break is the note's when the layout sets it in the
    // notes' face (p.69, note 178).
    noteFaceRunOver(),
    // The findings open "#1:" ... "#20:" (p.12), which would read as Markdown headings.
    escapeLeadingHash(),
  ],
});
