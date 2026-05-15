# 公文材料写作助手

这是一个 mac 本地公文材料写作助手。当前版本实现了 Tauri 桌面壳、内置 WebUI、自包含本地 worker、任务持久化、材料识别、脱敏、质量审计和 Markdown/DOCX 导出。

## 运行

```bash
npm install
npm run dev
```

打开：

```text
http://127.0.0.1:5173/
```

后台 worker：

```text
http://127.0.0.1:8787/
```

## Tauri 桌面版

开发模式：

```bash
npm run tauri:dev
```

生产打包：

```bash
npm run tauri:build
```

当前已验证生成：

```text
src-tauri/target/release/bundle/macos/公文材料写作助手.app
src-tauri/target/release/bundle/dmg/公文材料写作助手_0.1.0_aarch64.dmg
```

生产 `.app` 已内置 Node 运行时和 worker-runtime，双击即可自动启动后台服务，不需要用户预装 Node，也不需要手动运行 `npm run dev:server`。生产前端会连接应用自动托管的 `http://127.0.0.1:8787`。

## 已实现

- 结构化写作需求录入
- 任务列表与当前任务工作台
- 16 步流程时间线
- Server-Sent Events 实时状态推送
- 模型与接口设置：每个流程角色可单独配置模型名、API Key、Base URL
- 支持两种真实模型调用路径：直连服务商 API，或通过 cc-switch 本地代理调用
- 支持 OpenAI Responses、Chat Completions、Gemini 原生接口三种请求格式
- 支持设置页一键填入 cc-switch 默认代理地址并测试连接
- 支持上传材料入库前脱敏，可配置本地 Ollama、LM Studio 或 deepseek API 作为脱敏模型
- 每个 AI 生成阶段后自动增加质量审计节点，审计模型由用户在设置中自行配置
- 三 Agent 并行构思模拟输出
- GPT-5.5 思路取舍记录
- 资料检索卡片模拟输出
- Gemini 与 deepseek 双大纲模拟输出
- GPT-5.5 定稿大纲
- 补充材料清单
- 粘贴参考材料
- 上传并识别 `.xls`、`.xlsx`、`.doc`、`.docx`、`.pdf`、`.jpg`、`.png`、`.txt`、`.md`、`.csv`、`.tsv`
- 素材提炼
- 事实材料提炼后，继续要求上传文风参考材料
- deepseek-V4-pro 归纳文风、表述形式并形成提示词
- 所有粘贴/上传材料可在入库前脱敏，后续模型只读取脱敏后的材料文本
- 所有 AI 生成内容进入下一阶段前都会形成质量审计记录
- Gemini-3.1-pro-preview 按文风提示词起草初稿
- 初稿、修改、校对三阶段生成
- Markdown 定稿下载
- DOCX 定稿下载
- 本机导出文件保存到 `~/Library/Application Support/GongwenWriter/projects`
- 任务本机持久化保存到 `~/Library/Application Support/GongwenWriter/tasks.json`，重启 worker 后仍可恢复任务列表和结果
- 生产 `.app/.dmg` 自包含 worker-runtime，双击应用即可运行完整流程

## 当前实现边界

当前联网检索仍是确定性模拟数据，目的是先验证产品流程、状态机、前后端交互和 UI 工作台。模型调用已接入统一适配器；当某个流程角色在设置中选择“真实调用”时，会按该角色配置请求真实模型，否则继续使用本地模拟兜底。

模型适配器入口在 `server/index.mjs`：

- `callLiveModel`：根据设置调用 OpenAI Responses、Chat Completions 或 Gemini 原生接口。
- `maybeCallRole`：按流程角色决定是否真实调用，并把真实输出写入任务结果和运行日志。
- `sanitizeMaterialText`：材料入库前脱敏，支持本地规则兜底或用户配置的脱敏模型。
- `auditGeneratedContent`：每个 AI 生成阶段后的质量审计入口，审计结果会进入流程进度和“审计”输出页。
- `testModelSetting`：设置页“测试”按钮使用的连接检测接口。
- `createDocxBuffer`：将最终 Markdown 稿件转换为 DOCX 下载文件。

文件识别说明：

