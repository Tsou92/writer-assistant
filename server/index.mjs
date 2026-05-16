import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  auditFeedbackHint,
  compactText,
  decryptWithKeys,
  defaultModelSettings,
  deriveKeyFromMaterial,
  encryptWithKey,
  mergeModelSettings,
  mockAuditContent,
  mockSanitizeText,
  normalizeApiFormat,
  normalizeExecutionMode,
  normalizeModelSetting,
  normalizeProviderType
} from "./lib.mjs";
import {
  callLiveModelDetailed,
  listAvailableModels,
  testModelSetting
} from "./modules/models.mjs";
import { runWebSearch } from "./modules/search.mjs";
import { extractUploadedMaterial } from "./modules/materials.mjs";
import {
  briefLabel,
  createDocxBuffer,
  extractMaterials,
  extractStylePrompt,
  makeAgentIdeas,
  makeMaterialRequest,
  makeOutline,
  makeResearchCards,
  modelName,
  proofreadDraft,
  renderDraft,
  reviseDraft
} from "./modules/content.mjs";
import {
  RERUN_PLANS,
  createSteps,
  now,
  stepTemplate
} from "./modules/workflow-config.mjs";
import { corsHeaders, readBody, sendJson } from "./modules/http.mjs";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8787);

function resolveAppDir() {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "GongwenWriter");
  }
  return join(homedir(), "Library", "Application Support", "GongwenWriter");
}

const appDir = resolveAppDir();
const projectsDir = join(appDir, "projects");
const settingsFile = join(appDir, "model-settings.json");
const tasksFile = join(appDir, "tasks.json");

/** @type {Map<string, any>} */
const tasks = new Map();
/** @type {Set<http.ServerResponse>} */
const clients = new Set();
/** @type {Map<string, AbortController>} */
const taskRunControllers = new Map();

const KEYCHAIN_SERVICE = "com.local.gongwen-writer";
const KEYCHAIN_ACCOUNT = "settings-aes-v1";

class TaskPausedError extends Error {
  constructor(message = "用户已暂停当前任务。") {
    super(message);
    this.name = "TaskPausedError";
  }
}

class TaskSupersededError extends Error {
  constructor(message = "当前任务已有新的运行接管。") {
    super(message);
    this.name = "TaskSupersededError";
  }
}

async function macosKeychainFetch() {
  // 仅 macOS,通过 security 命令读取当前用户登录 keychain 的密码条目。
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", KEYCHAIN_ACCOUNT,
      "-w"
    ], { maxBuffer: 128 * 1024 });
    const b64 = stdout.trim();
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64");
    if (buf.length !== 32) return null;
    return buf;
  } catch {
    return null;
  }
}

async function macosKeychainStore(key32) {
  const b64 = Buffer.from(key32).toString("base64");
  // -U 已存在则更新,-s/-a 标识条目。
  await execFileAsync("/usr/bin/security", [
    "add-generic-password",
    "-U",
    "-s", KEYCHAIN_SERVICE,
    "-a", KEYCHAIN_ACCOUNT,
    "-w", b64
  ], { maxBuffer: 128 * 1024 });
}

let cachedActiveKey = null;
let cachedFallbackKey = null;

function legacyDerivedKey() {
  if (!cachedFallbackKey) {
    cachedFallbackKey = deriveKeyFromMaterial(process.platform, process.arch, homedir(), appDir, "GongwenWriter::v1");
  }
  return cachedFallbackKey;
}

async function resolveActiveKey() {
  if (cachedActiveKey) return cachedActiveKey;
  if (process.platform === "darwin" && !process.env.GONGWEN_DISABLE_KEYCHAIN) {
    let key = await macosKeychainFetch();
    if (!key) {
      key = randomBytes(32);
      try {
        await macosKeychainStore(key);
      } catch (error) {
        console.warn("写入 keychain 失败,本次仍用派生密钥兜底:", error?.message || error);
        key = legacyDerivedKey();
      }
    }
    cachedActiveKey = key;
    return key;
  }
  cachedActiveKey = legacyDerivedKey();
  return cachedActiveKey;
}

const SECRET_FIELDS = ["apiKey", "searchApiKey"];

async function encryptSettingsForDisk(settings) {
  const key = await resolveActiveKey();
  return settings.map((item) => {
    const next = { ...item };
    for (const field of SECRET_FIELDS) {
      if (next[field]) next[field] = encryptWithKey(next[field], key);
    }
    return next;
  });
}

async function decryptSettingsFromDisk(settings) {
  const active = await resolveActiveKey();
  // 迁移场景:盘上旧密文用派生密钥加密过,优先用当前 keychain 密钥解,失败时回退派生密钥。
  const candidateKeys = [active];
  const legacy = legacyDerivedKey();
  if (!legacy.equals(active)) candidateKeys.push(legacy);
  return settings.map((item) => {
    const next = { ...item };
    for (const field of SECRET_FIELDS) {
      if (next[field]) next[field] = decryptWithKeys(next[field], candidateKeys);
    }
    return next;
  });
}

let modelSettings = await loadModelSettings();

function restoreSettingSecrets(item) {
  const { tokenUsage, ...rest } = item || {};
  const next = { ...rest };
  for (const field of SECRET_FIELDS) {
    const incoming = next[field];
    if (incoming && incoming !== "已配置") continue;
    const byProfile = modelSettings.find((old) => item.profileId && old.profileId === item.profileId && old[field])?.[field];
    if (byProfile) {
      next[field] = byProfile;
      continue;
    }
    const exact = modelSettings.find((old) => old.role === item.role)?.[field];
    if (exact) {
      next[field] = exact;
      continue;
    }
    const byEndpoint = modelSettings.find((old) =>
      old.providerName === item.providerName &&
      old.baseUrl === item.baseUrl &&
      old.model === item.model &&
      old[field]
    )?.[field];
    next[field] = byEndpoint || "";
  }
  return next;
}

async function loadModelSettings() {
  await mkdir(appDir, { recursive: true });
  try {
    const raw = JSON.parse(await readFile(settingsFile, "utf8"));
    const decrypted = await decryptSettingsFromDisk(Array.isArray(raw) ? raw : []);
    return mergeModelSettings(decrypted);
  } catch {
    const defaults = mergeModelSettings([]);
    await saveModelSettings(defaults);
    return defaults;
  }
}

async function saveModelSettings(settings) {
  await mkdir(appDir, { recursive: true });
  const payload = await encryptSettingsForDisk(settings);
  await writeFile(settingsFile, JSON.stringify(payload, null, 2), "utf8");
  // 限制文件权限只对当前用户可读写,避免其他账号窥探。
  try {
    await chmod(settingsFile, 0o600);
  } catch {}
}

async function loadTasks() {
  await mkdir(appDir, { recursive: true });
  try {
    const saved = JSON.parse(await readFile(tasksFile, "utf8"));
    for (const task of Array.isArray(saved) ? saved : []) {
      tasks.set(task.id, normalizeTask(task));
    }
  } catch {
    await persistTasks();
  }
}

function normalizeTask(task) {
  const stepById = new Map((Array.isArray(task.steps) ? task.steps : []).map((step) => [step.id, step]));
  return {
    ...task,
    status: task.status || "created",
    steps: stepTemplate.map(([id, title, status, description]) => ({
      id,
      title,
      status,
      description,
      startedAt: null,
      finishedAt: null,
      ...(stepById.get(id) || {})
    })),
    outputs: task.outputs || {},
    materials: Array.isArray(task.materials) ? task.materials : [],
    logs: Array.isArray(task.logs) ? task.logs : [],
    failure: task.failure || null,
    lockedFinal: task.lockedFinal || null,
    modelSettings: mergeModelSettings(task.modelSettings || modelSettings),
    createdAt: task.createdAt || now(),
    updatedAt: task.updatedAt || now()
  };
}

async function persistTasks() {
  await mkdir(appDir, { recursive: true });
  await writeFile(tasksFile, JSON.stringify([...tasks.values()], null, 2), "utf8");
}

let persistTimer = null;
function schedulePersistTasks() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTasks().catch((error) => console.error("Failed to persist tasks:", error));
  }, 120);
}

function settingFor(settings, role) {
  return settings.find((item) => item.role === role) || defaultModelSettings.find((item) => item.role === role);
}

function modelUsageKey(setting) {
  return [
    setting?.providerName || setting?.providerType || "unknown",
    setting?.baseUrl || "",
    setting?.model || ""
  ].join("::");
}

function emptyUsage() {
  return { input: 0, output: 0, total: 0, calls: 0 };
}

