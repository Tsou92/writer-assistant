// 写作内容生成 helper:模拟产出 + 模板拼装,所有函数都是纯函数。
import { randomUUID } from "node:crypto";
import { Document, Packer } from "docx";
import { markdownToDocxChildren } from "../lib.mjs";

export function modelName(settings, role) {
  return settings.find((item) => item.role === role)?.model || role;
}

export function briefLabel(brief, fallback) {
  return String(brief?.theme || brief?.materialType || fallback || "未命名材料").trim();
}

function thinkingContext(brief) {
  const theme = briefLabel(brief, "工作汇报材料");
  const type = brief?.materialType || "公文材料";
  const scene = brief?.scene || "正式写作场景";
  const audience = brief?.audience || "相关干部和读者";
  const org = brief?.orgContext || "本单位";
  const keywords = brief?.keywords || "政策要求、工作实践、问题短板、改进举措";
  const background = brief?.background || "用户暂未补充更多背景";
  return { theme, type, scene, audience, org, keywords, background };
}

function localThinkingText(brief, variant) {
  const { theme, type, scene, audience, org, keywords, background } = thinkingContext(brief);
  if (variant === "macro") {
    return [
      `【写作主线】围绕“${theme}”，不宜泛泛写成普通工作汇报，而应扣住“${scene}”的真实使用场景，把${org}的职责定位、业务痛点和能力提升要求统一起来。面向${audience}，文章主线应从“为什么必须讲清、当前容易偏在哪里、实务上怎样闭环、下一步如何提升”四个层次展开，确保内容既有政治高度，也有操作颗粒度。`,
      `【展开角度】第一层写意义，重点说明该主题与当前重点工作、制度执行、队伍能力建设之间的关系；第二层写问题，结合“${keywords}”提示中的关键事项，点出实践中常见的认识误区、流程断点、责任虚化和结果运用不足；第三层写方法，把要求拆成可执行的步骤、标准、文书、督办和评查机制；第四层写提升，落到规范化、法治化、专业化和长效化。`,
      `【结构建议】建议采用“认识意义-把握要求-规范操作-闭环落实-提升质效”的结构。开头不宜铺陈过长背景，应直接进入任务痛点；主体部分每一节都要形成“概念解释、实务做法、风险提醒、案例提示”的组合，方便干部听得懂、记得住、用得上。`,
      `【必须补充的材料】需要补充上级制度依据、近年本单位或本系统相关案例、制发和整改督办中的典型问题、评查发现的共性短板，以及可公开使用的规范表述。背景补充为：${background}`,
      `【风险提示】避免把材料写成空泛表态或政策摘抄；避免脱离“${theme}”谈宏观治理；涉及案例、数据、制度名称时必须由用户核验，不能自行编造。`
    ].join("\n\n");
  }
  if (variant === "expression") {
    return [
      `【写作主线】“${theme}”应突出实务训练和问题解决导向。文章要让${audience}感到这不是一般性宣讲，而是围绕具体业务环节的一套工作方法：先讲清职责边界，再讲清操作流程，最后讲清整改督办和质量评查如何形成闭环。`,
      `【表达策略】标题和段落宜采用务实、短促、可执行的表达，例如“把准定位、解决为什么发”“规范程序、解决怎么发”“跟踪问效、解决如何改”“评查复盘、解决怎样提质”。每一部分开头用判断句立住观点，中间用流程化语言展开，结尾用风险提醒压实要求。`,
      `【内容取舍】围绕“${keywords}”筛选材料，优先保留与业务办理、文书质量、整改责任、督办评查、成果运用直接相关的内容；弱化泛泛的形势判断和口号式表态。若需要引用背景，只服务于说明本主题的必要性，不喧宾夺主。`,
      `【建议结构】一是从政治和法治要求讲意义；二是从适用情形、权限边界、文本要素讲规范；三是从送达反馈、台账管理、跟踪督办讲闭环；四是从评查复盘、案例剖析、制度完善讲提升。`,
      `【风险提示】注意避免把“${type}”写成纯理论文章；避免把“建议制发”与一般通知、函询、整改要求混同；涉及${org}内部案例时应先脱敏再使用。`
    ].join("\n\n");
  }
  return [
    `【写作主线】围绕“${theme}”，建议建立“政策依据-现实问题-操作规范-整改闭环-质量提升”的主线。材料不能只写重要性，也不能只罗列流程，而要回答${audience}最关心的三个问题：为什么这项工作必须规范做，具体应该怎么做，怎样确保做出治理效果。`,
    `【结构建议】开篇用${scene}切入，说明这类材料或讲稿的目标是服务实际工作。第一部分写政治意义和制度依据，第二部分写当前容易出现的偏差和风险，第三部分写关键流程和操作标准，第四部分写督办评查与成果运用，最后提出持续提升的要求。`,
    `【内容重点】结合“${keywords}”，正文应重点补足制度依据、适用场景、责任主体、文书要素、整改要求、督办方式、评查标准和典型案例。每个观点最好能对应一条事实材料或制度表述，防止空泛。`,
    `【需要补充的事实材料】建议补充：本单位相关工作基础，近年典型案例或常见问题，已有制度文件或会议要求，整改督办中形成的经验做法，能够公开使用的数据或成效描述。背景补充为：${background}`,
    `【风险提示】避免编造政策名称、数字和案例；避免脱离${org}实际；避免大段套用通用党建、公文套话，导致主题发散。`
  ].join("\n\n");
}

