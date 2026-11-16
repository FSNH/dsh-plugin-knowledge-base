# 个人知识库插件 · 分析与实现方案

> 目标安装环境（已核实）：DeepSeek Harness **0.2.2-rc.3** · Desktop profile `desktop` · Electron 44.7.0（Node **24.21.0**）· Windows
> 本文档基于对本机已安装 DSH 的包源码与文档的只读核对，以及与 `dsh-plugin-workbench`（工作区里已在跑的同类插件）的对照。
> 文末列出「已核实 / 未核实」和「需要你拍板的点」。

---

## 1. 一句话结论

**能做，而且不需要造一个大系统。** 关键判断只有一条：

> 知识库插件不该自己做"文件浏览 + 文档渲染 + 聊天窗"，而应该**只拥有"库"（目录树 / 元数据 / 索引 / 检索能力）**，把"看文件"交给宿主右侧栏原生预览，把"对话"交给宿主会话（通过工具 + 预填 prompt 供给上下文）。

按这个切法，工作量集中在三件事：**树状目录 CRUD**、**上传解析+索引**、**三个模型工具**。渲染、PDF/Office 预览、会话、流式、模型选择、审批、历史记录全部零成本复用。

---

## 2. 需求 → 平台能力映射（先看这张表）

| 你的需求 | 实现方式 | 复用还是自研 | 难度 |
|---|---|---|---|
| 创建知识库 / 树状目录 | 自建 SQLite 表 + `main` 面板里的树组件 | 自研（简单） | 低 |
| 上传文件 | 插件自己的 HTTP 路由（`ctx.webServer.register`）流式落盘 | 自研（简单） | 低 |
| **在线查看文件内容** | 右手边栏原生预览：`ctx.sidebarRight.openResource(...)` + 绝对路径 | **完全复用宿主**（PDF/Office/Excel/Markdown/代码/图片/HTML 全都自带，Word/PPT 自动转 PDF） | 低 |
| AI 检索知识库 | 三个模型工具：`kb_list` / `kb_search` / `kb_read`，背后是 SQLite FTS5 | 自研（核心） | 中 |
| 针对某知识库/文档对话 | **不新建聊天窗**：预填 prompt 开一个正常会话（`ctx.uiWorkspace.startSession`），模型用 `kb_read` 读 | 复用宿主会话 | 低 |
| 设置 / 索引管理 | `settings.section` 插槽 | 自研（表单） | 低 |
| 左栏入口 + 图标 | `sidebar.panellist`（列表）+ `main`（keyed 页面） | 复用宿主框架 | 低 |

**唯一"重"的部分是文本抽取与中文检索质量**，见第 6、7 节。

---

## 3. 被否掉的几种做法（以及为什么）

这些是同类需求最容易走错的路，逐条说明，避免返工：

| 方案 | 为什么否 |
|---|---|
| 起一个独立 Web 服务（或内嵌 iframe 页面） | 拿不到宿主的主题 token、明暗切换、语言包、会话上下文；DSH 插件规范明确禁止在 iframe 里塞自建页面。用户会看到"两个应用拼在一起"。 |
| 自研 PDF / Office / Excel 渲染器 | PDF.js + Office 转码 + 表格渲染是数周工作量，而且宿主已经做得比我们能做到的更好（含缺字体提示、缩放、选区、懒加载）。 |
| 在插件里做第二个聊天框、自己直连 LLM | 会绕过 session log —— 而 DSH 里**会话日志是唯一真相**（fork / resume / 重放全靠它）。自建聊天框等于重写模型选择、流式、审批、压缩、标题、成本统计。 |
| 把文件放进当前工作区 | 工作区被 `workspace-changes` 逐轮比对、会算进"本轮改动文件"、会进 git diff；知识库是跨工作区长期资料，放进去会污染交付物。 |
| 把索引/库结构写进 session 事件 | 新增自定义事件 `type` 会被 Session 拒绝重开（除非 `ignorable`，而那是实验包专用）。库里状态放 Host 存储，不放会话。 |
| 依赖 Milvus / MaxKB / RAGFlow 做检索 | 你现在有 SAG/MaxKB 的经验（工作区里有笔记），但为一个本地个人知识库多养一个服务不划算；FTS5 + 可选向量足够。规模上限到"几万段"都没问题。 |

> 补充：如果目标是"团队共享 + 权限 + 多模态"，那应该反过来 —— 用 MCP 把既有 RAG 平台（MaxKB / SAG / 乐享）接进来，而不是自建。本方案定位是**个人本地知识库**。

---

## 4. 总体架构

```
┌─────────────────────────── 浏览器（DSH Web / Desktop 渲染层） ───────────────────────────┐
│                                                                                          │
│  ① 左栏图标 sidebar.panellist ──► ② 主面板 main[key=kb]（自研页面）                       │
│                                        │ 树 / 上传 / 搜索 / 详情                         │
│                                        │                                                 │
│                                        ├─► ③ 右侧栏原生预览 sidebar.right.pane.tab        │
│                                        │     （PDF / Word / Excel / MD / 图片，0 行渲染代码）│
│                                        └─► ④ 会话：预填 prompt → 正常对话                 │
│  ⑤ 设置页 settings.section（根目录 / 解析 / 向量 / 重建索引）                              │
└──────────────────────────────────────────┬───────────────────────────────────────────────┘
                                           │ fetch（同源 /api/kb/*，带自定义头）
┌──────────────────────────────────────────▼───────────────────────────────────────────────┐
│ Host 半部（插件进程内）                                                                    │
│  ┌──────────────┐   ┌───────────────┐   ┌────────────────┐   ┌─────────────────────────┐ │
│  │ HTTP 路由层   │──►│ 库服务 kbStore │──►│ 解析流水线      │──►│ 索引 kbIndex (FTS5)     │ │
│  │ 树/上传/检索  │   │ 树/文档/元数据 │   │ extractors     │   │ chunk / bm25 / 可选向量  │ │
│  └──────────────┘   └───────────────┘   └────────────────┘   └─────────────────────────┘ │
│         │                    │                    │                      │                │
│         │                    └────────┬───────────┴──────────────────────┘                │
│         │                             ▼                                                   │
│         │                    $DSH_HOME/kb/  （kb.db · files/<docId>.<ext>）                │
│         ▼                                                                                  │
│  模型工具 kb_list / kb_search / kb_read ＋ systemPrompt 段落                                │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

三条要点：

1. **文件是真的文件**，落在 `$DSH_HOME/kb/files/`，不是 base64 塞数据库。右侧栏预览、系统应用打开、以后做全文重建都靠它。
2. **预览靠"绝对路径 + 会话身份"**。`dsh-client-ui-sidebar-documentpreview` 的文件读取服务明确允许读工作区之外的绝对路径（见 §12 核实项），所以库文件不需要放进工作区。
3. **模型只看得到工具**，看不到 HTTP 路由；UI 只看得到 HTTP 路由，不碰数据库。两条通道在 Host 的 `kbStore` 上汇合 —— 与 DSH 的 "一个操作，两个调用方" 约定一致。

---

## 5. 数据模型与存储布局

### 5.1 磁盘

```
$DSH_HOME/kb/                     ← 默认根目录，可被 config.root 覆盖
├── kb.db                         ← node:sqlite（同一进程内，零依赖）
├── files/
│   └── <docId>.<ext>             ← 原始文件（绝不使用用户文件名落盘）
└── tmp/                          ← 上传中的半成品，启动时清理
```

不入工作区，理由见 §3。卸载插件**不删**这些文件（文档里写明），设置页提供"清空全部数据"。

### 5.2 表结构（概念）

```sql
kbs(id, name, icon, sort, created_at, updated_at)
nodes(id, kb_id, parent_id NULL, kind 'folder'|'doc', name, path, sort, created_at, updated_at)
  -- path 物化路径 '/a/b/c'，移动子树 = 一次前缀 UPDATE
  -- sort 用分数索引（'a0','a1','a0V'…），拖拽只改一行
