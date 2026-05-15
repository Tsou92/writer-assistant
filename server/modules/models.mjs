// 模型适配层:OpenAI Responses / Chat Completions / Gemini 三种格式的统一调用。
// 包含连接测试 helper,所有函数都是纯函数。
import { normalizeModelSetting, defaultModelSettings } from "../lib.mjs";

const CC_SWITCH_BASE_URL = "http://127.0.0.1:15721/v1";
const COMMON_GEMINI_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash"
].map((id) => ({
  id,
  name: id,
  displayName: id,
  description: "常用 Gemini 模型候选，请以 Google AI Studio/Vertex 当前可用模型为准。",
  inputTokenLimit: null,
  outputTokenLimit: null
}));

export function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

export function geminiModelName(value) {
  return String(value || "").trim().replace(/^models\//, "");
}

export function geminiEndpoint(baseUrl, model) {
  const base = stripTrailingSlash(baseUrl || "https://generativelanguage.googleapis.com/v1beta")
    .replace(/\/models$/, "");
  return `${base}/models/${encodeURIComponent(geminiModelName(model))}:generateContent`;
}

export function headersFor(setting) {
  const headers = { "content-type": "application/json" };
  if (setting.apiKey) headers.authorization = `Bearer ${setting.apiKey}`;
  if (setting.providerType === "ccSwitch" && !setting.apiKey) headers.authorization = "Bearer cc-switch";
  return headers;
}

export function extractResponseText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") chunks.push(content.text);
      if (typeof content?.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

export function extractChatText(data) {
  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
}

export function extractGeminiText(data) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

export function extractTokenUsage(data, apiFormat = "") {
  const usage = data?.usage || data?.usageMetadata || {};
  const input =
    usage.input_tokens ??
    usage.prompt_tokens ??
    usage.promptTokenCount ??
    usage.inputTokens ??
    usage.promptTokens ??
    0;
  const output =
    usage.output_tokens ??
    usage.completion_tokens ??
    usage.candidatesTokenCount ??
    usage.outputTokens ??
    usage.completionTokens ??
    0;
  const total =
    usage.total_tokens ??
    usage.totalTokenCount ??
    usage.totalTokens ??
    Number(input || 0) + Number(output || 0);
  return {
    input: Number(input || 0),
    output: Number(output || 0),
    total: Number(total || 0),
    apiFormat
  };
}

function providerName(setting) {
  return String(setting?.providerName || setting?.providerType || "").toLowerCase();
}

function normalizeModelList(data, setting) {
  if (Array.isArray(data?.models)) {
    return data.models
      .map((item) => ({
        id: geminiModelName(item.baseModelId || item.name || item.model || item.id),
        name: geminiModelName(item.name || item.baseModelId || item.model || item.id),
        displayName: item.displayName || item.name || item.baseModelId || item.id || "",
        description: item.description || "",
        inputTokenLimit: item.inputTokenLimit || null,
        outputTokenLimit: item.outputTokenLimit || null
      }))
      .filter((item) => item.id);
  }
  if (Array.isArray(data?.data)) {
    return data.data
      .map((item) => ({
        id: item.id || item.name || item.model,
        name: item.id || item.name || item.model,
        displayName: item.display_name || item.displayName || item.id || item.name || "",
        description: item.description || "",
        inputTokenLimit: item.input_token_limit || item.context_window || null,
        outputTokenLimit: item.output_token_limit || null
      }))
      .filter((item) => item.id);
  }
  if (Array.isArray(data)) {
    return data
      .map((item) => ({
        id: typeof item === "string" ? item : item.id || item.name || item.model,
        name: typeof item === "string" ? item : item.id || item.name || item.model,
        displayName: typeof item === "string" ? item : item.display_name || item.displayName || item.name || item.id || "",
        description: typeof item === "string" ? "" : item.description || "",
        inputTokenLimit: typeof item === "string" ? null : item.input_token_limit || item.context_window || null,
        outputTokenLimit: typeof item === "string" ? null : item.output_token_limit || null
      }))
      .filter((item) => item.id);
  }
  if (setting?.model) {
    return [{
      id: setting.model,
      name: setting.model,
      displayName: setting.model,
      description: "供应商未返回标准模型列表,已保留当前模型。",
      inputTokenLimit: null,
      outputTokenLimit: null
    }];
  }
  return [];
}

export async function listAvailableModels(setting) {
  const normalized = normalizeModelSetting(defaultModelSettings[0], {
    ...setting,
    role: defaultModelSettings[0].role,
    title: setting?.title || "模型配置"
  });
  if (normalized.providerType === "ccSwitch" && !normalized.baseUrl) normalized.baseUrl = CC_SWITCH_BASE_URL;
  const baseUrl = stripTrailingSlash(normalized.baseUrl);
  if (!baseUrl) throw new Error("请先填写 Base URL。");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let response;
    if ((normalized.apiFormat === "gemini" || providerName(setting).includes("gemini")) && !String(error.message || "").includes("API Key")) {
      if (!normalized.apiKey) throw new Error("Gemini 获取模型列表需要 API Key。");
      const base = stripTrailingSlash(baseUrl).replace(/\/models$/, "");
      response = await fetch(`${base}/models?key=${encodeURIComponent(normalized.apiKey)}&pageSize=1000`, {
        method: "GET",
        headers: { "content-type": "application/json" },
        signal: controller.signal
      });
    } else if (providerName(setting).includes("anthropic")) {
      if (!normalized.apiKey) throw new Error("Anthropic 获取模型列表需要 API Key。");
      response = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers: {
          "content-type": "application/json",
          "x-api-key": normalized.apiKey,
          authorization: `Bearer ${normalized.apiKey}`,
          "anthropic-version": "2023-06-01"
        },
        signal: controller.signal
      });
    } else {
      response = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers: headersFor(normalized),
        signal: controller.signal
      });
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok && normalized.providerType === "ccSwitch" && (response.status === 404 || response.status === 405)) {
      return {
        ok: true,
        provider: setting?.providerName || "cc-switch",
        models: normalizeModelList({}, setting),
        message: "cc-switch 本地路由未提供 /models 列表，请在 cc-switch 中配置模型后手动填写模型名。"
      };
    }
    if (!response.ok) throw new Error(data?.error?.message || data?.error || `获取模型列表失败：${response.status}`);
    return {
      ok: true,
      provider: setting?.providerName || normalized.providerType,
      models: normalizeModelList(data, setting)
    };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("获取模型列表超时，请确认接口服务可访问。");
    if (normalized.apiFormat === "gemini" || providerName(setting).includes("gemini")) {
      return {
        ok: true,
        provider: setting?.providerName || "Gemini",
        models: COMMON_GEMINI_MODELS,
        message: `Gemini 模型列表暂时无法连接（${error.message || "fetch failed"}），已提供常用模型候选。`
      };
    }
    if (String(error.message || "").includes("fetch failed")) {
      throw new Error(`无法连接模型列表接口：${baseUrl}/models。请确认网络、代理或 Base URL。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callLiveModelDetailed(setting, systemPrompt, userPrompt, options = {}) {
  if (!setting || setting.executionMode !== "live") return null;
  if (!setting.baseUrl) throw new Error(`${setting.title} 缺少 Base URL。`);
  if (setting.providerType !== "ccSwitch" && setting.providerType !== "local" && !setting.apiKey) {
    throw new Error(`${setting.title} 已启用真实调用，但缺少 API Key。`);
  }

  const baseUrl = stripTrailingSlash(setting.baseUrl);
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const externalSignal = options.signal;
  const externalAbort = () => {
    externallyAborted = true;
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) {
    externalAbort();
  } else if (externalSignal) {
    externalSignal.addEventListener("abort", externalAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 120000);
  try {
    if (setting.apiFormat === "gemini") {
      const url = `${geminiEndpoint(baseUrl, setting.model)}?key=${encodeURIComponent(setting.apiKey)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || `Gemini 请求失败：${response.status}`);
      return { text: extractGeminiText(data), usage: extractTokenUsage(data, "gemini") };
    }

    if (setting.apiFormat === "chatCompletions") {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: headersFor(setting),
        signal: controller.signal,
        body: JSON.stringify({
          model: setting.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.3
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || `Chat Completions 请求失败：${response.status}`);
      return { text: extractChatText(data), usage: extractTokenUsage(data, "chatCompletions") };
    }

    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: headersFor(setting),
      signal: controller.signal,
      body: JSON.stringify({
        model: setting.model,
        input: `${systemPrompt}\n\n${userPrompt}`,
        temperature: 0.3
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `Responses 请求失败：${response.status}`);
    return { text: extractResponseText(data), usage: extractTokenUsage(data, "responses") };
  } catch (error) {
    if (externallyAborted) {
      const reason = externalSignal?.reason;
      if (reason instanceof Error) throw reason;
      throw new Error(String(reason || "用户已暂停当前任务。"));
    }
    if (error.name === "AbortError") {
      throw new Error(`${setting.title || setting.role || "模型"}（${setting.model || "未填写模型"}）调用超过 120 秒，已中止本次请求。请检查该供应商响应速度、模型名或 Base URL。`);
    }
    if (String(error.message || "").includes("This operation was aborted")) {
      if (timedOut) {
        throw new Error(`${setting.title || setting.role || "模型"}（${setting.model || "未填写模型"}）调用超过 120 秒，已中止本次请求。请检查该供应商响应速度、模型名或 Base URL。`);
      }
      throw new Error(`${setting.title || setting.role || "模型"}（${setting.model || "未填写模型"}）请求被中止。请检查该供应商响应速度、模型名或 Base URL。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener("abort", externalAbort);
  }
}

export async function callLiveModel(setting, systemPrompt, userPrompt) {
  const result = await callLiveModelDetailed(setting, systemPrompt, userPrompt);
  return result?.text || null;
}

export async function testModelSetting(setting) {
  const fallback = defaultModelSettings.find((item) => item.role === setting?.role) || defaultModelSettings[0];
  const normalized = normalizeModelSetting(fallback, setting || {});
  if (normalized.providerType === "ccSwitch" && !normalized.baseUrl) normalized.baseUrl = CC_SWITCH_BASE_URL;
  const baseUrl = stripTrailingSlash(normalized.baseUrl);
  if (!baseUrl) throw new Error("请先填写 Base URL。");

  const probeUrl = normalized.apiFormat === "gemini"
    ? `${geminiEndpoint(baseUrl, normalized.model)}?key=${encodeURIComponent(normalized.apiKey || "")}`
    : `${baseUrl}/models`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    if (normalized.providerType === "local" && !normalized.apiKey) {
      const response = await fetch(probeUrl, { method: "GET", headers: { "content-type": "application/json" }, signal: controller.signal });
      if (response.ok) return { ok: true, message: "本地模型服务已连通，/models 可访问。" };
      const liveText = await callLiveModel({ ...normalized, executionMode: "live" }, "连接测试", "请回复：连接正常");
      if (liveText) return { ok: true, message: `本地模型请求可用，返回：${liveText.slice(0, 80)}` };
      throw new Error(`连接失败：${response.status}`);
    }

    if (normalized.apiFormat === "gemini") {
      if (!normalized.apiKey) throw new Error("Gemini 原生接口测试需要 API Key。");
      const response = await fetch(probeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "请回复：连接正常" }] }] })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || `连接失败：${response.status}`);
      return { ok: true, message: `Gemini 原生接口可用，模型返回：${extractGeminiText(data).slice(0, 80) || "已响应"}` };
    }

    const response = await fetch(probeUrl, { method: "GET", headers: headersFor(normalized), signal: controller.signal });
    if (response.ok) return { ok: true, message: `${normalized.providerType === "ccSwitch" ? "cc-switch" : "直连接口"}已连通，/models 可访问。` };

    const liveText = await callLiveModel({ ...normalized, executionMode: "live" }, "连接测试", "请回复：连接正常");
    if (liveText) return { ok: true, message: `模型请求可用，返回：${liveText.slice(0, 80)}` };
    throw new Error(`连接失败：${response.status}`);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("连接超时，请确认本地代理或接口服务已启动。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
