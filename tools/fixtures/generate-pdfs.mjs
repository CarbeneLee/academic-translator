import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { URL } from "node:url";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const FIXED_DATE = new Date("2026-08-31T00:00:00Z");
const CREATOR = "Academic Translator Fixture Generator";
const PRODUCER = "pdf-lib (Academic Translator fixtures)";
const OUTPUT_NAMES = [
  "single-column.pdf",
  "two-column.pdf",
  "cross-page.pdf",
  "hyphenation-ligatures.pdf",
  "equations-citations.pdf",
  "no-text-layer.pdf",
];
const outputDirectory = new URL("../../tests/fixtures/", import.meta.url);
const fontBytes = await readFile(
  new URL("./fonts/NotoSerif-Regular.ttf", import.meta.url),
);

const palette = {
  ink: rgb(0.12, 0.15, 0.2),
  muted: rgb(0.38, 0.43, 0.5),
  accent: rgb(0.08, 0.32, 0.55),
  rule: rgb(0.76, 0.8, 0.84),
  panel: rgb(0.95, 0.97, 0.99),
};

function setMetadata(document, title) {
  document.setTitle(title);
  document.setAuthor("Academic Translator fixture authors");
  document.setSubject("Generated PDF text-layer regression fixture");
  document.setKeywords(["generated", "licensed-font", "pdf-fixture"]);
  document.setCreator(CREATOR);
  document.setProducer(PRODUCER);
  document.setCreationDate(FIXED_DATE);
  document.setModificationDate(FIXED_DATE);
}

function addTextPage(document, font, title) {
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawText(title, {
    x: 54,
    y: 734,
    size: 18,
    font,
    color: palette.accent,
  });
  page.drawLine({
    start: { x: 54, y: 720 },
    end: { x: 558, y: 720 },
    thickness: 0.8,
    color: palette.rule,
  });
  return page;
}

function drawLines(page, font, lines, options = {}) {
  const x = options.x ?? 64;
  const startY = options.startY ?? 688;
  const size = options.size ?? 11;
  const lineHeight = options.lineHeight ?? 20;
  const color = options.color ?? palette.ink;

  lines.forEach((line, index) => {
    page.drawText(line, {
      x,
      y: startY - index * lineHeight,
      size,
      font,
      color,
    });
  });
}

async function saveTextFixture(name, title, draw) {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  setMetadata(document, title);
  const font = await document.embedFont(fontBytes, { subset: true });
  await draw({ document, font });
  const bytes = await document.save({ useObjectStreams: false });
  await writeFile(new URL(name, outputDirectory), bytes);
}

async function saveGraphicsFixture() {
  const document = await PDFDocument.create();
  setMetadata(document, "Graphics-only fixture");
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  page.drawRectangle({
    x: 54,
    y: 80,
    width: 504,
    height: 632,
    color: palette.panel,
    borderColor: palette.rule,
    borderWidth: 1,
  });
  page.drawRectangle({
    x: 92,
    y: 580,
    width: 428,
    height: 84,
    color: rgb(0.82, 0.88, 0.93),
  });
  for (let row = 0; row < 7; row += 1) {
    const y = 520 - row * 48;
    page.drawLine({
      start: { x: 108, y },
      end: { x: 504, y },
      thickness: row % 2 === 0 ? 4 : 2,
      color: row % 2 === 0 ? palette.muted : palette.rule,
    });
  }
  page.drawCircle({
    x: 306,
    y: 156,
    size: 32,
    color: rgb(0.2, 0.48, 0.68),
    borderColor: palette.accent,
    borderWidth: 2,
  });

  const bytes = await document.save({ useObjectStreams: false });
  await writeFile(new URL("no-text-layer.pdf", outputDirectory), bytes);
}