export function makeAgentIdeas(brief, settings) {
  const theme = briefLabel(brief, "工作汇报材料");
  const org = brief.orgContext || "本单位";
  return [
    {
      agent: modelName(settings, "thinkChief"),
      role: "政策逻辑与结构把关",
      core_thesis: localThinkingText(brief, "policy"),
      angles: ["上级部署如何落地", "当前基础和问题短板", "下一步机制化推进"],
      structure_suggestion: ["提高站位", "总结成效", "剖析不足", "部署举措"],
      must_include: ["政策依据", "组织推进机制", "可量化成效"],
      risk_points: ["避免空泛表态", "数据需由用户确认"],
      confidence: 0.91
    },
    {
      agent: modelName(settings, "thinkGemini"),
      role: "宏观视角与篇章展开",
      core_thesis: localThinkingText(brief, "macro"),
      angles: ["形势背景", "典型实践", "经验启示", "未来展望"],
      structure_suggestion: ["为什么做", "做了什么", "效果如何", "接着怎么做"],
      must_include: ["场景化案例", "群众或服务对象感受", "中长期安排"],
      risk_points: ["宏观表达不能替代具体做法"],
      confidence: 0.87
    },
    {
      agent: modelName(settings, "thinkDeepseek"),
      role: "中文语感与务实表达",
      core_thesis: localThinkingText(brief, "expression"),
      angles: ["抓组织领导", "抓重点任务", "抓督导闭环", "抓经验固化"],
      structure_suggestion: ["主要做法", "阶段成效", "存在问题", "工作打算"],
      must_include: ["具体举措", "基层案例", "时间节点"],
      risk_points: ["标题需避免口号化堆叠"],
      confidence: 0.89
    }
  ];
}

export function makeResearchCards(brief, synthesis) {
  const theme = briefLabel(brief, "工作汇报材料");
  const keywords = synthesis.searchKeywords || [theme, "高质量发展", "会议精神"];
  return keywords.slice(0, 5).map((keyword, index) => ({
    id: randomUUID(),
    title: `${keyword}相关公开资料`,
    source: index < 2 ? "官方公开渠道" : "权威媒体公开报道",
    url: `https://example.com/search?q=${encodeURIComponent(keyword)}`,
    publishedAt: "待接入真实搜索后获取",
    summary: `围绕“${keyword}”提取政策表述、部署要求和可引用工作要点。`,
    usablePoints: [
      "坚持问题导向、目标导向、结果导向相统一",
      "完善任务分解、过程督导、结果评估工作闭环",
      "把阶段性成效转化为长效机制"
    ],
    relation: `可用于支撑“${theme}”的背景依据和工作要求。`
  }));
}