docs(node_id PK, ext, mime, bytes, sha256, file_path, page_count,
     status 'pending'|'parsing'|'ready'|'failed', error, indexed_at)
chunks(id INTEGER PK, node_id, kb_id, ord, heading, page, char_start, char_end, text)
chunks_fts USING fts5(cjk, kb_id UNINDEXED, node_id UNINDEXED, tokenize='unicode61')
  -- rowid = chunks.id；cjk 是「中文字间插空格」后的归一化文本（见 §7）
```

为什么用 SQLite 而不是 `ctx.storage.domain`：域存储（`defineDomain` + zod）适合**少量 schema 化的 KV 记录**，但明确不支持二级索引、多表事务、全文检索。知识库要做 FTS 和分块排序，直接用 `node:sqlite` 更合适；`node:sqlite` 在本机 Electron 44 / Node 24.21 上已实测可用（§12）。

---

## 6. 上传与解析流水线

### 6.1 上传

```
浏览器  fetch('/api/kb/v1/upload', { method:'POST',
          headers:{ 'x-kb-filename': encodeURIComponent(file.name), 'x-kb-parent': nodeId,
                    'x-kb-client': '1' },
          body: file })            ← File/Blob 直传，流式，不 base64
Host    req(流) → tmp/<uuid> → 边写边算 sha256 → 校验 → rename 到 files/<docId>.<ext>
        → 插 docs(status='pending') → 投递解析任务 → 立即返回 { docId, status }
```

不用 multipart：单文件用"裸 body + 头部带文件名"更省事，也避免手写 boundary 解析器。多文件就是并发多个请求。

**校验**：扩展名白名单 + 大小上限（默认 64 MiB，可配）+ 魔数嗅探（PDF `%PDF`、docx/pptx/xlsx 是 ZIP `PK\x03\x04`、图片魔数），不匹配就拒绝并把原因回给 UI。

### 6.2 解析（后台队列，不阻塞请求）

单飞队列，并发 1–2，逐文档推进 `pending → parsing → ready|failed`。失败**必须**给人话原因：`扫描件无文本层` / `PDF 已加密` / `格式暂不支持` / `文件损坏`，并提供「重试」「在右侧打开原文件」两个动作。

### 6.3 各格式策略（这是本方案唯一需要外部依赖的地方）

| 格式 | 预览 | 文本抽取方案 | 依赖 |
|---|---|---|---|
| md / txt / csv / json / yaml / 代码 | ✅ 原生 | 直读 UTF-8（BOM 嗅探；非 UTF-8 标记需转码） | 无 |
| html | ✅ 原生 | 正则去标签 + 实体解码 + 保留标题层级 | 无 |
| **docx** | ✅ 原生（转 PDF） | 自研：ZIP 中央目录 + `inflateRaw` + 读 `word/document.xml` 段落与标题样式 | **无** |
| **pptx** | ✅ 原生（转 PDF） | 自研：`ppt/slides/slideN.xml` 的 `<a:t>` + 备注页 | **无** |
| **xlsx / csv** | ✅ 原生（浏览器直开表格） | 自研：`sharedStrings.xml` + 各 sheet，按每 50 行一块，sheet 名做 heading | **无** |
| **pdf** | ✅ 原生 | `pdfjs-dist`（legacy build）按页抽文本 | 1 个 npm 包 |
| doc / ppt / xls（老格式） | ✅（LibreOffice 转） | P2：借 `ctx.officeKit` 转 PDF 再抽；MVP 只索引文件名 | 无 |
| 图片 / 扫描件 | ✅ 原生 | P3：OCR（可选） | 可选 |

**依赖策略（建议）**：docx/pptx/xlsx 用自研 ZIP+XML 抽取（约 150 行，零依赖，可控）；只有 PDF 引入 `pdfjs-dist`。并且把 PDF 抽取做成**可选能力**：设置页显示「PDF 文本抽取：可用 / 未安装」；缺失时 PDF 退化为"可预览 + 仅按文件名检索"，不影响插件其余部分可用。

> 备选（若不希望引入任何依赖）：MVP 先不做 PDF 正文索引，靠文件名 + PDF 页数 + 让模型在需要时让用户贴内容。体验会明显打折，但对"先跑通"是可行的。

### 6.4 分块

- 按结构切：Markdown 标题、docx 标题样式、xlsx 的 sheet+行块、pptx 的每页、pdf 的每页；单块目标 **400–800 字**，段间重叠 **80 字**。
- 每块存 `heading`（章节面包屑，如 `3.2 出口判定`）和 `page`，这是**引文质量的关键** —— 模型回答能说"《登记证清单》3.2 节"，而不是"某文档"。
- 单块超长（>1500 字）强制二次切分，带 `(2/5)` 后缀。

---

## 7. 检索设计（含已实测的中文结论）

### 7.1 中文是这里最大的坑，已实测

FTS5 的 `unicode61` 分词器**不切中文**（整句当一个 token），`trigram` 分词器又要求查询 ≥3 字。在本机 SQLite 3.53.4 上实测：

| 索引方式 | 查「农药」（2 字） | 查「登记证」（3 字） |
|---|---|---|
| `tokenize='trigram'` | ❌ 命中 0 条 | ✅ 命中 |
| `tokenize='unicode61'`（原文） | ❌ 命中 0 条 | ❌ 命中 0 条 |
| **`unicode61` + 中文字间插空格** | ✅ 命中 | ✅ 命中 |

**结论**：入索引前把文本里的 CJK 字符逐个用空格隔开再存（`知识库检索` → ` 艾 津 农 药 `），查询串做同样归一化后拼成短语查询 `"农 药"`。这样 1–2 字中文查询也能命中，英文单词仍是整词、编号/CAS 不受影响。这条方案已在本机验证通过。

### 7.2 排序

`bm25()` 为主，叠加：

- 标题命中加权（`nodes.name` 命中 → ×2）
- 同库优先（用户在"产品资料"库里搜时，本库结果前置）
- 块位置轻微衰减（文档太靠后的段落略降权）
- 返回 `snippet()` 高亮片段（前后各 12 token）

### 7.3 向量（P2，可选）

- 走 **OpenAI 兼容 embeddings 接口**（`baseUrl` / `model` / key 走 `ctx.credentials`，不进配置文件）。
- 存 `chunks_vec(node_id, ord, dim, vec BLOB float32)`；个人规模（<5 万块）直接内存里暴力算余弦即可（5 万 × 768 维 ≈ 150 MB，必要时分库/降维）。
- 与 BM25 用 **RRF 融合**（各取 top-50，按 `1/(60+rank)` 加权），不做复杂的加权调参。
- 提供开关 + 明确的隐私提示（开启后文本片段会发往该端点）。

### 7.4 检索 API 的返回形状（UI 与工具共用）

```json
{ "hits": [ { "docId":"d_01H…", "kbId":"k_01…", "name":"登记证清单.xlsx",
              "breadcrumb":"产品资料 / 登记证", "heading":"Sheet1 · 第 3 行块",
              "score":12.4, "snippet":"…出口 巴西 需 提供 …", "page":null } ],
  "total": 42, "truncated": true }
