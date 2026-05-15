// 文件解析模块:把上传的二进制数据(Buffer)转成纯文本。
// 所有函数都是纯函数,不依赖 server 共享状态。
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { PDFParse } from "pdf-parse";
import { createWorker } from "tesseract.js";
import { compactText } from "../lib.mjs";

const execFileAsync = promisify(execFile);

export function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return Buffer.from(String(dataUrl || ""), "base64");
  return Buffer.from(match[2], "base64");
}

export async function extractExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const chunks = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
    const textRows = rows
      .map((row) => row.map((cell) => String(cell).trim()).filter(Boolean).join(" | "))
      .filter(Boolean);
    if (textRows.length) chunks.push(`【${sheetName}】\n${textRows.join("\n")}`);
  }
  return compactText(chunks.join("\n\n"));
}

export async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return compactText(result.value);
}

export async function extractDoc(buffer, fileName) {
  const dir = await mkdtemp(join(tmpdir(), "gongwen-doc-"));
  const input = join(dir, fileName || `material-${randomUUID()}.doc`);
  try {
    await writeFile(input, buffer);
    const { stdout } = await execFileAsync("/usr/bin/textutil", ["-convert", "txt", "-stdout", input], {
      maxBuffer: 20 * 1024 * 1024
    });
    return compactText(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return compactText(result.text);
  } finally {
    await parser.destroy();
  }
}

export async function extractImage(buffer) {
  const worker = await createWorker("chi_sim+eng");
  try {
    const result = await worker.recognize(buffer);
    return compactText(result.data.text);
  } finally {
    await worker.terminate();
  }
}

export async function extractUploadedMaterial({ name, mime, dataUrl }) {
  const fileName = String(name || "上传材料");
  const ext = extname(fileName).toLowerCase();
  const buffer = decodeDataUrl(dataUrl);
  let kind = "unknown";
  let content = "";

  if ([".txt", ".md", ".csv", ".tsv"].includes(ext) || /^text\//.test(mime || "")) {
    kind = "text";
    content = compactText(buffer.toString("utf8"));
  } else if ([".xlsx", ".xls"].includes(ext)) {
    kind = "spreadsheet";
    content = await extractExcel(buffer);
  } else if (ext === ".docx") {
    kind = "word";
    content = await extractDocx(buffer);
  } else if (ext === ".doc") {
    kind = "word-legacy";
    content = await extractDoc(buffer, fileName);
  } else if (ext === ".pdf" || mime === "application/pdf") {
    kind = "pdf";
    content = await extractPdf(buffer);
  } else if ([".jpg", ".jpeg", ".png"].includes(ext) || /^image\/(jpeg|png)$/.test(mime || "")) {
    kind = "image-ocr";
    content = await extractImage(buffer);
  } else {
    throw new Error("暂不支持该文件格式，请上传 Excel、doc/docx、pdf、jpg、png 或文本文件。");
  }

  if (!content) {
    content = "未能识别出可用文本，请确认文件内容清晰、未加密，或改为粘贴文字材料。";
  }

  return {
    id: randomUUID(),
    name: fileName,
    kind,
    mime: mime || "",
    content,
    createdAt: new Date().toISOString()
  };
}
