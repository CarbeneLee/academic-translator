import {
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { tagTextLayer } from "./PdfPage";

type NodeFileSystem = {
  readFileSync(path: string): Uint8Array;
};

const nodeRuntime = (
  globalThis as typeof globalThis & {
    process: {
      cwd(): string;
      getBuiltinModule(specifier: "node:fs"): NodeFileSystem;
    };
  }
).process;
const nodeFileSystem = nodeRuntime.getBuiltinModule("node:fs");

const FIXTURES = [
  ["single-column.pdf", 1, "Single-column academic text fixture"],
  ["two-column.pdf", 1, "Two-column academic text fixture"],
  ["cross-page.pdf", 2, "Cross-page academic text fixture"],
  [
    "hyphenation-ligatures.pdf",
    1,
    "Hyphenation and ligatures academic text fixture",
  ],
  ["equations-citations.pdf", 1, "Equations and citations fixture"],
  ["no-text-layer.pdf", 1, "Graphics-only fixture"],
] as const;

function fixtureBytes(name: string): Uint8Array {
  const path = `${nodeRuntime.cwd()}/tests/fixtures/${name}`;
  return Uint8Array.from(nodeFileSystem.readFileSync(path));
}

async function withFixture<T>(
  name: string,
  inspect: (document: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  const loadingTask = getDocument({
    data: fixtureBytes(name),
    useWorkerFetch: false,
  });

  try {
    const document = await loadingTask.promise;
    return await inspect(document);
  } finally {
    await loadingTask.destroy();
  }
}

async function textItems(
  document: PDFDocumentProxy,
  pageNumber: number,
  disableNormalization = false,
): Promise<TextItem[]> {
  const page = await document.getPage(pageNumber);
  const content = await page.getTextContent({ disableNormalization });
  return content.items.filter((item): item is TextItem => "str" in item);
}

function joinedText(items: readonly TextItem[]): string {
  return items.map((item) => item.str).join(" ");
}

test.each(FIXTURES)(
  "%s has fixed Letter pages and deterministic metadata",
  async (name, expectedPages, expectedTitle) => {
    await withFixture(name, async (document) => {
      expect(document.numPages).toBe(expectedPages);
      expect(document.numPages).toBeLessThanOrEqual(2);

      for (let pageNumber = 1; pageNumber <= expectedPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        expect(viewport.width).toBeCloseTo(612, 5);
        expect(viewport.height).toBeCloseTo(792, 5);
      }

      const metadata = await document.getMetadata();
      const info = metadata.info as Record<string, unknown>;
      expect(info.Title).toBe(expectedTitle);
      expect(info.Creator).toBe(
        "Academic Translator Fixture Generator",
      );
      expect(info.Producer).toBe(
        "pdf-lib (Academic Translator fixtures)",
      );
      expect(info.CreationDate).toBe("D:20260831000000Z");
      expect(info.ModDate).toBe("D:20260831000000Z");
    });
  },
);

test("single-column fixture exposes ordered academic text items", async () => {
  await withFixture("single-column.pdf", async (document) => {
    const items = await textItems(document, 1);
    const text = joinedText(items);

    expect(items.length).toBeGreaterThan(2);
    expect(text).toContain("Single column sentence one.");
    expect(text).toContain("Single column sentence two.");
    expect(text.indexOf("sentence one")).toBeLessThan(
      text.indexOf("sentence two"),
    );
  });
});

test("two-column fixture preserves deterministic labeled draw order", async () => {
  await withFixture("two-column.pdf", async (document) => {
    const items = await textItems(document, 1);
    const text = joinedText(items);
    const positions = ["LEFT-1", "LEFT-2", "RIGHT-1", "RIGHT-2"].map(
      (label) => text.indexOf(label),
    );

    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
    expect(positions[2]).toBeLessThan(positions[3]);
  });
});

test("cross-page fixture exposes the continuation on page two", async () => {
  await withFixture("cross-page.pdf", async (document) => {
    const pageOne = joinedText(await textItems(document, 1));
    const pageTwo = joinedText(await textItems(document, 2));

    expect(pageOne).toContain("PAGE-1-END");
    expect(pageOne).not.toContain("PAGE-2-CONTINUATION");
    expect(pageTwo).toContain("PAGE-2-CONTINUATION");
    expect(pageTwo).not.toContain("PAGE-1-END");
  });
});

test("hyphenation fixture exposes line-wrap pieces and real ligature code points", async () => {
  await withFixture("hyphenation-ligatures.pdf", async (document) => {
    const items = await textItems(document, 1, true);
    const text = joinedText(items);

    expect(items.some((item) => item.str === "multi-" && item.hasEOL)).toBe(
      true,
    );
    expect(items.some((item) => item.str === "modal" && item.hasEOL)).toBe(
      true,
    );
    expect(text).toContain("ef\ufb01cient");
    expect(text).toContain("\ufb02ow");
  });
});

test("equations fixture preserves symbols, units, citations, and references", async () => {
  await withFixture("equations-citations.pdf", async (document) => {
    const items = await textItems(document, 1);
    const text = joinedText(items);

    expect(items.length).toBeGreaterThan(1);
    expect(text).toContain("\u03b2 = 0.5 [12]");
    expect(text).toContain("25 mg/mL");
    expect(text).toContain("Figure 2");
    expect(text).toContain("Table 1");
    expect(text).toContain("Equation (3)");
  });
});

test("graphics-only fixture exposes no text layer and takes the unsupported path", async () => {
  await withFixture("no-text-layer.pdf", async (pdfDocument) => {
    const items = await textItems(pdfDocument, 1);
    const textLayer = globalThis.document.createElement("div");
    const rendered = vi.fn();
    textLayer.addEventListener("textlayerrendered", rendered);

    expect(items).toEqual([]);
    tagTextLayer(0, items, textLayer, "fixture-session");

    expect(textLayer.dataset.selectionSupported).toBe("false");
    expect(textLayer).toHaveAttribute("data-document-session-id", "fixture-session");
    expect(textLayer.querySelector("[data-text-item-index]")).toBeNull();
    expect(rendered).toHaveBeenCalledOnce();
  });
});