async function assertExactOutputSet() {
  const actual = (await readdir(outputDirectory))
    .filter((name) => name.endsWith(".pdf"))
    .sort();
  const expected = [...OUTPUT_NAMES].sort();

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected exactly ${expected.join(", ")}; found ${actual.join(", ")}`,
    );
  }
}

await mkdir(outputDirectory, { recursive: true });

await saveTextFixture(
  "single-column.pdf",
  "Single-column academic text fixture",
  async ({ document, font }) => {
    const page = addTextPage(document, font, "Single-column research excerpt");
    drawLines(page, font, [
      "Single column sentence one.",
      "Single column sentence two.",
      "The controlled sample contains deterministic academic prose.",
      "Each line remains selectable through the PDF text layer.",
      "The fixture contains no text copied from a published paper.",
    ]);
  },
);

await saveTextFixture(
  "two-column.pdf",
  "Two-column academic text fixture",
  async ({ document, font }) => {
    const page = addTextPage(document, font, "Two-column selection order");
    page.drawRectangle({
      x: 48,
      y: 452,
      width: 240,
      height: 228,
      color: palette.panel,
      borderColor: palette.rule,
      borderWidth: 0.8,
    });
    page.drawRectangle({
      x: 324,
      y: 452,
      width: 240,
      height: 228,
      color: palette.panel,
      borderColor: palette.rule,
      borderWidth: 0.8,
    });
    page.drawLine({
      start: { x: 306, y: 438 },
      end: { x: 306, y: 692 },
      thickness: 1.2,
      color: palette.accent,
    });
    drawLines(
      page,
      font,
      [
        "LEFT-1 Controlled observations.",
        "Left column line one.",
        "LEFT-2 Ordered evidence.",
        "Left column line two.",
      ],
      { x: 62, startY: 644, lineHeight: 34, size: 10.5 },
    );
    drawLines(
      page,
      font,
      [
        "RIGHT-1 Comparative results.",
        "Right column line one.",
        "RIGHT-2 Final observations.",
        "Right column line two.",
      ],
      { x: 338, startY: 644, lineHeight: 34, size: 10.5 },
    );
  },
);

await saveTextFixture(
  "cross-page.pdf",
  "Cross-page academic text fixture",
  async ({ document, font }) => {
    const firstPage = addTextPage(document, font, "Cross-page selection - page 1");
    drawLines(firstPage, font, [
      "A bounded selection can continue across a page boundary.",
      "The first page contains a clear terminal marker below.",
    ]);
    firstPage.drawText("PAGE-1-END", {
      x: 64,
      y: 72,
      size: 12,
      font,
      color: palette.accent,
    });

    const secondPage = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    secondPage.drawText("PAGE-2-CONTINUATION", {
      x: 54,
      y: 738,
      size: 14,
      font,
      color: palette.accent,
    });
    secondPage.drawLine({
      start: { x: 54, y: 720 },
      end: { x: 558, y: 720 },
      thickness: 0.8,
      color: palette.rule,
    });
    drawLines(secondPage, font, [
      "The second page begins with the continuation marker.",
      "Page-local text items remain available in source order.",
    ]);
  },
);

await saveTextFixture(
  "hyphenation-ligatures.pdf",
  "Hyphenation and ligatures academic text fixture",
  async ({ document, font }) => {
    const page = addTextPage(document, font, "Hyphenation and ligatures");
    drawLines(
      page,
      font,
      [
        "The next two lines encode an intentional line-wrap break:",
        "multi-",
        "modal",
        "The ef\ufb01cient method preserves \ufb02ow across the text layer.",
        "These ligatures are Unicode characters, not replacement images.",
      ],
      { startY: 674, lineHeight: 30 },
    );
  },
);

await saveTextFixture(
  "equations-citations.pdf",
  "Equations and citations fixture",
  async ({ document, font }) => {
    const page = addTextPage(document, font, "Equations, units, and citations");
    drawLines(
      page,
      font,
      [
        "Estimated coefficient: \u03b2 = 0.5 [12]",
        "Measured concentration: 25 mg/mL at 37 \u00b0C.",
        "Equation (3): y = \u03b2x + \u03b5.",
        "Figure 2, Table 1, and Equation (3) preserve references.",
        "Variables x and y remain unchanged in academic translation.",
      ],
      { startY: 674, lineHeight: 32 },
    );
  },
);

await saveGraphicsFixture();
await assertExactOutputSet();
