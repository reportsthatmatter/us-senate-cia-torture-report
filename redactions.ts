import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { SourcePass } from "@rtm/ingest";

/**
 * The report's redactions, classification markings and printer's furniture, read off the page images
 * and applied to the text layer before the pipeline reads a page (a `SourcePass`).
 *
 * `scripts/redaction-boxes.ts` finds each solid black box on each page image and writes, line by line
 * of the `pdftotext -layout` text, what the line becomes (reference/redactions.json.gz):
 *
 * - **redaction**: the characters the OCR read inside a box ("H ^ H", "B I H I H", "|") become one
 *   mark, U+2588 FULL BLOCK, per box; a box with nothing read inside it gets a mark between the words
 *   either side, or a line of its own. The report's own "[REDACTED]", its pseudonyms and bracketed
 *   substitutions ("[DETENTION SITE GREEN]", "Country |" as printed) are words on the page and are kept.
 * - **portion**: a paragraph's opening classification marking, "(U)", "(S//NF)", "(TS//█//NF)", struck
 *   through on declassification, goes.
 * - **rejoin**: two rows of one printed line, which a skewed scan's text layer gives apart, are one line
 *   again (the second row is removed, not blanked).
 * - **note-number**: a note number the OCR lost (against a box) or misread ("so" for 50) is put back
 *   from the page's own sequence of note numbers.
 * - **banner**, **counter**, **slug**: the classification banners at the head and foot of every page
 *   ("UNCLASSIFIED", "TOP SECRET//█//NOFORN", struck through), each part's own "Page 21 of 499" or page
 *   number above the GPO folio, and the GPO's typesetting slugs. The folio itself stays.
 *
 * Every edit names the line as the text layer reads it; one that does not match exactly (a different
 * poppler) fails the build rather than landing on the wrong text: regenerate the pack.
 */
export function redactionBoxes(options: { dir: string; pack: { path: string; sha256: string }; pdfSha256: string }): SourcePass {
  type Edit = { line: number; from: string; to: string | null; kinds: string[]; remove?: true };
  type Insert = { after: number; text: string };
  type Pack = { sha256: string; poppler: string; pages: Array<{ page: number; edits: Edit[]; inserts: Insert[] }> };
  let byPage: Map<number, { edits: Edit[]; inserts: Insert[] }> | undefined;
  let poppler = "";
  const load = () => {
    if (byPage) return byPage;
    const raw = readFileSync(join(options.dir, options.pack.path));
    const sha = createHash("sha256").update(raw).digest("hex");
    if (sha !== options.pack.sha256) throw new Error(`redactionBoxes: ${options.pack.path} is ${sha}, expected ${options.pack.sha256}`);
    const pack = JSON.parse(gunzipSync(raw).toString("utf8")) as Pack;
    if (pack.sha256 !== options.pdfSha256) throw new Error(`redactionBoxes: ${options.pack.path} was made from a different PDF (${pack.sha256})`);
    poppler = pack.poppler;
    byPage = new Map(pack.pages.map((p) => [p.page, p]));
    return byPage;
  };
  return {
    name: "redactionBoxes",
    stage: "source",
    run(lines, at) {
      if (at.volume !== 1) return lines;
      const page = load().get(at.pdfIndex);
      if (!page) return lines;
      const out: Array<string | null> = [...lines];
      const removed = new Set<number>();
      for (const e of page.edits) {
        if (lines[e.line] !== e.from)
          throw new Error(
            `redactionBoxes: PDF p.${at.pdfIndex} line ${e.line} reads ${JSON.stringify(lines[e.line])}, the pack expects ${JSON.stringify(e.from)} (made with ${poppler}): regenerate it with node scripts/redaction-boxes.ts`
          );
        out[e.line] = e.to;
        if (e.remove) removed.add(e.line);
      }
      // Inserted lines go after the line they follow (-1: the top), in the order the pack lists them.
      const after = new Map<number, string[]>();
      for (const i of page.inserts) after.set(i.after, [...(after.get(i.after) ?? []), i.text]);
      const result: string[] = [...(after.get(-1) ?? [])];
      out.forEach((line, i) => {
        if (!removed.has(i)) result.push(line ?? "");
        result.push(...(after.get(i) ?? []));
      });
      return result;
    },
  };
}