```

`breadcrumb` 就是给人和模型看的定位路径（工作台插件里已验证这种"locator"字段对回答质量帮助很大）。

---

## 8. 模型侧：让 AI 真的"用得上"

### 8.1 三个工具（只读）

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `kb_list` | `kbId?` | 库清单 + 树（截断到 200 节点） | 先看有什么 |
| `kb_search` | `query`, `kbIds?`, `mode?`('keyword'\|'hybrid'), `limit?`(≤20) | `hits`（§7.4） | 主入口 |
| `kb_read` | `docId`, `section?`/`page?`, `offset?`, `limit?`(≤6000 字) | 文本 + `next` 游标 + 出处头 | 分页读取，控 token |

工具注册形状（与工作区 `dsh-plugin-workbench` 里已验证的写法一致）：

```js
tools.register({
  name: 'kb_search',
  description: '在我的个人知识库中检索段落。用户提到"知识库/我的资料/那份文档"时先调用它。',
  parameters: { type:'object', additionalProperties:false, required:['query'], properties:{ /* JSON Schema 子集 */ } },
  output: { schema: {/* … */}, render: (value) => [{ type:'text', text: renderHits(value) }] },
  execute: async (args) => index.search(args),
})
```

> 注意 JSON Schema 只能用 DSH 支持的子集：`type / oneOf / properties / required / additionalProperties / items / enum / const`（+ `description/title/default/examples`）。

### 8.2 系统提示段（`ctx.systemPrompt.section`）

只在"库非空"时注入，避免空库污染所有会话：

```
## 个人知识库
可用：kb_list / kb_search / kb_read。
用户说"知识库""我的资料""那份文档"或问题明显依赖本地资料时：先 kb_list 看库，
再 kb_search 检索，必要时 kb_read 读片段。回答末尾给出处（知识库 → 路径 → 章节）。
当前：3 个知识库，142 篇文档。
```

### 8.3 "针对具体文档对话" —— 三条入口，一条链路

**关键设计决定：不新建聊天窗，全部落到"正常会话 + 工具"。**

1. **文档详情页「问 AI」**
   预填 prompt 并开新会话（`ctx.uiWorkspace.startSession(undefined, { prompt, whenDraftExists:'append' })`，这是宿主自己在用的 API）：

   ```
   请基于我的知识库回答。
   文档：《2026 登记证清单.xlsx》  kb://doc/d_01HX…
   先用 kb_read 读这篇文章的相关部分，再回答；回答里标注出处（文档名 + 章节）。
   我的问题：
   ```

2. **知识库页顶部「检索 + 问 AI」**：Host 先跑一次检索，把 top-2 片段直接嵌进 prompt（省模型一轮工具调用，首字更快；片段有长度上限）。

3. **任意会话里模型自己调 `kb_search`**：不需要用户做任何事。

为什么用"预填 prompt"而不是"暗中注入上下文"：会话日志是唯一真相，用户看得见、改得掉、可重放；`agent.inject()` 那种隐式注入会让"为什么模型知道这个"无法从日志理解。

---

## 9. UI 设计

### 9.1 挂载点（已核实的插槽名）

| 位置 | 插槽 | 形态 |
|---|---|---|
| 左栏图标 | `sidebar.panellist` | `list`，注册 `{ id, order, label }` **且 `id` 必须与 `main` 的 `key` 完全一致**（不一致时选中会抛错） |
| 主页面 | `main` | `keyed`，注册 `{ key: 'dsh-knowledge-base' }`；切换面板用 `ctx.layout.selectPanel(id)` |
| 设置分区 | `settings.section` | `list`，`{ id, order, label }` |
| 会话头部（可选） | `conversation.session.header.utilities` | 会话作用域，能拿到 `sessionId`，用于"把这篇文档带进当前对话" |
| 输入区（可选） | `conversation.input.right` | 会话作用域，做"@"式引用桥 |

渲染客户端的形态（模板已验证）：

```js
window.__ModuleLoader__.load({ id: 'dsh-plugin-knowledge-base', factory(require) {
  const React = require('react')
  return { inject: ['slots'], apply(ctx) {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name:'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '知识库' }, KbIcon))
    ctx.slots.inject('main', () => ctx.slots.register(
      { name:'main', key: PANEL_ID }, KbPage))
  } }
} })
```

### 9.2 主页面布局

```
┌──────────────────────────────────────────────────────────────────────┐
│ 知识库 ▾ 产品资料          [搜索知识库…]          [导入文件] [新建]    │
├──────────────┬───────────────────────────────────────────────────────┤
│ ▾ 登记证      │  《2026 登记证清单.xlsx》                              │
│   · 清单.xlsx │  产品资料 / 登记证 · 1.2 MB · 已索引（38 段）· 2 分钟前 │
│ ▸ 报价        │  [在线阅读]  [问 AI]  [重新索引]  [重命名]  [删除]     │
│ ▸ 技术资料    │  ─────────────────────────────────────────────────    │
│              │  命中片段 / 相关文档 / 文档概要                          │
└──────────────┴───────────────────────────────────────────────────────┘
```

- 「在线阅读」→ `ctx.sidebarRight.openResourceIn(sessionId, fileAddressFor(sessionId, cwd, absolutePath))`，直接落到宿主原生预览（PDF 缩放、Office 转码、Excel 表格、Markdown 全都有了）。
- 状态点：`pending / parsing / failed / ready`，解析中显示进度，失败给原因 + 重试。
- 拖拽上传、右键菜单（重命名/移动/删除）走 P2/P3。
- 空态：「把文件拖进来，文件只存在这台电脑的 `~/.dsh/kb`，不会上传云端」。
- 主题：只用 `--dsw-alias-*` token，明暗跟随宿主；文案走 `ctx.locale`。

### 9.3 需要提前验证的一个细节

`main` 是 **root 作用域**，组件拿不到 `sessionId`；而预览地址是 **session 作用域**的（`dsh-resource://file/session/<sid>/<path>`）。所以"打开预览"必须先有一个会话身份。三种处理，按优先级：

