# 贡献指南

欢迎参与文档、测试、客户端接入和代码改进。维护者为 [@Piao-2024](https://github.com/Piao-2024)。仓库当前为私有，参与者需要相应访问权限；项目由 [Infinite Monkey Lab](https://github.com/Infinite-Monkey-Lab) 托管，协作同时遵循[组织贡献指南](https://github.com/Infinite-Monkey-Lab/.github/blob/main/CONTRIBUTING.md)。

## 选择任务

小型文档修正或明确缺陷可以直接提交 PR。新功能、数据格式、公共接口、许可证或隐私边界的变化，请先用 Issue 讨论问题、范围和验证方法。开始处理已有任务前留言说明计划，避免重复劳动。

适合首次参与的工作包括：按 README 复核安装命令，用虚构数据验证两个客户端之间的查询，补充 Linux 或 Windows 的实际验证记录。没有实际验证的平台不要写成已支持。

## 开发和验证

需要 Git、Node.js 24 或更高版本与 npm。从最新的 `main` 创建主题分支，然后执行：

```sh
npm ci
npm test
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
git diff --check
```

测试使用临时目录和虚构数据；不要把真实记忆作为测试输入。npm 镜像可能不支持安全审计，上面的审计命令显式使用官方 registry，不修改本机 npm 配置。运行审计需要联网。

需要手动启动或执行维护命令时，请在终端中同时设置三个路径，使用独立、可丢弃的目录：

```sh
export MEMORY_DB_PATH="$PWD/.local-memory-test/memory.sqlite3"
export MEMORY_FILE_PATH="$PWD/.local-memory-test/memory.jsonl"
export MEMORY_EXPORT_PATH="$PWD/.local-memory-test/exports/memory.md"
npm run status
```

后续命令应在同一终端运行，并沿用这三个变量。退出测试终端即可结束该终端的环境设置。不要直接修改 SQLite、JSONL 或锁文件来改变记忆，通过 MCP 工具操作。

## 提交 PR

1. 每个 PR 聚焦一个问题，说明触发条件、改动和影响。
2. 附上运行环境、验证命令、结果，以及没有验证的部分；文档改动检查链接和示例。
3. 关联已有 Issue，只有确实解决问题时才使用 `Closes #编号`。
4. 说明重要的 AI 辅助部分，以及自己如何理解和核验。不能理解的代码、编造结果或引用不得提交。
5. 等待维护者评审后合入。维护者的改动也优先通过 PR，保留讨论和验证记录。

自动测试覆盖本地核心逻辑与协议交互，不代表真实客户端、插件安装或全部平台验证。独立复核时应记录复核者、系统、Node 版本和可重复步骤。

## 来源、隐私与许可

只提交有权分发的内容，保留原作者署名。新增依赖需同步锁文件和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，说明来源、用途和许可；项目的 MIT 不会覆盖第三方许可证。

不要提交真实记忆、聊天记录、数据库备份、凭据或个人资料。Issue、PR、终端输出和截图也应遵守这一点。复现问题使用最小的虚构数据，不粘贴整个记忆库。

发现可能泄露数据、越权访问等安全漏洞时，不要在公开 Issue 中贴出漏洞细节或真实数据。优先使用仓库 Security 页的私密报告入口（若已开启）；入口不可用时，先向维护者请求私密报告渠道，联系请求中不含漏洞细节。

提交原创代码或文档意味着你有权按本项目 [MIT 许可证](LICENSE) 提供该内容，第三方内容需单独标明授权。
