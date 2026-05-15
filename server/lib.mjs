import { AlignmentType, HeadingLevel, Paragraph, TextRun } from "docx";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

export function deriveKeyFromMaterial(...parts) {
  return createHash("sha256").update(parts.map(String).join("")).digest();
}

export function encryptWithKey(value, key) {
  const plain = String(value ?? "");
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptWithKey(stored, key) {
  if (!stored || typeof stored !== "string") return "";
  if (!stored.startsWith("enc:v1:")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 5) return "";
  const iv = Buffer.from(parts[2], "base64");
  const tag = Buffer.from(parts[3], "base64");
  const data = Buffer.from(parts[4], "base64");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

// 用多把候选密钥尝试解密,命中即返回。用于 keychain 迁移期兼容旧派生密钥。
export function decryptWithKeys(stored, keys) {
  if (!stored || typeof stored !== "string") return "";
  if (!stored.startsWith("enc:v1:")) return stored;
  for (const key of keys) {
    const out = decryptWithKey(stored, key);
    if (out) return out;
  }
  return "";
}

export const defaultModelSettings = [
  { role: "thinkChief", title: "构思 Agent A", model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", apiKey: "", providerType: "direct", apiFormat: "responses", executionMode: "mock", profileId: "openai-default", providerName: "OpenAI" },
  { role: "thinkGemini", title: "构思 Agent B", model: "gemini-2.5-pro", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "", providerType: "direct", apiFormat: "gemini", executionMode: "mock", profileId: "gemini-default", providerName: "Gemini" },
  { role: "thinkDeepseek", title: "构思 Agent C", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "", providerType: "direct", apiFormat: "chatCompletions", executionMode: "mock", profileId: "deepseek-default", providerName: "DeepSeek" },
  { role: "synthesis", title: "思路汇总把关", model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", apiKey: "", providerType: "direct", apiFormat: "responses", executionMode: "mock", profileId: "openai-default", providerName: "OpenAI" },
  { role: "research", title: "联网检索资料", model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", apiKey: "", providerType: "direct", apiFormat: "responses", executionMode: "mock", profileId: "openai-default", providerName: "OpenAI", searchProvider: "mock", searchBaseUrl: "", searchApiKey: "" },
  { role: "outlineGemini", title: "大纲 Agent A", model: "gemini-2.5-pro", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "", providerType: "direct", apiFormat: "gemini", executionMode: "mock", profileId: "gemini-default", providerName: "Gemini" },
  { role: "outlineDeepseek", title: "大纲 Agent B", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "", providerType: "direct", apiFormat: "chatCompletions", executionMode: "mock", profileId: "deepseek-default", providerName: "DeepSeek" },
  { role: "finalOutline", title: "定稿大纲把关", model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", apiKey: "", providerType: "direct", apiFormat: "responses", executionMode: "mock", profileId: "openai-default", providerName: "OpenAI" },
  { role: "factExtractor", title: "事实素材提炼", model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", apiKey: "", providerType: "direct", apiFormat: "responses", executionMode: "mock", profileId: "openai-default", providerName: "OpenAI" },
  { role: "styleExtractor", title: "文风提炼", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "", providerType: "direct", apiFormat: "chatCompletions", executionMode: "mock", profileId: "deepseek-default", providerName: "DeepSeek" },
  { role: "drafter", title: "初稿撰写", model: "gemini-2.5-pro", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "", providerType: "direct", apiFormat: "gemini", executionMode: "mock", profileId: "gemini-default", providerName: "Gemini" },
  { role: "reviser", title: "修改完善", model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", apiKey: "", providerType: "direct", apiFormat: "responses", executionMode: "mock", profileId: "openai-default", providerName: "OpenAI" },
  { role: "proofreader", title: "校对纠错", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "", providerType: "direct", apiFormat: "chatCompletions", executionMode: "mock", profileId: "deepseek-default", providerName: "DeepSeek" },
  { role: "sanitizer", title: "材料脱敏", model: "llama3.1", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", providerType: "local", apiFormat: "chatCompletions", executionMode: "mock", profileId: "local-default", providerName: "本地模型" },
  { role: "qualityAuditor", title: "内容质量审计", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "", providerType: "direct", apiFormat: "chatCompletions", executionMode: "mock", profileId: "deepseek-default", providerName: "DeepSeek" }
];

export function normalizeProviderType(value) {
  if (value === "local") return "local";
  return value === "ccSwitch" ? "ccSwitch" : "direct";
}

export function normalizeApiFormat(value) {
  if (value === "chatCompletions" || value === "gemini") return value;
  return "responses";
}

export function normalizeExecutionMode(value) {
  return value === "live" ? "live" : "mock";
}

export function normalizeModelSetting(defaultItem, incoming = {}) {
  return {
    ...defaultItem,
    ...incoming,
    role: defaultItem.role,
    title: defaultItem.title,
    providerType: normalizeProviderType(incoming.providerType || defaultItem.providerType),
    apiFormat: normalizeApiFormat(incoming.apiFormat || defaultItem.apiFormat),
    executionMode: normalizeExecutionMode(incoming.executionMode || defaultItem.executionMode),
    profileId: String(incoming.profileId ?? defaultItem.profileId ?? ""),
    providerName: String(incoming.providerName ?? defaultItem.providerName ?? ""),
    searchProvider: normalizeSearchProvider(incoming.searchProvider ?? defaultItem.searchProvider),
    searchBaseUrl: String(incoming.searchBaseUrl ?? defaultItem.searchBaseUrl ?? ""),
    searchApiKey: String(incoming.searchApiKey ?? defaultItem.searchApiKey ?? "")
  };
}

export function normalizeSearchProvider(value) {
  if (value === "tavily" || value === "serper" || value === "custom") return value;
  return "mock";
}

export function mergeModelSettings(input) {
  const incoming = new Map((Array.isArray(input) ? input : []).map((item) => [item.role, item]));
  return defaultModelSettings.map((item) => normalizeModelSetting(item, incoming.get(item.role)));
}

export function compactText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function mockSanitizeText(text) {
  return String(text || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱]")
    .replace(/\b\d{17}[\dXx]\b/g, "[身份证号]")
    .replace(/\b\d{15}\b/g, "[身份证号]")
    .replace(/\b[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}\b/g, "[统一社会信用代码]")
    .replace(/(^|[^\d])([1-9]\d{15,18})(?!\d)/g, "$1[银行卡号]")
    .replace(/1[3-9]\d{9}/g, "[手机号]")
    .replace(/[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-Z0-9]{5,6}/g, "[车牌号]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP地址]")
    .replace(/\b0\d{2,3}[-\s]?\d{7,8}\b/g, "[座机]")
    .replace(/\b(?:QQ[:：]?\s*)(\d{5,11})\b/gi, "QQ:[QQ号]")
    .replace(/(微信|wechat)\s*[:：]?\s*[A-Za-z][-_A-Za-z0-9]{4,19}/gi, "[微信号]")
    .replace(/(?:[一-龥]{2,}(?:省|市|区|县|镇|街道|路|号|小区|大厦|楼|室)){2,}/g, "[地址]")
    .replace(/([，。；;、\s])[一-龥]{2,4}(同志|先生|女士|主任|局长|书记|经理|科长)/g, "$1[姓名]$2")
    .replace(/\d+/g, "XX");
}

export function mockAuditContent(content) {
  const text = String(content || "");
  const risks = [];
  if (/(历史最好|全面领先|根本解决|彻底解决)/.test(text)) risks.push("存在绝对化表述,建议核验后弱化。");
  if (/\d/.test(text)) risks.push("包含数字或比例,正式使用前需核对来源。");
  if (text.length < 40) risks.push("内容偏短,可能不足以支撑该阶段输出。");
  return {
    score: Math.max(72, 95 - risks.length * 7),
    verdict: risks.length ? "需人工复核" : "通过",
    risks,
    summary: risks.length ? "审计发现若干需复核项,已保留生成内容但提示人工把关。" : "逻辑、事实边界和表达风险未见明显问题。"
  };
}

export function auditFeedbackHint(task, ...sourceSteps) {
  const wanted = new Set(sourceSteps);
  const audits = (task?.outputs?.qualityAudits || []).filter((audit) => wanted.has(audit.sourceStep));
  const opinions = audits.flatMap((audit) => audit.feedback || []).map((item) => item.opinion).filter(Boolean);
  if (!opinions.length) return "";
  return `\n\n【上一阶段已确认的审计意见,必须在本阶段中落实】\n- ${opinions.join("\n- ")}`;
}

function parseInlineRuns(text, base = {}) {
  const segments = [];
  const pattern = /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`([^`]+)`/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), bold: false, italic: false });
    }
    if (match[1] || match[2]) {
      segments.push({ text: match[1] || match[2], bold: true });
    } else if (match[3] || match[4]) {
      segments.push({ text: match[3] || match[4], italic: true });
    } else if (match[5]) {
      segments.push({ text: match[5], code: true });
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  if (!segments.length) segments.push({ text });
  return segments.map((seg) => new TextRun({
    text: seg.text,
    bold: seg.bold ?? base.bold ?? false,
    italics: seg.italic ?? false,
    size: base.size ?? 28,
    font: seg.code ? "Menlo" : (base.font ?? "仿宋")
  }));
}

function headingParagraphForChinese(line) {
  if (/^[一二三四五六七八九十百]+、/.test(line)) {
    return new Paragraph({
      children: parseInlineRuns(line, { bold: true, size: 32, font: "黑体" }),
      spacing: { before: 240, after: 160 },
      heading: HeadingLevel.HEADING_2
    });
  }
  if (/^[(（][一二三四五六七八九十]+[)）]/.test(line)) {
    return new Paragraph({
      children: parseInlineRuns(line, { bold: true, size: 30, font: "楷体" }),
      spacing: { before: 180, after: 120 },
      heading: HeadingLevel.HEADING_3
    });
  }
  if (/^\d+[.、]\s*/.test(line)) {
    return new Paragraph({
      children: parseInlineRuns(line, { bold: true, size: 28, font: "仿宋" }),
      spacing: { before: 140, after: 100 },
      heading: HeadingLevel.HEADING_4
    });
  }
  return null;
}

export function markdownToDocxChildren(markdown) {
  const children = [];
  const rawLines = String(markdown || "").split(/\r?\n/);
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("# ")) {
      children.push(new Paragraph({
        children: parseInlineRuns(line.replace(/^#\s+/, ""), { bold: true, size: 44, font: "方正小标宋简体" }),
        alignment: AlignmentType.CENTER,
        spacing: { after: 360 },
        heading: HeadingLevel.TITLE
      }));
      continue;
    }
    if (line.startsWith("## ")) {
      children.push(new Paragraph({
        children: parseInlineRuns(line.replace(/^##\s+/, ""), { bold: true, size: 32, font: "黑体" }),
        spacing: { before: 240, after: 160 },
        heading: HeadingLevel.HEADING_1
      }));
      continue;
    }
    if (line.startsWith("### ")) {
      children.push(new Paragraph({
        children: parseInlineRuns(line.replace(/^###\s+/, ""), { bold: true, size: 30, font: "楷体" }),
        spacing: { before: 180, after: 120 },
        heading: HeadingLevel.HEADING_2
      }));
      continue;
    }
    if (line.startsWith("> ")) {
      children.push(new Paragraph({
        children: parseInlineRuns(line.replace(/^>\s+/, ""), { italic: true, size: 26, font: "楷体" }),
        indent: { left: 560, right: 280 },
        spacing: { line: 400, after: 120 }
      }));
      continue;
    }
    const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      children.push(new Paragraph({
        children: parseInlineRuns(bulletMatch[1], { size: 28, font: "仿宋" }),
        bullet: { level: 0 },
        spacing: { line: 400, after: 80 }
      }));
      continue;
    }
    const orderedMatch = line.match(/^\(?\d+[.、)]\s*(.+)$/);
    const chineseHeading = headingParagraphForChinese(line);
    if (chineseHeading) {
      children.push(chineseHeading);
      continue;
    }
    if (orderedMatch) {
      children.push(new Paragraph({
        children: parseInlineRuns(orderedMatch[0], { size: 28, font: "仿宋" }),
        spacing: { line: 420, after: 100 },
        indent: { firstLine: 280 }
      }));
      continue;
    }

    children.push(new Paragraph({
      children: parseInlineRuns(line, { size: 28, font: "仿宋" }),
      firstLine: 560,
      spacing: { line: 420, after: 120 }
    }));
  }
  return children.length ? children : [new Paragraph("定稿尚无内容")];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineHtml(text) {
  // 顺序很重要:先跑代码/粗体/斜体,再 escape 会冲突,所以先 escape 再把 markdown 符号转 HTML。
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/(^|[^_])_([^_]+?)_(?!_)/g, "$1<em>$2</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  return html;
}

export function markdownToPrintHtml(markdown, meta = {}) {
  const title = meta.title || "公文材料";
  const subtitle = meta.subtitle || "";
  const lines = String(markdown || "").split(/\r?\n/);
  const body = [];
  let listBuffer = [];
  const flushList = () => {
    if (!listBuffer.length) return;
    body.push(`<ul>${listBuffer.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    listBuffer = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (line.startsWith("# ")) {
      flushList();
      body.push(`<h1 class="doc-title">${renderInlineHtml(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      body.push(`<h2 class="level-1">${renderInlineHtml(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("### ")) {
      flushList();
      body.push(`<h3 class="level-2">${renderInlineHtml(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith("> ")) {
      flushList();
      body.push(`<blockquote>${renderInlineHtml(line.slice(2))}</blockquote>`);
      continue;
    }
    const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      listBuffer.push(renderInlineHtml(bulletMatch[1]));
      continue;
    }
    flushList();
    // 一、、(一)、1. 三段式标题
    if (/^[一二三四五六七八九十百]+、/.test(line)) {
      body.push(`<h2 class="cn-level-1">${renderInlineHtml(line)}</h2>`);
      continue;
    }
    if (/^[(（][一二三四五六七八九十]+[)）]/.test(line)) {
      body.push(`<h3 class="cn-level-2">${renderInlineHtml(line)}</h3>`);
      continue;
    }
    if (/^\d+[.、]\s*/.test(line)) {
      body.push(`<h4 class="cn-level-3">${renderInlineHtml(line)}</h4>`);
      continue;
    }
    body.push(`<p>${renderInlineHtml(line)}</p>`);
  }
  flushList();

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 25mm 20mm 22mm 25mm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "方正仿宋简体", "仿宋", "FangSong", "STFangsong", serif;
    font-size: 16pt;
    line-height: 1.75;
    color: #18201d;
    padding: 0 12mm;
  }
  .doc-subtitle { text-align: center; color: #666; font-size: 11pt; margin-bottom: 6mm; }
  h1.doc-title {
    font-family: "方正小标宋简体", "SimSun", "宋体", serif;
    font-size: 22pt;
    text-align: center;
    font-weight: 700;
    margin: 4mm 0 8mm 0;
    line-height: 1.4;
  }
  h2.level-1, h2.cn-level-1 {
    font-family: "黑体", "SimHei", sans-serif;
    font-size: 16pt;
    font-weight: 700;
    margin: 6mm 0 3mm 0;
  }
  h3.level-2, h3.cn-level-2 {
    font-family: "楷体", "KaiTi", "STKaiti", serif;
    font-size: 15pt;
    font-weight: 700;
    margin: 5mm 0 2mm 0;
  }
  h4.cn-level-3 {
    font-size: 15pt;
    font-weight: 700;
    margin: 4mm 0 2mm 0;
  }
  p {
    text-indent: 2em;
    margin: 0 0 2mm 0;
    text-align: justify;
  }
  blockquote {
    margin: 2mm 6mm;
    padding: 1mm 4mm;
    font-family: "楷体", "KaiTi", serif;
    color: #4a4a4a;
    border-left: 3px solid #c8c3a8;
  }
  ul { margin: 2mm 0 2mm 6mm; padding: 0; }
  ul li { margin-bottom: 1mm; text-indent: 0; }
  code {
    font-family: "Menlo", "Consolas", monospace;
    font-size: 13pt;
    background: #f2ead2;
    padding: 0 3px;
    border-radius: 3px;
  }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    background: #18201d; color: #f5f2e9;
    padding: 8px 16px; display: flex; gap: 12px; align-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px;
  }
  .toolbar button {
    background: #d9c785; color: #18201d; border: none;
    padding: 6px 14px; border-radius: 5px; cursor: pointer; font-weight: 600;
  }
  .toolbar button.secondary { background: transparent; color: #f5f2e9; border: 1px solid rgba(255,255,255,0.3); }
  @media print {
    .toolbar { display: none !important; }
    body { padding: 0; }
  }
</style>
</head>
<body>
<div class="toolbar">
  <span>${escapeHtml(title)}${subtitle ? "  ·  " + escapeHtml(subtitle) : ""}</span>
  <button onclick="window.print()">打印 / 另存为 PDF</button>
  <button class="secondary" onclick="window.close()">关闭</button>
</div>
${subtitle ? `<div class="doc-subtitle">${escapeHtml(subtitle)}</div>` : ""}
${body.join("\n")}
</body>
</html>`;
}

// ---- 行级 diff(LCS) ----
// 返回形如 [{type: 'equal'|'add'|'remove', left?: string, right?: string}] 的数组,用于双栏并排显示。
export function diffLines(oldText, newText) {
  const splitLines = (text) => {
    const s = String(text || "");
    return s.length ? s.split(/\r?\n/) : [];
  };
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length;
  const n = b.length;
  // DP 表:dp[i][j] = LCS(a[0..i-1], b[0..j-1])
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i += 1) dp[i] = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ type: "equal", left: a[i - 1], right: b[j - 1] });
      i -= 1; j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ type: "remove", left: a[i - 1] });
      i -= 1;
    } else {
      out.push({ type: "add", right: b[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) { out.push({ type: "remove", left: a[i - 1] }); i -= 1; }
  while (j > 0) { out.push({ type: "add", right: b[j - 1] }); j -= 1; }
  out.reverse();
  return out;
}

export function diffSummary(ops) {
  let added = 0;
  let removed = 0;
  let equal = 0;
  for (const op of ops) {
    if (op.type === "add") added += 1;
    else if (op.type === "remove") removed += 1;
    else equal += 1;
  }
  return { added, removed, equal, total: ops.length };
}