1. 从全局 `useSessions` 里取最近一个有 `cwd` 的会话借用其文件系统身份（预览只是用它的 fs 执行世界，路径本身是绝对路径）；
2. 一个会话都没有时，提示"先开一个会话"，或退化为页面内纯文本预览；
3. 补齐入口：在会话头部加"知识库"按钮（session 作用域），从会话侧发起预览/引用。

这条在 P0 阶段必须先用一条真实文件打通（见 §12 未核实项）。

---

## 10. Host HTTP 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/kb/v1/state` | 库 + 树 + 统计 + 能力（PDF 抽取是否可用等） |
| POST | `/api/kb/v1/node` | `{ action:'create'\|'rename'\|'move'\|'delete', ... }` |
| POST | `/api/kb/v1/upload` | 裸 body 上传（§6.1），返回 `{ docId, status }` |
| GET | `/api/kb/v1/doc?id=&action=meta` | 元数据 + 分块数 + 解析状态 |
| GET | `/api/kb/v1/doc?id=&action=text&offset=&limit=` | 预览/取正文（UI 用） |
| GET | `/api/kb/v1/doc?id=&action=raw&t=<token>` | 原始字节（给 `<img>`/`<iframe>`，用启动令牌代替自定义头） |
| POST | `/api/kb/v1/doc?id=&action=reindex` | 重解析重建索引 |
| GET | `/api/kb/v1/search?q=&kb=&limit=` | 页面搜索（与工具共用同一份实现） |
| POST | `/api/kb/v1/ask` | 生成"针对某文档/某库"的预填 prompt |

路由注册（与工作区已有插件同款，已验证）：

```js
export const inject = ['webServer']
export function apply(ctx, config) {
  const routes = [ ... ]
  for (const route of routes) ctx.effect(() => ctx.webServer.register(route), `kb: ${route.path}`)
}
```

**UI 和工具调同一份服务方法**（不是两套逻辑）——这是 DSH 的明确约定，也避免"UI 能删、模型删不了"这种解释不清的状态。

---

## 11. 安全与隐私

| 风险 | 说明 | 对策 |
|---|---|---|
| **CSRF** | `webServer` 路由**没有全局鉴权**（会话 cookie 保护的是 `/api` 桥，不是插件路由）。用户浏览器里任意网页都能向 `127.0.0.1:<port>/api/kb/v1/...` 发简单请求 | 所有写接口要求自定义头 `x-kb-client: 1` + 校验 `Origin === ctx.webServer.getOrigin()`；自定义头会触发预检，而插件不应答 CORS → 浏览器直接拦掉 |
| 路径穿越 | 用户文件名里带 `../` | 落盘名固定 `<docId>.<ext>`，原名只存 DB；预览只接受"由 docId 查出来的路径"，绝不接受客户端传任意路径 |
| 任意文件读取 | 别把 `/api/kb/v1/doc/:id` 做成 `?path=` | 同上，只按 id |
| 密钥 | 向量服务 key | 走 `ctx.credentials.modifyRecord()`，不进 `cordis.patch.yml` |
| 隐私 | 默认全本地；开向量才出网 | 设置页显式开关 + 文案说明"开启后文本片段会发往 <端点>" |
| 容量 | 个人库会攒大文件 | 单文件上限 + 库总量提示 + 一键清空 |

---

## 12. 已核实 / 未核实（诚实清单）

**已核实（读安装包源码或实测）：**

