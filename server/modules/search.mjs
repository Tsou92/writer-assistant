// 联网搜索适配层:Tavily / Serper / 自定义。
// searchWeb 是纯函数;runWebSearch 接受 task,只读 modelSettings + log 回调。
import { stripTrailingSlash } from "./models.mjs";

export async function searchWeb(setting, query) {
  if (!setting || setting.executionMode !== "live") return null;
  const provider = setting.searchProvider || "mock";
  if (provider === "mock") return null;

  const timeout = 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    if (provider === "tavily") {
      const apiKey = setting.searchApiKey || setting.apiKey;
      if (!apiKey) throw new Error("Tavily 搜索缺少 API Key。");
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "basic",
          max_results: 5,
          include_answer: false,
          include_raw_content: false
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `Tavily 请求失败：${response.status}`);
      return (data?.results || []).map((item) => ({
        title: item.title || query,
        url: item.url || "",
        source: item.url ? new URL(item.url).hostname : "tavily",
        publishedAt: item.published_date || "",
        summary: item.content || ""
      }));
    }

    if (provider === "serper") {
      const apiKey = setting.searchApiKey || setting.apiKey;
      if (!apiKey) throw new Error("Serper 搜索缺少 API Key。");
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        signal: controller.signal,
        body: JSON.stringify({ q: query, num: 5, hl: "zh-cn" })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `Serper 请求失败：${response.status}`);
      return (data?.organic || []).slice(0, 5).map((item) => ({
        title: item.title || query,
        url: item.link || "",
        source: item.source || (item.link ? new URL(item.link).hostname : "serper"),
        publishedAt: item.date || "",
        summary: item.snippet || ""
      }));
    }

    if (provider === "custom") {
      const baseUrl = stripTrailingSlash(setting.searchBaseUrl);
      if (!baseUrl) throw new Error("自定义搜索接口缺少 Base URL。");
      const headers = { "content-type": "application/json" };
      if (setting.searchApiKey) headers.authorization = `Bearer ${setting.searchApiKey}`;
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({ query, limit: 5 })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `自定义搜索失败：${response.status}`);
      const items = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
      return items.slice(0, 5).map((item) => ({
        title: item.title || item.name || query,
        url: item.url || item.link || "",
        source: item.source || (item.url ? new URL(item.url).hostname : "custom"),
        publishedAt: item.publishedAt || item.date || "",
        summary: item.summary || item.snippet || item.content || ""
      }));
    }

    throw new Error(`未知搜索 provider：${provider}`);
  } finally {
    clearTimeout(timer);
  }
}

// runWebSearch 把 task.modelSettings 中 research 角色的搜索能力包起来,
// onLog 用于把搜索失败信息回传到 task 日志(由调用方注入),保持模块无副作用。
export async function runWebSearch(task, keywords, settingFor, onLog) {
  const setting = settingFor(task.modelSettings, "research");
  if (!setting || setting.executionMode !== "live" || !setting.searchProvider || setting.searchProvider === "mock") {
    return { results: [], provider: setting?.searchProvider || "mock" };
  }
  const collected = [];
  for (const keyword of keywords.slice(0, 5)) {
    try {
      const hits = await searchWeb(setting, keyword);
      if (Array.isArray(hits)) {
        for (const hit of hits) collected.push({ ...hit, keyword });
      }
    } catch (error) {
      onLog?.(`关键词“${keyword}”搜索失败：${error.message || error}`, setting.searchProvider || "search");
    }
  }
  return { results: collected, provider: setting.searchProvider };
}
