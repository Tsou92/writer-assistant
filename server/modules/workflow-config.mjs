// 工作流静态配置:步骤模板、可重跑映射、now 时间戳、初始 steps 工厂。
// 完全无状态,可被 server / 测试任意复用。

export const stepTemplate = [
  ["create", "新建任务", "done", "写作项目已创建"],
  ["brief", "写作要求", "done", "结构化写作任务已生成"],
  ["parallel-thinking", "三 Agent 并行构思", "pending", "等待三个模型输出思路"],
  ["synthesis", "GPT 汇总思路", "pending", "保留优质思路，删除低质量点位"],
  ["research", "联网资料检索", "pending", "检索领导讲话、会议精神、政策文件"],
  ["dual-outline", "双模型大纲", "pending", "Gemini 与 deepseek 分别搭建大纲"],
  ["final-outline", "定稿大纲", "pending", "GPT 汇总形成标题和段落点位"],
  ["material-request", "补充材料清单", "pending", "判断需要用户提供的事实素材"],
  ["materials", "事实材料", "needs_user", "上传或粘贴做法、案例、数据"],
  ["extract", "事实素材提炼", "pending", "GPT-5.5 提炼事实、案例、数据和可复用表述"],
  ["style-materials", "文风材料", "pending", "上传或粘贴表述形式参考材料"],
  ["style-extract", "文风提炼", "pending", "deepseek-V4-pro 总结文字风格和表述形式"],
  ["draft", "Gemini 起草", "pending", "按照大纲、事实素材和文风提示词撰写初稿"],
  ["revise", "GPT 修改完善", "pending", "检查逻辑、政策口径和表达精度"],
  ["user-review", "用户批注修改稿", "pending", "等待用户对修改稿标注位置和修改意见"],
  ["proofread", "deepseek 校对", "pending", "纠正错别字、标点和格式"],
  ["export", "定稿导出", "pending", "生成可下载 Markdown 文件"]
];

// 阶段重跑映射:每个可重跑入口对应一个 runner + 重置起点。
// `phase` 决定调用哪个 runner;`fromStep` 之后的所有步骤会被重置为 pending。
export const RERUN_PLANS = {
  "parallel-thinking": { phase: "workflow", fromStep: "parallel-thinking" },
  "synthesis": { phase: "workflow", fromStep: "synthesis" },
  "research": { phase: "workflow", fromStep: "research" },
  "dual-outline": { phase: "workflow", fromStep: "dual-outline" },
  "final-outline": { phase: "workflow", fromStep: "final-outline" },
  "material-request": { phase: "workflow", fromStep: "material-request" },
  "extract": { phase: "content", fromStep: "extract" },
  "style-extract": { phase: "style", fromStep: "style-extract" },
  "draft": { phase: "style", fromStep: "draft" },
  "revise": { phase: "style", fromStep: "revise" },
  "proofread": { phase: "style", fromStep: "proofread" }
};

export function now() {
  return new Date().toISOString();
}

export function createSteps() {
  return stepTemplate.map(([id, title, status, description]) => ({
    id,
    title,
    status,
    description,
    startedAt: id === "brief" || id === "create" ? now() : null,
    finishedAt: id === "brief" || id === "create" ? now() : null
  }));
}