1. `node:sqlite` 在 Electron 44.7.0 / Node 24.21.0 下可用；SQLite 3.53.4；FTS5 可用；中文检索结论见 §7.1（实测）。
2. 插槽：`sidebar.panellist`（root list）、`main`（root keyed）、`settings.section`、`sidebar.right.pane.tab`、`conversation.session.header.utilities`、`conversation.input.right` 均存在，且 `sidebar.panellist` 的 `id` 必须等于 `main` 的 `key`。
3. `ctx.sidebarRight.openResource(address, options?)` / `openResourceIn(sessionId, address, options?)` / `openTab(kind, options)` 存在；文件地址语法为 `dsh-resource://file/session/<sid>/<编码后的相对或绝对路径>`。
4. **工作区文件服务允许读工作区之外的绝对路径**（`dsh-api-workspace-files` README 明写："File reads and watches may target paths outside the workspace"；`stat/read/readBytes` 接受绝对路径）。→ 这是"库文件放 DSH_HOME 也能用原生预览"的可行性依据。
5. `ctx.webServer.register({ kind:'exact'|'prefix', path, handler })`、`ctx.tools.register({ name, description, parameters, output, execute })`、`ctx.systemPrompt.section({ name, order, text })`、`ctx.uiWorkspace.startSession(workspaceId, { prompt, whenDraftExists })`、`ctx.layout.selectPanel(id)`、`ctx.effect(fn, label)`、`ctx.inject([...], cb)` 的形态。
6. 官方模板形态：`package.json` 的 `dsh.bundle.patch` + `dsh.client.{platform,immediately,inject}`，客户端必须是 `window.__ModuleLoader__.load({ id, factory })` 且工厂里 `require('react')`、不出现 `import/export`。
7. 宿主禁止事项：不得 `require` 任何 Harness Client 包（React 与自研控件除外）；不得新增 session 事件类型；不得自己写 profile 的 `package.json` / `cordis.patch.yml`（交给 `plugin_manager install_bundle`）。

**未核实（实施时先花 30 分钟打通）：**

1. `fileAddressFor` 的**精确百分号编码**（每段 `encodeURIComponent`、绝对路径保留前导 `/`、Windows 盘符 `C:` 如何处理）。→ 用一条真实文件调一次预览确认，别凭猜。
2. root 作用域的页面能否稳妥拿到一个可用的 `sessionId`（§9.3）。
3. 本地目录方式安装 bundle 后，插件目录里的 `node_modules`（`pdfjs-dist`）能否正常解析（本地目录安装是 link，理论上可以）。
4. `pdfjs-dist` 在 asar 环境下的加载表现（插件本身在 profile 目录、不在 asar 内，预期正常，但要实测一次）。
5. `ctx.officeKit` 对 `.doc/.ppt/.xls` 老格式的可用性与耗时（P2 才需要）。

---

## 13. 分期计划与验收标准

### P0 · 骨架（半天）
bundle 骨架 + 图标/名称/详情页 + 左栏图标 + 空页面 + 一条 `GET /api/kb/v1/state` + 建表。
**验收**：安装后新会话里左栏出现图标；点开是空态页面；明暗主题正常；控制台无 `slot entry crashed`；§12 未核实 1–3 有结论。

### P1 · MVP（3–5 天，可用）
多库 + 树 CRUD + 上传 + 解析（md/txt/csv/docx/pptx/xlsx）+ FTS 索引 + `kb_list/kb_search/kb_read` + 右侧预览 + 设置页（根目录/上限/重建索引）。
**验收**：
- 建库 → 建文件夹 → 传 3 种格式 → 点「在线阅读」能看；
- 在**新会话里直接问**"我的知识库里有关于出口巴西的登记要求吗"，模型调 `kb_search` 命中；
- 中文 2 字词（"农药"）能命中；
- 关掉 DSH 重开，数据还在；卸载再装，文件还在。

### P2 · 对话闭环（2–3 天）
「问 AI」预填 + 系统提示段 + 命中高亮/引文 + PDF 抽取（pdfjs，可选能力）+ 解析失败可重试 + 会话头部入口。
**验收**：点文档问 AI，模型先 `kb_read` 再答，回答里带"文档名 + 章节"。

### P3 · 质量与体验（按需）
向量混合检索、拖拽导入、标签/收藏、`@` 引用源、聊天里的引文卡片、批量导入目录。

---

## 14. 风险与化解

| 风险 | 概率 | 影响 | 化解 |
|---|---|---|---|
| 预览地址编码不对 | 中 | 打不开文件 | P0 先打通一条，写进契约测试 |
| 中文检索召回差 | 中 | 答非所问 | 已定 CJK 归一化方案；P2 加向量兜底 |
| PDF 依赖装不上 | 中 | PDF 只能预览 | 抽取做成可选能力 + 设置页显示能力状态（降级不崩） |
| 大库索引卡顿 | 低 | 上传后长时间不可搜 | 后台单飞队列 + 进度 + 分页写入 |
| 文件越攒越多 | 中 | 磁盘 | 单文件上限 + 库容量提示 + 清空 |
| 用户以为是"云端知识库" | 中 | 信任问题 | UI 文案明写"只在本机"；向量开关单独说明 |
| 插件升级需重启 | 低 | 体验 | 文档写明；改配置可热更（`volatile` 字段） |

---

## 15. 落地目录结构

```
dsh-plugin-knowledge-base/
├── package.json              # dsh.bundle.patch + dsh.client（platform/immediately/inject）
├── cordis.patch.yml          # insert: id: knowledge-base, name: …, config: { root, maxFileBytes, … }
├── icon.svg                  # 插件图标（≤256 KiB）
├── locale/{zh,en}.json       # meta.title / meta.description / meta.detail + 界面文案
├── docs/DETAIL.md            # 插件详情页文档（功能、用法、限制）
├── index.js                  # Host 入口：export function apply(ctx, config) / export const inject
├── client.js                 # 浏览器入口：__ModuleLoader__.load({ id, factory })
├── lib/
│   ├── store.mjs             # 树/文档/元数据（node:sqlite）
│   ├── index-fts.mjs         # 分块 + CJK 归一化 + bm25 + snippet
│   ├── extract/{zip.mjs,docx.mjs,pptx.mjs,xlsx.mjs,pdf.mjs,text.mjs}
│   ├── pipeline.mjs          # 上传校验 → 抽取 → 分块 → 写索引（单飞队列）
│   ├── routes.mjs            # /api/kb/v1/*（Origin + 自定义头校验）
│   └── tools.mjs             # kb_list / kb_search / kb_read
└── test/smoke.mjs            # 建库→上传→检索→工具调用 一条链路
```

安装：`plugin_manager` 的 `install_bundle`（目标为这个绝对路径）。**不要**手写 profile 的 `package.json` / `cordis.patch.yml`。

---

## 16. 需要你拍板的 5 个点（我的默认建议已写在括号里）

