import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bot,
  Check,
  ChevronRight,
  ClipboardCheck,
  Download,
  FileUp,
  History,
  Layers3,
  Loader2,
  Pause,
  PencilLine,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  Wand2,
  Eye,
  EyeOff,
  FileText
} from "lucide-react";
import "./styles.css";

type StepStatus = "pending" | "running" | "needs_user" | "done" | "failed" | "skipped";

type WorkflowStep = {
  id: string;
  title: string;
  status: StepStatus;
  description: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type WritingBrief = {
  materialType: string;
  theme: string;
  scene: string;
  audience: string;
  targetWords: string;
  orgContext: string;
  keywords: string;
  forbidden: string;
  background: string;
};

type Task = {
  id: string;
  brief: WritingBrief;
  status: string;
  steps: WorkflowStep[];
  outputs: Record<string, any>;
  modelSettings?: ModelSetting[];
  materials: Array<{
    id: string;
    name: string;
    category: "content" | "style";
    kind: string;
    mime: string;
    sanitized: boolean;
    privacyReport: { changed?: boolean; summary?: string } | null;
    characters: number;
    createdAt: string;
  }>;
  logs: Array<{ id: string; at: string; model: string; message: string }>;
  failure?: { phase: "workflow" | "content" | "style"; message: string; at: string } | null;
  lockedFinal?: { text: string; lockedAt: string; stage: "final" } | null;
  createdAt: string;
  updatedAt: string;
};

type ModelSetting = {
  role: string;
  title: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  providerType: "direct" | "ccSwitch" | "local";
  apiFormat: "responses" | "chatCompletions" | "gemini";
  executionMode: "mock" | "live";
  profileId?: string;
  providerName?: string;
  searchProvider?: "mock" | "tavily" | "serper" | "custom";
  searchBaseUrl?: string;
  searchApiKey?: string;
  tokenUsage?: TokenUsage;
};

type ModelTestResult = Record<string, { ok: boolean; message: string }>;
type WorkflowStage = "brief" | "thinking" | "materials" | "final";
type TokenUsage = { input: number; output: number; total: number; calls: number };
type ProviderModel = {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  inputTokenLimit?: number | null;
  outputTokenLimit?: number | null;
};
type ModelCatalogState = Record<string, { loading: boolean; message: string; models: ProviderModel[] }>;
type PendingUpload = { id: string; file: File };
type RevisionComment = { id?: string; anchor: string; comment: string; createdAt?: string };
type OutputFeedbackPayload = {
  targetId: string;
  targetTitle: string;
  stepId: string;
  sourceStep: string;
  role?: string;
  opinion?: string;
  status?: "comment" | "approved";
};

type AuditRequestPayload = {
  targetId: string;
  targetTitle: string;
  sourceStep: string;
  content: string;
};

type ModelProfile = {
  id: string;
  name: string;
  providerName: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  providerType: ModelSetting["providerType"];
  apiFormat: ModelSetting["apiFormat"];
};

function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, total: 0, calls: 0 };
}

function addTokenUsage(a: TokenUsage, b?: Partial<TokenUsage> | null): TokenUsage {
  if (!b) return a;
  return {
    input: a.input + Number(b.input || 0),
    output: a.output + Number(b.output || 0),
    total: a.total + Number(b.total || 0),
    calls: a.calls + Number(b.calls || 0)
  };
}

function formatTokenCount(value: number): string {
  if (!value) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatTokenUsage(usage?: Partial<TokenUsage> | null): string {
  return `${formatTokenCount(Number(usage?.total || 0))} tokens`;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function taskTokenUsage(task: Task | null): TokenUsage {
  const usage = task?.outputs?.tokenUsage;
  return {
    input: Number(usage?.input || 0),
    output: Number(usage?.output || 0),
    total: Number(usage?.total || 0),
    calls: Number(usage?.calls || 0)
  };
}

const emptyBrief: WritingBrief = {
  materialType: "",
  theme: "",
  scene: "",
  audience: "",
  targetWords: "",
  orgContext: "",
  keywords: "",
  forbidden: "",
  background: ""
};

const LOCAL_SANITIZER_PRESETS: ModelSetting[] = [
  {
    role: "sanitizer",
    title: "材料脱敏",
    model: "llama3.1",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    providerType: "local",
    apiFormat: "chatCompletions",
    executionMode: "live",
    profileId: "local-ollama",
    providerName: "Ollama"
  },
  {
    role: "sanitizer",
    title: "材料脱敏",
    model: "local-model",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "",
    providerType: "local",
    apiFormat: "chatCompletions",
    executionMode: "live",
    profileId: "local-lm-studio",
    providerName: "LM Studio"
  }
];

const API_BASE = import.meta.env.DEV ? "" : "http://127.0.0.1:8787";

async function waitForServer(maxWait = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`${API_BASE}/api/settings/models`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
}

const serverReady = waitForServer();

const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

type UpdateInfo = {
  version: string;
  current_version: string;
  notes: string;
};

async function tauriCheckForUpdates(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<UpdateInfo | null>("check_for_updates");
}

async function tauriInstallUpdate(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("install_update");
}

function sanitizeFileName(value: string): string {
  return String(value || "公文材料")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "公文材料";
}

async function fetchExportBlob(path: string): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || `下载失败：${response.status}`);
  }
  return await response.blob();
}

async function saveExportFile(path: string, suggestedName: string, mimeType: string): Promise<string> {
  const fileName = sanitizeFileName(suggestedName);
  const picker = (window as any).showSaveFilePicker;
  if (!isTauri && typeof picker === "function") {
    const handle = await picker({
      suggestedName: fileName,
      types: [{ description: fileName.endsWith(".docx") ? "Word 文档" : "Markdown 文档", accept: { [mimeType]: [fileName.slice(fileName.lastIndexOf("."))] } }]
    });
    const blob = await fetchExportBlob(path);
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return `已保存：${handle.name || fileName}`;
  }

  const blob = await fetchExportBlob(path);
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const savedPath = await invoke<string>("save_download_file", { fileName, bytes });
    return `已保存到：${savedPath}`;
  }

  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  return "已开始下载，文件会进入浏览器默认下载目录。";
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineHtml(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/(^|[^_])_([^_]+?)_(?!_)/g, "$1<em>$2</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  return html;
}