export function makeOutline(brief, variant, settings) {
  const theme = briefLabel(brief, "工作汇报材料");
  const prefix = variant === "gemini" ? "以系统推进写出层次" : "以务实举措写出质感";
  return {
    model: variant === "gemini" ? modelName(settings, "outlineGemini") : modelName(settings, "outlineDeepseek"),
    title: `${theme}大纲方案：${prefix}`,
    sections: [
      {
        id: "1",
        title: "一、提高站位、凝聚共识，准确把握工作推进的总体要求",
        points: ["写清上级部署、现实背景和本单位承担的职责", "点明材料主旨和工作方向"],
        children: [
          { id: "1.1", title: "从政治要求看责任", points: ["承接会议精神和政策要求"] },
          { id: "1.2", title: "从发展需要看任务", points: ["结合行业、地区或单位实际"] }
        ]
      },
      {
        id: "2",
        title: "二、聚焦重点、精准发力，推动各项任务落地见效",
        points: ["写主要做法、机制设计、协同推进和典型案例"],
        children: [
          { id: "2.1", title: "健全机制抓统筹", points: ["领导小组、专班、清单化推进"] },
          { id: "2.2", title: "攻坚重点抓突破", points: ["重点任务、难点问题、创新做法"] },
          { id: "2.3", title: "闭环督导抓落实", points: ["调度、督查、反馈、整改"] }
        ]
      },
      {
        id: "3",
        title: "三、总结经验、正视不足，持续提升工作质效",
        points: ["写成效、经验、不足和下一步安排"],
        children: [
          { id: "3.1", title: "工作成效更加明显", points: ["数据、案例、群众反馈"] },
          { id: "3.2", title: "短板问题仍需破解", points: ["用克制语言写真实不足"] },
          { id: "3.3", title: "下一步工作更加有力", points: ["任务清单、责任分工、长效机制"] }
        ]
      }
    ]
  };
}

export function makeMaterialRequest() {
  return [
    { type: "成效数据", prompt: "请补充近一年关键指标、完成率、增长变化或排名情况。" },
    { type: "典型案例", prompt: "请提供 1-2 个能体现工作亮点的具体案例。" },
    { type: "工作做法", prompt: "请补充本单位已经采取的机制、活动、专项行动或制度安排。" },
    { type: "领导要求", prompt: "如有内部会议精神或领导批示，请粘贴可公开使用的表述。" }
  ];
}

export function extractMaterials(materials) {
  const joined = materials.map((item) => item.content).join("\n").trim();
  const lines = joined.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return {
    facts: lines.slice(0, 5).map((line) => line.slice(0, 120)),
    cases: lines.filter((line) => /案例|推进|开展|完成|建立|组织/.test(line)).slice(0, 4),
    numbers: joined.match(/\d+(?:\.\d+)?%?|\d+余?个|\d+余?项|\d+余?次/g)?.slice(0, 8) || [],
    phrases: ["清单化推进", "闭环式落实", "常态化调度", "机制化巩固"],
    constraints: ["涉及内部敏感信息、未核实数据和个人信息的内容需人工确认后使用"],
    outline_mapping: [
      { outline_node_id: "2.1", usable_material: ["机制建设、专班推进、清单管理相关素材"] },
      { outline_node_id: "2.2", usable_material: ["专项行动、重点突破、典型案例相关素材"] },
      { outline_node_id: "3.1", usable_material: ["成效数据、排名变化、服务对象反馈相关素材"] }
    ]
  };
}