1. **范围**：只做"个人本地库"，还是要"团队共享/多端同步"？（**建议先个人本地**；团队共享走 MCP 接 RAG 平台更划算）
2. **首发格式**：P1 只保 md/txt/docx/xlsx/pptx + PDF 仅预览，能接受吗？还是**必须**第一版就有 PDF 全文检索（那要早一天引入 `pdfjs-dist`）？
3. **是否允许文本出网**：向量检索要调 embeddings 接口（**建议 P2 再开，默认关**）。
4. **库文件位置**：`~/.dsh/kb`（**建议**）还是你指定某个盘符/目录（比如已有资料盘）？
5. **"问 AI"的形态**：预填 prompt 开新会话（**建议，最稳**），还是希望有个"钉在某文档上的常驻对话"（那要多做一个会话绑定层，P3 再说）？

---

## 附：为什么这套方案"看起来简单"却是对的

DSH 的插件模型把"能复用的"和"必须自己做的"切得很清楚：

- **槽位（slots）** 让你贡献 UI，但不让你重写应用外壳 —— 所以左栏图标、整页、设置页都是注册，不是新框架。
- **右侧栏 + workspaceFiles** 已经是一个完整的"文件浏览/预览"子系统，且**允许读工作区外的绝对路径** —— 所以"在线查看上传文件"这个看起来最重的需求，成本被压到一次 `openResource` 调用。
- **会话 + 工具 + 系统提示** 是 DSH 的"AI 能力"入口 —— 任何自建的聊天窗都只是在劣化复制它。

于是这个插件真正的价值只剩下：**树、解析、索引、工具语义**。这也是它应该被写的地方。

---

## 17. 已确认的决策 + 实施状态（第一版已落地）

### 17.1 你拍板的五件事

| # | 决策 |
|---|---|
| 1 | 只做**个人本地知识库**（不做团队共享/同步） |
| 2 | **必须有 PDF 全文检索**（因此第一版就引入 `pdfjs-dist`） |
| 3 | **允许做向量检索**（做成可选项，默认关闭，配置了 OpenAI 兼容 embeddings 才生效） |
| 4 | 库文件默认放 `~/.dsh/kb`，**配置 `root` 可改** |
| 5 | "问 AI"用**预填 prompt**，不做常驻的文档对话窗 |

### 17.2 与初版方案的三处偏差（有理由）

1. **阅读器做在页面内，而不是右侧栏原生预览**。
   原因：`main` 是 root 作用域，组件拿不到 `sessionId`，而右侧栏的文件地址是 session 作用域的。
   **第一版只做"文字阅读"，被实际使用打回**：用户打开一个 PPT，看到的是抽出来的文字目录，不是幻灯片原样。于是补了真正的原版式：借宿主的 `officeKit`（内置 LibreOffice）把 docx/pptx/xls/xlsx 转成 PDF，塞进 `<iframe>`；PDF/图片直接给原文件。这样零 session 依赖，且**是真的原版式**（版式、图片、表格都在）。文字版保留成可切换的一档。
2. **二进制预览不能带自定义头**，所以 `action=raw` / `action=preview` 额外支持一个启动令牌 `t=`（令牌只通过需要自定义头的 `/api/kb/v1/state` 下发），既让 `<img>/<iframe>` 能用，又不给跨站留口子。
3. 另外发现：这一版 `webServer` 的**前缀路由**没有接管 `/api` 下的自定义前缀（请求会落到 API 网关并得到 401），所以文档相关接口统一改成一条 exact 路由 + 查询参数。

### 17.3 已经真实跑通的部分（在这台机器上，装进 `desktop` profile 后实测）

| 能力 | 验证方式 | 结果 |
|---|---|---|
| 插件安装/激活 | `plugin_manager install_bundle` → `application: applied` | ✅ 左栏出现"知识库"，工具已挂到我这个会话 |
| 存储 | `node:sqlite` 在 Electron 44 / Node 24 主进程里可用，库建在 `C:\Users\AJ\.dsh\kb` | ✅ |
| docx 解析 | 上传 `示例-读书笔记.docx`（41 KB）→ 0.7 s 内 `ready`，抽出 2651 字 | ✅ |
| xlsx 解析 | 冒烟测试用 `示例-数据表.xlsx`，抽出 3637 字 | ✅ |
| PDF 全文 | 冒烟测试用生成的 PDF，pdfjs 抽出文字层并命中英文检索 | ✅ |
| 中文检索 | 「农药」「登记证」「化工品」两字/三字词均命中 | ✅ |
| 上传接口 | 裸 body 流式落盘 + 魔数/扩展名校验 + sha256 | ✅ |
| 原始文件 | `action=raw` 返回正确 MIME 与字节数 | ✅ |
| 预填 prompt | `POST /ask` 生成的文稿头包含文件名、路径、docId 与"先读再答、标注出处"的指令 | ✅ |
| CSRF | 不带 `x-kb-client` 头的请求被 403 拒绝 | ✅ |
| 工具 | `kb_list` / `kb_search` / `kb_read` 在本会话实际调用成功 | ✅ |
| 系统提示 | 库非空时自动注入"个人知识库"段落，库空时不注入 | ✅ |

### 17.4 还没验证的

- **浏览器里的视觉效果与交互**（点击、拖拽上传、PDF iframe 渲染）——我这边没有可用的浏览器控制通道，需要你刷新页面后自己看一眼。命令都通了，UI 代码也过了语法检查，但"看起来对不对"不能靠推断。
- 向量检索的真实效果（没有 embeddings 服务可用，代码路径与降级都写了，但没跑过真实请求）。
- 老版 `.doc/.ppt/.xls` 只支持打开原文件，不抽正文。

### 17.5 怎么继续用

1. 刷新页面（新装的客户端插件要重新加载一次）。
2. 左栏点「知识库」→ 新建库 → 拖文件或点「导入文件」。
3. 任意会话里问"我的知识库里有没有…"，模型会自己调 `kb_search` / `kb_read`。
4. 想开向量：插件配置里填 `embedding.baseUrl` / `model`（OpenAI 兼容），KEY 放环境变量 `DSH_KB_EMBEDDING_KEY`，设置页会显示状态。

插件源码在 `dsh-plugin-knowledge-base/`。

### 17.6 交付前的一轮 UX/契约审查（已修）