function addUsage(target, usage) {
  if (!target || !usage) return target;
  target.input += Number(usage.input || 0);
  target.output += Number(usage.output || 0);
  target.total += Number(usage.total || 0);
  target.calls += Number(usage.calls || 1);
  return target;
}

function recordTokenUsage(task, role, purpose, setting, usage) {
  if (!task || !usage || Number(usage.total || 0) <= 0) return;
  task.outputs.tokenUsage ||= {
    input: 0,
    output: 0,
    total: 0,
    calls: 0,
    byModel: {},
    byRole: {},
    callsLog: []
  };
  const usageBook = task.outputs.tokenUsage;
  const normalized = {
    input: Number(usage.input || 0),
    output: Number(usage.output || 0),
    total: Number(usage.total || 0),
    calls: 1
  };
  addUsage(usageBook, normalized);
  const key = modelUsageKey(setting);
  usageBook.byModel[key] ||= {
    ...emptyUsage(),
    providerName: setting.providerName || setting.providerType || "",
    model: setting.model || "",
    baseUrl: setting.baseUrl || ""
  };
  addUsage(usageBook.byModel[key], normalized);
  usageBook.byRole[role] ||= { ...emptyUsage(), title: setting.title || role, model: setting.model || "" };
  addUsage(usageBook.byRole[role], normalized);
  usageBook.callsLog.unshift({
    id: randomUUID(),
    at: now(),
    role,
    purpose,
    providerName: setting.providerName || setting.providerType || "",
    model: setting.model || "",
    input: normalized.input,
    output: normalized.output,
    total: normalized.total
  });
  usageBook.callsLog = usageBook.callsLog.slice(0, 200);
  task.updatedAt = now();
  schedulePersistTasks();
}

function tokenUsageForSetting(setting) {
  const total = emptyUsage();
  const key = modelUsageKey(setting);
  for (const task of tasks.values()) {
    const modelUsage = task.outputs?.tokenUsage?.byModel?.[key];
    if (modelUsage) addUsage(total, modelUsage);
  }
  return total;
}

function publicModelSettings() {
  return modelSettings.map((item) => ({
    ...item,
    tokenUsage: tokenUsageForSetting(item)
  }));
}

function cloneModelSettings(settings = modelSettings) {
  return JSON.parse(JSON.stringify(mergeModelSettings(settings)));
}

function refreshTaskModelSettings(task) {
  if (!task || task.status === "done" || task.deletedAt) return false;
  task.modelSettings = cloneModelSettings(modelSettings);
  task.updatedAt = now();
  return true;
}

function syncOpenTasksModelSettings() {
  let changed = false;
  for (const task of tasks.values()) {
    if (task.status === "running") continue;
    changed = refreshTaskModelSettings(task) || changed;
  }
  if (changed) {
    schedulePersistTasks();
    for (const task of tasks.values()) {
      if (task.status !== "running" && task.status !== "done") emit("task:update", publicTask(task));
    }
  }
}

function sanitizerSettingFromPayload(payload) {
  const fallback = defaultModelSettings.find((item) => item.role === "sanitizer");
  const restored = restoreSettingSecrets(payload || {});
  return normalizeModelSetting(fallback, {
    ...restored,
    role: "sanitizer",
    title: "材料脱敏",
    executionMode: "live"
  });
}

async function maybeCallRole(task, role, purpose, prompt) {
  ensureTaskActive(task);
  const setting = settingFor(task.modelSettings, role);
  let result = null;
  try {
    result = await callLiveModelDetailed(
      setting,
      "你是严谨的中文公文写作 Agent。必须围绕用户给出的材料任务工作,不编造事实数据,输出可直接用于下一阶段的中文内容。",
      prompt,
      { signal: taskRunSignal(task) }
    );
  } catch (error) {
    if (isPauseError(error) || isSupersededError(error)) throw error;
    task.outputs.modelCallWarnings ||= [];
    task.outputs.modelCallWarnings.unshift({
      id: randomUUID(),
      at: now(),
      role,
      purpose,
      model: setting.model,
      message: error?.message || "模型调用失败"
    });
    task.outputs.modelCallWarnings = task.outputs.modelCallWarnings.slice(0, 100);
    log(task, `${setting.title} 未完成真实模型调用：${error?.message || "模型调用失败"}。请检查配置或稍后重新生成。`, setting.model);
    return null;
  }
  ensureTaskActive(task);
  const text = result?.text || null;
  if (!text) return null;
  recordTokenUsage(task, role, purpose, setting, result.usage);
  task.outputs.liveModelNotes ||= {};
  task.outputs.liveModelNotes[role] = { purpose, model: setting.model, text };
  schedulePersistTasks();
  log(task, `${setting.title} 已通过${setting.providerType === "ccSwitch" ? " cc-switch" : "直连 API"}完成真实模型调用。`, setting.model);
  return text;
}

async function sanitizeMaterialText(task, text, name) {
  const setting = settingFor(task.modelSettings, "sanitizer");
  const result = await callLiveModelDetailed(
    setting,
    "你是材料入库前的中文隐私脱敏助手。只输出脱敏后的正文，不要解释。保留事实含义和公文语气，将姓名、手机号、身份证号、邮箱、详细地址、银行卡号、内部敏感编号替换为方括号占位符；所有阿拉伯数字必须统一替换为 XX。",
    `请对以下材料脱敏后输出：\n【材料名】${name}\n\n${text}`
  );
  const liveText = result?.text || null;
  recordTokenUsage(task, "sanitizer", "材料脱敏", setting, result?.usage);
  const sanitized = compactText(mockSanitizeText(liveText || text));
  return {
    text: sanitized,
    report: {
      model: setting.model,
      mode: setting.executionMode,
      changed: sanitized !== compactText(text),
      summary: liveText ? "已由配置的脱敏模型完成入库前脱敏。" : "已使用本地规则完成入库前脱敏；可在设置中切换为 Ollama、LM Studio 或 deepseek API。"
    }
  };
}

async function prepareMaterialForStorage(task, material, sanitize = true) {
  if (!sanitize) {
    return {
      ...material,
      sanitized: false,
      privacyReport: { changed: false, summary: "用户选择跳过入库前脱敏。" }
    };
  }
  const result = await sanitizeMaterialText(task, material.content, material.name);
  return {
    ...material,
    content: result.text,
    sanitized: true,
    privacyReport: result.report
  };
}

async function auditGeneratedContent(task, sourceStep, content, stepId = "") {
  ensureTaskActive(task);
  if (stepId) updateStep(task, stepId, { status: "running", startedAt: now() });
  const setting = settingFor(task.modelSettings, "qualityAuditor");
  let result = null;
  try {
    result = await callLiveModelDetailed(
      setting,
      "你是公文生成内容质量审计员。请审查逻辑一致性、事实边界、政策口径、数据风险、表达规范和是否可能编造。输出简洁审计意见。",
      `请审计以下“${sourceStep}”阶段生成内容：\n\n${typeof content === "string" ? content : JSON.stringify(content, null, 2)}`,
      { signal: taskRunSignal(task) }
    );
  } catch (error) {
    if (isPauseError(error) || isSupersededError(error)) throw error;
    log(task, `质量审计模型未完成：${error?.message || "模型调用失败"}。已生成本地审计提示供人工参考。`, setting.model);
  }
  ensureTaskActive(task);
  const auditText = result?.text || null;
  recordTokenUsage(task, "qualityAuditor", `质量审计：${sourceStep}`, setting, result?.usage);
  const mock = mockAuditContent(typeof content === "string" ? content : JSON.stringify(content));
  const audit = {
    id: randomUUID(),
    sourceStep,
    model: setting.model,
    mode: setting.executionMode,
    score: mock.score,
    verdict: auditText ? "已审计" : mock.verdict,
    summary: auditText || mock.summary,
    risks: auditText ? [] : mock.risks,
    createdAt: now()
  };
  task.outputs.qualityAudits ||= [];
  task.outputs.qualityAudits.unshift(audit);
  schedulePersistTasks();
  log(task, `按用户请求完成质量审计：${sourceStep}，结论：${audit.verdict}。`, setting.model);
  if (stepId) updateStep(task, stepId, { status: "done", finishedAt: now() });
  emit("task:update", publicTask(task));
  return audit;
}

function pushDraftVersion(task, stage, text, source) {
  if (!text) return null;
  const version = {
    id: randomUUID(),
    stage,
    source: source || modelName(task.modelSettings, stage === "initial" ? "drafter" : stage === "revised" ? "reviser" : "proofreader"),
    length: String(text).length,
    text,
    createdAt: now()
  };
  task.outputs.draftHistory ||= [];
  task.outputs.draftHistory.unshift(version);
  // 最多保留 20 条,防止 tasks.json 爆。
  task.outputs.draftHistory = task.outputs.draftHistory.slice(0, 20);
  schedulePersistTasks();
  return version;
}

