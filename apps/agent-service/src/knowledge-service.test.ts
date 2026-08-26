import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeService, KnowledgeServiceError } from "./knowledge-service.ts";
import { AgentStore } from "./storage.ts";

const createSimplePdf = (text: string): Buffer => {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
};

test("Local Knowledge indexes text, BOM and PDF with citations and incremental cleanup", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "jlcircuit-knowledge-"));
  const sourceDirectory = join(temporary, "datasheets");
  mkdirSync(sourceDirectory);
  const markdownPath = join(sourceDirectory, "power.md");
  const bomPath = join(sourceDirectory, "bom.csv");
  const pdfPath = join(sourceDirectory, "stm32.pdf");
  writeFileSync(markdownPath, "# 电源设计\n芯片供电电压为 3.3V。\n去耦电容应靠近 VDD 引脚。\n");
  writeFileSync(bomPath, "Designator,Value\nC1,100nF\nR1,10k\n");
  writeFileSync(pdfPath, createSimplePdf("STM32 datasheet VDD 3.3V reference circuit"));
  const store = new AgentStore(":memory:");
  const service = new KnowledgeService(store);
  try {
    await assert.rejects(
      async () => service.createSource({ id: "relative", rootPath: "datasheets" }),
      (error: unknown) => error instanceof KnowledgeServiceError && error.code === "KNOWLEDGE_SOURCE_INVALID",
    );
    const source = service.createSource({
      id: "board-docs",
      name: "板卡资料",
      rootPath: sourceDirectory,
      extensions: [".md", ".csv", ".pdf"],
    });
    assert.equal(source.enabled, true);

    const first = await service.scanSource("board-docs");
    assert.equal(first.discovered, 3);
    assert.equal(first.indexed, 3, JSON.stringify(first));
    assert.equal(first.errors, 0, JSON.stringify(first));
    assert.equal(store.listKnowledgeDocuments("board-docs").length, 3);

    const chineseResults = service.search("供电电压", ["board-docs"], 5) as Array<Record<string, unknown>>;
    assert.equal(chineseResults.length > 0, true);
    assert.equal(chineseResults[0]?.path, "power.md");
    assert.equal((chineseResults[0]?.citation as Record<string, unknown>).lineStart, 1);

    const pdfResults = service.search("STM32 VDD", [], 5) as Array<Record<string, unknown>>;
    assert.equal(pdfResults.length > 0, true);
    assert.equal(pdfResults[0]?.path, "stm32.pdf");
    assert.equal((pdfResults[0]?.citation as Record<string, unknown>).page, 1);
    const read = await service.callTool("knowledge_read", "knowledge-test", {
      chunkId: pdfResults[0]?.chunkId,
      maxChars: 10_000,
    });
    assert.equal(read.ok, true);
    assert.match(JSON.stringify(read.data), /STM32 datasheet/);
    assert.doesNotMatch(JSON.stringify(read.data), new RegExp(sourceDirectory.replaceAll("\\", "\\\\")));

    service.updateSource("board-docs", {
      id: "board-docs",
      name: "板卡资料",
      rootPath: sourceDirectory,
      extensions: [".md", ".csv", ".pdf"],
      enabled: false,
    });
    assert.equal(service.search("供电电压").length, 0);
    const disabledRead = await service.callTool("knowledge_read", "knowledge-test", {
      chunkId: pdfResults[0]?.chunkId,
    });
    assert.equal(disabledRead.ok, false);
    service.updateSource("board-docs", {
      id: "board-docs",
      name: "板卡资料",
      rootPath: sourceDirectory,
      extensions: [".md", ".csv", ".pdf"],
      enabled: true,
    });

    const second = await service.scanSource("board-docs");
    assert.equal(second.unchanged, 3);
    unlinkSync(bomPath);
    const third = await service.scanSource("board-docs");
    assert.equal(third.removed, 1);
    assert.equal(store.listKnowledgeDocuments("board-docs").some((document) => document.relativePath === "bom.csv"), false);

    service.deleteSource("board-docs");
    assert.equal(store.listKnowledgeSources().length, 0);
    assert.equal(service.search("供电电压").length, 0);
  } finally {
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