写完后让一个独立审查（只读）过了一遍 `client.js`，报了 15 条，其中 3 条是阻断级的，都已修：

| 级别 | 问题 | 处理 |
|---|---|---|
| 阻断 | `schedulePoll` 用了未声明的 `pollTimer` → 只要有文档在解析，`loadState` 就抛 ReferenceError，上传成功提示永远不出现 | 补回声明；轮询超时改成给一句"解析时间较长，可点重新索引" |
| 阻断 | 新建/重命名/删除全走 `window.prompt`，而 **Electron 渲染进程不支持 prompt** → 这些操作会静默失效 | 换成页内对话框（输入框 + 确认弹层，Escape/回车/点遮罩都可关）；删除独立成按钮 |
| 阻断 | 新建知识库后立刻 `loadState('')`，把选中项刷回最旧的库 | 改为直接用返回的新库 id |
| 明显 | 分页用"已显示字数"当绝对偏移，"继续加载"会读到重叠内容 | 服务端返回 `end`，前端存 `docNext` 作为唯一偏移来源 |
| 明显 | 检索请求没有序号，慢请求回包会覆盖新查询 | 加自增 `seq`，过期回包直接丢弃 |
| 明显 | 在 PDF/图片上点检索命中，界面不动但偏移被偷偷改了 | PDF/图片命中只打开文件并说明"无法精确定位" |
| 明显 | 操作失败被渲染成"信息"色（看着像成功） | 失败统一走红色 `error` 横幅 + `role="alert"` |
| 明显 | 零知识库时，正文引导去点一个被禁用的「导入文件」 | 空库改为给「新建知识库」主按钮 |
| 明显 | 删除藏在"重命名留空即删除"的 prompt 里，且只有右键入口 | 行内悬停出现"重命名/删除"两个按钮，另支持 F2 / Delete |
| 次要 | 树行不可键盘访问 | 加 `role="treeitem"`、`tabIndex`、Enter/Space/F2/Delete |
| 次要 | 设置页不显示错误，失败时永远"读取中…" | 设置页渲染 `error` |
| 次要 | 左栏图标忽略 `active` | 接 `active` 做高亮 |
| 次要 | 硬编码颜色 | 危险/警告色改为 `var(--dsw-alias-label-danger|warning, 兜底)` |

### 17.7 现在的自动化验证

两个不依赖浏览器的测试（都在插件目录里）：

```powershell
# Host：建库 → 解析（md/docx/xlsx/生成的 PDF）→ 中文检索 → 三个工具 → 树的增删改 → 清理
$env:ELECTRON_RUN_AS_NODE=1; & "<DeepSeek Harness.exe>" test/smoke.mjs    # 22 项断言

# Client：模块注册形态 / 三个插槽 / id 与 key 一致 / 首次渲染 / 文档·PDF·图片·检索·对话框·空态的渲染
& "<DeepSeek Harness.exe>" test/client-smoke.mjs                          # 25 项断言
```

两个都跑通（Host 22 项、Client 25 项）。

**仍然只能靠你眼睛确认的**：配色与间距在明暗两套主题下的观感、拖拽上传的手感、PDF iframe 在 Electron 里能不能正常显示（Chromium 内置 PDF 阅读器一般可以，但这台机器我没法替你打开页面看）。

### 17.8 原版式预览（第一版被打回后补的）

第一版只做了"文字阅读"，实际打开一个 PPT 看到的是抽取出来的目录文字 —— 这条需求没达成。补法是**不自己渲染 Office**，改用宿主的 `officeKit`：

```
点击 Office 文档
   → GET /api/kb/v1/doc?id=&action=preview&t=<token>
   → previewer.ensure(node)
       · files/<docId>.preview.pdf 比源文件新？→ 直接给（毫秒级）
       · 否则调 ctx.officeKit.convert({ extension, source:{ key, version, bytes, read() } })
       · 同一个文档的并发请求共用一次转换；结果落盘缓存
   → 返回 application/pdf → <iframe>（Chromium 内置 PDF 阅读器）
```

本机实测（都是在运行中的 DSH 里跑的）：

| 文件 | 大小 | 首次转换 | 生成的 PDF | 再次打开 |
|---|---|---|---|---|
| 示例-AI转型分享.pptx | 10.5 MB | 10.5 s | 1.67 MB | 缓存命中 |
| 示例-培训课件.pptx | 31.2 MB | 24.8 s | 22.3 MB | 缓存命中 |
| 示例-技术进展报告.pptx | 46.5 MB | 39.9 s | 13.9 MB | 缓存命中 |

配套的三个细节：
- **导入即预热**：上传/重建索引时就把转换排在后台（`priority: 'background'`），用户点开时通常已是缓存；前台请求会抢占后台任务。
- **超时可解释**：90 秒还没 `onLoad` 就给出"转换较慢/可能失败，可切文字版"，不让"转换中"永远转。
- **能力可降级**：`/state` 的 `capabilities.officePreview` 反映当前有没有转换服务；没有时界面直接说明并停在文字版，而不是转圈。

产物 `files/<docId>.preview.pdf` 与文档同生命周期：删除文档时一起删；源文件 mtime 变新则重转。

**第二轮被打回：预览里的缩略图栏跟左侧目录"打架"。** 截图里能清楚看到：阅读器自带的缩略图栏（第 1/2/3 页缩略图）站在预览左边，看起来像第二个目录，正文只剩右边一半 —— 那些 `#navpanes=0` 之类的 URL 参数在 Chromium 的 PDF 阅读器里不生效。结论：**不再把浏览器 PDF 阅读器塞进页面**。

最终做法（`lib/preview.mjs` 的 `ensurePages`）：

```
点击 Office 文档
   → GET /doc?action=previewinfo
       · 先确保有 PDF（见上一节）
       · officeKit.renderImages({ extension:'pdf', dpi:96, maxImages:200, … })
         → 每页 PNG 落到 files/<docId>.pages/p1.png、p2.png…
       · 页数超过 200 时退化为"只渲前 200 页"，并在界面注明
   → 前端自己画阅读器：页面自上而下堆叠、每页左上角页码、<img loading="lazy">
     只在前两页 eager，滚到哪儿才取哪页（GET /doc?action=page&n=K）
```

这样布局完全由我们控制：铺满阅读区、没有外来栏目、暗色主题一致、页面宽度自适应。本机实测：

