# Shared Agent Memory

本地共享长期记忆 MCP 服务，适用于支持 stdio MCP 的 Agent；仓库同时包含 Codex 可移植插件清单。多个客户端可使用同一份 SQLite 数据，保存偏好与项目决策，并查询、修订和追溯历史。

## 功能

- 通过 `remember_memory`、`search_memories`、`correct_memory`、`memory_history` 和 `forget_memory` 管理记忆；更正保留版本历史，`forget_memory` 为逻辑删除，历史仍然保留。
- 检索支持中文分词、关键词全文检索、项目范围和结果预算；项目过滤不是权限隔离，也没有向量语义检索。
- 提供原 memory server 实体、观察、关系工具的兼容接口；从原 JSONL 只读导入。
- 将阅读副本单向导出为 Markdown。Agent 需要按自身规则调用 MCP，插件不自动采集全部对话或保证每轮检索。

## 环境和启动

要求 Node.js 24 或更高版本，使用内置 `node:sqlite` 和 FTS5。安装依赖：

```sh
git clone https://github.com/Piao-2024/shared-agent-memory.git
cd shared-agent-memory
npm ci
npm test
```

运行 `node start.mjs` 启动 stdio MCP 服务。MCP 客户端需要使用稳定的绝对路径指向 `start.mjs`，并确保 Node 在客户端进程的 PATH 中。示例（将 `/path/to/shared-agent-memory` 换为实际路径）：

```json
{
  "mcpServers": {
    "shared-memory": {
      "command": "node",
      "args": ["/path/to/shared-agent-memory/start.mjs"]
    }
  }
}
```

Codex 配置位于 `~/.codex/config.toml`，Claude Code 和其他 MCP 客户端的配置格式各不相同；可以使用其各自的 MCP 配置命令或设置界面。现有的手动 MCP 入口与插件入口若同时启用，可能出现两组同名工具；请根据客户端情况保留所需入口并确认指向同一数据目录。

默认数据目录为 `~/.agent-memory`：

| 路径 / 环境变量 | 用途 |
|---|---|
| `memory.sqlite3` / `MEMORY_DB_PATH` | 共享权威数据库 |
| `memory.jsonl` / `MEMORY_FILE_PATH` | 可选的旧记忆只读导入来源 |
| `exports/memory.md` / `MEMORY_EXPORT_PATH` | 单向生成的 Markdown 阅读副本 |

首次启动若同一目录已有 v1 JSONL，会通过旧 memory server 接口读取并导入；如需全新隔离库，请同时显式设置上述三个环境变量到独立目录。不要直接修改 SQLite、JSONL 或锁文件来操作记忆。

## Codex 插件

根目录的 `plugin.json`、`mcp.json` 和 `.agents/plugins/marketplace.json` 是插件与仓库 marketplace 清单。根据 [OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins)，可添加此仓库为 marketplace，并在支持的 Codex 客户端中安装。插件中的 MCP Server 依赖本地 Node 和 npm 依赖；需要确保**客户端实际加载的插件副本**中已经安装依赖。插件安装、缓存目录与依赖安装的端到端流程尚未实测，不保证从 GitHub 直接安装即可运行；直接配置上面的 MCP 入口是已经由集成测试覆盖的使用方式。

在目录中执行 `npm ci` 安装依赖；这不会自动为客户端缓存中的另一份插件副本安装依赖。插件需在本地运行，不能因此推断支持云端或移动端。

## 维护

```sh
npm run status
npm run export
npm run backup -- /absolute/path/to/new-backup.sqlite3
```

备份目标必须是不存在的绝对路径；备份使用 SQLite backup API。复制运行中的主数据库文件不一定包含 WAL 中的全部内容。旧进程仍可能使用 v1 JSONL：v2 可读取其后续变更，但 v1 不会看到 v2 新记录，旧客户端需要重连。

项目只存程序源码和虚构的测试数据；数据库、JSONL、Markdown 导出、备份、凭据和用户配置均不应提交到 Git。实际检索结果进入模型上下文后，会发送给所用模型服务商。