// 阶段重跑映射:每个可重跑入口对应一个 runner + 重置起点。
// `phase` 决定调用哪个 runner;`fromStep` 之后的所有步骤会被重置为 pending。

await loadTasks();

function emit(type, payload) {
  if (type === "task:update" && payload?.deletedAt) return;
  const safePayload = payload?.id && payload?.brief && payload?.steps && payload?.materials?.some((material) => "content" in material)
    ? publicTask(payload)
    : payload;
  const line = `event: ${type}\ndata: ${JSON.stringify(safePayload)}\n\n`;
  for (const client of clients) client.write(line);
}

function updateStep(task, id, patch) {
  task.steps = task.steps.map((step) =>
    step.id === id ? { ...step, ...patch } : step
  );
  task.updatedAt = now();
  schedulePersistTasks();
  emit("task:update", task);
}

// 重跑场景下:已完成的步骤不再重复执行,失败/pending 的才跑。
function stepNeedsRun(task, id) {
  const step = task.steps.find((item) => item.id === id);
  if (!step) return true;
  return step.status !== "done";
}

function revisionReviewSubmitted(task) {
  return Boolean(task.outputs?.revisionReview?.submittedAt);
}

function formatRevisionReview(review) {
  if (!review?.submittedAt) return "用户尚未提交批注。";
  if (review.skipped || !Array.isArray(review.comments) || review.comments.length === 0) {
    return "用户确认无批注，按当前修改稿继续定稿。";
  }
  return review.comments
    .map((item, index) => `批注${index + 1}\n位置：${item.anchor || "未填写"}\n意见：${item.comment || "未填写"}`)
    .join("\n\n");
}

function outputFeedbackHint(task, ...keys) {
  const wanted = new Set(keys.filter(Boolean));
  const feedback = (task.outputs?.outputFeedback || [])
    .filter((item) => item.status !== "approved" && item.opinion)
    .filter((item) =>
      wanted.has(item.targetId) ||
      wanted.has(item.stepId) ||
      wanted.has(item.sourceStep) ||
      wanted.has(item.role)
    );
  if (!feedback.length) return "";
  return `\n\n【用户对本环节生成内容的修改意见，重跑时必须落实】\n- ${feedback.map((item) => `${item.targetTitle || item.sourceStep || item.stepId}：${item.opinion}`).join("\n- ")}`;
}

function log(task, message, model = "system") {
  if (task.deletedAt) return;
  task.logs.unshift({ id: randomUUID(), at: now(), model, message });
  task.logs = task.logs.slice(0, 120);
  schedulePersistTasks();
  emit("task:update", task);
}

function isPauseError(error) {
  return error?.name === "TaskPausedError" || String(error?.message || "").includes("暂停当前任务");
}

function isSupersededError(error) {
  return error?.name === "TaskSupersededError";
}

function taskRunSignal(task) {
  return taskRunControllers.get(task.id)?.signal;
}

function ensureTaskActive(task) {
  if (task.status === "paused") throw new TaskPausedError();
  const signal = taskRunSignal(task);
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new TaskPausedError();
  }
}

function startTaskRun(task) {
  const previous = taskRunControllers.get(task.id);
  if (previous && !previous.signal.aborted) {
    previous.abort(new TaskSupersededError());
  }
  const controller = new AbortController();
  taskRunControllers.set(task.id, controller);
  delete task.pausedAt;
  return controller;
}

function finishTaskRun(task, controller) {
  if (taskRunControllers.get(task.id) === controller) {
    taskRunControllers.delete(task.id);
  }
}

function pauseTask(task) {
  if (!task || task.deletedAt || task.status === "done") return;
  const controller = taskRunControllers.get(task.id);
  if (controller && !controller.signal.aborted) controller.abort(new TaskPausedError());
  task.status = "paused";
  task.pausedAt = now();
  task.failure = null;
  task.steps = task.steps.map((step) =>
    step.status === "running" ? { ...step, status: "pending", startedAt: null, finishedAt: null } : step
  );
  task.updatedAt = now();
  log(task, "当前任务已暂停，正在进行的模型响应已中止。");
  emit("task:update", publicTask(task));
}

function runTaskPhase(task, phase, runner) {
  const controller = startTaskRun(task);
  Promise.resolve()
    .then(() => runner(task))
    .catch((error) => {
      if (isPauseError(error) && taskRunControllers.get(task.id) !== controller) return;
      failTask(task, phase, error);
    })
    .finally(() => finishTaskRun(task, controller));
}

function failTask(task, phase, error) {
  if (task.deletedAt) return;
  if (isSupersededError(error)) return;
  if (isPauseError(error)) {
    if (task.status !== "paused") pauseTask(task);
    return;
  }
  task.status = "failed";
  task.failure = {
    phase,
    message: error?.message || "运行失败",
    at: now()
  };
  task.steps = task.steps.map((step) =>
    step.status === "running" ? { ...step, status: "failed", finishedAt: now() } : step
  );
  log(task, `运行失败：${task.failure.message}`);
  schedulePersistTasks();
  emit("task:update", publicTask(task));
}

function resetForRetry(task) {
  task.failure = null;
  // 把 failed/running 的步骤重置回 pending,已完成步骤保留。
  task.steps = task.steps.map((step) => {
    if (step.status === "failed" || step.status === "running") {
      return { ...step, status: "pending", startedAt: null, finishedAt: null };
    }
    return step;
  });
}

function publicTask(task) {
  return {
    id: task.id,
    deletedAt: task.deletedAt || null,
    brief: task.brief,
    status: task.status,
    steps: task.steps,
    outputs: task.outputs,
    modelSettings: (task.modelSettings || modelSettings).map((item) => ({
      role: item.role,
      title: item.title,
      model: item.model,
      baseUrl: item.baseUrl,
      apiKey: item.apiKey ? "已配置" : "",
      providerType: item.providerType,
      apiFormat: item.apiFormat,
      executionMode: item.executionMode,
      profileId: item.profileId || "",
      providerName: item.providerName || "",
      searchProvider: item.searchProvider || "mock",
      searchBaseUrl: item.searchBaseUrl || "",
      searchApiKey: item.searchApiKey ? "已配置" : ""
    })),
    materials: task.materials.map((material) => ({
      id: material.id,
      name: material.name,
      category: material.category,
      kind: material.kind,
      mime: material.mime,
      sanitized: Boolean(material.sanitized),
      privacyReport: material.privacyReport || null,
      characters: material.content.length,
      createdAt: material.createdAt
    })),
    logs: task.logs,
    lockedFinal: task.lockedFinal || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function currentMaterialCategory(task, requestedCategory) {
  if (requestedCategory === "style" || requestedCategory === "content") return requestedCategory;
  return task.status === "needs_style" ? "style" : "content";
}

function continuationPlan(task) {
  const shouldRunWorkflow = task.status === "created" || stepNeedsRun(task, "material-request");
  const hasStyleMaterials = task.materials.some((item) => item.category === "style");
  const runner = shouldRunWorkflow
    ? runWorkflow
    : task.status === "needs_style" || task.status === "needs_revision_review" || hasStyleMaterials
      ? continueAfterStyleMaterials
      : continueAfterContentMaterials;
  return {
    runner,
    phase: shouldRunWorkflow ? "workflow" : runner === continueAfterStyleMaterials ? "style" : "content"
  };
}

function emptyExtractedMaterials(reason = "用户选择跳过事实材料补充。") {
  return {
    facts: [],
    cases: [],
    numbers: [],
    phrases: [],
    constraints: ["未补充事实材料，正文不得编造具体数据、案例、文件名称或工作成效。"],
    liveText: reason
  };
}

function defaultStylePrompt(reason = "用户选择跳过文风参考材料。") {
  return {
    tone: "稳妥、准确、正式，符合机关公文和讲话材料常用表达。",
    structure: ["按主题和大纲自然展开", "段落层次清楚", "观点后接工作要求或待补充事实"],
    expressionRules: ["不使用夸张化表述", "不编造数据和案例", "涉及具体事实时明确提示待用户补充"],
    phraseBank: ["坚持问题导向", "突出工作闭环", "强化责任落实", "注重实际成效"],
    prompt: `${reason} 请使用稳妥正式的机关材料文风起草；只依据写作要求、大纲和已提供信息，不得编造具体数据、案例、文件名称或领导指示。缺少事实支撑的位置请用“待补充”提示。`
  };
}

function parseMaterialRequestsFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || raw.match(/\[[\s\S]*\]/)?.[0] || raw;
  try {
    const parsed = JSON.parse(jsonMatch);
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.requests) ? parsed.requests : [];
    return items
      .map((item, index) => ({
        type: compactText(item.type || item.title || item.name || `补充材料 ${index + 1}`).slice(0, 40),
        prompt: compactText(item.prompt || item.description || item.requirement || item.reason || "").slice(0, 240)
      }))
      .filter((item) => item.type && item.prompt);
  } catch {
    return [];
  }
}

