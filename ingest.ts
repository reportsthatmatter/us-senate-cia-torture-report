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
    // The redactions, read off the page images (scripts/redaction-boxes.ts): each printed black box is
    // one mark, U+2588, where the OCR read garble ("Country |", "B I H I H") or nothing; the
    // classification banners, portion markings, "Page 21 of 499" and GPO slugs come off (PDF p.51).
    redactionBoxes({
      dir: import.meta.dirname,
      pack: { path: "reference/redactions.json.gz", sha256: "7d09b009bf6087e3f96fa6bc2394d6b07a911356db11cd86952d2e8a37e937b0" },
      pdfSha256: "4989f2fb14509322dfb22d3e90ed5b569bc653aba25826da7adb8da7c8090bb3",
    }),
    layoutPageJoins({ scanned: true }),
    pageBreakContinuations(),
    foliosInStep(),
    layoutMarkers(),
    sequencedNoteOpenings(),
    romanFolios(),
    contentsOutline({ ocr: true, centredMinor: true }),
    noteFaceRunOver(),
    escapeLeadingHash(),
  ],
});