function buildPrintHtml(markdown: string, meta: { title: string; subtitle?: string }): string {
  const lines = String(markdown || "").split(/\r?\n/);
  const body: string[] = [];
  let listBuffer: string[] = [];
  const flushList = () => {
    if (!listBuffer.length) return;
    body.push(`<ul>${listBuffer.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    listBuffer = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushList(); continue; }
    if (line.startsWith("# ")) { flushList(); body.push(`<h1 class="doc-title">${renderInlineHtml(line.slice(2))}</h1>`); continue; }
    if (line.startsWith("## ")) { flushList(); body.push(`<h2 class="level-1">${renderInlineHtml(line.slice(3))}</h2>`); continue; }
    if (line.startsWith("### ")) { flushList(); body.push(`<h3 class="level-2">${renderInlineHtml(line.slice(4))}</h3>`); continue; }
    if (line.startsWith("> ")) { flushList(); body.push(`<blockquote>${renderInlineHtml(line.slice(2))}</blockquote>`); continue; }
    const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) { listBuffer.push(renderInlineHtml(bulletMatch[1])); continue; }
    flushList();
    if (/^[一二三四五六七八九十百]+、/.test(line)) { body.push(`<h2 class="cn-level-1">${renderInlineHtml(line)}</h2>`); continue; }
    if (/^[((][一二三四五六七八九十]+[))]/.test(line)) { body.push(`<h3 class="cn-level-2">${renderInlineHtml(line)}</h3>`); continue; }
    if (/^\d+[.、]\s*/.test(line)) { body.push(`<h4 class="cn-level-3">${renderInlineHtml(line)}</h4>`); continue; }
    body.push(`<p>${renderInlineHtml(line)}</p>`);
  }
  flushList();
  const subtitle = meta.subtitle ? `<div class="doc-subtitle">${escapeHtml(meta.subtitle)}</div>` : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>${escapeHtml(meta.title)}</title>
<style>
@page { size: A4; margin: 25mm 20mm 22mm 25mm; }
html, body { margin: 0; padding: 0; }
body { font-family: "方正仿宋简体","仿宋","FangSong","STFangsong",serif; font-size:16pt; line-height:1.75; color:#18201d; padding:0 12mm; }
.doc-subtitle { text-align:center; color:#666; font-size:11pt; margin-bottom:6mm; }
h1.doc-title { font-family:"方正小标宋简体","SimSun","宋体",serif; font-size:22pt; text-align:center; font-weight:700; margin:4mm 0 8mm 0; line-height:1.4; }
h2.level-1, h2.cn-level-1 { font-family:"黑体","SimHei",sans-serif; font-size:16pt; font-weight:700; margin:6mm 0 3mm 0; }
h3.level-2, h3.cn-level-2 { font-family:"楷体","KaiTi","STKaiti",serif; font-size:15pt; font-weight:700; margin:5mm 0 2mm 0; }
h4.cn-level-3 { font-size:15pt; font-weight:700; margin:4mm 0 2mm 0; }
p { text-indent:2em; margin:0 0 2mm 0; text-align:justify; }
blockquote { margin:2mm 6mm; padding:1mm 4mm; font-family:"楷体","KaiTi",serif; color:#4a4a4a; border-left:3px solid #c8c3a8; }
ul { margin:2mm 0 2mm 6mm; padding:0; } ul li { margin-bottom:1mm; text-indent:0; }
code { font-family:"Menlo","Consolas",monospace; font-size:13pt; background:#f2ead2; padding:0 3px; border-radius:3px; }
.toolbar { position:sticky; top:0; z-index:10; background:#18201d; color:#f5f2e9; padding:8px 16px; display:flex; gap:12px; align-items:center; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:13px; }
.toolbar button { background:#d9c785; color:#18201d; border:none; padding:6px 14px; border-radius:5px; cursor:pointer; font-weight:600; }
.toolbar button.secondary { background:transparent; color:#f5f2e9; border:1px solid rgba(255,255,255,0.3); }
@media print { .toolbar { display:none !important; } body { padding:0; } }
</style></head><body>
<div class="toolbar"><span>${escapeHtml(meta.title)}${meta.subtitle ? "  ·  " + escapeHtml(meta.subtitle) : ""}</span>
<button onclick="window.print()">打印 / 另存为 PDF</button>
<button class="secondary" onclick="window.close()">关闭</button></div>
${subtitle}
${body.join("\n")}
</body></html>`;
}

function materialFlowActive(task: Task | null): boolean {
  if (!task) return false;
  if (task.status === "needs_materials" || task.status === "needs_style") return true;
  if (task.status !== "running") return false;
  const materialStepIds = new Set([
    "materials",
    "extract",
    "style-materials",
    "style-extract",
    "draft",
    "revise"
  ]);
  return task.steps.some((step) => materialStepIds.has(step.id) && step.status === "running");
}

function finalFlowActive(task: Task | null): boolean {
  if (!task) return false;
  if (task.status === "needs_revision_review" || task.status === "done") return true;
  return task.status === "running" && task.steps.some((step) => ["proofread", "export"].includes(step.id) && step.status === "running");
}

function stageForTask(task: Task | null): WorkflowStage {
  if (!task) return "brief";
  if (materialFlowActive(task)) return "materials";
  if (finalFlowActive(task)) return "final";
  return "thinking";
}

function taskStatusLabel(status: string): string {
  if (status === "needs_materials") return "等待事实材料";
  if (status === "needs_style") return "等待文风材料";
  if (status === "needs_revision_review") return "等待批注确认";
  if (status === "paused") return "已暂停";
  if (status === "running") return "运行中";
  if (status === "created") return "待启动";
  if (status === "done") return "完成";
  if (status === "failed") return "失败";
  return status;
}

const statusText: Record<StepStatus, string> = {
  pending: "未开始",
  running: "运行中",
  needs_user: "待补充",
  done: "完成",
  failed: "失败",
  skipped: "跳过"
};

const statusIcon: Record<StepStatus, React.ReactNode> = {
  pending: <ChevronRight size={15} />,
  running: <Loader2 size={15} className="spin" />,
  needs_user: <Upload size={15} />,
  done: <Check size={15} />,
  failed: <RefreshCw size={15} />,
  skipped: <ChevronRight size={15} />
};

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const method = String(options?.method || "GET").toUpperCase();
  const attempts = method === "GET" ? 10 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}${url}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(options?.headers || {})
        }
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `请求失败：${response.status}`);
      }
      return response.json() as Promise<T>;
    } catch (error) {
      lastError = error;
      if (method !== "GET" || attempt === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("请求失败");
}

function upsertTaskList(items: Task[], task: Task): Task[] {
  const exists = items.some((item) => item.id === task.id);
  const next = exists ? items.map((item) => (item.id === task.id ? task : item)) : [task, ...items];
  return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

type ErrorBoundaryProps = { children: React.ReactNode; fallbackLabel?: string };
type ErrorBoundaryState = { error: Error | null };

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("UI 渲染异常", error);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="errorBoundary">
          <strong>{this.props.fallbackLabel || "该区域渲染失败"}</strong>
          <p>{this.state.error.message || "未知错误"}</p>
          <button onClick={this.reset}>
            <RefreshCw size={14} /> 重试渲染
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [brief, setBrief] = useState<WritingBrief>(() => ({ ...emptyBrief }));
  const [materialText, setMaterialText] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [uploadNotice, setUploadNotice] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [sanitizeMaterials, setSanitizeMaterials] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showMonitor, setShowMonitor] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [selectedStage, setSelectedStage] = useState<WorkflowStage>("brief");
  const [modelSettings, setModelSettings] = useState<ModelSetting[]>([]);
  const [modelTestResults, setModelTestResults] = useState<ModelTestResult>({});
  const [testingRole, setTestingRole] = useState("");
  const [error, setError] = useState("");
  const [taskQuery, setTaskQuery] = useState("");
  const [taskFilter, setTaskFilter] = useState<"all" | "active" | "waiting" | "done" | "failed">("all");
  const [isDraftingNewTask, setIsDraftingNewTask] = useState(false);
  const [renameDialog, setRenameDialog] = useState<{ id: string; value: string } | null>(null);

  useEffect(() => {
    serverReady.then(() => {
      request<Task[]>("/api/tasks")
        .then((items) => {
          setTasks(items);
          setActiveId((current) => current || items[0]?.id || null);
        })
        .catch((err) => setError(err.message));

      request<ModelSetting[]>("/api/settings/models")
        .then(setModelSettings)
        .catch((err) => setError(err.message));
    });

    let source: EventSource | null = null;
    let retry = 0;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function open() {
      if (cancelled) return;
      source = new EventSource(`${API_BASE}/events`);
      source.addEventListener("ready", () => {
        retry = 0;
      });
      source.addEventListener("task:update", (event) => {
        const task = JSON.parse((event as MessageEvent).data) as Task;
        setTasks((items) => upsertTaskList(items, task));
        setActiveId((current) => current || task.id);
      });
      source.addEventListener("task:delete", (event) => {
        const { id } = JSON.parse((event as MessageEvent).data) as { id: string };
        setTasks((items) => items.filter((item) => item.id !== id));
        setActiveId((current) => (current === id ? null : current));
      });
      source.onerror = () => {
        source?.close();
        source = null;
        if (cancelled) return;
        const delay = Math.min(15000, 500 * 2 ** retry);
        retry += 1;
        retryTimer = setTimeout(open, delay);
      };
    }

    open();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  const visibleTasks = useMemo(() => {
    const query = taskQuery.trim().toLowerCase();
    return tasks.filter((task) => {
      if (taskFilter === "active" && !(task.status === "running" || task.status === "created" || task.status === "paused")) return false;
      if (taskFilter === "waiting" && !(task.status === "needs_materials" || task.status === "needs_style" || task.status === "needs_revision_review")) return false;
      if (taskFilter === "done" && task.status !== "done") return false;
      if (taskFilter === "failed" && task.status !== "failed") return false;
      if (!query) return true;
      const haystack = [
        task.brief?.theme,
        task.brief?.materialType,
        task.brief?.scene,
        task.brief?.audience,
        task.brief?.orgContext,
        task.brief?.keywords,
        task.status
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [tasks, taskQuery, taskFilter]);

  const activeTask = useMemo(
    () => tasks.find((task) => task.id === activeId) || null,
    [activeId, tasks]
  );

  useEffect(() => {
    if (isDraftingNewTask) return;
    const currentVisible = Boolean(activeId && visibleTasks.some((task) => task.id === activeId));
    if (currentVisible) return;
    if (taskQuery.trim() || taskFilter !== "all") {
      setActiveId(visibleTasks[0]?.id || null);
      return;
    }
    if (!activeId && tasks.length) setActiveId(tasks[0].id);
  }, [activeId, isDraftingNewTask, taskFilter, taskQuery, tasks, visibleTasks]);

  const lastSyncedBriefId = useRef<string | null>(null);
  useEffect(() => {
    if (!activeTask) return;
    setSelectedStage(stageForTask(activeTask));
    if (lastSyncedBriefId.current !== activeTask.id) {
      setBrief(activeTask.brief);
      setPendingUploads([]);
      setUploadNotice("");
      lastSyncedBriefId.current = activeTask.id;
    }
  }, [activeTask?.id, activeTask?.status]);

  const progress = useMemo(() => {
    if (!activeTask) return 0;
    return Math.round(
      (activeTask.steps.filter((step) => step.status === "done").length / activeTask.steps.length) * 100
    );
  }, [activeTask]);

  const currentStep = useMemo(() => {
    if (!activeTask) return null;
    return (
      activeTask.steps.find((step) => step.status === "running" || step.status === "needs_user") ||
      [...activeTask.steps].reverse().find((step) => step.status === "done") ||
      activeTask.steps[0]
    );
  }, [activeTask]);
  const canPauseTask = activeTask?.status === "running";
  const canResumeTask = activeTask?.status === "paused";

  function startBlankTask() {
    setIsDraftingNewTask(true);
    setActiveId(null);
    setBrief({ ...emptyBrief });
    setSelectedStage("brief");
    setPendingUploads([]);
    setUploadNotice("");
    setMaterialText("");
    setError("");
    lastSyncedBriefId.current = null;
  }

  async function createTask() {
    if (!brief.materialType.trim() && !brief.theme.trim()) {
      setError("请先填写材料类型或主题，再启动 Agent。");
      return;
    }
    setIsCreating(true);
    setError("");
    try {
      const task = await request<Task>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(brief)
      });
      setTasks((items) => upsertTaskList(items, task));
      setActiveId(task.id);
      setIsDraftingNewTask(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setIsCreating(false);
    }
  }

  async function saveBriefToTask() {
    if (!activeTask) return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/brief`, {
        method: "PUT",
        body: JSON.stringify(brief)
      });
      setTasks((items) => items.map((item) => (item.id === task.id ? task : item)));
      setActiveId(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存写作要求失败");
    }
  }

  async function saveModelSettings(nextSettings = modelSettings) {
    setIsSavingSettings(true);
    setError("");
    try {
      const saved = await request<ModelSetting[]>("/api/settings/models", {
        method: "PUT",
        body: JSON.stringify(nextSettings)
      });
      setModelSettings(saved);
      setShowSettings(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存模型设置失败");
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function openModelSettings() {
    setError("");
    try {
      const latest = await request<ModelSetting[]>("/api/settings/models");
      setModelSettings(latest);
      setShowSettings(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取模型设置失败");
      setShowSettings(true);
    }
  }

  async function testModelSetting(setting: ModelSetting) {
    setTestingRole(setting.role);
    setModelTestResults((current) => ({ ...current, [setting.role]: { ok: false, message: "正在测试连接..." } }));
    try {
      const result = await request<{ ok: boolean; message: string }>("/api/settings/models/test", {
        method: "POST",
        body: JSON.stringify(setting)
      });
      setModelTestResults((current) => ({ ...current, [setting.role]: result }));
    } catch (err) {
      setModelTestResults((current) => ({
        ...current,
        [setting.role]: { ok: false, message: err instanceof Error ? err.message : "连接测试失败" }
      }));
    } finally {
      setTestingRole("");
    }
  }

  async function addMaterial() {
    if (!activeTask || !materialText.trim()) return;
    setError("");
    const materialLabel = activeTask.status === "needs_style" ? "文风材料" : "事实材料";
    const materialName = `${materialLabel} ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    try {
      await request<Task>(`/api/tasks/${activeTask.id}/materials`, {
        method: "POST",
        body: JSON.stringify({
          name: materialName,
          content: materialText,
          category: activeTask.status === "needs_style" ? "style" : "content",
          sanitize: sanitizeMaterials
        })
      });
      setMaterialText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交材料失败");
    }
  }

  function queueUploadFiles(files: File[]) {
    if (!files.length) return;
    setPendingUploads((items) => [
      ...items,
      ...files.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
        file
      }))
    ]);
    setUploadNotice(`已加入 ${files.length} 个待上传文件。`);
  }

  function removePendingUpload(id: string) {
    setPendingUploads((items) => items.filter((item) => item.id !== id));
  }

  async function uploadSingleFile(file: File) {
    if (!activeTask) return;
    setUploadNotice(`正在读取 ${file.name}...`);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsDataURL(file);
    });
    setUploadNotice(`正在识别 ${file.name}，请稍候...`);
    await request<Task>(`/api/tasks/${activeTask.id}/materials/upload`, {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        mime: file.type,
        dataUrl,
        category: activeTask.status === "needs_style" ? "style" : "content",
        sanitize: sanitizeMaterials
      })
    });
    setMaterialText("");
  }

  async function uploadPendingFiles() {
    if (!activeTask || !pendingUploads.length) return;
    setError("");
    setIsUploading(true);
    const queue = [...pendingUploads];
    try {
      for (let index = 0; index < queue.length; index += 1) {
        const item = queue[index];
        setUploadNotice(`正在上传 ${index + 1}/${queue.length}：${item.file.name}`);
        await uploadSingleFile(item.file);
        setPendingUploads((items) => items.filter((pending) => pending.id !== item.id));
      }
      setUploadNotice(`已上传 ${queue.length} 个文件并加入材料库。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "文件识别失败");
      setUploadNotice("上传中断，未完成的文件仍保留在待上传列表。");
    } finally {
      setIsUploading(false);
    }
  }

  async function updateTaskSanitizer(setting: ModelSetting) {
    if (!activeTask) return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/sanitizer-setting`, {
        method: "PUT",
        body: JSON.stringify(setting)
      });
      setTasks((items) => upsertTaskList(items, task));
      setActiveId(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换脱敏模型失败");
    }
  }

  async function continueTask() {
    if (!activeTask) return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/continue`, { method: "POST" });
      setTasks((items) => upsertTaskList(items, task));
    } catch (err) {
      setError(err instanceof Error ? err.message : "继续生成失败");
    }
  }

  async function skipMaterialsAndContinue() {
    if (!activeTask) return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/continue`, {
        method: "POST",
        body: JSON.stringify({ skipMaterials: true })
      });
      setTasks((items) => upsertTaskList(items, task));
    } catch (err) {
      setError(err instanceof Error ? err.message : "跳过材料失败");
    }
  }

  async function retryTask() {
    if (!activeTask) return;
    setError("");
    try {
      await request<Task>(`/api/tasks/${activeTask.id}/retry`, { method: "POST" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "重试失败");
    }
  }

  async function pauseCurrentTask() {
    if (!activeTask || activeTask.status !== "running") return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/pause`, { method: "POST" });
      setTasks((items) => upsertTaskList(items, task));
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂停任务失败");
    }
  }

  async function resumeCurrentTask() {
    if (!activeTask || activeTask.status !== "paused") return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/resume`, { method: "POST" });
      setTasks((items) => upsertTaskList(items, task));
    } catch (err) {
      setError(err instanceof Error ? err.message : "恢复任务失败");
    }
  }

  async function deleteTask(id: string) {
    const target = tasks.find((task) => task.id === id);
    if (!target) return;
    const label = target.brief.theme || target.brief.materialType || "该任务";
    if (!window.confirm(`确定删除“${label}”?本机存档和导出文件会一同清理。`)) return;
    setError("");
    try {
      await request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" });
      setTasks((items) => items.filter((item) => item.id !== id));
      setActiveId((current) => (current === id ? null : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除任务失败");
    }
  }

  function openRenameTask(id: string) {
    const target = tasks.find((task) => task.id === id);
    if (!target) return;
    setRenameDialog({ id, value: target.brief.theme || target.brief.materialType || "" });
  }

  async function submitRenameTask() {
    if (!renameDialog) return;
    const target = tasks.find((task) => task.id === renameDialog.id);
    const current = target?.brief.theme || target?.brief.materialType || "";
    const trimmed = renameDialog.value.trim();
    if (!trimmed || trimmed === current) return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${renameDialog.id}/rename`, {
        method: "PUT",
        body: JSON.stringify({ theme: trimmed })
      });
      setTasks((items) => items.map((item) => (item.id === task.id ? task : item)));
      setRenameDialog(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重命名失败");
    }
  }

  async function toggleLockFinal(id: string, shouldLock: boolean) {
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${id}/lock`, {
        method: shouldLock ? "POST" : "DELETE"
      });
      setTasks((items) => items.map((item) => (item.id === task.id ? task : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : shouldLock ? "锁定失败" : "解锁失败");
    }
  }

  async function rerunStep(taskId: string, stepId: string) {
    setError("");
    try {
      await request<Task>(`/api/tasks/${taskId}/rerun`, {
        method: "POST",
        body: JSON.stringify({ stepId })
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "阶段重跑失败");
    }
  }

  async function deleteMaterial(materialId: string) {
    if (!activeTask) return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/materials/${materialId}`, {
        method: "DELETE"
      });
      setTasks((items) => items.map((item) => (item.id === task.id ? task : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除材料失败");
    }
  }

  async function submitAuditFeedback(auditId: string, opinion: string) {
    if (!activeTask || !opinion.trim()) return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/audits/${auditId}/feedback`, {
        method: "POST",
        body: JSON.stringify({ opinion })
      });
      setTasks((items) => items.map((item) => (item.id === task.id ? task : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存审计反馈失败");
    }
  }

  async function submitOutputFeedback(payload: OutputFeedbackPayload) {
    if (!activeTask) return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/output-feedback`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setTasks((items) => items.map((item) => (item.id === task.id ? task : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存修改意见失败");
    }
  }

  async function requestAudit(payload: AuditRequestPayload) {
    if (!activeTask) return;
    setError("");
    try {
      const result = await request<{ task: Task }>(`/api/tasks/${activeTask.id}/audits`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setTasks((items) => items.map((item) => (item.id === result.task.id ? result.task : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "审计失败");
    }
  }

  async function submitRevisionReview(comments: RevisionComment[], skipped = false) {
    if (!activeTask) return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/revision-review`, {
        method: "POST",
        body: JSON.stringify({ comments, skipped })
      });
      setTasks((items) => upsertTaskList(items, task));
      setSelectedStage("final");
      if (!skipped) setShowMonitor(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交批注失败");
    }
  }

  async function deleteLogs(logIds: string[]) {
    if (!activeTask || !logIds.length) return;
    setError("");
    try {
      const task = await request<Task>(`/api/tasks/${activeTask.id}/logs`, {
        method: "DELETE",
        body: JSON.stringify({ ids: logIds })
      });
      setTasks((items) => upsertTaskList(items, task));
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除日志失败");
    }
  }

  function updateBrief<K extends keyof WritingBrief>(key: K, value: WritingBrief[K]) {
    setBrief((current) => ({ ...current, [key]: value }));
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">
            <FileText className="brandIcon" size={25} strokeWidth={1.9} />
          </div>
          <div>
            <strong>公文材料写作助手</strong>
            <span>本地工作台 · Agent 编排</span>
          </div>
        </div>

        <button className="newTask" onClick={startBlankTask} disabled={isCreating}>
          <Plus size={17} />
          新建任务
        </button>

        <button className="settingsButton" onClick={openModelSettings}>
          <SlidersHorizontal size={17} />
          模型与接口设置
        </button>

        <div className="taskFilterBar">
          <div className="taskSearchBox">
            <Search size={14} />
            <input
              type="text"
              value={taskQuery}
              onChange={(event) => setTaskQuery(event.target.value)}
              placeholder="搜索主题、材料类型或状态"
            />
            {taskQuery && (
              <button type="button" onClick={() => setTaskQuery("")} title="清除">
                ×
              </button>
            )}
          </div>
          <div className="taskFilterChips">
            {([
              ["all", "全部"],
              ["active", "进行中"],
              ["waiting", "等待"],
              ["done", "已完成"],
              ["failed", "失败"]
            ] as Array<[typeof taskFilter, string]>).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={taskFilter === id ? "active" : ""}
                onClick={() => setTaskFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="taskList">
          {visibleTasks.length === 0 ? (
            <div className="emptyList">
              {tasks.length === 0 ? "暂无任务，填写右侧写作要求后启动。" : "当前筛选下没有任务。"}
            </div>
          ) : (
            visibleTasks.map((task) => (
              <div
                className={`taskItem ${task.id === activeTask?.id ? "active" : ""}`}
                key={task.id}
              >
                <button
                  className="taskItemMain"
                  onClick={() => {
                    setIsDraftingNewTask(false);
                    setActiveId(task.id);
                  }}
                >
                  <span>{task.brief.theme || task.brief.materialType}</span>
                  <small>
                    {taskStatusLabel(task.status)}
                    <b>{formatTokenUsage(taskTokenUsage(task))}</b>
                  </small>
                </button>
                <button
                  className="taskItemRename"
                  onClick={(event) => {
                    event.stopPropagation();
                    openRenameTask(task.id);
                  }}
                  title="重命名任务"
                >
                  <PencilLine size={13} />
                </button>
                <button
                  className="taskItemDelete"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteTask(task.id);
                  }}
                  title="删除任务"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>

        <SidebarLogs task={activeTask} onOpen={() => setShowLogs(true)} />
        {isTauri && <UpdateChecker />}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p>材料工作台</p>
            <h1>{activeTask?.brief.theme || "从写作要求开始"}</h1>
          </div>
          <div className="topbarActions">
            <button
              className={`taskRunToggle ${canResumeTask ? "resume" : ""}`}
              onClick={canResumeTask ? resumeCurrentTask : pauseCurrentTask}
              disabled={!canPauseTask && !canResumeTask}
              title={canResumeTask ? "恢复当前任务" : "停止当前任务"}
            >
              {canResumeTask ? <Play size={16} /> : <Pause size={16} />}
              <span>{canResumeTask ? "恢复任务" : "停止任务"}</span>
            </button>
            <button className="progressButton" onClick={() => setShowMonitor(true)} disabled={!activeTask}>
              <Activity size={17} />
              <span>流程监控</span>
              <strong>{progress}%</strong>
            </button>
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        {activeTask?.status === "failed" && activeTask.failure && (
          <div className="failureBanner">
            <div>
              <strong>任务已中断</strong>
              <span>
                {activeTask.failure.phase === "workflow"
                  ? "前置流程"
                  : activeTask.failure.phase === "content"
                    ? "事实材料阶段"
                    : "文风材料阶段"}
                · {activeTask.failure.message}
              </span>
            </div>
            <button className="primaryAction" onClick={retryTask}>
              <RefreshCw size={16} />
              重试
            </button>
          </div>
        )}

        <FlowGuide
          task={activeTask}
          progress={progress}
          selectedStage={selectedStage}
          onSelect={setSelectedStage}
        />

        <div className="guidedGrid">
          <section className="panel actionPanel">
            <CurrentAction
              task={activeTask}
              brief={brief}
              onBriefChange={updateBrief}
              selectedStage={selectedStage}
              isCreating={isCreating}
              createTask={createTask}
              saveBrief={saveBriefToTask}
              currentStep={currentStep}
              openMonitor={() => setShowMonitor(true)}
              materialText={materialText}
              setMaterialText={setMaterialText}
              queueUploadFiles={queueUploadFiles}
              pendingUploads={pendingUploads}
              removePendingUpload={removePendingUpload}
              uploadPendingFiles={uploadPendingFiles}
              addMaterial={addMaterial}
              continueTask={continueTask}
              skipMaterialsAndContinue={skipMaterialsAndContinue}
              deleteMaterial={deleteMaterial}
              isUploading={isUploading}
              uploadNotice={uploadNotice}
              sanitizeMaterials={sanitizeMaterials}
              setSanitizeMaterials={setSanitizeMaterials}
              modelSettings={modelSettings}
              updateTaskSanitizer={updateTaskSanitizer}
            />
          </section>

          <section className="panel outputPanel">
            <PanelTitle icon={<Bot size={18} />} title="Agent 输出" sub="思路、大纲、资料与版本" />
            <ErrorBoundary fallbackLabel="Agent 输出渲染失败">
              <OutputTabs
                task={activeTask}
                selectedStage={selectedStage}
                onAuditFeedback={submitAuditFeedback}
                onAuditRequest={requestAudit}
                onOutputFeedback={submitOutputFeedback}
                onRerun={rerunStep}
                onToggleLock={toggleLockFinal}
                onRevisionReview={submitRevisionReview}
              />
            </ErrorBoundary>
          </section>
        </div>
      </section>

      {showMonitor && activeTask && <WorkflowMonitor task={activeTask} progress={progress} onClose={() => setShowMonitor(false)} onRerun={rerunStep} />}
      {showLogs && activeTask && <LogPanel task={activeTask} onClose={() => setShowLogs(false)} onDeleteLogs={deleteLogs} />}
      {renameDialog && (
        <RenameTaskDialog
          value={renameDialog.value}
          onChange={(value) => setRenameDialog((current) => current ? { ...current, value } : current)}
          onCancel={() => setRenameDialog(null)}
          onSubmit={submitRenameTask}
        />
      )}

      {showSettings && (
        <SettingsPanel
          settings={modelSettings}
          onSave={saveModelSettings}
          onClose={() => setShowSettings(false)}
          isSaving={isSavingSettings}
          onTest={testModelSetting}
          testResults={modelTestResults}
          testingRole={testingRole}
          tasks={tasks}
        />
      )}
    </main>
  );
}

function PanelTitle({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="panelTitle">
      <div>{icon}</div>
      <span>
        <strong>{title}</strong>
        <small>{sub}</small>
      </span>
    </div>
  );
}

function RenameTaskDialog({
  value,
  onChange,
  onCancel,
  onSubmit
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="renameOverlay">
      <section className="renameDialog">
        <header>
          <div>
            <p>项目名称</p>
            <h2>重命名任务</h2>
          </div>
          <button type="button" onClick={onCancel}>关闭</button>
        </header>
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSubmit();
            if (event.key === "Escape") onCancel();
          }}
        />
        <footer>
          <button type="button" className="secondaryAction" onClick={onCancel}>取消</button>
          <button type="button" className="primaryAction" onClick={onSubmit} disabled={!value.trim()}>
            保存名称
          </button>
        </footer>
      </section>
    </div>
  );
}

function FlowGuide({
  task,
  progress,
  selectedStage,
  onSelect
}: {
  task: Task | null;
  progress: number;
  selectedStage: WorkflowStage;
  onSelect: (stage: WorkflowStage) => void;
}) {
  const stages: Array<{ id: WorkflowStage; title: string; sub: string }> = [
    { id: "brief", title: "写作要求", sub: "填写任务背景" },
    { id: "thinking", title: "构思与资料", sub: "Agent 自动推进" },
    { id: "materials", title: "补充素材", sub: "事实与文风材料" },
    { id: "final", title: "定稿导出", sub: "审校后下载" }
  ];
  const activeId = stageForTask(task);
  const availableStages = new Set<WorkflowStage>(
    !task ? ["brief"] : activeId === "thinking" ? ["brief", "thinking"] : activeId === "materials" ? ["brief", "thinking", "materials"] : ["brief", "thinking", "materials", "final"]
  );

  return (
    <div className="flowGuide" aria-label="写作流程引导">
      {stages.map((stage, index) => (
        <button
          className={`guideStep ${stage.id === activeId ? "active" : ""} ${stage.id === selectedStage ? "selected" : ""}`}
          disabled={!availableStages.has(stage.id)}
          key={stage.id}
          onClick={() => onSelect(stage.id)}
          type="button"
        >
          <span>{index + 1}</span>
          <strong>{stage.title}</strong>
          <small>{stage.sub}</small>
        </button>
      ))}
      <div className="guideMeter">
        <strong>{progress}%</strong>
        <span>总体进度</span>
      </div>
    </div>
  );
}

function CurrentAction({
  task,
  brief,
  onBriefChange,
  selectedStage,
  isCreating,
  createTask,
  saveBrief,
  currentStep,
  openMonitor,
  materialText,
  setMaterialText,
  queueUploadFiles,
  pendingUploads,
  removePendingUpload,
  uploadPendingFiles,
  addMaterial,
  continueTask,
  skipMaterialsAndContinue,
  deleteMaterial,
  isUploading,
  uploadNotice,
  sanitizeMaterials,
  setSanitizeMaterials,
  modelSettings,
  updateTaskSanitizer
}: {
  task: Task | null;
  brief: WritingBrief;
  onBriefChange: <K extends keyof WritingBrief>(key: K, value: WritingBrief[K]) => void;
  selectedStage: WorkflowStage;
  isCreating: boolean;
  createTask: () => void;
  saveBrief: () => void;
  currentStep: WorkflowStep | null;
  openMonitor: () => void;
  materialText: string;
  setMaterialText: (value: string) => void;
  queueUploadFiles: (files: File[]) => void;
  pendingUploads: PendingUpload[];
  removePendingUpload: (id: string) => void;
  uploadPendingFiles: () => void;
  addMaterial: () => void;
  continueTask: () => void;
  skipMaterialsAndContinue: () => void;
  deleteMaterial: (id: string) => void;
  isUploading: boolean;
  uploadNotice: string;
  sanitizeMaterials: boolean;
  setSanitizeMaterials: (value: boolean) => void;
  modelSettings: ModelSetting[];
  updateTaskSanitizer: (setting: ModelSetting) => void;
}) {
  if (!task || selectedStage === "brief") {
    return (
      <>
        <PanelTitle icon={<Wand2 size={18} />} title="第 1 步：写作要求" sub="先把任务说明清楚" />
        <BriefForm brief={brief} onChange={onBriefChange} disabled={isCreating} />
        <div className="actionFooter">
          {task && (
            <button className="secondaryAction" onClick={saveBrief}>
              <Save size={16} />
              保存到当前项目
            </button>
          )}
          {!task && (
            <button className="secondaryAction" onClick={createTask} disabled={isCreating}>
            {isCreating ? <Loader2 className="spin" size={17} /> : <Plus size={17} />}
              启动 Agent
            </button>
          )}
        </div>
      </>
    );
  }

  if (selectedStage === "materials") {
    return (
      <>
        <PanelTitle
          icon={<Upload size={18} />}
          title={task.status === "needs_style" ? "第 3 步：上传文风材料" : "第 3 步：补充素材"}
          sub={task.status === "needs_style" ? "用于提炼表述风格" : "用于补充案例、做法、数据"}
        />
        {task.status === "running" && (
          <div className={`currentStepCard ${currentStep?.status || "running"}`}>
            <div className="stepIcon">{currentStep ? statusIcon[currentStep.status] : <Loader2 size={15} className="spin" />}</div>
            <div>
              <strong>{currentStep?.title || "Agent 正在处理材料"}</strong>
              <span>{currentStep?.description || "已收到材料，正在提炼并推进后续稿件生成。"}</span>
            </div>
            <em>{currentStep ? statusText[currentStep.status] : "运行中"}</em>
          </div>
        )}
        <MaterialBox
          task={task}
          materialText={materialText}
          setMaterialText={setMaterialText}
          queueUploadFiles={queueUploadFiles}
          pendingUploads={pendingUploads}
          removePendingUpload={removePendingUpload}
          uploadPendingFiles={uploadPendingFiles}
          addMaterial={addMaterial}
          continueTask={continueTask}
          skipMaterialsAndContinue={skipMaterialsAndContinue}
          deleteMaterial={deleteMaterial}
          isUploading={isUploading}
          uploadNotice={uploadNotice}
          sanitizeMaterials={sanitizeMaterials}
          setSanitizeMaterials={setSanitizeMaterials}
          modelSettings={modelSettings}
          updateTaskSanitizer={updateTaskSanitizer}
        />
      </>
    );
  }

  return (
    <>
      <PanelTitle
        icon={selectedStage === "final" ? <Check size={18} /> : <Activity size={18} />}
        title={selectedStage === "final" ? "第 4 步：定稿导出" : "第 2 步：构思与资料"}
        sub={selectedStage === "final" ? "可在右侧定稿页下载" : "查看自动推进阶段"}
      />
      <div className={`currentStepCard ${currentStep?.status || "pending"}`}>
        <div className="stepIcon">{currentStep ? statusIcon[currentStep.status] : <ChevronRight size={15} />}</div>
        <div>
          <strong>{currentStep?.title || "等待启动"}</strong>
          <span>{currentStep?.description || "任务进入队列后会自动推进。"}</span>
        </div>
        <em>{currentStep ? statusText[currentStep.status] : "未开始"}</em>
      </div>
      <div className="actionFooter split">
        <button className="secondaryAction" onClick={openMonitor}>
          <Activity size={16} />
          查看完整流程
        </button>
        <button className="primaryAction" onClick={continueTask} disabled={task.status === "done"}>
          <RefreshCw size={16} />
          运行 / 继续 Agent
        </button>
      </div>
    </>
  );
}

const RERUNNABLE_STEP_IDS = new Set([
  "parallel-thinking",
  "synthesis",
  "research",
  "dual-outline",
  "final-outline",
  "material-request",
  "extract",
  "style-extract",
  "draft",
  "revise",
  "proofread"
]);

function WorkflowMonitor({
  task,
  progress,
  onClose,
  onRerun
}: {
  task: Task;
  progress: number;
  onClose: () => void;
  onRerun: (taskId: string, stepId: string) => void;
}) {
  return (
    <div className="settingsOverlay">
      <section className="monitorPanel">
        <header>
          <div>
            <p>实时状态</p>
            <h2>流程进度监控</h2>
          </div>
          <button onClick={onClose}>关闭</button>
        </header>
        <div className="monitorProgress">
          <strong>{progress}%</strong>
          <div className="progressTrack">
            <div style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="timeline monitorTimeline">
          {task.steps.map((step) => {
            const canRerun = RERUNNABLE_STEP_IDS.has(step.id) && (step.status === "done" || step.status === "failed");
            return (
              <div className={`step ${step.status}`} key={step.id}>
                <div className="stepIcon">{statusIcon[step.status]}</div>
                <div>
                  <strong>{step.title}</strong>
                  <span>{step.description}</span>
                </div>
                <em>{statusText[step.status]}</em>
                {canRerun && (
                  <button
                    className="stepRerun"
                    type="button"
                    title="从该阶段开始重跑"
                    onClick={() => {
                      if (window.confirm(`确认从“${step.title}”重跑?该阶段及其后续步骤会重新执行。`)) {
                        onRerun(task.id, step.id);
                      }
                    }}
                  >
                    <RefreshCw size={13} />
                    重跑
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SidebarLogs({ task, onOpen }: { task: Task | null; onOpen: () => void }) {
  const latest = task?.logs?.[0];
  return (
    <section className="sidebarLogs">
      <button className="logOpenButton" onClick={onOpen} disabled={!task}>
        <History size={16} />
        <span>
          <strong>运行日志</strong>
          <small>{task ? `${task.logs.length} 条记录` : "暂无项目"}</small>
        </span>
      </button>
      {latest ? <p className="latestLog">{latest.model}：{latest.message}</p> : <div className="sidebarLogEmpty">项目运行后可查看日志。</div>}
    </section>
  );
}

function UpdateChecker() {
  const [state, setState] = useState<"idle" | "checking" | "none" | "available" | "installing" | "error">("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [message, setMessage] = useState<string>("");

  async function check() {
    setState("checking");
    setMessage("");
    try {
      const result = await tauriCheckForUpdates();
      if (result) {
        setInfo(result);
        setState("available");
      } else {
        setState("none");
      }
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "检查更新失败");
    }
  }

  async function install() {
    setState("installing");
    try {
      await tauriInstallUpdate();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "安装更新失败");
    }
  }

  return (
    <section className="updateChecker">
      {state === "available" && info ? (
        <>
          <div>
            <strong>发现新版本 {info.version}</strong>
            <small>当前 {info.current_version}</small>
          </div>
          {info.notes && <p className="updateNotes">{info.notes}</p>}
          <div className="updateActions">
            <button onClick={install}>立即安装并重启</button>
            <button className="secondary" onClick={() => setState("idle")}>稍后</button>
          </div>
        </>
      ) : (
        <button className="updateCheckButton" onClick={check} disabled={state === "checking" || state === "installing"}>
          <RefreshCw size={14} className={state === "checking" || state === "installing" ? "spin" : ""} />
          {state === "checking" ? "检查中..." : state === "installing" ? "安装中..." : state === "none" ? "已是最新" : state === "error" ? "重试检查更新" : "检查更新"}
        </button>
      )}
      {state === "error" && message && <p className="updateError">{message}</p>}
    </section>
  );
}

function LogPanel({
  task,
  onClose,
  onDeleteLogs
}: {
  task: Task;
  onClose: () => void;
  onDeleteLogs: (ids: string[]) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(task.logs[0]?.id || "");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [exportNotice, setExportNotice] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const selectedLog = task.logs.find((log) => log.id === selectedId) || task.logs[0] || null;
  const selectedCount = selectedIds.size;

  useEffect(() => {
    const existing = new Set(task.logs.map((log) => log.id));
    setSelectedId((current) => (existing.has(current) ? current : task.logs[0]?.id || ""));
    setSelectedIds((current) => new Set([...current].filter((id) => existing.has(id))));
  }, [task.logs]);

  function logExportContent() {
    const lines = task.logs
      .slice()
      .reverse()
      .map((log) => `[${new Date(log.at).toLocaleString("zh-CN", { hour12: false })}] ${log.model}\n${log.message}`)
      .join("\n\n");
    return `项目：${task.brief.theme || task.brief.materialType}\n导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}\n\n${lines}\n`;
  }

  async function exportLogs() {
    const fileName = `${task.brief.theme || "gongwen"}-运行日志.txt`;
    const content = logExportContent();
    const picker = (window as any).showSaveFilePicker;
    if (typeof picker === "function") {
      try {
        const handle = await picker({
          suggestedName: fileName,
          types: [{ description: "文本日志", accept: { "text/plain": [".txt"] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        setExportNotice(`日志已导出：${handle.name || fileName}`);
        return;
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
      }
    }
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    setExportNotice(`日志已导出为“${fileName}”，请在浏览器默认下载目录查看。`);
  }

  function toggleLogSelection(logId: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(logId);
      else next.delete(logId);
      return next;
    });
  }

  async function deleteSelectedLogs() {
    if (!selectedCount) return;
    if (!window.confirm(`确认删除选中的 ${selectedCount} 条运行日志？`)) return;
    setIsDeleting(true);
    setExportNotice("");
    try {
      const count = selectedCount;
      await onDeleteLogs([...selectedIds]);
      setSelectedIds(new Set());
      setExportNotice(`已删除 ${count} 条日志。`);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="settingsOverlay">
      <section className="logPanelDialog">
        <header>
          <div>
            <p>项目排查</p>
            <h2>运行日志</h2>
          </div>
          <div>
            <button onClick={exportLogs} disabled={!task.logs.length}>
              <Download size={16} />
              导出日志
            </button>
            <button onClick={deleteSelectedLogs} disabled={!selectedCount || isDeleting}>
              {isDeleting ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}
              {selectedCount ? `删除 ${selectedCount} 条` : "删除日志"}
            </button>
            <button onClick={onClose}>关闭</button>
          </div>
        </header>
        {exportNotice && <div className="exportNotice">{exportNotice}</div>}
        {task.logs.length > 0 && (
          <div className="logSelectionBar">
            <button type="button" onClick={() => setSelectedIds(new Set(task.logs.map((log) => log.id)))}>
              全选
            </button>
            <button type="button" onClick={() => setSelectedIds(new Set())} disabled={!selectedCount}>
              清空选择
            </button>
            <span>{selectedCount ? `已选择 ${selectedCount} 条` : "可勾选多条日志后删除"}</span>
          </div>
        )}
        <div className="logDialogBody">
          <div className="logEntryList">
            {task.logs.length ? (
              task.logs.map((log) => (
                <div className={`logEntryRow ${log.id === selectedLog?.id ? "active" : ""}`} key={log.id}>
                  <label className="logEntryCheck" title="选择该日志">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(log.id)}
                      onChange={(event) => toggleLogSelection(log.id, event.target.checked)}
                    />
                  </label>
                  <button className="logEntryButton" type="button" onClick={() => setSelectedId(log.id)}>
                    <span>{new Date(log.at).toLocaleString("zh-CN", { hour12: false })}</span>
                    <strong>{log.model}</strong>
                    <small>{log.message}</small>
                  </button>
                </div>
              ))
            ) : (
              <div className="placeholder compact">暂无日志。</div>
            )}
          </div>
          <article className="logDetail">
            {selectedLog ? (
              <>
                <div>
                  <strong>{selectedLog.model}</strong>
                  <span>{new Date(selectedLog.at).toLocaleString("zh-CN", { hour12: false })}</span>
                </div>
                <pre>{selectedLog.message}</pre>
              </>
            ) : (
              <div className="placeholder compact">选择一条日志查看详情。</div>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}

const MODEL_PROFILE_PRESETS: ModelProfile[] = [
  {
    id: "openai-default",
    name: "OpenAI",
    providerName: "OpenAI",
    model: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    providerType: "direct",
    apiFormat: "responses"
  },
  {
    id: "anthropic-default",
    name: "Anthropic",
    providerName: "Anthropic",
    model: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "",
    providerType: "direct",
    apiFormat: "chatCompletions"
  },
  {
    id: "deepseek-default",
    name: "DeepSeek",
    providerName: "DeepSeek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    providerType: "direct",
    apiFormat: "chatCompletions"
  },
  {
    id: "gemini-default",
    name: "Gemini",
    providerName: "Gemini",
    model: "gemini-2.5-pro",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "",
    providerType: "direct",
    apiFormat: "gemini"
  },
  {
    id: "cc-switch-default",
    name: "cc-switch",
    providerName: "cc-switch",
    model: "gpt-4.1",
    baseUrl: "http://127.0.0.1:15721/v1",
    apiKey: "",
    providerType: "ccSwitch",
    apiFormat: "chatCompletions"
  }
];

function providerNameForSetting(setting: ModelSetting): string {
  if (setting.providerName) return setting.providerName;
  if (setting.apiFormat === "gemini" || /google|generativelanguage|gemini/i.test(setting.baseUrl)) return "Gemini";
  if (/deepseek/i.test(setting.baseUrl) || /deepseek/i.test(setting.model)) return "DeepSeek";
  if (/anthropic|claude/i.test(setting.baseUrl) || /claude/i.test(setting.model)) return "Anthropic";
  if (setting.providerType === "ccSwitch") return "cc-switch";
  if (setting.providerType === "local") return "本地模型";
  return "OpenAI";
}

function profileSignature(setting: ModelSetting): string {
  return [
    providerNameForSetting(setting),
    setting.providerType,
    setting.apiFormat,
    setting.baseUrl,
    setting.model,
    setting.apiKey ? "key" : "nokey"
  ].join("|");
}

function sanitizerOptionKey(setting: ModelSetting): string {
  return [
    providerNameForSetting(setting),
    setting.providerType,
    setting.apiFormat,
    setting.baseUrl,
    setting.model
  ].join("|");
}

function sanitizerOptionLabel(setting: ModelSetting): string {
  const provider = providerNameForSetting(setting);
  const origin = setting.providerType === "local" ? "本地" : "API";
  return `${provider} · ${setting.model || "未填写模型"} · ${origin}`;
}

function sanitizerOptionsFor(task: Task | null, settings: ModelSetting[]) {
  const options = new Map<string, { key: string; label: string; setting: ModelSetting }>();
  const add = (setting?: ModelSetting) => {
    if (!setting?.baseUrl || !setting?.model) return;
    const normalized: ModelSetting = {
      ...setting,
      role: "sanitizer",
      title: "材料脱敏",
      executionMode: "live"
    };
    const key = sanitizerOptionKey(normalized);
    if (!options.has(key)) {
      options.set(key, {
        key,
        label: sanitizerOptionLabel(normalized),
        setting: normalized
      });
    }
  };
  const currentSanitizer = task?.modelSettings?.find((item) => item.role === "sanitizer");
  add(currentSanitizer);
  LOCAL_SANITIZER_PRESETS.forEach(add);
  (task?.modelSettings || []).forEach(add);
  settings.forEach(add);
  return [...options.values()];
}

function makeProfilesFromSettings(settings: ModelSetting[]): { profiles: ModelProfile[]; assignments: Record<string, string> } {
  const profiles = [...MODEL_PROFILE_PRESETS];
  const assignments: Record<string, string> = {};
  const bySignature = new Map(profiles.map((profile) => [
    [profile.providerName, profile.providerType, profile.apiFormat, profile.baseUrl, profile.model, profile.apiKey ? "key" : "nokey"].join("|"),
    profile.id
  ]));
  const byProfileId = new Map(profiles.map((profile) => [profile.id, profile]));

  for (const setting of settings) {
    const preferredProfile = setting.profileId ? byProfileId.get(setting.profileId) : null;
    const preferred = preferredProfile?.id || "";
    if (preferred) {
      const currentProfile = preferredProfile as ModelProfile;
      const nextProfile: ModelProfile = {
        ...currentProfile,
        id: currentProfile.id,
        name: currentProfile.name,
        providerName: setting.providerName || providerNameForSetting(setting),
        model: setting.model,
        baseUrl: setting.baseUrl,
        apiKey: setting.apiKey,
        providerType: setting.providerType,
        apiFormat: setting.apiFormat
      };
      const index = profiles.findIndex((profile) => profile.id === preferred);
      if (index >= 0) profiles[index] = nextProfile;
      byProfileId.set(preferred, nextProfile);
      bySignature.set(
        [nextProfile.providerName, nextProfile.providerType, nextProfile.apiFormat, nextProfile.baseUrl, nextProfile.model, nextProfile.apiKey ? "key" : "nokey"].join("|"),
        preferred
      );
      assignments[setting.role] = preferred;
      continue;
    }
    const signature = profileSignature(setting);
    let profileId = bySignature.get(signature);
    if (!profileId) {
      profileId = `profile-${profiles.length + 1}`;
      const providerName = providerNameForSetting(setting);
      profiles.push({
        id: profileId,
        name: `${providerName} · ${setting.model || "未命名模型"}`,
        providerName,
        model: setting.model,
        baseUrl: setting.baseUrl,
        apiKey: setting.apiKey,
        providerType: setting.providerType,
        apiFormat: setting.apiFormat
      });
      bySignature.set(signature, profileId);
    }
    assignments[setting.role] = profileId;
  }

  return { profiles, assignments };
}

function applyProfilesToSettings(settings: ModelSetting[], profiles: ModelProfile[], assignments: Record<string, string>): ModelSetting[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return settings.map((setting) => {
    const profile = byId.get(assignments[setting.role]) || profiles[0];
    return {
      ...setting,
      profileId: profile.id,
      providerName: profile.providerName,
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      providerType: profile.providerType,
      apiFormat: profile.apiFormat,
      executionMode: "live"
    };
  });
}

function modelProfileKey(profile: Pick<ModelProfile, "providerName" | "baseUrl" | "model">): string {
  return [profile.providerName || "", profile.baseUrl || "", profile.model || ""].join("::");
}

function SettingsPanel({
  settings,
  onSave,
  onClose,
  isSaving,
  onTest,
  testResults,
  testingRole,
  tasks
}: {
  settings: ModelSetting[];
  onSave: (settings?: ModelSetting[]) => void;
  onClose: () => void;
  isSaving: boolean;
  onTest: (setting: ModelSetting) => void;
  testResults: ModelTestResult;
  testingRole: string;
  tasks: Task[];
}) {
  const initial = useMemo(() => makeProfilesFromSettings(settings), [settings]);
  const [profiles, setProfiles] = useState<ModelProfile[]>(initial.profiles);
  const [assignments, setAssignments] = useState<Record<string, string>>(initial.assignments);
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [profilesExpanded, setProfilesExpanded] = useState(false);
  const [assignmentsExpanded, setAssignmentsExpanded] = useState(false);
  const [modelCatalogs, setModelCatalogs] = useState<ModelCatalogState>({});
  const [searchDraft, setSearchDraft] = useState(() => {
    const research = settings.find((setting) => setting.role === "research");
    return {
      searchProvider: research?.searchProvider || "mock",
      searchBaseUrl: research?.searchBaseUrl || "",
      searchApiKey: research?.searchApiKey || ""
    };
  });

  useEffect(() => {
    setProfiles(initial.profiles);
    setAssignments(initial.assignments);
    const research = settings.find((setting) => setting.role === "research");
    setSearchDraft({
      searchProvider: research?.searchProvider || "mock",
      searchBaseUrl: research?.searchBaseUrl || "",
      searchApiKey: research?.searchApiKey || ""
    });
  }, [initial]);

  const appliedSettings = useMemo(
    () => applyProfilesToSettings(settings, profiles, assignments).map((setting) =>
      setting.role === "research" ? { ...setting, ...searchDraft } : setting
    ),
    [assignments, profiles, searchDraft, settings]
  );

  function updateProfile(id: string, key: keyof ModelProfile, value: string) {
    setProfiles((items) => items.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, [key]: value };
      if (key === "providerType" && value === "ccSwitch") next.apiKey = "";
      return next;
    }));
  }

  function addProfile() {
    const id = `profile-${Date.now()}`;
    setProfiles((items) => [
      ...items,
      {
        id,
        name: "自定义模型",
        providerName: "自定义",
        model: "",
        baseUrl: "",
        apiKey: "",
        providerType: "direct",
        apiFormat: "chatCompletions"
      }
    ]);
  }

  function removeProfile(id: string) {
    if (profiles.length <= 1) return;
    const fallback = profiles.find((profile) => profile.id !== id)?.id || profiles[0].id;
    setProfiles((items) => items.filter((item) => item.id !== id));
    setAssignments((current) => {
      const next = { ...current };
      for (const setting of settings) {
        if (next[setting.role] === id) next[setting.role] = fallback;
      }
      return next;
    });
  }

  function settingForRole(role: string): ModelSetting {
    return appliedSettings.find((setting) => setting.role === role) || settings.find((setting) => setting.role === role) || settings[0];
  }

  function save() {
    onSave(appliedSettings);
  }

  function usageForProfile(profile: ModelProfile): TokenUsage {
    const wanted = modelProfileKey(profile);
    const seen = new Set<string>();
    let total = emptyTokenUsage();
    let hasTaskUsage = false;
    for (const task of tasks) {
      const modelUsage = task.outputs?.tokenUsage?.byModel?.[wanted];
      if (modelUsage) {
        total = addTokenUsage(total, modelUsage);
        hasTaskUsage = true;
      }
    }
    if (hasTaskUsage) return total;
    for (const setting of settings) {
      const key = modelProfileKey({
        providerName: setting.providerName || providerNameForSetting(setting),
        baseUrl: setting.baseUrl,
        model: setting.model
      });
      if (key !== wanted || seen.has(key)) continue;
      seen.add(key);
      total = addTokenUsage(total, setting.tokenUsage);
    }
    return total;
  }

  async function fetchModelsForProfile(profile: ModelProfile) {
    setModelCatalogs((current) => ({
      ...current,
      [profile.id]: { loading: true, message: "正在获取模型列表...", models: current[profile.id]?.models || [] }
    }));
    try {
      const result = await request<{ ok: boolean; provider: string; models: ProviderModel[]; message?: string }>("/api/settings/models/list", {
        method: "POST",
        body: JSON.stringify({ ...profile, profileId: profile.id, role: "research", title: profile.name || profile.providerName })
      });
      setModelCatalogs((current) => ({
        ...current,
        [profile.id]: {
          loading: false,
          message: result.message || (result.models.length ? `已获取 ${result.models.length} 个模型` : "供应商未返回可选模型"),
          models: result.models
        }
      }));
    } catch (err) {
      setModelCatalogs((current) => ({
        ...current,
        [profile.id]: {
          loading: false,
          message: err instanceof Error ? err.message : "获取模型列表失败",
          models: current[profile.id]?.models || []
        }
      }));
    }
  }

  return (
    <div className="settingsOverlay">
      <section className="settingsPanel">
        <header>
          <div>
            <p>模型供应商与 Agent 路由</p>
            <h2>模型与接口设置</h2>
          </div>
          <button onClick={onClose}>关闭</button>
        </header>

        <div className="settingsHint">
          先配置 OpenAI、Anthropic、DeepSeek、Gemini、cc-switch 或自定义模型档案，再让每个 Agent 选择一个档案。上线模式固定为真实调用，不再暴露本地模拟选项。
        </div>

        <div className="settingsHint warning">
          <ShieldCheck size={14} />
          <span>
            材料脱敏的本地正则仅覆盖常见格式（姓名、手机号、身份证号、银行卡号、统一社会信用代码、车牌、IP、座机、QQ/微信、邮箱、地址）,不保证完备。涉密材料请务必把“材料脱敏”角色切换为本地 Ollama / LM Studio / deepseek 等真实模型。
          </span>
        </div>

        <section className={`collapsibleSettings ${profilesExpanded ? "expanded" : ""}`}>
          <button
            className="collapsibleHeading"
            type="button"
            onClick={() => setProfilesExpanded((value) => !value)}
            aria-expanded={profilesExpanded}
          >
            <ChevronRight size={16} />
            <span>
              <strong>模型配置档</strong>
              <small>{profiles.length} 个配置 · OpenAI / Anthropic / DeepSeek / Gemini / 自定义</small>
            </span>
            <em>{profilesExpanded ? "收起" : "展开设置"}</em>
          </button>
          {!profilesExpanded ? (
            <div className="collapsedSummary">
              {profiles.slice(0, 4).map((profile) => (
                <span key={profile.id}>{profile.name || profile.providerName}</span>
              ))}
              {profiles.length > 4 && <span>+{profiles.length - 4}</span>}
            </div>
          ) : (
            <div className="collapsibleBody providerProfiles">
              <div className="sectionHeading">
                <span>配置 provider、model、Base URL 和 API Key。</span>
                <button type="button" onClick={addProfile}>
                  <Plus size={14} />
                  添加配置
                </button>
              </div>
              <div className="modelSettingsGrid">
                {profiles.map((profile) => {
                  const isCcSwitchProfile = profile.providerType === "ccSwitch" || profile.providerName.toLowerCase().includes("cc-switch");
                  return (
                  <article className="modelSettingCard" key={profile.id}>
                    <div className="modelSettingTitle">
                      <div>
                        <strong>{profile.name || profile.providerName}</strong>
                        <span>{profile.providerName}</span>
                      </div>
                      <em>{formatTokenUsage(usageForProfile(profile))}</em>
                    </div>
                    <label>
                      配置名称
                      <input
                        value={profile.name}
                        onChange={(event) => updateProfile(profile.id, "name", event.target.value)}
                        placeholder="例如：OpenAI 主账号"
                      />
                    </label>
                    <label>
                      供应商
                      <input
                        value={profile.providerName}
                        onChange={(event) => updateProfile(profile.id, "providerName", event.target.value)}
                        placeholder="OpenAI / Anthropic / DeepSeek / Gemini / 自定义"
                        list="provider-name-options"
                      />
                    </label>
                    <datalist id="provider-name-options">
                      <option value="OpenAI" />
                      <option value="Anthropic" />
                      <option value="DeepSeek" />
                      <option value="Gemini" />
                      <option value="cc-switch" />
                      <option value="本地模型" />
                      <option value="自定义" />
                    </datalist>
                    <div className="settingRow">
                      <label>
                        调用方式
                        <select
                          value={profile.providerType}
                          onChange={(event) => updateProfile(profile.id, "providerType", event.target.value as ModelProfile["providerType"])}
                        >
                          <option value="direct">直连 API</option>
                          <option value="local">本地模型</option>
                          <option value="ccSwitch">cc-switch 本地代理</option>
                        </select>
                      </label>
                      <label>
                        API 格式
                        <select
                          value={profile.apiFormat}
                          onChange={(event) => updateProfile(profile.id, "apiFormat", event.target.value as ModelProfile["apiFormat"])}
                        >
                          <option value="responses">OpenAI Responses</option>
                          <option value="chatCompletions">Chat Completions</option>
                          <option value="gemini">Gemini 原生</option>
                        </select>
                      </label>
                    </div>
                    <label>
                      Base URL
                      <input
                        value={profile.baseUrl}
                        onChange={(event) => updateProfile(profile.id, "baseUrl", event.target.value)}
                        placeholder={isCcSwitchProfile ? "http://127.0.0.1:15721/v1" : "https://api.example.com/v1"}
                      />
                    </label>
                    {isCcSwitchProfile ? (
                      <div className="ccSwitchGuide">
                        <strong>cc-switch 使用方式</strong>
                        <span>在 cc-switch 中先配置 Claude Code 可用的供应商与模型；这里选择“cc-switch 本地代理”，只填写本地路由地址，API Key 留给 cc-switch 管理。</span>
                      </div>
                    ) : (
                      <label>
                        API Key
                        <span className="secretInput">
                          <input
                            value={profile.apiKey}
                            onChange={(event) => updateProfile(profile.id, "apiKey", event.target.value)}
                            placeholder="sk-..."
                            type={visibleKeys[profile.id] ? "text" : "password"}
                          />
                          <button
                            type="button"
                            onClick={() => setVisibleKeys((current) => ({ ...current, [profile.id]: !current[profile.id] }))}
                            title={visibleKeys[profile.id] ? "隐藏 API Key" : "显示 API Key"}
                          >
                            {visibleKeys[profile.id] ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </span>
                      </label>
                    )}
                    <label>
                      模型
                      <input
                        value={profile.model}
                        onChange={(event) => updateProfile(profile.id, "model", event.target.value)}
                        placeholder="例如 gpt-4.1 / claude-sonnet-4-5 / deepseek-chat / gemini-2.5-pro"
                      />
                    </label>
                    <div className="modelPickerBlock">
                      <button
                        type="button"
                        onClick={() => fetchModelsForProfile(profile)}
                        disabled={modelCatalogs[profile.id]?.loading || !profile.baseUrl}
                      >
                        {modelCatalogs[profile.id]?.loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                        获取模型列表
                      </button>
                      {modelCatalogs[profile.id]?.models.length ? (
                        <select
                          value={profile.model}
                          onChange={(event) => updateProfile(profile.id, "model", event.target.value)}
                        >
                          <option value={profile.model}>{profile.model || "选择模型"}</option>
                          {modelCatalogs[profile.id].models.map((model) => (
                            <option value={model.id} key={model.id}>
                              {model.displayName && model.displayName !== model.id ? `${model.displayName} · ${model.id}` : model.id}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {modelCatalogs[profile.id]?.message && (
                        <p className={`modelCatalogMessage ${modelCatalogs[profile.id].models.length ? "ok" : "bad"}`}>
                          {modelCatalogs[profile.id].message}
                        </p>
                      )}
                    </div>
                    <div className="settingActions">
                      <button type="button" onClick={() => removeProfile(profile.id)} disabled={profiles.length <= 1}>
                        <Trash2 size={14} />
                        删除配置
                      </button>
                    </div>
                  </article>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <section className={`collapsibleSettings ${assignmentsExpanded ? "expanded" : ""}`}>
          <button
            className="collapsibleHeading"
            type="button"
            onClick={() => setAssignmentsExpanded((value) => !value)}
            aria-expanded={assignmentsExpanded}
          >
            <ChevronRight size={16} />
            <span>
              <strong>Agent 使用配置</strong>
              <small>{settings.length} 个 Agent · 只选择已配置好的 provider + model</small>
            </span>
            <em>{assignmentsExpanded ? "收起" : "展开设置"}</em>
          </button>
          {!assignmentsExpanded ? (
            <div className="collapsedSummary">
              <span>已分配 {Object.keys(assignments).length} 个 Agent</span>
              <span>搜索：{searchDraft.searchProvider === "mock" ? "暂不联网" : searchDraft.searchProvider}</span>
            </div>
          ) : (
            <div className="collapsibleBody agentAssignments">
              <div className="sectionHeading">
                <span>为每个 Agent 选择模型配置档，并设置联网搜索 Provider。</span>
              </div>
              <div className="assignmentGrid">
                {settings.map((setting) => {
                  const testSetting = settingForRole(setting.role);
                  return (
                    <article className="assignmentCard" key={setting.role}>
                      <div>
                        <strong>{setting.title}</strong>
                        <span>{setting.role}</span>
                      </div>
                      <select
                        value={assignments[setting.role] || profiles[0]?.id || ""}
                        onChange={(event) => setAssignments((current) => ({ ...current, [setting.role]: event.target.value }))}
                      >
                        {profiles.map((profile) => (
                          <option value={profile.id} key={profile.id}>
                            {profile.name || profile.providerName} · {profile.model || "未填写模型"}
                          </option>
                        ))}
                      </select>
                      {setting.role === "research" && (
                        <div className="searchProviderBlock">
                          <label>
                            搜索 Provider
                            <select
                              value={searchDraft.searchProvider || "mock"}
                              onChange={(event) => setSearchDraft((current) => ({ ...current, searchProvider: event.target.value as NonNullable<ModelSetting["searchProvider"]> }))}
                            >
                              <option value="mock">暂不联网</option>
                              <option value="tavily">Tavily</option>
                              <option value="serper">Serper (Google)</option>
                              <option value="custom">自定义 /search 接口</option>
                            </select>
                          </label>
                          {searchDraft.searchProvider === "custom" && (
                            <label>
                              搜索 Base URL
                              <input
                                value={searchDraft.searchBaseUrl || ""}
                                onChange={(event) => setSearchDraft((current) => ({ ...current, searchBaseUrl: event.target.value }))}
                                placeholder="https://your-search.example.com"
                              />
                            </label>
                          )}
                          {searchDraft.searchProvider !== "mock" && (
                            <label>
                              搜索 API Key
                              <span className="secretInput">
                                <input
                                  value={searchDraft.searchApiKey || ""}
                                  onChange={(event) => setSearchDraft((current) => ({ ...current, searchApiKey: event.target.value }))}
                                  placeholder="留空则复用模型 API Key"
                                  type={visibleKeys.searchApiKey ? "text" : "password"}
                                />
                                <button
                                  type="button"
                                  onClick={() => setVisibleKeys((current) => ({ ...current, searchApiKey: !current.searchApiKey }))}
                                  title={visibleKeys.searchApiKey ? "隐藏搜索 API Key" : "显示搜索 API Key"}
                                >
                                  {visibleKeys.searchApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                                </button>
                              </span>
                            </label>
                          )}
                        </div>
                      )}
                      <button type="button" onClick={() => onTest(testSetting)} disabled={testingRole === setting.role}>
                        {testingRole === setting.role ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                        测试该 Agent
                      </button>
                      {testResults[setting.role] && (
                        <p className={`settingTest ${testResults[setting.role].ok ? "ok" : "bad"}`}>
                          {testResults[setting.role].message}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <footer>
          <button onClick={save} disabled={isSaving}>
            {isSaving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            保存设置
          </button>
        </footer>
      </section>
    </div>
  );
}

function BriefForm({
  brief,
  onChange,
  disabled
}: {
  brief: WritingBrief;
  onChange: <K extends keyof WritingBrief>(key: K, value: WritingBrief[K]) => void;
  disabled: boolean;
}) {
  return (
    <div className="briefForm">
      <label>
        材料类型
        <input
          value={brief.materialType}
          onChange={(event) => onChange("materialType", event.target.value)}
          disabled={disabled}
          list="material-type-options"
          placeholder="可自定义，如党课讲稿、公函、请示"
        />
        <datalist id="material-type-options">
          {["工作汇报", "领导讲话稿", "工作总结", "调研报告", "经验材料", "方案", "党课讲稿", "业务培训讲课材料", "公函", "报告", "请示", "通知", "通报", "会议纪要", "发言材料"].map((item) => (
            <option value={item} key={item} />
          ))}
        </datalist>
      </label>
      <label className="wide">
        主题
        <input value={brief.theme} onChange={(event) => onChange("theme", event.target.value)} disabled={disabled} placeholder="填写写作主题或标题方向" />
      </label>
      <label>
        使用场景
        <input value={brief.scene} onChange={(event) => onChange("scene", event.target.value)} disabled={disabled} />
      </label>
      <label>
        受众
        <input value={brief.audience} onChange={(event) => onChange("audience", event.target.value)} disabled={disabled} />
      </label>
      <label>
        字数
        <input value={brief.targetWords} onChange={(event) => onChange("targetWords", event.target.value)} disabled={disabled} />
      </label>
      <label>
        单位/地区背景
        <input value={brief.orgContext} onChange={(event) => onChange("orgContext", event.target.value)} disabled={disabled} />
      </label>
      <label className="wide">
        必须体现
        <input value={brief.keywords} onChange={(event) => onChange("keywords", event.target.value)} disabled={disabled} />
      </label>
      <label className="wide">
        禁止内容
        <input value={brief.forbidden} onChange={(event) => onChange("forbidden", event.target.value)} disabled={disabled} />
      </label>
      <label className="wide">
        背景补充
        <textarea value={brief.background} onChange={(event) => onChange("background", event.target.value)} disabled={disabled} />
      </label>
    </div>
  );
}

function OutputTabs({
  task,
  selectedStage,
  onAuditFeedback,
  onAuditRequest,
  onOutputFeedback,
  onRerun,
  onToggleLock,
  onRevisionReview
}: {
  task: Task | null;
  selectedStage: WorkflowStage;
  onAuditFeedback: (auditId: string, opinion: string) => void;
  onAuditRequest: (payload: AuditRequestPayload) => void;
  onOutputFeedback: (payload: OutputFeedbackPayload) => void;
  onRerun: (taskId: string, stepId: string) => void;
  onToggleLock: (id: string, shouldLock: boolean) => void;
  onRevisionReview: (comments: RevisionComment[], skipped?: boolean) => void;
}) {
  const [tab, setTab] = useState("ideas");
  const [fullContent, setFullContent] = useState<{ title: string; text: string; subtitle?: string } | null>(null);

  useEffect(() => {
    if (selectedStage === "brief" || selectedStage === "thinking") setTab("ideas");
    if (selectedStage === "materials") setTab("materials");
    if (selectedStage === "final") setTab("draft");
  }, [task?.id, selectedStage]);

  if (!task) return <div className="placeholder">启动任务后，Agent 输出会在这里汇总。</div>;

  const tabs = [
    ["ideas", "思路"],
    ["research", "资料"],
    ["outline", "大纲"],
    ["materials", "素材"],
    ["style", "文风"],
    ["audit", "审计"],
    ["draft", "定稿"]
  ];

  return (
    <div className="outputs">
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "ideas" && <IdeasView task={task} onOpenContent={setFullContent} onAuditRequest={onAuditRequest} onOutputFeedback={onOutputFeedback} onRerun={onRerun} />}
      {tab === "research" && <ResearchView task={task} onOpenContent={setFullContent} onAuditRequest={onAuditRequest} onOutputFeedback={onOutputFeedback} onRerun={onRerun} />}
      {tab === "outline" && <OutlineView task={task} onOpenContent={setFullContent} onAuditRequest={onAuditRequest} onOutputFeedback={onOutputFeedback} onRerun={onRerun} />}
      {tab === "materials" && <ExtractedView task={task} onOpenContent={setFullContent} onAuditRequest={onAuditRequest} onOutputFeedback={onOutputFeedback} onRerun={onRerun} />}
      {tab === "style" && <StyleView task={task} onOpenContent={setFullContent} onAuditRequest={onAuditRequest} onOutputFeedback={onOutputFeedback} onRerun={onRerun} />}
      {tab === "audit" && <AuditView task={task} onFeedback={onAuditFeedback} onOpenContent={setFullContent} />}
      {tab === "draft" && (
        <DraftView
          task={task}
          onToggleLock={onToggleLock}
          onOpenContent={setFullContent}
          onAuditRequest={onAuditRequest}
          onOutputFeedback={onOutputFeedback}
          onRerun={onRerun}
          onRevisionReview={onRevisionReview}
        />
      )}
      {fullContent && <FullContentDialog content={fullContent} onClose={() => setFullContent(null)} />}
    </div>
  );
}

function CompactText({
  title,
  text,
  subtitle,
  onOpenContent,
  lines = 4
}: {
  title: string;
  text: string;
  subtitle?: string;
  onOpenContent: (content: { title: string; text: string; subtitle?: string }) => void;
  lines?: number;
}) {
  const value = String(text || "");
  if (!value) return null;
  return (
    <div className="compactText">
      <p style={{ WebkitLineClamp: lines }}>{value}</p>
      <button type="button" onClick={() => onOpenContent({ title, text: value, subtitle })}>
        查看全文
      </button>
    </div>
  );
}

function FullContentDialog({
  content,
  onClose
}: {
  content: { title: string; text: string; subtitle?: string };
  onClose: () => void;
}) {
  const charCount = Array.from(content.text || "").length;
  return (
    <div className="contentOverlay">
      <section className="contentDialog">
        <header>
          <div>
            {content.subtitle && <p>{content.subtitle}</p>}
            <h2>{content.title}</h2>
            <small>{charCount.toLocaleString("zh-CN")} 字 · 正文区域可滚动查看到底</small>
          </div>
          <button type="button" onClick={onClose}>关闭</button>
        </header>
        <pre>{content.text}</pre>
      </section>
    </div>
  );
}

function feedbackForTarget(task: Task, targetId: string) {
  return (task.outputs.outputFeedback || []).filter((item: any) => item.targetId === targetId);
}

function OutputFeedbackBox({
  task,
  targetId,
  targetTitle,
  stepId,
  sourceStep,
  role,
  auditContent,
  onAuditRequest,
  onOutputFeedback,
  onRerun
}: {
  task: Task;
  targetId: string;
  targetTitle: string;
  stepId: string;
  sourceStep: string;
  role?: string;
  auditContent?: string;
  onAuditRequest: (payload: AuditRequestPayload) => void;
  onOutputFeedback: (payload: OutputFeedbackPayload) => void;
  onRerun: (taskId: string, stepId: string) => void;
}) {
  const [opinion, setOpinion] = useState("");
  const [rerunState, setRerunState] = useState({ active: false, seenRunning: false });
  const [auditState, setAuditState] = useState(false);
  const feedback = feedbackForTarget(task, targetId);
  const stepIsRunning = task.status === "running" && task.steps.some((step) => step.id === stepId && step.status === "running");
  const isRerunning = rerunState.active;
  const canRerun = RERUNNABLE_STEP_IDS.has(stepId) && task.status !== "running";
  const canAudit = Boolean(String(auditContent || "").trim()) && !auditState;
  const payloadBase = { targetId, targetTitle, stepId, sourceStep, role };

  useEffect(() => {
    if (!auditState) return;
    const timer = setTimeout(() => setAuditState(false), 3500);
    return () => clearTimeout(timer);
  }, [auditState]);

  useEffect(() => {
    if (!rerunState.active) return;
    if (stepIsRunning && !rerunState.seenRunning) {
      setRerunState({ active: true, seenRunning: true });
      return;
    }
    if (rerunState.seenRunning && !stepIsRunning) {
      setRerunState({ active: false, seenRunning: false });
      return;
    }
    if (!rerunState.seenRunning && !stepIsRunning) {
      const timer = setTimeout(() => setRerunState({ active: false, seenRunning: false }), 3000);
      return () => clearTimeout(timer);
    }
  }, [rerunState.active, rerunState.seenRunning, stepIsRunning]);

  return (
    <div className="outputFeedbackBox">
      {feedback.length > 0 && (
        <div className="outputFeedbackHistory">
          {feedback.slice(0, 3).map((item: any) => (
            <p key={item.id}>
              <strong>{item.status === "approved" ? "无意见" : "修改意见"}</strong>
              <span>{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
              {item.opinion && <em>{item.opinion}</em>}
            </p>
          ))}
        </div>
      )}
      <textarea
        value={opinion}
        onChange={(event) => setOpinion(event.target.value)}
        placeholder="填写对这段生成内容的修改意见；没有意见可直接点“无意见”。"
      />
      <div className="outputFeedbackActions">
        <button
          type="button"
          onClick={() => {
            onOutputFeedback({ ...payloadBase, opinion, status: "comment" });
            setOpinion("");
          }}
          disabled={!opinion.trim()}
        >
          <ClipboardCheck size={15} />
          记录意见
        </button>
        <button
          type="button"
          className="quiet"
          onClick={() => onOutputFeedback({ ...payloadBase, opinion: "", status: "approved" })}
        >
          无意见
        </button>
        <button
          type="button"
          className="quiet"
          disabled={!canAudit}
          title={canAudit ? "调用审计 Agent 检查当前生成内容" : "没有可审计内容或审计正在进行"}
          onClick={() => {
            const content = String(auditContent || "").trim();
            if (!content) return;
            setAuditState(true);
            onAuditRequest({ targetId, targetTitle, sourceStep, content });
          }}
        >
          <ShieldCheck size={15} className={auditState ? "spin" : ""} />
          审计
        </button>
        <button
          type="button"
          className={`quiet ${isRerunning ? "rerunning" : ""}`}
          disabled={!canRerun}
          title={isRerunning ? "正在重新生成" : canRerun ? "按已记录意见从该环节重新生成" : "任务运行中不可重跑"}
          onClick={() => {
            if (window.confirm(`确认重新生成“${targetTitle}”?该环节及后续步骤会重新执行。`)) {
              setRerunState({ active: true, seenRunning: false });
              onRerun(task.id, stepId);
            }
          }}
        >
          <RefreshCw size={15} className={isRerunning ? "spin" : ""} />
          重新生成
        </button>
      </div>
    </div>
  );
}

const THINKING_ROLE_KEYS = ["thinkChief", "thinkGemini", "thinkDeepseek"];

function latestModelWarning(task: Task, role: string, purpose?: string) {
  return (task.outputs.modelCallWarnings || []).find((warning: any) =>
    warning.role === role && (!purpose || warning.purpose === purpose)
  );
}

function ModelFailureNotice({ warning, title }: { warning: any; title: string }) {
  return (
    <div className="modelFailureNotice">
      <strong>{title}</strong>
      <span>{warning?.message || "模型调用失败或超时，没有生成可用内容。"}</span>
      <small>请检查模型配置、接口状态或稍后点击“重新生成”。系统不会用本地兜底内容替代真实生成结果。</small>
    </div>
  );
}

function IdeasView({
  task,
  onOpenContent,
  onAuditRequest,
  onOutputFeedback,
  onRerun
}: {
  task: Task;
  onOpenContent: (content: { title: string; text: string; subtitle?: string }) => void;
  onAuditRequest: (payload: AuditRequestPayload) => void;
  onOutputFeedback: (payload: OutputFeedbackPayload) => void;
  onRerun: (taskId: string, stepId: string) => void;
}) {
  const ideas = task.outputs.agentIdeas || [];
  return (
    <div className="cardGrid">
      {ideas.length ? (
        ideas.map((idea: any, index: number) => (
          <article className="agentCard" key={`${idea.agent}-${index}`}>
            {(() => {
              const roleKey = THINKING_ROLE_KEYS[index] || "";
              const liveText = task.outputs.liveModelNotes?.[roleKey]?.text;
              const warning = latestModelWarning(task, roleKey, "构思");
              const hasModelFailure = !liveText && Boolean(warning);
              const rawFallback = String(idea.core_thesis || "");
              const displayText = String(liveText || rawFallback);
              const displayAgent = task.outputs.liveModelNotes?.[roleKey]?.model || warning?.model || idea.agent;
              const outputMode = liveText ? "真实模型输出" : hasModelFailure ? "调用失败" : "本地模板";
              return (
                <>
            <div>
              <strong>{displayAgent}</strong>
              <span>{idea.role} · {outputMode}</span>
            </div>
            {hasModelFailure ? (
              <ModelFailureNotice warning={warning} title={`${displayAgent} 构思未生成`} />
            ) : (
              <>
                <CompactText title={`${displayAgent} 构思全文`} subtitle={`${idea.role} · ${outputMode}`} text={displayText} onOpenContent={onOpenContent} />
                <List title="角度" items={idea.angles} />
                <List title="风险" items={idea.risk_points} />
              </>
            )}
            <OutputFeedbackBox
              task={task}
              targetId={`idea:${index}`}
              targetTitle={`${displayAgent} 构思`}
              stepId="parallel-thinking"
              sourceStep="三 Agent 并行构思"
              role={roleKey || idea.agent}
              auditContent={hasModelFailure ? "" : displayText}
              onAuditRequest={onAuditRequest}
              onOutputFeedback={onOutputFeedback}
              onRerun={onRerun}
            />
                </>
              );
            })()}
          </article>
        ))
      ) : (
        <div className="placeholder">等待三个 Agent 并行构思。</div>
      )}
      {task.outputs.synthesis && (
        <article className="wideCard">
          {(() => {
            const liveText = task.outputs.liveModelNotes?.synthesis?.text;
            const warning = latestModelWarning(task, "synthesis", "思路汇总");
            const hasModelFailure = !liveText && Boolean(warning);
            const model = task.outputs.liveModelNotes?.synthesis?.model || warning?.model || "思路汇总模型";
            const synthesisContent = String(liveText || task.outputs.synthesis.finalThesis || "");
            return (
              <>
          <h3>{model} 取舍记录</h3>
          {hasModelFailure ? (
            <ModelFailureNotice warning={warning} title={`${model} 思路汇总未生成`} />
          ) : (
            <>
              <CompactText title="思路汇总取舍记录" text={liveText || task.outputs.synthesis.finalThesis} onOpenContent={onOpenContent} />
              <List title="保留" items={task.outputs.synthesis.retained} />
              <List title="删除" items={task.outputs.synthesis.removed} />
            </>
          )}
          <OutputFeedbackBox
            task={task}
            targetId="synthesis"
            targetTitle="思路汇总取舍记录"
            stepId="synthesis"
            sourceStep="GPT 汇总思路"
            role="synthesis"
            auditContent={hasModelFailure ? "" : synthesisContent}
            onAuditRequest={onAuditRequest}
            onOutputFeedback={onOutputFeedback}
            onRerun={onRerun}
          />
              </>
            );
          })()}
        </article>
      )}
    </div>
  );
}

function ResearchView({
  task,
  onOpenContent,
  onAuditRequest,
  onOutputFeedback,
  onRerun
}: {
  task: Task;
  onOpenContent: (content: { title: string; text: string; subtitle?: string }) => void;
  onAuditRequest: (payload: AuditRequestPayload) => void;
  onOutputFeedback: (payload: OutputFeedbackPayload) => void;
  onRerun: (taskId: string, stepId: string) => void;
}) {
  const cards = task.outputs.researchCards || [];
  return cards.length ? (
    <div className="sourceList">
      {cards.map((card: any, index: number) => (
        <article className="sourceCard" key={card.id}>
          <div>
            <Search size={16} />
            <strong>{card.title}</strong>
            <span>{card.source}</span>
          </div>
          <CompactText title={card.title} subtitle={card.source} text={card.summary} onOpenContent={onOpenContent} />
          <List title="可引用要点" items={card.usablePoints} />
          <OutputFeedbackBox
            task={task}
            targetId={`research:${card.id || index}`}
            targetTitle={card.title || "资料卡片"}
            stepId="research"
            sourceStep="联网资料检索"
            role="research"
            auditContent={[card.summary, ...(card.usablePoints || [])].filter(Boolean).join("\n")}
            onAuditRequest={onAuditRequest}
            onOutputFeedback={onOutputFeedback}
            onRerun={onRerun}
          />
        </article>
      ))}
    </div>
  ) : (
    <div className="placeholder">等待资料检索结果。</div>
  );
}

function OutlineView({
  task,
  onOpenContent,
  onAuditRequest,
  onOutputFeedback,
  onRerun
}: {
  task: Task;
  onOpenContent: (content: { title: string; text: string; subtitle?: string }) => void;
  onAuditRequest: (payload: AuditRequestPayload) => void;
  onOutputFeedback: (payload: OutputFeedbackPayload) => void;
  onRerun: (taskId: string, stepId: string) => void;
}) {
  const outline = task.outputs.finalOutline;
  if (!outline) return <div className="placeholder">等待定稿大纲。</div>;
  return (
    <div className="outline">
      <h3>{outline.title}</h3>
      {outline.sections.map((section: any) => (
        <div className="outlineSection" key={section.id}>
          <strong>{section.title}</strong>
          <List title="本段要点" items={section.points} />
          {section.children?.map((child: any) => (
            <div className="outlineChild" key={child.id}>
              <span>{child.title}</span>
              <p>{child.points.join("；")}</p>
            </div>
          ))}
        </div>
      ))}
      {outline.liveText && (
        <article className="wideCard">
          <h3>真实模型定稿大纲</h3>
          <CompactText title="真实模型定稿大纲" text={outline.liveText} onOpenContent={onOpenContent} />
        </article>
      )}
      <article className="wideCard">
        <h3>大纲修改意见</h3>
        <OutputFeedbackBox
          task={task}
          targetId="final-outline"
          targetTitle="定稿大纲"
          stepId="final-outline"
          sourceStep="定稿大纲"
          role="finalOutline"
          auditContent={outline.liveText || JSON.stringify(outline, null, 2)}
          onAuditRequest={onAuditRequest}
          onOutputFeedback={onOutputFeedback}
          onRerun={onRerun}
        />
      </article>
    </div>
  );
}

function ExtractedView({
  task,
  onOpenContent,
  onAuditRequest,
  onOutputFeedback,
  onRerun
}: {
  task: Task;
  onOpenContent: (content: { title: string; text: string; subtitle?: string }) => void;
  onAuditRequest: (payload: AuditRequestPayload) => void;
  onOutputFeedback: (payload: OutputFeedbackPayload) => void;
  onRerun: (taskId: string, stepId: string) => void;
}) {
  const data = task.outputs.extractedMaterials;
  if (!data) return <div className="placeholder">用户补充材料后，将显示可用素材库。</div>;
  return (
    <div className="extractGrid">
      <List title="可核实事实" items={data.facts} />
      <List title="案例" items={data.cases} />
      <List title="数据" items={data.numbers} />
      <List title="可复用表述" items={data.phrases} />
      <List title="约束" items={data.constraints} />
      {data.liveText && (
        <article className="wideCard">
          <h3>真实模型提炼</h3>
          <CompactText title="真实模型提炼" text={data.liveText} onOpenContent={onOpenContent} />
        </article>
      )}
      <article className="wideCard">
        <h3>素材提炼修改意见</h3>
        <OutputFeedbackBox
          task={task}
          targetId="extract"
          targetTitle="事实素材提炼"
          stepId="extract"
          sourceStep="事实素材提炼"
          role="factExtractor"
          auditContent={data.liveText || JSON.stringify(data, null, 2)}
          onAuditRequest={onAuditRequest}
          onOutputFeedback={onOutputFeedback}
          onRerun={onRerun}
        />
      </article>
    </div>
  );
}

function StyleView({
  task,
  onOpenContent,
  onAuditRequest,
  onOutputFeedback,
  onRerun
}: {
  task: Task;
  onOpenContent: (content: { title: string; text: string; subtitle?: string }) => void;
  onAuditRequest: (payload: AuditRequestPayload) => void;
  onOutputFeedback: (payload: OutputFeedbackPayload) => void;
  onRerun: (taskId: string, stepId: string) => void;
}) {
  const style = task.outputs.stylePrompt;
  if (!style) return <div className="placeholder">事实素材提炼完成后，上传文风参考材料，这里会显示 deepseek 归纳出的文风提示词。</div>;
  return (
    <div className="stylePrompt">
      <article className="wideCard">
        <h3>deepseek-V4-pro 文风归纳</h3>
        <CompactText title="文风归纳" text={style.tone} onOpenContent={onOpenContent} />
        <List title="结构形式" items={style.structure} />
        <List title="表述规则" items={style.expressionRules} />
        <List title="常用表达" items={style.phraseBank} />
      </article>
      <article className="wideCard">
        <h3>输出给 Gemini 的提示词</h3>
        <CompactText title="输出给起草模型的文风提示词" text={style.prompt} onOpenContent={onOpenContent} lines={5} />
        <OutputFeedbackBox
          task={task}
          targetId="style-extract"
          targetTitle="文风提示词"
          stepId="style-extract"
          sourceStep="文风提炼"
          role="styleExtractor"
          auditContent={style.prompt || JSON.stringify(style, null, 2)}
          onAuditRequest={onAuditRequest}
          onOutputFeedback={onOutputFeedback}
          onRerun={onRerun}
        />
      </article>
    </div>
  );
}

type DraftVersion = {
  id: string;
  stage: "initial" | "revised" | "final";
  source: string;
  length: number;
  text: string;
  createdAt: string;
};

const stageLabel: Record<DraftVersion["stage"], string> = {
  initial: "初稿",
  revised: "修改稿",
  final: "定稿"
};

function DraftView({
  task,
  onToggleLock,
  onOpenContent,
  onAuditRequest,
  onOutputFeedback,
  onRerun,
  onRevisionReview
}: {
  task: Task;
  onToggleLock: (id: string, shouldLock: boolean) => void;
  onOpenContent: (content: { title: string; text: string; subtitle?: string }) => void;
  onAuditRequest: (payload: AuditRequestPayload) => void;
  onOutputFeedback: (payload: OutputFeedbackPayload) => void;
  onRerun: (taskId: string, stepId: string) => void;
  onRevisionReview: (comments: RevisionComment[], skipped?: boolean) => void;
}) {
  const drafts = task.outputs.drafts || {};
  const history = (task.outputs.draftHistory || []) as DraftVersion[];
  const locked = task.lockedFinal || null;
  const available = [
    { id: "initial", label: "初稿", text: drafts.initial as string | undefined },
    { id: "revised", label: "修改稿", text: drafts.revised as string | undefined },
    { id: "final", label: "定稿", text: drafts.final as string | undefined }
  ].filter((item) => item.text);
  const [variant, setVariant] = useState<string>(available[available.length - 1]?.id || "final");
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState("");
  const [printHtml, setPrintHtml] = useState<string | null>(null);
  const [showRevisionReview, setShowRevisionReview] = useState(false);

  useEffect(() => {
    if (!available.length) return;
    if (!available.some((item) => item.id === variant)) {
      setVariant(available[available.length - 1].id);
    }
  }, [task.id, available.map((item) => item.id).join("|")]);

  useEffect(() => {
    setHistoryId(null);
  }, [task.id]);

  if (!available.length) {
    return <div className="placeholder">补充材料并继续生成后，这里会显示校对后的定稿。</div>;
  }

  const currentLive = available.find((item) => item.id === variant) || available[available.length - 1];
  const snapshot = historyId ? history.find((item) => item.id === historyId) : null;
  const display = snapshot ? { label: `${stageLabel[snapshot.stage]}·历史`, text: snapshot.text } : currentLive;
  const suffix = currentLive.id === "final" ? "" : `?variant=${currentLive.id}`;
  const feedbackStep = currentLive.id === "initial" ? "draft" : currentLive.id === "revised" ? "revise" : "proofread";
  const feedbackSource = currentLive.id === "initial" ? "Gemini 起草" : currentLive.id === "revised" ? "GPT 修改完善" : "deepseek 校对";
  const feedbackRole = currentLive.id === "initial" ? "drafter" : currentLive.id === "revised" ? "reviser" : "proofreader";
  const pendingRevisionCount = Array.isArray(task.outputs.pendingRevisionComments)
    ? task.outputs.pendingRevisionComments.length
    : 0;
  const isRevisionRunning = task.status === "running" && task.steps.some((step) => step.id === "revise" && step.status === "running");

  async function downloadDraft(format: "md" | "docx") {
    const title = task.brief.theme || task.brief.materialType || "公文材料";
    const extension = format === "docx" ? "docx" : "md";
    const endpoint = `/api/tasks/${task.id}/export${format === "docx" ? ".docx" : ""}${suffix}`;
    const mimeType = format === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "text/markdown";
    const nameSuffix = currentLive.id === "final" ? "" : `.${currentLive.id}`;
    setDownloadNotice("正在准备下载文件...");
    try {
      const message = await saveExportFile(endpoint, `${title}${nameSuffix}.${extension}`, mimeType);
      setDownloadNotice(message);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        setDownloadNotice("已取消保存。");
        return;
      }
      setDownloadNotice(err instanceof Error ? err.message : "下载失败");
    }
  }

  function openPrintView() {
    const title = task.brief.theme || task.brief.materialType || "公文材料";
    const subtitle = snapshot
      ? `${stageLabel[snapshot.stage]} 历史版本 · ${new Date(snapshot.createdAt).toLocaleString("zh-CN", { hour12: false })}`
      : `${currentLive.label} · ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    const html = buildPrintHtml(display.text ?? "", { title, subtitle });
    setPrintHtml(html);
  }

  return (
    <div className="draft">
      {locked ? (
        <div className="draftLockBanner locked">
          <ShieldCheck size={16} />
          <span>
            定稿已锁定 · {new Date(locked.lockedAt).toLocaleString("zh-CN", { hour12: false })}
            <small>后续重跑会保留锁定版,新产出记入历史。</small>
          </span>
          <button type="button" onClick={() => onToggleLock(task.id, false)}>
            解锁
          </button>
        </div>
      ) : drafts.final ? (
        <div className="draftLockBanner">
          <ShieldCheck size={16} />
          <span>当前定稿未锁定,重跑校对阶段会覆盖。</span>
          <button type="button" onClick={() => onToggleLock(task.id, true)}>
            锁定定稿
          </button>
        </div>
      ) : null}
      <div className="draftTabs">
        {available.map((item) => (
          <button
            key={item.id}
            className={!snapshot && item.id === currentLive.id ? "active" : ""}
            onClick={() => {
              setVariant(item.id);
              setHistoryId(null);
            }}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="draftActions">
        <button className="download" type="button" onClick={() => downloadDraft("md")}>
          <Download size={16} />
          下载 {currentLive.label} (Markdown)
        </button>
        <button className="download" type="button" onClick={() => downloadDraft("docx")}>
          <Download size={16} />
          下载 {currentLive.label} (DOCX)
        </button>
        <button className="download" type="button" onClick={openPrintView}>
          <Printer size={16} />
          打印 / 导出 PDF
        </button>
      </div>
      {downloadNotice && <div className="downloadNotice">{downloadNotice}</div>}
      {(pendingRevisionCount > 0 || isRevisionRunning) && (
        <div className="revisionRunningNotice">
          <Loader2 size={15} className={isRevisionRunning ? "spin" : ""} />
          <div>
            <strong>批注意见已提交</strong>
            <span>
              {isRevisionRunning
                ? "起草 Agent 正在按批注修改，完成后会刷新修改稿。"
                : `已记录 ${pendingRevisionCount} 条批注，等待起草 Agent 接手修改。`}
            </span>
          </div>
        </div>
      )}
      {task.status === "needs_revision_review" && drafts.revised && !task.outputs.revisionReview?.submittedAt && (
        <div className="revisionReviewEntry">
          <div>
            <strong>修改稿等待批注确认</strong>
            <span>打开大窗口阅读修改稿、标注位置并填写修改意见。</span>
          </div>
          <button type="button" onClick={() => setShowRevisionReview(true)}>
            <PencilLine size={15} />
            打开批注窗口
          </button>
        </div>
      )}
      <div className="draftPreview">
        <CompactText
          title={`${task.brief.theme || task.brief.materialType || "公文材料"} · ${display.label}`}
          subtitle={snapshot ? new Date(snapshot.createdAt).toLocaleString("zh-CN", { hour12: false }) : currentLive.label}
          text={display.text || ""}
          onOpenContent={onOpenContent}
          lines={8}
        />
        {!snapshot && (
          <OutputFeedbackBox
            task={task}
            targetId={`draft:${currentLive.id}`}
            targetTitle={currentLive.label}
            stepId={feedbackStep}
            sourceStep={feedbackSource}
            role={feedbackRole}
            auditContent={display.text || ""}
            onAuditRequest={onAuditRequest}
            onOutputFeedback={onOutputFeedback}
            onRerun={onRerun}
          />
        )}
      </div>
      {history.length > 0 && (
        <DraftHistorySection
          history={history}
          snapshotId={snapshot?.id || null}
          onPreview={(id) => setHistoryId(id)}
        />
      )}
      {showRevisionReview && drafts.revised && (
        <RevisionReviewDialog
          revisedText={String(drafts.revised)}
          onClose={() => setShowRevisionReview(false)}
          onSubmit={(comments, skipped) => {
            setShowRevisionReview(false);
            onRevisionReview(comments, skipped);
          }}
        />
      )}
      {printHtml && <PrintDialog html={printHtml} onClose={() => setPrintHtml(null)} />}
    </div>
  );
}

function RevisionReviewDialog({
  revisedText,
  onClose,
  onSubmit
}: {
  revisedText: string;
  onClose: () => void;
  onSubmit: (comments: RevisionComment[], skipped?: boolean) => void;
}) {
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const [anchor, setAnchor] = useState("");
  const [comment, setComment] = useState("");
  const [comments, setComments] = useState<RevisionComment[]>([]);

  function useSelectionAsAnchor() {
    const node = textRef.current;
    const selected = node ? revisedText.slice(node.selectionStart, node.selectionEnd).trim() : "";
    if (selected) setAnchor(selected.slice(0, 240));
  }

  function addComment() {
    if (!anchor.trim() || !comment.trim()) return;
    setComments((items) => [
      ...items,
      {
        id: `${Date.now()}-${items.length}`,
        anchor: anchor.trim(),
        comment: comment.trim()
      }
    ]);
    setAnchor("");
    setComment("");
  }

  return (
    <div className="revisionReviewOverlay">
      <section className="revisionReview revisionReviewDialog">
        <div className="revisionReviewHeader">
          <div>
            <strong>修改稿批注</strong>
            <span>在正文中选中文字后点击“填入批注位置”，再填写修改意见。</span>
          </div>
          <div>
            <button type="button" onClick={useSelectionAsAnchor}>
              <ClipboardCheck size={15} />
              填入批注位置
            </button>
            <button type="button" onClick={onClose}>关闭</button>
          </div>
        </div>
        <div className="revisionReviewBody">
          <textarea ref={textRef} value={revisedText} readOnly />
          <div className="revisionReviewSide">
            <div className="revisionCommentForm">
              <label>
                批注位置
                <input value={anchor} onChange={(event) => setAnchor(event.target.value)} placeholder="可粘贴原文段落、标题或关键词" />
              </label>
              <label>
                批注意见
                <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="说明希望如何调整、删改或补充" />
              </label>
              <button type="button" onClick={addComment} disabled={!anchor.trim() || !comment.trim()}>
                <Plus size={15} />
                添加批注
              </button>
            </div>
            {comments.length > 0 ? (
              <div className="revisionCommentList">
                {comments.map((item, index) => (
                  <article key={item.id || index}>
                    <strong>{index + 1}. {item.anchor}</strong>
                    <p>{item.comment}</p>
                    <button
                      type="button"
                      onClick={() => setComments((items) => items.filter((_, itemIndex) => itemIndex !== index))}
                      title="删除批注"
                    >
                      <Trash2 size={14} />
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="placeholder compact">尚未添加批注。</div>
            )}
          </div>
        </div>
        <div className="revisionReviewActions">
          <button className="secondaryAction" type="button" onClick={() => onSubmit([], true)}>
            无意见，进入定稿
          </button>
          <button className="primaryAction" type="button" onClick={() => onSubmit(comments)} disabled={!comments.length}>
            <Wand2 size={16} />
            提交批注并修改
          </button>
        </div>
      </section>
    </div>
  );
}

function PrintDialog({ html, onClose }: { html: string; onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  function printFrame() {
    const frame = frameRef.current?.contentWindow;
    frame?.focus();
    frame?.print();
  }
  return (
    <div className="printOverlay">
      <section className="printDialog">
        <header>
          <div>
            <p>打印预览</p>
            <h2>导出 PDF</h2>
          </div>
          <div>
            <button type="button" onClick={printFrame}>
              <Printer size={15} />
              打印 / 另存为 PDF
            </button>
            <button type="button" onClick={onClose}>关闭</button>
          </div>
        </header>
        <iframe ref={frameRef} srcDoc={html} title="打印预览" />
      </section>
    </div>
  );
}

function AuditView({
  task,
  onFeedback,
  onOpenContent
}: {
  task: Task;
  onFeedback: (auditId: string, opinion: string) => void;
  onOpenContent: (content: { title: string; text: string; subtitle?: string }) => void;
}) {
  const audits = task.outputs.qualityAudits || [];
  return audits.length ? (
    <div className="auditList">
      {audits.map((audit: any) => (
        <AuditCard audit={audit} key={audit.id} onFeedback={onFeedback} onOpenContent={onOpenContent} />
      ))}
    </div>
  ) : (
    <div className="placeholder">点击生成内容下方的“审计”按钮后，这里会显示质量审计结果。</div>
  );
}

function AuditCard({
  audit,
  onFeedback,
  onOpenContent
}: {
  audit: any;
  onFeedback: (auditId: string, opinion: string) => void;
  onOpenContent: (content: { title: string; text: string; subtitle?: string }) => void;
}) {
  const [opinion, setOpinion] = useState("");
  const hasRisk = audit.verdict !== "通过" || (audit.risks || []).length > 0 || audit.score < 90;
  return (
    <details className={`auditCard ${hasRisk ? "risk" : "ok"}`}>
      <summary>
        <span>
          <strong>{audit.sourceStep}</strong>
          <small>{audit.verdict} · {audit.score} 分</small>
        </span>
        <em>{audit.model} · {audit.mode === "live" ? "真实审计" : "本地模拟"}</em>
      </summary>
      <CompactText title={`${audit.sourceStep} 审计意见`} subtitle={audit.model} text={audit.summary} onOpenContent={onOpenContent} />
      <List title="问题内容/风险提示" items={audit.risks?.length ? audit.risks : ["未发现明确风险项。"]} />
      {audit.feedback?.length ? (
        <div className="auditFeedbackList">
          <strong>已确认意见</strong>
          {audit.feedback.map((item: any) => (
            <p key={item.id}>{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}：{item.opinion}</p>
          ))}
        </div>
      ) : null}
      <div className="auditFeedbackBox">
        <textarea
          value={opinion}
          onChange={(event) => setOpinion(event.target.value)}
          placeholder="填写对本条审计意见的确认、驳回或修改要求"
        />
        <button
          onClick={() => {
            onFeedback(audit.id, opinion);
            setOpinion("");
          }}
          disabled={!opinion.trim()}
        >
          <ClipboardCheck size={16} />
          记录确认意见
        </button>
      </div>
    </details>
  );
}

function MaterialBox({
  task,
  materialText,
  setMaterialText,
  queueUploadFiles,
  pendingUploads,
  removePendingUpload,
  uploadPendingFiles,
  addMaterial,
  continueTask,
  skipMaterialsAndContinue,
  deleteMaterial,
  isUploading,
  uploadNotice,
  sanitizeMaterials,
  setSanitizeMaterials,
  modelSettings,
  updateTaskSanitizer
}: {
  task: Task | null;
  materialText: string;
  setMaterialText: (value: string) => void;
  queueUploadFiles: (files: File[]) => void;
  pendingUploads: PendingUpload[];
  removePendingUpload: (id: string) => void;
  uploadPendingFiles: () => void;
  addMaterial: () => void;
  continueTask: () => void;
  skipMaterialsAndContinue: () => void;
  deleteMaterial: (id: string) => void;
  isUploading: boolean;
  uploadNotice: string;
  sanitizeMaterials: boolean;
  setSanitizeMaterials: (value: boolean) => void;
  modelSettings: ModelSetting[];
  updateTaskSanitizer: (setting: ModelSetting) => void;
}) {
  const requests = task?.outputs.materialRequests || [];
  const materialRequestFailure = task?.outputs.materialRequestFailure;
  const isStyleStage = task?.status === "needs_style";
  const canContinue = Boolean(task && (task.status === "needs_materials" || task.status === "needs_style"));
  const contentMaterials = task?.materials?.filter((material) => material.category !== "style") || [];
  const styleMaterials = task?.materials?.filter((material) => material.category === "style") || [];
  const hasRequiredMaterials = isStyleStage ? styleMaterials.length > 0 : contentMaterials.length > 0;
  const sanitizerOptions = useMemo(() => sanitizerOptionsFor(task, modelSettings), [task, modelSettings]);
  const selectedSanitizer =
    task?.modelSettings?.find((item) => item.role === "sanitizer") ||
    modelSettings.find((item) => item.role === "sanitizer") ||
    LOCAL_SANITIZER_PRESETS[0];
  const selectedSanitizerKey = sanitizerOptionKey(selectedSanitizer);

  return (
    <div className="materialBox">
      {materialRequestFailure && !isStyleStage ? (
        <div className="modelFailureNotice">
          <strong>补充材料清单生成失败</strong>
          <span>{materialRequestFailure.message || "模型未能生成可用的材料清单。"}</span>
          <small>{materialRequestFailure.model ? `${materialRequestFailure.model} · ` : ""}请检查模型配置或回到上一步重新生成。</small>
        </div>
      ) : isStyleStage ? (
        <div className="requestList">
          <div>
            <strong>文风参考材料</strong>
            <span>请上传你希望模仿的讲话稿、汇报稿、总结材料、领导常用表述等，deepseek 将提炼文字风格和表达形式。</span>
          </div>
        </div>
      ) : requests.length ? (
        <div className="requestList">
          {requests.map((item: any) => (
            <div key={item.type}>
              <strong>{item.type}</strong>
              <span>{item.prompt}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="placeholder compact">大纲完成后会列出需要补充的材料。</div>
      )}

      {contentMaterials.length || styleMaterials.length ? (
        <div className="uploadedList">
          {[...contentMaterials, ...styleMaterials].map((material) => (
            <div key={material.id}>
              <div className="uploadedRow">
                <strong>{material.name}</strong>
                <button
                  className="materialDelete"
                  onClick={() => deleteMaterial(material.id)}
                  title="移除该材料"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <span>
                {material.category === "style" ? "文风材料" : "事实材料"} · {material.kind} · {material.characters} 字 · {material.sanitized ? "已脱敏" : "未脱敏"}
              </span>
              {material.privacyReport?.summary && <small>{material.privacyReport.summary}</small>}
            </div>
          ))}
        </div>
      ) : null}

      <div className="sanitizeControls">
        <label className="sanitizeToggle">
          <input
            type="checkbox"
            checked={sanitizeMaterials}
            onChange={(event) => setSanitizeMaterials(event.target.checked)}
            disabled={!task || isUploading}
          />
          <span>入库前脱敏</span>
        </label>
        <label className="sanitizerSelect">
          <span>脱敏模型</span>
          <select
            value={selectedSanitizerKey}
            onChange={(event) => {
              const option = sanitizerOptions.find((item) => item.key === event.target.value);
              if (option) updateTaskSanitizer(option.setting);
            }}
            disabled={!task || isUploading || !sanitizeMaterials}
          >
            {sanitizerOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={`filePicker ${isUploading ? "loading" : ""}`} aria-busy={isUploading}>
        {isUploading ? <Loader2 size={16} className="spin" /> : <FileUp size={16} />}
        {isUploading ? "正在识别文件" : pendingUploads.length ? "继续选择文件" : isStyleStage ? "选择文风参考" : "选择事实材料"}
        <input
          type="file"
          accept=".txt,.md,.csv,.tsv,.xls,.xlsx,.doc,.docx,.pdf,.jpg,.jpeg,.png"
          multiple
          disabled={!task || isUploading}
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            if (files.length) queueUploadFiles(files);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {pendingUploads.length ? (
        <div className="pendingUploadList">
          <div>
            <strong>待上传文件</strong>
            <span>{pendingUploads.length} 个文件，确认后统一识别入库</span>
          </div>
          {pendingUploads.map((item) => (
            <div className="pendingUploadItem" key={item.id}>
              <span>
                <strong>{item.file.name}</strong>
                <small>{item.file.type || "未知类型"} · {formatFileSize(item.file.size)}</small>
              </span>
              <button type="button" onClick={() => removePendingUpload(item.id)} disabled={isUploading} title="移除待上传文件">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button className="pendingUploadConfirm" onClick={uploadPendingFiles} disabled={!task || !pendingUploads.length || isUploading}>
            {isUploading ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}
            确认上传 {pendingUploads.length} 个文件
          </button>
        </div>
      ) : null}
      {uploadNotice && <div className={`uploadNotice ${isUploading ? "running" : "done"}`}>{uploadNotice}</div>}
      <textarea
        value={materialText}
        onChange={(event) => setMaterialText(event.target.value)}
        placeholder={isStyleStage ? "粘贴希望模仿的文风段落、标题、常用表述等" : "粘贴做法、案例、成效数据、会议纪要等"}
        disabled={!task}
      />
      <div className="materialActions">
        <button onClick={addMaterial} disabled={!task || !materialText.trim()}>
          <Layers3 size={16} />
          提交材料
        </button>
        <button className="primary" onClick={continueTask} disabled={!canContinue || !hasRequiredMaterials}>
          <Wand2 size={16} />
          {isStyleStage ? "提炼文风并起草" : "提炼事实要点"}
        </button>
        <button className="skip" onClick={skipMaterialsAndContinue} disabled={!canContinue}>
          <Play size={16} />
          {isStyleStage ? "跳过文风直接起草" : "直接起草"}
        </button>
      </div>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="miniList">
      <b>{title}</b>
      {items.map((item, index) => (
        <span key={`${item}-${index}`}>{item}</span>
      ))}
    </div>
  );
}

type DiffOp = { type: "equal" | "add" | "remove"; left?: string; right?: string };

function diffLinesClient(oldText: string, newText: string): DiffOp[] {
  const splitLines = (text: string) => {
    const s = String(text || "");
    return s.length ? s.split(/\r?\n/) : [];
  };
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i += 1) dp.push(new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { ops.push({ type: "equal", left: a[i - 1], right: b[j - 1] }); i -= 1; j -= 1; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { ops.push({ type: "remove", left: a[i - 1] }); i -= 1; }
    else { ops.push({ type: "add", right: b[j - 1] }); j -= 1; }
  }
  while (i > 0) { ops.push({ type: "remove", left: a[i - 1] }); i -= 1; }
  while (j > 0) { ops.push({ type: "add", right: b[j - 1] }); j -= 1; }
  return ops.reverse();
}

function DraftHistorySection({
  history,
  snapshotId,
  onPreview
}: {
  history: DraftVersion[];
  snapshotId: string | null;
  onPreview: (id: string | null) => void;
}) {
  const [leftId, setLeftId] = useState<string>("");
  const [rightId, setRightId] = useState<string>("");
  const [mode, setMode] = useState<"list" | "diff">("list");

  const left = history.find((item) => item.id === leftId);
  const right = history.find((item) => item.id === rightId);
  const ops = left && right ? diffLinesClient(left.text, right.text) : [];
  const summary = ops.reduce(
    (acc, op) => {
      if (op.type === "add") acc.added += 1;
      else if (op.type === "remove") acc.removed += 1;
      else acc.equal += 1;
      return acc;
    },
    { added: 0, removed: 0, equal: 0 }
  );

  return (
    <details className="draftHistory" open={mode === "diff"}>
      <summary>历史版本 · 共 {history.length} 条</summary>
      <div className="draftHistoryModes">
        <button
          className={mode === "list" ? "active" : ""}
          onClick={() => setMode("list")}
          type="button"
        >
          列表预览
        </button>
        <button
          className={mode === "diff" ? "active" : ""}
          onClick={() => setMode("diff")}
          type="button"
        >
          并排对比
        </button>
      </div>

      {mode === "list" ? (
        <>
          <div className="draftHistoryList">
            {history.map((item) => (
              <button
                key={item.id}
                className={snapshotId === item.id ? "active" : ""}
                onClick={() => onPreview(snapshotId === item.id ? null : item.id)}
                type="button"
              >
                <strong>{stageLabel[item.stage]}</strong>
                <span>{item.source} · {item.length} 字</span>
                <small>{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}</small>
              </button>
            ))}
          </div>
          {snapshotId && (
            <div className="draftHistoryActions">
              <button onClick={() => onPreview(null)} type="button">
                <RefreshCw size={14} />
                返回当前版本
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="diffPickers">
            <label>
              旧版本
              <select value={leftId} onChange={(event) => setLeftId(event.target.value)}>
                <option value="">请选择</option>
                {history.map((item) => (
                  <option key={item.id} value={item.id}>
                    {stageLabel[item.stage]} · {new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              新版本
              <select value={rightId} onChange={(event) => setRightId(event.target.value)}>
                <option value="">请选择</option>
                {history.map((item) => (
                  <option key={item.id} value={item.id}>
                    {stageLabel[item.stage]} · {new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {left && right ? (
            <>
              <div className="diffSummary">
                <span className="add">+{summary.added}</span>
                <span className="remove">−{summary.removed}</span>
                <span className="equal">={summary.equal}</span>
              </div>
              <div className="diffTable">
                {ops.map((op, index) => (
                  <div className={`diffRow ${op.type}`} key={`${op.type}-${index}`}>
                    <pre className="diffLeft">{op.type === "add" ? "" : op.left ?? ""}</pre>
                    <pre className="diffRight">{op.type === "remove" ? "" : op.right ?? ""}</pre>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="placeholder compact">在上方选中两个版本后自动对比。</div>
          )}
        </>
      )}
    </details>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