function latestModelWarning(task, role, purpose) {
  return (task.outputs.modelCallWarnings || []).find((warning) =>
    warning.role === role && (!purpose || warning.purpose === purpose)
  );
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function taskWait(task, ms) {
  ensureTaskActive(task);
  await wait(ms);
  ensureTaskActive(task);
}

async function runWorkflow(task) {
  refreshTaskModelSettings(task);
  task.status = "running";
  emit("task:update", publicTask(task));

  if (stepNeedsRun(task, "parallel-thinking")) {
    updateStep(task, "parallel-thinking", { status: "running", startedAt: now() });
    log(task, "三个 Agent 已开始并行构思。");
    const thinkingPrompt = `写作要求：${JSON.stringify(task.brief, null, 2)}
请围绕当前写作主题输出一份完整、可执行的写作构思，不要泛泛而谈，不要套用无关单位或无关场景。
输出要求：
1. 字数不少于 800 个中文字符。
2. 必须紧扣材料类型、主题、使用场景、受众、单位背景、关键词和背景补充。
3. 至少包含【写作主线】【结构建议】【事实材料需求】【风险点】【下一步建议】五个部分。
4. 如果材料主题涉及具体业务，请把业务环节拆开讲清楚，避免只写宏观口号。
5. 不得编造具体数据、文件名称、案例细节；需要补充的内容请明确列为“待用户补充”。${outputFeedbackHint(task, "parallel-thinking", "三 Agent 并行构思")}`;
    const liveIdeas = await Promise.all([
      maybeCallRole(task, "thinkChief", "构思", thinkingPrompt),
      maybeCallRole(task, "thinkGemini", "构思", thinkingPrompt),
      maybeCallRole(task, "thinkDeepseek", "构思", thinkingPrompt)
    ]);
    await taskWait(task, 300);
    task.outputs.agentIdeas = makeAgentIdeas(task.brief, task.modelSettings);
    liveIdeas.forEach((text, index) => {
      if (text) task.outputs.agentIdeas[index].core_thesis = text;
    });
    updateStep(task, "parallel-thinking", { status: "done", finishedAt: now() });
    log(task, "三个 Agent 已完成思路输出。", "multi-agent");
  }

  if (stepNeedsRun(task, "synthesis")) {
    updateStep(task, "synthesis", { status: "running", startedAt: now() });
    const synthesisText = await maybeCallRole(
      task,
      "synthesis",
      "思路汇总",
      `请汇总取舍三名 Agent 的构思，保留高质量思路、删除低质量点位，并形成最终写作主线。\n${JSON.stringify(task.outputs.agentIdeas, null, 2)}${auditFeedbackHint(task, "三 Agent 并行构思")}${outputFeedbackHint(task, "synthesis", "GPT 汇总思路")}`
    );
    await taskWait(task, 250);
    task.outputs.synthesis = {
      retained: ["政策逻辑", "工作闭环", "典型案例", "成效数据"],
      merged: ["将宏观背景与本单位实践合并为“部署要求转化为落实成效”的主线"],
      removed: ["过度口号化、缺少事实支撑的表达"],
      finalThesis: synthesisText || `围绕“${briefLabel(task.brief)}”，突出部署有依据、推进有机制、落实有成效、提升有方向。`,
      searchKeywords: [task.brief.theme, task.brief.materialType, "高质量发展", "会议精神", task.brief.orgContext].filter(Boolean)
    };
    updateStep(task, "synthesis", { status: "done", finishedAt: now() });
    log(task, `${modelName(task.modelSettings, "synthesis")} 已完成思路取舍和主线归纳。`, modelName(task.modelSettings, "synthesis"));
  }

  if (stepNeedsRun(task, "research")) {
    updateStep(task, "research", { status: "running", startedAt: now() });
    const researchText = await maybeCallRole(
      task,
      "research",
      "检索资料建议",
      `请根据写作主线生成联网检索计划：需要搜索哪些领导讲话、会议精神、文件通知、政策关键词，并说明每类资料的用途。\n${task.outputs.synthesis.finalThesis}${outputFeedbackHint(task, "research", "联网资料检索")}`
    );
    await taskWait(task, 250);
    task.outputs.researchCards = makeResearchCards(task.brief, task.outputs.synthesis);
    const search = await runWebSearch(task, task.outputs.synthesis.searchKeywords || [], settingFor, (msg, who) => log(task, msg, who));
    if (search.results.length) {
      const liveCards = search.results.map((hit) => ({
        id: randomUUID(),
        title: hit.title,
        source: hit.source,
        url: hit.url,
        publishedAt: hit.publishedAt || "",
        summary: hit.summary,
        usablePoints: [],
        relation: `关键词“${hit.keyword}”真实搜索结果。`,
        provider: search.provider
      }));
      task.outputs.researchCards = [...liveCards, ...task.outputs.researchCards.map((card) => ({ ...card, url: card.url || "" }))];
      log(task, `已通过 ${search.provider} 联网获取 ${liveCards.length} 条资料。`, search.provider);
    } else if (task.modelSettings.find((item) => item.role === "research")?.searchProvider && task.modelSettings.find((item) => item.role === "research").searchProvider !== "mock" && task.modelSettings.find((item) => item.role === "research").executionMode === "live") {
      log(task, "联网搜索已启用但未返回结果,已回退到模拟资料卡。", "search");
    }
    if (researchText) task.outputs.researchCards.unshift({
      id: randomUUID(),
      title: `${modelName(task.modelSettings, "research")} 检索计划`,
      source: "真实模型输出",
      url: "",
      publishedAt: now(),
      summary: researchText.slice(0, 900),
      usablePoints: ["按该检索计划接入真实搜索源后可回填 URL、来源和发布时间"],
      relation: "用于指导联网检索和资料筛选。"
    });
    updateStep(task, "research", { status: "done", finishedAt: now() });
    log(task, search.results.length ? "联网搜索结果已并入资料卡。" : "资料检索已生成来源卡片。真实搜索可在设置中切换 Provider。", modelName(task.modelSettings, "research"));
  }

  if (stepNeedsRun(task, "dual-outline")) {
    updateStep(task, "dual-outline", { status: "running", startedAt: now() });
    const outlinePrompt = `请根据写作主线和资料卡片搭建文章大纲，至少包括一级标题、二级标题和每段写作点位。\n主线：${task.outputs.synthesis.finalThesis}\n资料：${JSON.stringify(task.outputs.researchCards, null, 2)}${outputFeedbackHint(task, "dual-outline", "双模型大纲")}`;
    const [geminiOutlineText, deepseekOutlineText] = await Promise.all([
      maybeCallRole(task, "outlineGemini", "大纲搭建", outlinePrompt),
      maybeCallRole(task, "outlineDeepseek", "大纲搭建", outlinePrompt)
    ]);
    await taskWait(task, 250);
    task.outputs.outlineCandidates = [
      makeOutline(task.brief, "gemini", task.modelSettings),
      makeOutline(task.brief, "deepseek", task.modelSettings)
    ];
    if (geminiOutlineText) task.outputs.outlineCandidates[0].liveText = geminiOutlineText;
    if (deepseekOutlineText) task.outputs.outlineCandidates[1].liveText = deepseekOutlineText;
    updateStep(task, "dual-outline", { status: "done", finishedAt: now() });
    log(task, "Gemini 与 deepseek 已分别完成大纲方案。", "outline-agents");
  }

  if (stepNeedsRun(task, "final-outline")) {
    updateStep(task, "final-outline", { status: "running", startedAt: now() });
    const finalOutlineText = await maybeCallRole(
      task,
      "finalOutline",
      "定稿大纲",
      `请综合两个大纲方案，形成定稿大纲，并列出每个小段要写的点位。\n${JSON.stringify(task.outputs.outlineCandidates, null, 2)}${auditFeedbackHint(task, "双模型大纲")}${outputFeedbackHint(task, "final-outline", "定稿大纲")}`
    );
    await taskWait(task, 250);
    task.outputs.finalOutline = {
      model: modelName(task.modelSettings, "finalOutline"),
      title: `${briefLabel(task.brief)}定稿大纲`,
      sections: task.outputs.outlineCandidates[0].sections,
      guardrails: ["标题层级保持三段式", "每个观点必须对应事实或资料来源", "数据类表述进入正文前需人工确认"],
      liveText: finalOutlineText || ""
    };
    updateStep(task, "final-outline", { status: "done", finishedAt: now() });
    log(task, `${modelName(task.modelSettings, "finalOutline")} 已汇总形成定稿大纲。`, modelName(task.modelSettings, "finalOutline"));
  }

  if (stepNeedsRun(task, "material-request")) {
    updateStep(task, "material-request", { status: "running", startedAt: now() });
    delete task.outputs.materialRequestFailure;
    const materialRequestText = await maybeCallRole(
      task,
      "factExtractor",
      "补充材料清单",
      `请根据以下信息动态生成用户需要补充的事实素材清单。

【写作要求】
${JSON.stringify(task.brief, null, 2)}

【最终写作主线】
${task.outputs.synthesis?.finalThesis || ""}

【定稿大纲】
${JSON.stringify(task.outputs.finalOutline || {}, null, 2)}

请只输出 JSON，不要输出解释文字。格式必须是数组：
[
  {"type":"材料类别名称","prompt":"请用户补充什么内容、用于支撑大纲中的哪个部分、注意哪些核验要求"}
]

要求：
1. 生成 3-6 项，必须紧扣当前主题、材料类型、受众、使用场景和大纲。
2. 不要使用固定模板，不要泛泛写“成效数据、典型案例”等通用项，除非确实与本大纲相关。
3. 每项 prompt 要具体到用户能直接照着准备材料。
4. 不得编造事实、数据、文件名或案例。`
    );
    const dynamicRequests = parseMaterialRequestsFromText(materialRequestText);
    if (!dynamicRequests.length) {
      const warning = latestModelWarning(task, "factExtractor", "补充材料清单");
      task.outputs.materialRequests = [];
      task.outputs.materialRequestFailure = {
        message: warning?.message || (materialRequestText ? "模型已返回内容，但不是可解析的材料清单 JSON。" : "模型未生成补充材料清单。"),
        model: modelName(task.modelSettings, "factExtractor"),
        createdAt: now()
      };
      updateStep(task, "material-request", { status: "failed", finishedAt: now() });
      task.status = "needs_materials";
      log(task, `补充材料清单生成失败：${task.outputs.materialRequestFailure.message}`, modelName(task.modelSettings, "factExtractor"));
      emit("task:update", publicTask(task));
      return;
    }
    task.outputs.materialRequests = dynamicRequests;
    task.outputs.liveModelNotes ||= {};
    task.outputs.liveModelNotes.materialRequest = {
      purpose: "补充材料清单",
      model: modelName(task.modelSettings, "factExtractor"),
      text: materialRequestText
    };
    updateStep(task, "material-request", { status: "done", finishedAt: now() });
    // 如果事实材料已存在,保持后续步骤不重置;否则回到 needs_user。
    const hasContent = task.materials.some((item) => item.category === "content");
    if (!hasContent) {
      updateStep(task, "materials", { status: "needs_user" });
      task.status = "needs_materials";
    }
    log(task, hasContent ? "动态补充材料清单已生成,材料已存在,可继续推进。" : "动态补充材料清单已生成，请补充事实材料后继续生成正文。", modelName(task.modelSettings, "factExtractor"));
  }

  if (task.status === "running") {
    // 走完全部 workflow 且材料已在:进入需要后续操作的中间状态。
    const hasContent = task.materials.some((item) => item.category === "content");
    if (!hasContent) {
      task.status = "needs_materials";
    }
  }
  emit("task:update", publicTask(task));
}

async function continueAfterContentMaterials(task) {
  refreshTaskModelSettings(task);
  const contentMaterials = task.materials.filter((material) => material.category === "content");
  const skipContentMaterials = Boolean(task.outputs.skipContentMaterials);
  if (!contentMaterials.length && !skipContentMaterials) {
    throw new Error("请先上传或粘贴至少一份参考材料。");
  }
  task.status = "running";
  updateStep(task, "materials", { status: "done", finishedAt: now() });

  if (stepNeedsRun(task, "extract")) {
    updateStep(task, "extract", { status: "running", startedAt: now() });
    if (contentMaterials.length) {
      log(task, `${modelName(task.modelSettings, "factExtractor")} 开始提炼用户补充材料。`, modelName(task.modelSettings, "factExtractor"));
      const extractionText = await maybeCallRole(
        task,
        "factExtractor",
        "事实素材提炼",
        `请从用户补充材料中提炼可用于正文的事实、案例、数据、工作做法和需要人工核验的风险。\n${contentMaterials.map((item) => `【${item.name}】\n${item.content}`).join("\n\n")}${outputFeedbackHint(task, "extract", "事实素材提炼")}`
      );
      task.outputs.extractedMaterials = extractMaterials(contentMaterials);
      if (extractionText) task.outputs.extractedMaterials.liveText = extractionText;
    } else {
      task.outputs.extractedMaterials = emptyExtractedMaterials();
      log(task, "用户选择跳过事实材料补充，已使用空素材约束继续推进。");
    }
    updateStep(task, "extract", { status: "done", finishedAt: now() });
  }

  // 如果文风材料尚未提供,转入 needs_style;已有则直接走文风后续阶段。
  const hasStyle = task.materials.some((item) => item.category === "style");
  if (!hasStyle && !task.outputs.skipStyleMaterials) {
    updateStep(task, "style-materials", {
      status: "needs_user",
      startedAt: now(),
      description: "请上传或粘贴希望模仿的文风、语气、标题和表述形式参考材料"
    });
    task.status = "needs_style";
    log(task, "事实要点已提炼完成。请继续补充文风参考材料。", modelName(task.modelSettings, "factExtractor"));
    emit("task:update", publicTask(task));
    return;
  }
  // 文风材料已存在,直接调用 style runner。
  await continueAfterStyleMaterials(task);
}

async function continueAfterStyleMaterials(task) {
  refreshTaskModelSettings(task);
  const styleMaterials = task.materials.filter((material) => material.category === "style");
  const skipStyleMaterials = Boolean(task.outputs.skipStyleMaterials);
  if (!styleMaterials.length && !skipStyleMaterials) {
    throw new Error("请先上传或粘贴至少一份文风参考材料。");
  }
  task.status = "running";
  updateStep(task, "style-materials", { status: "done", finishedAt: now() });

  if (stepNeedsRun(task, "style-extract")) {
    updateStep(task, "style-extract", { status: "running", startedAt: now() });
    if (styleMaterials.length) {
      log(task, `${modelName(task.modelSettings, "styleExtractor")} 开始总结文风和表述形式。`, modelName(task.modelSettings, "styleExtractor"));
      const styleText = await maybeCallRole(
        task,
        "styleExtractor",
        "文风提炼",
        `请分析这些文风参考材料，总结语气、标题方式、段落结构、常用表达、禁忌，并归纳成可交给起草模型使用的提示词。\n${styleMaterials.map((item) => `【${item.name}】\n${item.content}`).join("\n\n")}${outputFeedbackHint(task, "style-extract", "文风提炼")}`
      );
      task.outputs.stylePrompt = extractStylePrompt(styleMaterials, task.modelSettings);
      if (styleText) task.outputs.stylePrompt.prompt = styleText;
    } else {
      task.outputs.stylePrompt = defaultStylePrompt();
      log(task, "用户选择跳过文风参考材料，已使用通用机关材料文风继续起草。");
    }
    updateStep(task, "style-extract", { status: "done", finishedAt: now() });
    log(task, `${modelName(task.modelSettings, "styleExtractor")} 已形成文风提示词，准备交给 ${modelName(task.modelSettings, "drafter")} 起草。`, modelName(task.modelSettings, "styleExtractor"));
  }

  if (stepNeedsRun(task, "draft")) {
    updateStep(task, "draft", { status: "running", startedAt: now() });
    const draftText = await maybeCallRole(
      task,
      "drafter",
      "初稿撰写",
      `请根据定稿大纲、事实素材和文风提示词撰写完整初稿。只使用已提供事实，不要编造数据。\n定稿大纲：${JSON.stringify(task.outputs.finalOutline, null, 2)}\n事实素材：${JSON.stringify(task.outputs.extractedMaterials, null, 2)}\n文风提示词：${task.outputs.stylePrompt.prompt}${auditFeedbackHint(task, "事实素材提炼", "文风提炼", "定稿大纲")}${outputFeedbackHint(task, "draft", "Gemini 起草")}`
    );
    task.outputs.drafts = task.outputs.drafts || {};
    task.outputs.drafts.initial = draftText || renderDraft(task);
    pushDraftVersion(task, "initial", task.outputs.drafts.initial);
    updateStep(task, "draft", { status: "done", finishedAt: now() });
    log(task, `${modelName(task.modelSettings, "drafter")} 已完成初稿。`, modelName(task.modelSettings, "drafter"));
  }

  if (stepNeedsRun(task, "revise")) {
    updateStep(task, "revise", { status: "running", startedAt: now() });
    const pendingComments = Array.isArray(task.outputs.pendingRevisionComments) ? task.outputs.pendingRevisionComments : [];
    const reviseRole = pendingComments.length ? "drafter" : "reviser";
    const revisePurpose = pendingComments.length ? "按批注修改" : "修改完善";
    const revisePrompt = pendingComments.length
      ? `请根据用户对修改稿的批注，对对应位置进行修改、补充或完善，直接输出更新后的完整修改稿。不得进入最终定稿，不得忽略未涉及部分。

【用户批注】
${formatRevisionReview({ comments: pendingComments, submittedAt: now() })}

【当前修改稿】
${task.outputs.drafts.revised || task.outputs.drafts.initial}`
      : `请对以下初稿进行修改完善，重点检查逻辑是否顺畅、政策口径是否稳妥、表述是否精准，直接输出修改后的全文。\n${task.outputs.drafts.initial}${auditFeedbackHint(task, "Gemini 起草")}${outputFeedbackHint(task, "revise", "GPT 修改完善")}`;
    const revisedText = await maybeCallRole(task, reviseRole, revisePurpose, revisePrompt);
    if (pendingComments.length && !revisedText) {
      throw new Error("按批注修改失败：起草 Agent 未返回更新后的修改稿。");
    }
    task.outputs.drafts.revised = revisedText || reviseDraft(task.outputs.drafts.initial);
    delete task.outputs.revisionReview;
    delete task.outputs.pendingRevisionComments;
    pushDraftVersion(task, "revised", task.outputs.drafts.revised, modelName(task.modelSettings, reviseRole));
    updateStep(task, "revise", { status: "done", finishedAt: now() });
    log(task, pendingComments.length ? `${modelName(task.modelSettings, reviseRole)} 已按用户批注更新修改稿。` : `${modelName(task.modelSettings, "reviser")} 已完成逻辑和表述修改。`, modelName(task.modelSettings, reviseRole));
  }

  if (!revisionReviewSubmitted(task)) {
    updateStep(task, "user-review", {
      status: "needs_user",
      startedAt: now(),
      description: "请在修改稿上标注需要调整的位置和意见，提交后再生成最终定稿"
    });
    task.status = "needs_revision_review";
    log(task, "修改稿已生成，请用户批注确认后继续定稿。", modelName(task.modelSettings, "reviser"));
    emit("task:update", publicTask(task));
    return;
  }
  updateStep(task, "user-review", { status: "done", finishedAt: now() });

  if (stepNeedsRun(task, "proofread")) {
    updateStep(task, "proofread", { status: "running", startedAt: now() });
    const revisionReviewHint = formatRevisionReview(task.outputs.revisionReview);
    const finalText = await maybeCallRole(
      task,
      "proofreader",
      "校对纠错",
      `请根据用户对修改稿的批注进行最后完善，并完成错别字、标点、格式和明显语病校对。直接输出最终定稿全文，不要额外编造事实。\n用户批注：\n${revisionReviewHint}\n\n修改稿：\n${task.outputs.drafts.revised}${auditFeedbackHint(task, "GPT 修改完善")}${outputFeedbackHint(task, "proofread", "deepseek 校对")}`
    );
    const incomingFinal = finalText || proofreadDraft(task.outputs.drafts.revised);
    if (task.lockedFinal?.text) {
      task.outputs.drafts.final = task.lockedFinal.text;
      pushDraftVersion(task, "final", incomingFinal, `${modelName(task.modelSettings, "proofreader")} · 锁定期间新产出`);
      log(task, "定稿处于锁定状态,本轮新产出已保留到历史,不覆盖锁定版。", modelName(task.modelSettings, "proofreader"));
    } else {
      task.outputs.drafts.final = incomingFinal;
      pushDraftVersion(task, "final", task.outputs.drafts.final);
    }
    updateStep(task, "proofread", { status: "done", finishedAt: now() });
    log(task, `${modelName(task.modelSettings, "proofreader")} 已完成校对。`, modelName(task.modelSettings, "proofreader"));
  }

  if (stepNeedsRun(task, "export")) {
    updateStep(task, "export", { status: "running", startedAt: now() });
    await mkdir(projectsDir, { recursive: true });
    const fileName = `${task.id}.md`;
    const filePath = join(projectsDir, fileName);
    await writeFile(filePath, task.outputs.drafts.final, "utf8");
    const docxFileName = `${task.id}.docx`;
    const docxFilePath = join(projectsDir, docxFileName);
    await writeFile(docxFilePath, await createDocxBuffer(task.outputs.drafts.final));
    task.outputs.export = { fileName, filePath, docxFileName, docxFilePath };
    schedulePersistTasks();
    updateStep(task, "export", { status: "done", finishedAt: now() });
  }
  task.status = "done";
  log(task, "定稿已生成，可下载 Markdown 文件。");
  emit("task:update", publicTask(task));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(req, res, 200, {
        ok: true,
        app: "gongwen-writer-worker",
        version: "0.1.0",
        at: now()
      });
      return;
    }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...corsHeaders(req)
      });
      clients.add(res);
      res.write(`event: ready\ndata: {"ok":true}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (url.pathname === "/api/tasks" && req.method === "GET") {
      sendJson(req, res, 200, [...tasks.values()].map(publicTask).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      return;
    }

    if (url.pathname === "/api/settings/models" && req.method === "GET") {
      sendJson(req, res, 200, publicModelSettings());
      return;
    }

    if (url.pathname === "/api/settings/models" && req.method === "PUT") {
      const body = await readBody(req);
      // 前端的 apiKey/searchApiKey 是占位符 "已配置",表示用户没改这一项。需要从已有设置里补回来,避免保存后被清空。
      const incomingItems = Array.isArray(body) ? body : [];
      const restored = incomingItems.map(restoreSettingSecrets);
      modelSettings = mergeModelSettings(restored);
      await saveModelSettings(modelSettings);
      syncOpenTasksModelSettings();
      sendJson(req, res, 200, publicModelSettings());
      return;
    }

    if (url.pathname === "/api/settings/models/test" && req.method === "POST") {
      const body = await readBody(req);
      const result = await testModelSetting(restoreSettingSecrets(body));
      sendJson(req, res, 200, result);
      return;
    }

    if (url.pathname === "/api/settings/models/list" && req.method === "POST") {
      const body = await readBody(req);
      const result = await listAvailableModels(restoreSettingSecrets(body));
      sendJson(req, res, 200, result);
      return;
    }

    const sanitizerSettingMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/sanitizer-setting$/);
    if (sanitizerSettingMatch && req.method === "PUT") {
      const task = tasks.get(sanitizerSettingMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      const sanitizerSetting = sanitizerSettingFromPayload(body);
      task.modelSettings = mergeModelSettings(task.modelSettings || modelSettings).map((item) =>
        item.role === "sanitizer" ? sanitizerSetting : item
      );
      task.updatedAt = now();
      log(task, `入库前脱敏模型已切换为 ${sanitizerSetting.providerName || sanitizerSetting.providerType} · ${sanitizerSetting.model}。`);
      schedulePersistTasks();
      emit("task:update", publicTask(task));
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    if (url.pathname === "/api/tasks" && req.method === "POST") {
      const body = await readBody(req);
      const id = randomUUID();
      const task = {
        id,
        brief: body,
        status: "created",
        steps: createSteps(),
        outputs: {},
        modelSettings: JSON.parse(JSON.stringify(modelSettings)),
        materials: [],
        logs: [],
        createdAt: now(),
        updatedAt: now()
      };
      tasks.set(id, task);
      log(task, "写作任务已创建。");
      sendJson(req, res, 201, publicTask(task));
      runTaskPhase(task, "workflow", runWorkflow);
      return;
    }

    const briefMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/brief$/);
    if (briefMatch && req.method === "PUT") {
      const task = tasks.get(briefMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      task.brief = { ...task.brief, ...body };
      task.updatedAt = now();
      log(task, "写作要求已更新。");
      schedulePersistTasks();
      emit("task:update", publicTask(task));
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    const renameMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/rename$/);
    if (renameMatch && req.method === "PUT") {
      const task = tasks.get(renameMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      const nextTheme = String(body.theme || "").trim().slice(0, 80);
      if (!nextTheme) {
        sendJson(req, res, 400, { error: "新名称不能为空" });
        return;
      }
      const previous = task.brief?.theme || task.brief?.materialType || "未命名材料";
      task.brief = { ...task.brief, theme: nextTheme };
      task.updatedAt = now();
      log(task, `任务名称已从“${previous}”改为“${nextTheme}”。`);
      schedulePersistTasks();
      emit("task:update", publicTask(task));
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    const duplicateMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/duplicate$/);
    if (duplicateMatch && req.method === "POST") {
      const source = tasks.get(duplicateMatch[1]);
      if (!source) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      // 复制:继承 brief 和写作要求需要的模型快照,重置流程/产出/材料/日志。
      const nextId = randomUUID();
      const inheritedBrief = {
        ...source.brief,
        theme: `${source.brief?.theme || source.brief?.materialType || "公文任务"} · 副本`
      };
      const newTask = {
        id: nextId,
        brief: inheritedBrief,
        status: "created",
        steps: createSteps(),
        outputs: {},
        modelSettings: JSON.parse(JSON.stringify(source.modelSettings || modelSettings)),
        materials: [],
        logs: [],
        failure: null,
        createdAt: now(),
        updatedAt: now()
      };
      tasks.set(nextId, newTask);
      log(newTask, `已从“${source.brief?.theme || source.brief?.materialType || source.id}”复制创建任务。`);
      sendJson(req, res, 201, publicTask(newTask));
      runTaskPhase(newTask, "workflow", runWorkflow);
      return;
    }

    const lockMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/lock$/);
    if (lockMatch && req.method === "POST") {
      const task = tasks.get(lockMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const finalText = task.outputs?.drafts?.final;
      if (!finalText) {
        sendJson(req, res, 400, { error: "当前没有可锁定的定稿。" });
        return;
      }
      task.lockedFinal = {
        text: finalText,
        lockedAt: now(),
        stage: "final"
      };
      task.updatedAt = now();
      log(task, "已锁定当前定稿,后续重跑不会覆盖。");
      schedulePersistTasks();
      emit("task:update", publicTask(task));
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    if (lockMatch && req.method === "DELETE") {
      const task = tasks.get(lockMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      if (!task.lockedFinal) {
        sendJson(req, res, 400, { error: "当前没有锁定的定稿。" });
        return;
      }
      task.lockedFinal = null;
      task.updatedAt = now();
      log(task, "已解锁定稿,后续重跑将覆盖。");
      schedulePersistTasks();
      emit("task:update", publicTask(task));
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    const rerunMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/rerun$/);
    if (rerunMatch && req.method === "POST") {
      const task = tasks.get(rerunMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      const stepId = String(body.stepId || "");
      const plan = RERUN_PLANS[stepId];
      if (!plan) {
        sendJson(req, res, 400, { error: "该阶段不支持单独重跑。" });
        return;
      }
      // content/style 阶段依赖前置材料,先核验。
      if (plan.phase === "content" && !task.materials.some((item) => item.category === "content")) {
        sendJson(req, res, 400, { error: "事实材料为空,无法重跑事实阶段。" });
        return;
      }
      if (plan.phase === "style" && !task.materials.some((item) => item.category === "style")) {
        sendJson(req, res, 400, { error: "文风材料为空,无法重跑文风及后续阶段。" });
        return;
      }
      // 找到起点步骤的下标,把它及之后的非用户步骤重置为 pending。
      const startIdx = task.steps.findIndex((step) => step.id === plan.fromStep);
      if (startIdx < 0) {
        sendJson(req, res, 400, { error: "未找到起点步骤。" });
        return;
      }
      task.steps = task.steps.map((step, idx) => {
        if (idx < startIdx) return step;
        if (step.id === "materials" || step.id === "style-materials") {
          // 这两个步骤是用户上传节点,保持其最终状态(done/needs_user)。
          return step;
        }
        return { ...step, status: "pending", startedAt: null, finishedAt: null };
      });
      task.failure = null;
      refreshTaskModelSettings(task);
      task.status = "running";
      log(task, `阶段重跑:从“${stepId}”开始。`);
      schedulePersistTasks();
      emit("task:update", publicTask(task));
      sendJson(req, res, 202, publicTask(task));

      const runner = plan.phase === "style"
        ? continueAfterStyleMaterials
        : plan.phase === "content"
          ? continueAfterContentMaterials
          : runWorkflow;
      runTaskPhase(task, plan.phase, runner);
      return;
    }

    const taskDeleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskDeleteMatch && req.method === "DELETE") {
      const task = tasks.get(taskDeleteMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      task.deletedAt = now();
      tasks.delete(task.id);
      // 清理导出文件,失败也不影响流程。
      const exportInfo = task.outputs?.export;
      if (exportInfo?.filePath) await rm(exportInfo.filePath, { force: true }).catch(() => {});
      if (exportInfo?.docxFilePath) await rm(exportInfo.docxFilePath, { force: true }).catch(() => {});
      schedulePersistTasks();
      emit("task:delete", { id: task.id });
      sendJson(req, res, 200, { ok: true, id: task.id });
      return;
    }

    const materialDeleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/materials\/([^/]+)$/);
    if (materialDeleteMatch && req.method === "DELETE") {
      const task = tasks.get(materialDeleteMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const before = task.materials.length;
      task.materials = task.materials.filter((item) => item.id !== materialDeleteMatch[2]);
      if (task.materials.length === before) {
        sendJson(req, res, 404, { error: "材料不存在" });
        return;
      }
      task.updatedAt = now();
      log(task, "已删除一份参考材料。");
      schedulePersistTasks();
      emit("task:update", publicTask(task));
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    const logDeleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/logs$/);
    if (logDeleteMatch && req.method === "DELETE") {
      const task = tasks.get(logDeleteMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? new Set(body.ids.map((id) => String(id))) : new Set();
      if (!ids.size) {
        sendJson(req, res, 400, { error: "请选择要删除的日志。" });
        return;
      }
      task.logs = task.logs.filter((item) => !ids.has(item.id));
      task.updatedAt = now();
      schedulePersistTasks();
      emit("task:update", publicTask(task));
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    const manualAuditMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/audits$/);
    if (manualAuditMatch && req.method === "POST") {
      const task = tasks.get(manualAuditMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      const sourceStep = compactText(body.sourceStep || body.targetTitle || "AI 生成内容");
      const content = typeof body.content === "string" ? body.content.trim() : JSON.stringify(body.content || "", null, 2);
      if (!content.trim()) {
        sendJson(req, res, 400, { error: "没有可审计的生成内容。" });
        return;
      }
      try {
        const audit = await auditGeneratedContent(task, sourceStep, content);
        sendJson(req, res, 200, { task: publicTask(task), audit });
      } catch (error) {
        if (isPauseError(error)) {
          sendJson(req, res, 409, { error: "任务已暂停，审计已中止。" });
          return;
        }
        sendJson(req, res, 500, { error: error?.message || "审计失败" });
      }
      return;
    }

    const auditFeedbackMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/audits\/([^/]+)\/feedback$/);
    if (auditFeedbackMatch && req.method === "POST") {
      const task = tasks.get(auditFeedbackMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const audit = (task.outputs.qualityAudits || []).find((item) => item.id === auditFeedbackMatch[2]);
      if (!audit) {
        sendJson(req, res, 404, { error: "审计记录不存在" });
        return;
      }
      const body = await readBody(req);
      audit.feedback ||= [];
      audit.feedback.unshift({
        id: randomUUID(),
        opinion: String(body.opinion || "").trim(),
        createdAt: now()
      });
      task.updatedAt = now();
      log(task, `已记录“${audit.sourceStep}”审计反馈意见。`);
      schedulePersistTasks();
      emit("task:update", publicTask(task));
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    const outputFeedbackMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/output-feedback$/);
    if (outputFeedbackMatch && req.method === "POST") {
      const task = tasks.get(outputFeedbackMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      const status = body.status === "approved" ? "approved" : "comment";
      const opinion = compactText(body.opinion || "");
      if (status !== "approved" && !opinion) {
        sendJson(req, res, 400, { error: "请先填写修改意见。" });
        return;
      }
      const item = {
        id: randomUUID(),
        targetId: String(body.targetId || "").slice(0, 160),
        targetTitle: String(body.targetTitle || "").slice(0, 160),
        stepId: String(body.stepId || "").slice(0, 80),
        sourceStep: String(body.sourceStep || "").slice(0, 120),
        role: String(body.role || "").slice(0, 80),
        status,
        opinion,
        createdAt: now()
      };
      task.outputs.outputFeedback ||= [];
      task.outputs.outputFeedback.unshift(item);
      task.outputs.outputFeedback = task.outputs.outputFeedback.slice(0, 300);
      task.updatedAt = now();
      log(task, status === "approved" ? `已确认“${item.targetTitle || item.sourceStep || item.stepId}”无修改意见。` : `已记录“${item.targetTitle || item.sourceStep || item.stepId}”修改意见。`);
      schedulePersistTasks();
      emit("task:update", publicTask(task));
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    const materialMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/materials$/);
    if (materialMatch && req.method === "POST") {
      const task = tasks.get(materialMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      const category = currentMaterialCategory(task, body.category);
      const material = await prepareMaterialForStorage(task, {
        id: randomUUID(),
        name: body.name || "粘贴材料",
        category,
        kind: "pasted-text",
        mime: "text/plain",
        content: body.content || "",
        createdAt: now()
      }, body.sanitize !== false);
      task.materials.push(material);
      log(task, `已接收${category === "style" ? "文风" : "事实"}参考材料：${body.name || "粘贴材料"}${material.sanitized ? "，已完成入库前脱敏" : "，未脱敏"}`);
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    const uploadMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/materials\/upload$/);
    if (uploadMatch && req.method === "POST") {
      const task = tasks.get(uploadMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      const category = currentMaterialCategory(task, body.category);
      log(task, `正在识别${category === "style" ? "文风" : "事实"}参考材料：${body.name || "上传文件"}`);
      let material = await extractUploadedMaterial(body);
      material.category = category;
      material = await prepareMaterialForStorage(task, material, body.sanitize !== false);
      task.materials.push(material);
      log(task, `已识别 ${material.name}，类型：${material.kind}，提取 ${material.content.length} 字${material.sanitized ? "，已完成入库前脱敏" : "，未脱敏"}。`);
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    const revisionReviewMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/revision-review$/);
    if (revisionReviewMatch && req.method === "POST") {
      const task = tasks.get(revisionReviewMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      const comments = Array.isArray(body.comments)
        ? body.comments
          .map((item) => ({
            id: item.id || randomUUID(),
            anchor: compactText(item.anchor || ""),
            comment: compactText(item.comment || ""),
            createdAt: item.createdAt || now()
          }))
          .filter((item) => item.anchor && item.comment)
        : [];
      if (!body.skipped && !comments.length) {
        sendJson(req, res, 400, { error: "请至少添加一条批注，或选择无意见进入定稿。" });
        return;
      }
      if (body.skipped) {
        task.outputs.revisionReview = {
          comments: [],
          skipped: true,
          submittedAt: now()
        };
        updateStep(task, "user-review", { status: "done", finishedAt: now() });
        log(task, "用户确认无意见，继续生成定稿。");
      } else {
        task.outputs.pendingRevisionComments = comments;
        delete task.outputs.revisionReview;
        task.steps = task.steps.map((step) =>
          ["revise", "user-review", "proofread", "export"].includes(step.id)
            ? { ...step, status: "pending", startedAt: null, finishedAt: null }
            : step
        );
        log(task, `用户已提交 ${comments.length} 条修改稿批注，起草 Agent 将先更新修改稿。`);
      }
      task.status = "running";
      emit("task:update", publicTask(task));
      sendJson(req, res, 202, publicTask(task));
      runTaskPhase(task, "style", continueAfterStyleMaterials);
      return;
    }

    const pauseMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/pause$/);
    if (pauseMatch && req.method === "POST") {
      const task = tasks.get(pauseMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      if (task.status === "done") {
        sendJson(req, res, 400, { error: "已完成任务无需暂停。" });
        return;
      }
      if (task.status !== "paused") pauseTask(task);
      schedulePersistTasks();
      sendJson(req, res, 200, publicTask(task));
      return;
    }

    const resumeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
    if (resumeMatch && req.method === "POST") {
      const task = tasks.get(resumeMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      if (task.status !== "paused") {
        sendJson(req, res, 400, { error: "当前任务未暂停。" });
        return;
      }
      refreshTaskModelSettings(task);
      task.status = "running";
      task.updatedAt = now();
      log(task, "当前任务已恢复运行。");
      emit("task:update", publicTask(task));
      sendJson(req, res, 202, publicTask(task));
      const { runner, phase } = continuationPlan(task);
      runTaskPhase(task, phase, runner);
      return;
    }

    const continueMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/continue$/);
    if (continueMatch && req.method === "POST") {
      const task = tasks.get(continueMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      const body = await readBody(req);
      if (task.status === "failed") resetForRetry(task);
      refreshTaskModelSettings(task);
      if (body.skipMaterials) {
        if (task.status === "needs_materials") {
          task.outputs.skipContentMaterials = true;
          task.outputs.skipStyleMaterials = true;
          log(task, "用户选择跳过事实材料和文风材料，直接继续形成初稿。");
        } else if (task.status === "needs_style") {
          task.outputs.skipStyleMaterials = true;
          log(task, "用户选择跳过文风参考材料，直接继续形成初稿。");
        }
      }
      if (task.status === "needs_revision_review" && !revisionReviewSubmitted(task)) {
        task.outputs.revisionReview = { comments: [], skipped: true, submittedAt: now() };
        updateStep(task, "user-review", { status: "done", finishedAt: now() });
        log(task, "未填写批注，按当前修改稿继续定稿。");
      }
      sendJson(req, res, 202, publicTask(task));
      const { runner, phase } = continuationPlan(task);
      runTaskPhase(task, phase, runner);
      return;
    }

    const retryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/);
    if (retryMatch && req.method === "POST") {
      const task = tasks.get(retryMatch[1]);
      if (!task) {
        sendJson(req, res, 404, { error: "任务不存在" });
        return;
      }
      if (task.status !== "failed") {
        sendJson(req, res, 400, { error: "当前任务不是失败状态,无需重试。" });
        return;
      }
      const phase = task.failure?.phase || "workflow";
      resetForRetry(task);
      refreshTaskModelSettings(task);
      task.status = "running";
      log(task, `重新运行${phase === "workflow" ? "流程" : phase === "style" ? "文风后续阶段" : "事实后续阶段"}。`);
      emit("task:update", publicTask(task));
      sendJson(req, res, 202, publicTask(task));

      const runner = phase === "style"
        ? continueAfterStyleMaterials
        : phase === "content"
          ? continueAfterContentMaterials
          : runWorkflow;
      runTaskPhase(task, phase, runner);
      return;
    }

    function resolveDraftVariant(task) {
      const variant = String(url.searchParams.get("variant") || "final");
      const drafts = task?.outputs?.drafts || {};
      const picked = variant === "initial" || variant === "revised" ? drafts[variant] : drafts.final;
      return { variant: picked ? variant : "final", text: picked || drafts.final || "" };
    }

    const exportMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/export$/);
    if (exportMatch && req.method === "GET") {
      const task = tasks.get(exportMatch[1]);
      const { variant, text } = resolveDraftVariant(task);
      if (!text) {
        sendJson(req, res, 404, { error: "定稿尚未生成" });
        return;
      }
      const suffix = variant === "final" ? "" : `.${variant}`;
      const name = encodeURIComponent(`${briefLabel(task.brief)}${suffix}.md`);
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${name}`,
        ...corsHeaders(req)
      });
      res.end(text);
      return;
    }

    const exportDocxMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/export\.docx$/);
    if (exportDocxMatch && req.method === "GET") {
      const task = tasks.get(exportDocxMatch[1]);
      const { variant, text } = resolveDraftVariant(task);
      if (!text) {
        sendJson(req, res, 404, { error: "定稿尚未生成" });
        return;
      }
      const buffer = await createDocxBuffer(text);
      const suffix = variant === "final" ? "" : `.${variant}`;
      const name = encodeURIComponent(`${briefLabel(task.brief)}${suffix}.docx`);
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": `attachment; filename*=UTF-8''${name}`,
        ...corsHeaders(req)
      });
      res.end(buffer);
      return;
    }

    sendJson(req, res, 404, { error: "not found" });
  } catch (error) {
    sendJson(req, res, 500, { error: error.message || "server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Gongwen Writer worker listening on http://127.0.0.1:${PORT}`);
});
