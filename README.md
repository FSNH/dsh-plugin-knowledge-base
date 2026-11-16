# DSH 个人知识库插件

把本地文件整理成树状知识库，在 DeepSeek Harness 里直接读、直接搜，AI 也能检索并针对某一篇文档对话。

数据全在本机（默认 `~/.dsh/kb`），不经过任何云端。

## 功能

- **树状目录**：多知识库 / 文件夹 / 拖拽移动 / 重命名 / 删除；文件树栏可收起
- **在线查看原版式**：Word、PPT、Excel 用本机 LibreOffice 转成 PDF，再逐页渲染成图片，由插件自己的阅读器显示（左侧缩略图栏 + 页码跳转 + 单页/连续 + 大屏放映）
- **全文检索**：SQLite FTS5，中英文混排，中文两字词也能命中（CJK 逐字归一化）
- **AI 检索**：模型侧有三个工具 `kb_list` / `kb_search` / `kb_read`，任何会话里问"我的知识库里有没有…"都会自动用上
- **针对文档对话**：「问 AI」把带 docId 的提问预填到会话输入框，模型先读文档再回答，并标注出处

## 安装

插件是一个 DSH bundle（本地目录安装）：

```powershell
# 方式一：让 agent 装
plugin_manager install_bundle "C:\path\to\dsh-plugin-knowledge-base"

# 方式二：界面里装
# Plugins → Add plugin → 选择这个目录
```

装好后**刷新页面**，左栏会多一个「知识库」图标。

> 依赖：`pdfjs-dist`（PDF 文字层抽取）。第一次装需要联网安装依赖。
> Office 原版式预览依赖 DSH 自带的 LibreOffice（`officeKit`），没装也能用，只是 Office 文档只能看抽取出来的文字。

## 使用

| 想做的事 | 怎么做 |
|---|---|
| 建库 | 顶部「知识库」下拉旁的 `+`，或左栏空态里的「新建知识库」 |
| 建文件夹 | 先点中父文件夹，再点「新建文件夹」 |
| 导入文件 | 点「导入文件」或把文件拖进页面；落在当前选中的文件夹里 |
| 移动到别的目录 | 把文件行拖到文件夹上，或用行上的「移动到…」 |
| 收起文件树 | 顶部最左侧的箭头按钮（收起后左边留一条细条，点它展开） |
| 看原版式 | 点文档 → 默认「原版式」；Word/PPT/Excel 第一次要等转换 |
| 大屏放映 | 文档页「大屏」→ 单页铺满、← → 翻页、右上角「恢复」或 Esc 退出 |
| 搜索 | 右上角搜索框，命中后点一条会跳到正文那一段并高亮 |
| 问 AI | 文档页「问 AI」，提问会预填进会话输入框 |

## AI 工具

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `kb_list` | 列出知识库与目录树 | `kbId?` |
| `kb_search` | 全文检索，返回片段 + 定位 | `query`、`kbIds?`、`limit?`、`mode?` |
| `kb_read` | 按字符偏移读正文（单次 ≤ 6000 字） | `docId`、`offset?`、`limit?` |

库非空时会自动注入一段系统提示，告诉模型这套工具怎么用。

## 配置

在插件行的 `config` 里改（插件页 → 知识库 → 配置）：

```yaml
root: ''                 # 库目录，留空 = $DSH_HOME/kb
maxFileBytes: 67108864   # 单文件上限，默认 64 MiB
parseConcurrency: 1      # 解析并发
embedding:
  enabled: false         # 向量检索，默认关
  baseUrl: ''            # OpenAI 兼容的 embeddings 接口
  model: ''
```

向量检索的 KEY 走环境变量 `DSH_KB_EMBEDDING_KEY`，不写进配置文件。开启后索引时会把片段、检索时会把查询发给你配置的端点。

## 数据与隐私

