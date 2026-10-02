# dsh-search — 全局检索

在整个 DSH 里搜关键词：**会话标题**、**全部聊天记录**（用户消息、助手回复、思考过程、
工具调用与结果、压缩摘要、会话目标、任务清单、审批、注入消息）、**长期记忆**，
以及（可选）工作区文件。

两个方向共用同一个索引，因此「人搜到的」和「模型搜到的」永远一致：

- **用户**：侧边栏底部的「全局搜索」入口 → 全屏面板（关键词高亮、按会话打开、看原文、索引状态与重建）。
- **模型**：`search_dsh`（检索）+ `search_dsh_read`（把某条整段读回）。

## 为什么需要它

会话日志是**多帧 zstd** 的 JSONL，`grep` 读不了；DSH 自带的会话搜索只覆盖标题。
想找"我上次说过的那句话""哪个会话里配过这个参数"，只能靠人翻。

本插件把会话语料解压后建成本地全文索引（SQLite FTS5），检索在毫秒级返回带出处与高亮的片段。

## 关键设计

| 问题 | 做法 |
| --- | --- |
| 1.1GB 文本、15 万条记录 | SQLite + FTS5 增量索引，按批事务写入；首次全量约 40 秒 |
| 多帧 zstd 读不了 | 自写帧边界扫描 + 逐帧解压（与 DSH 自身 `session-persistence-jsonl` 的扫描算法一致） |
| 中文搜索精度 | 建索引时**逐汉字成词**，查询时把连续汉字折成**一个短语**（`"任 务 看 板"`），因此"任务看板"只匹配真正相邻出现的文本，不会因分词顺序散架 |
| 索引期间不能卡住 GUI | 构建跑在 **worker 线程**里；主线程只收进度消息，会话与界面照常可用 |
| 重复记录占满结果 | 同一会话内文本相同的记录折叠（保留最权威的种类），并标注"另见 N 处" |
| 标题不全 | 会话日志里的 `session/title` 为主，`storages/session_projcache.json` 为补充 |
| 磁盘占用 | 正文一份 + contentless FTS 一份；实测 1.1GB 语料 → 约 450MB 索引 |

## 查询语法

- 多个词用空格分隔 = **都要命中**；`match: any` 改为任一命中；`match: phrase` 整串当一个短语。
- 引号包住 = 整体短语，例如 `"任务看板 cron"`。
- 词前加减号 = 排除，例如 `索引 -缓存`。
- 范围：`all` / `sessions` / `memory` / `files`；可按会话、工作目录、时间范围过滤。

## 配置（cordis.yml）

```yaml
- id: dsh-search
  name: dsh-search
  config:
    includeFiles: false        # 是否索引工作区文件（默认关，会显著拉长构建）
    fileRoots: []              # 工作区文件根目录；空则读环境变量 DSH_SEARCH_FILE_ROOTS
    autoIndexDelayMs: 20000    # 启动后首次自动增量索引的延迟；0 = 不自动
    autoIndexIntervalMs: 1800000
    defaultLimit: 30
```

## 数据位置

索引库 `$DSH_HOME/search/index.sqlite`。它是**可再生的派生物**：损坏或版本不匹配时直接重建
（`POST /plugins/dsh-search/build` 带 `{"full":true}`），不做兼容迁移。

## 本地路由

| 路径 | 用途 |
| --- | --- |
| `GET /plugins/dsh-search/status` | 索引状态、进度、配置 |
| `GET /plugins/dsh-search/search?query=&scope=&match=&limit=` | 检索（片段与高亮由 Host 算好） |
| `GET /plugins/dsh-search/doc?id=&radius=` | 某条原文（可选上下文邻域） |
| `GET /plugins/dsh-search/sessions` | 已索引会话列表 |
| `POST /plugins/dsh-search/build` | 构建/更新索引（`{"full":true}` 重建） |
| `POST /plugins/dsh-search/cancel` | 停止构建 |

## 边界

- 只读：插件不写会话日志、不写记忆、不改用户文件；唯一写入是它自己的索引库。
- 索引在 worker 里跑，一次只允许一个构建；取消在批次之间生效（已写入的批次保留）。
- 流式增量块（`assistant/chunk` 等）不入索引：它们是同一段文本的中间态，只在完整记录里建索引。
- 不含网络请求、不含遥测。