export function extractStylePrompt(materials, settings) {
  const joined = materials.map((item) => item.content).join("\n").trim();
  const paragraphs = joined.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const longSentences = paragraphs
    .flatMap((line) => line.split(/[。；;]+/))
    .map((line) => line.trim())
    .filter((line) => line.length > 12)
    .slice(0, 6);

  return {
    model: modelName(settings, "styleExtractor"),
    tone: "稳健、克制、正式，突出政治站位、工作闭环和务实成效，避免口语化和网文化表达。",
    structure: ["先讲背景和要求", "再讲做法和机制", "随后讲成效和经验", "最后讲问题和下一步安排"],
    expressionRules: [
      "多使用“坚持、聚焦、围绕、着力、推动、持续、进一步”等公文动词。",
      "段落内部采用“总起句 + 具体做法 + 成效落点”的表达形式。",
      "标题保持对仗但不过度堆砌口号，优先使用“动词 + 对象 + 结果”的结构。",
      "涉及成绩时使用稳妥表达，避免“全面领先、根本解决、历史最好”等未经核实的绝对化表述。"
    ],
    phraseBank: [
      "坚持目标导向、问题导向、结果导向相统一",
      "推动各项任务落细落实、见行见效",
      "形成清单化推进、闭环式落实的工作格局",
      "把阶段性成果转化为常态长效机制"
    ],
    samples: longSentences,
    prompt: [
      "请严格模仿参考材料的公文文风起草正文：",
      "1. 语气稳健正式，句式以中长句为主，避免口语化表达。",
      "2. 每个部分先总述，再展开做法，最后落到成效或下一步。",
      "3. 使用规范公文表达，可适度采用排比和对仗标题，但不能空泛堆词。",
      "4. 所有事实、数据、案例只使用已提炼素材，不编造未提供内容。",
      "5. 对不足和风险使用克制表述，保留人工核验空间。"
    ].join("\n")
  };
}

export function renderDraft(task) {
  const brief = task.brief;
  const title = briefLabel(brief, "工作汇报材料");
  const extracted = task.outputs.extractedMaterials;
  const style = task.outputs.stylePrompt;
  const fact = extracted?.facts?.[0] || "围绕重点任务持续推进，形成了一批阶段性成果";
  const number = extracted?.numbers?.[0] || "若干";
  const phrase = style?.phraseBank?.[0] || "坚持目标导向、问题导向、结果导向相统一";
  return `# ${title}\n\n一、提高站位、凝聚共识，准确把握工作推进的总体要求\n\n今年以来，${brief.orgContext || "本单位"}坚持把${title}作为服务中心大局、提升治理效能的重要抓手，紧扣上级部署要求，强化统筹调度，细化任务分工，推动各项工作有序开展。围绕目标任务，${phrase}，注重把政策要求转化为具体举措，把阶段安排转化为工作清单，把责任压力转化为落实成效。\n\n二、聚焦重点、精准发力，推动各项任务落地见效\n\n一是健全机制抓统筹。坚持专班推进、清单管理、定期调度，围绕重点任务明确责任单位、时间节点和成果标准，推动工作从“有人抓”向“抓得实”转变。${fact}。\n\n二是攻坚重点抓突破。聚焦制约工作质效的关键环节，组织开展专项推进和集中攻坚，推动资源力量向重点任务集中、向薄弱环节倾斜，形成上下协同、横向联动的工作格局。\n\n三是闭环督导抓落实。建立过程跟踪、问题反馈、整改销号机制，对推进情况及时复盘，对共性问题及时研究，对成熟经验及时固化，确保工作不断线、责任不落空、成效可检验。\n\n三、总结经验、正视不足，持续提升工作质效\n\n从推进情况看，相关工作取得了积极成效，形成了${number}项可延续、可推广的经验做法。但也要看到，部分工作还存在数据支撑不够充分、典型案例挖掘不够深入、长效机制仍需完善等问题。下一步，将继续按照文风提示词确定的“总述、做法、成效、提升”表达形式，进一步完善工作机制，强化跟踪问效，推动各项任务落到实处、见到实效。\n\n## ${modelName(task.modelSettings, "drafter")} 起草所用文风提示词\n\n${style?.prompt || "未提供文风参考材料，使用默认正式公文风格。"}`;
}

export function reviseDraft(draft) {
  return `${draft}\n\n## 修改完善说明\n\n已强化三处内容：一是把工作主线统一为“部署、推进、见效、提升”；二是将做法部分调整为机制、攻坚、督导三个层面；三是对成效和不足采用更稳妥的公文表达，避免未经核实的绝对化判断。`;
}

export function proofreadDraft(draft) {
  return `${draft}\n\n## 校对结果\n\n未发现明显错别字。正式使用前请人工核对数据、单位名称、时间节点和内部表述口径。`;
}

export async function createDocxBuffer(markdown) {
  const document = new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
        }
      },
      children: markdownToDocxChildren(markdown)
    }]
  });
  return Packer.toBuffer(document);
}