```
$DSH_HOME/kb/
├── kb.db                     # 库结构 + 全文索引（SQLite）
├── files/<docId>.<ext>       # 原始文件
├── files/<docId>.preview.pdf # Office 转出来的 PDF
├── files/<docId>.pages/      # 逐页大图（96 DPI）
└── files/<docId>.thumbs/     # 逐页缩略图（24 DPI）
```

- 插件不上传任何内容；只有开了向量检索才会把文本发给你指定的接口
- 卸载插件**不会**删除这些文件
- 页数多的文档会占几十 MB（123 页的 PPT 约 84 MB），设置页有「清理预览缓存」可随时清掉

## 支持的格式

| 类型 | 原版式 | 文字阅读 | 正文索引 |
|---|---|---|---|
| md / txt / csv / json / 代码 | — | ✅ | ✅ |
| html | — | ✅ | ✅ |
| docx / pptx / xlsx | ✅（转 PDF 再逐页出图） | ✅ | ✅ |
| doc / ppt / xls（老格式） | ✅ | — | ❌ 会提示 |
| pdf | ✅（浏览器阅读器） | — | ✅ 有文字层的；扫描件会提示 |
| png / jpg / gif / webp / bmp / svg | ✅ | — | 不索引 |

## 架构

```
浏览器（插件 client.js）
  ├─ sidebar.panellist  左栏图标
  ├─ main[key]          知识库页面：树 + 阅读器 + 检索
  └─ settings.section   设置分区
        │ 同源 HTTP（x-kb-client 头 + 启动令牌）
Host（index.js）
  ├─ lib/store.mjs       SQLite：库/树/正文/分块
  ├─ lib/extract.mjs     文本 / docx / pptx / xlsx 抽取（自研 ZIP+XML，零依赖）
  ├─ lib/pdf.mjs         PDF 文字层（pdfjs-dist）
  ├─ lib/chunker.mjs     渲染正文 + 分块
  ├─ lib/index.mjs       FTS5（CJK 归一化）+ 可选向量（RRF 融合）
  ├─ lib/pipeline.mjs    解析队列（上传即返回，后台解析）
  ├─ lib/preview.mjs     officeKit → PDF → 逐页大图 / 缩略图
  ├─ lib/routes.mjs      /api/kb/v1/*
  └─ lib/tools.mjs       kb_list / kb_search / kb_read
```

设计过程与踩过的坑记在 [docs/DESIGN.md](docs/DESIGN.md)（含每一轮反馈的原因与改法）。

## 开发与测试

不需要构建步骤，纯 ESM + 浏览器端 `__ModuleLoader__` 工厂。

```powershell
# Host：解析 / 中文检索 / 三工具 / 树增删改 / 预览器降级
$env:ELECTRON_RUN_AS_NODE=1
& "<DeepSeek Harness.exe>" test/smoke.mjs

# Client：模块注册 / 插槽 / 各种状态渲染 / 树展开 / 缩略图 / 大屏
& "<DeepSeek Harness.exe>" test/client-smoke.mjs
```

仓库里**不含任何真实文档**，docx / xlsx 解析用例默认跳过。想覆盖真实文件解析，指一个你自己的样例：

```powershell
$env:KB_TEST_DOCX = "C:\path\to\any.docx"
$env:KB_TEST_XLSX = "C:\path\to\any.xlsx"
```

两个套件都不依赖浏览器，Host 22 项、Client 70+ 项断言。

> 用 DSH 自带的 Electron 可执行文件跑，是因为 `node:sqlite` 需要 Node 24（DSH 内置），系统 Node 可能没有。

## 已知限制

- 老版 Office（`.doc/.ppt/.xls`）能看原版式，但不抽正文，搜不到里面的字
- 扫描件 PDF / 纯图片没有文字层，搜不到内容
- 转换上限：单文件 50 MB（LibreOffice），单次渲图 200 页
- 桌面端不允许插件页面开新窗口，所以「大屏」是应用内全屏，不是独立窗口

## License

MIT