| 文件 | 页数 | 首次渲染 | 逐页缓存 |
|---|---|---|---|
| 示例-读书笔记.docx | 8 | 1.1 s | 0.6 MB |
| 示例-AI转型分享.pptx | 9 | 2.5 s | 4.1 MB |
| 示例-培训课件.pptx | 25 | 6.2 s | 8.4 MB |
| 示例-技术进展报告.pptx | 123 | 28.1 s | 77 MB |

（单页 PNG 约 0.1–0.6 MB，取一页 0.12 s。）代价是页数多的文件会占几十 MB 磁盘，所以设置页加了「**清理预览缓存**」（`POST /api/kb/v1/purge-previews`），清掉后下次打开重做。

另外两个坑顺手记下：`officeKit.renderImages` 的 `maxPixels` 上限是 **16777216**、边长 **4096**，超了直接报 `maxPixels must be between 1 and 16777216`；`maxImages` 不够时给的是 `Selected page count exceeds maxPages`，据此做了"超页数就只渲前 200 页"的降级。

**第三轮反馈：能看原样了，但"不好选页"** —— 去掉缩略图栏之后，几十页的 PPT 只能一路滚，想直接看第 17 页没办法。于是补了阅读器自己的导航条：

- 页码输入框（回车跳转）+ 上一页 / 下一页 + 总页数；
- 默认「连续」模式：滚动时按可见页反算页码（scroll spy），页码框跟着变；
- 可切「单页」模式：只渲染当前页，配 ‹ › 一页一页翻 —— 讲 PPT 时更顺手；
- 每页容器带 `aspect-ratio`（用渲染结果的 1280×720 等尺寸），**未加载的页也占住正确高度**，所以"跳到第 50 页"不会因为图片还没来而滚偏。

这一版仍然是纯前端改动 + 已有接口，没有新增 Host 端点。

**第四轮：要能"点着选页"** —— 光有页码框还不够直观，于是补了一个**我们自己的**缩略图栏（和第一轮那个"外来栏目"的区别是：它在阅读器左侧独立成列、样式跟宿主一致、可一键收起）：

- 缩略图不是把 96 DPI 的大图缩着用 —— 那会让 123 页的文档一次解码几百 MB。改成服务端**另渲一套 24 DPI 的小图**（`files/<docId>.thumbs/p*.png`，320×180，约 20–80 KB/张），`GET /doc?action=thumb&n=K` 取用；
- 正文页与缩略图共用同一个渲染实现（`renderPageSet(node, { dpi, suffix })`），只是尺寸和缓存目录不同；
- 打开文档时 `previewinfo` 顺手在后台把缩略图渲好，所以滚动时缩略图基本都是热的；
- 点缩略图 = `goPage(n)`：连续模式下滚动定位、单页模式下切页；当前页加品牌色描边。

新增了一个 Host 端点（`action=thumb`），其余不变。

**第六轮：「新窗口」点了没反应。** 查了桌面端主进程源码（`app.asar/lib/main.js`），`view.webContents.setWindowOpenHandler` 只在目标协议是 `https:` 时才放行 —— 我们的地址是 `http://127.0.0.1:<port>/api/kb/v1/...`，于是被静默拒绝，`target="_blank"` 等于没有。

改法：**不再开新窗口**，改成插件自己的**应用内全屏覆盖层**「大屏」（`position:fixed; inset:0`，Esc 或按钮关闭）：

- Office：全屏铺开逐页图片（上限宽度放宽到 1400px，比面板里大得多）；
- PDF / 图片：全屏 iframe / `<img>`；
- 不依赖 `window.open`、`target=_blank`、任何浏览器权限，桌面端 Web 端都稳。

「下载」保持不变 —— 需要在第二个显示器上看、或者要选中复制 PDF 里的文字，仍然是「下载」后用系统应用打开最靠谱。

第三天又按反馈调了大屏的形态：**默认单页铺满**（一页一页看，像放映），顶部左侧是 `‹ 4 / 123 ›` 翻页 + 「单页 / 连续」切换，**右上角「恢复」按钮**（主色按钮，Esc 同效）；方向键 ← → / PageUp PageDown 也能翻。单页沿用 `object-fit: contain` 居中铺满的规则，所以横版 PPT、竖版 A4 都不会被裁。

再补一个布局需求：**文件树栏可收起**（`sideOpen`）—— 顶部最左侧箭头切换；收起后阅读区变宽，左边留一条 26px 细条，点它展开。这样窄屏时可以临时把目录让给正文。

**第五轮：新建的文件夹"点了没反应"** —— 查下来不是点击失效：那个文件夹里**没有子项**（用户的文件都在根目录），收起自然看不出变化。这暴露了三个真问题，都补上了：

1. **点文件夹不选中**：`activate` 对文件夹只切展开、不写 `selectedId`，于是"先选中文件夹再导入"根本做不到（导入永远落根）。现在点文件夹同时选中它（高亮）+ 展开收起。
2. **空文件夹没有反馈**：展开的文件夹没有子项时显示「（空文件夹，可拖入文件）」，收起才有对比。
3. **已有内容没法放进目录**：后端早就支持 `move`，界面却没有入口。现在行可拖拽（`text/kb-node`），文件夹行接收 drop 调 `move`；另外行上加了「移动到…」弹窗（列出所有文件夹 + 根目录，用物化 `path` 排除自己和子孙）。

顺带修了页面级拖放：以前把树内节点拖到空白处会触发"导入文件"的空处理，现在先判断 `dataTransfer.files.length`。

**又一轮被打回：预览窗口不适应界面。** 第一版把 iframe 塞在带 24px 内边距的滚动容器里，阅读器自带的缩略图栏还占掉一半宽度，页面只有 30% 缩放、下面还留一大条空白。改法：

- 视觉阅读单独一档 `.dsh-kb-reader--visual`：`padding:0`、`overflow:hidden`、`display:flex`，iframe `flex:1; min-height:0`，去边框 —— 铺满整块阅读区；
- 给阅读器传 `#view=FitH&navpanes=0`：适应宽度 + 收起缩略图栏（那栏是宽度杀手）；
- 操作栏拆成「新窗口」（在独立窗口看大图）和「下载」（存原件），避免"原文件"一点就直接下载这种反直觉行为。