- Excel：使用工作簿解析，按工作表提取行列文本。
- DOCX：提取正文原始文本。
- DOC：macOS 下优先调用系统 `textutil` 转文本。
- PDF：提取页面文本。扫描版 PDF 需要后续增加 PDF 转图片再 OCR。
- JPG/PNG：使用 OCR 识别中文和英文。清晰度会影响识别率。

模型设置说明：

- 设置保存在 `~/Library/Application Support/GongwenWriter/model-settings.json`。
- 每个流程角色都有独立配置，包括构思、汇总、检索、大纲、事实提炼、文风提炼、起草、修改、校对。
- 每个角色可配置 `providerType`、`apiFormat`、`executionMode`、`model`、`baseUrl` 和 `apiKey`。
- `providerType=ccSwitch` 时默认 Base URL 为 `http://127.0.0.1:15721/v1`，API Key 可留空；需要先在 cc-switch 中完成 OAuth 登录或 Provider 切换。
- `providerType=local` 时用于 Ollama、LM Studio 等本地 OpenAI 兼容服务，API Key 可留空。Ollama 默认可用 `http://127.0.0.1:11434/v1`，LM Studio 默认可用 `http://127.0.0.1:1234/v1`。
- `providerType=direct` 时按服务商要求填写 Base URL 和 API Key；OpenAI/GPT 可用 Responses，deepseek 等 OpenAI 兼容服务可用 Chat Completions，Gemini 可用 Gemini 原生接口。
- `executionMode=mock` 时不发起真实模型请求；`executionMode=live` 时真实调用模型，失败会在流程中明确报错。
- “材料脱敏”和“内容质量审计”也是独立流程角色，可单独选择本地模型、deepseek API、cc-switch 或其他 OpenAI 兼容服务。
- 新建任务时会快照当前模型设置，正在运行的任务不会被后续修改影响。

## 下一步

1. 增加任务版本记录和历史稿对比。(已完成)
2. 增加 PDF 导出。(已完成)
3. 联网检索真实适配器。(已完成,Tavily/Serper/自定义)
4. 代码签名、公证和自动更新发布通道。(已接入,按下面流程发布)

## 代码签名 + 公证 (macOS)

生产包默认未签名,按下面流程生成带签名并公证的 `.app` / `.dmg`:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # App Store Connect 生成
export APPLE_TEAM_ID="ABCDE12345"
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"

# 可选:打包前在 tauri.conf.json 的 bundle.macOS.signingIdentity 填写同一身份,让 tauri build 直接签名。
npm run tauri:build

# 签名 + 公证 .app
scripts/notarize-macos.sh src-tauri/target/release/bundle/macos/公文材料写作助手.app

# 签名 + 公证 .dmg
scripts/notarize-macos.sh src-tauri/target/release/bundle/dmg/*.dmg
```

签名授权文件:`src-tauri/entitlements.plist`(Hardened Runtime + 网络客户端/服务端 + 外部库加载)。

## 自动更新 (auto-update)

Tauri v2 updater 已接入。当 `tauri.conf.json -> plugins.updater.active=true` 并配置好公钥与 endpoint 后,应用左下角会出现"检查更新"按钮,点击即可检查并原地安装。

生成一次性的 updater 签名密钥对:

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/gongwen-writer.key
```

私钥(`gongwen-writer.key`)请妥善保管且不要入库;公钥内容填到 `tauri.conf.json -> plugins.updater.pubkey`。打包时需要 `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 环境变量:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/gongwen-writer.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-key-password"
npm run tauri:build
```

打出的 `latest.json` + `*.sig` 上传到 `tauri.conf.json -> plugins.updater.endpoints` 指向的静态资源路径,客户端即可拉到更新。

## API Key 本地存储

- macOS:随机 32 字节密钥写入 macOS Keychain(`service=com.local.gongwen-writer, account=settings-aes-v1`),配合 AES-256-GCM 加密保护 `model-settings.json` 中的 API Key。
- 其他平台:回退到由 `platform + arch + homedir + appDir` 派生的密钥(AES-256-GCM 加密仍启用)。
- `GONGWEN_DISABLE_KEYCHAIN=1` 可强制禁用 keychain,便于排查。
- `model-settings.json` 会被 `chmod 600`,仅当前用户可读写。

