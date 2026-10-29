# 第三方来源与许可

本项目原创源码、文档和横幅采用根目录的 [MIT 许可证](LICENSE)。第三方组件保留各自许可证，不能据此重新标为 MIT。依赖的精确版本、下载地址和完整性值以 [package-lock.json](package-lock.json) 为准。

## 运行依赖

| 组件 | 锁定版本 | 用途 | 包内声明与来源 |
|---|---|---|---|
| `@modelcontextprotocol/server` | 2.3.1 | MCP 服务端和 stdio 传输 | Apache-2.0；[上游](https://github.com/modelcontextprotocol/typescript-sdk) |
| `@modelcontextprotocol/core`（间接依赖） | 2.3.1 | MCP 协议核心 | Apache-2.0；[上游](https://github.com/modelcontextprotocol/typescript-sdk) |
| `@modelcontextprotocol/server-memory` | 2.0.0 | 读取旧 JSONL，以及复用文件锁接口 | 包声明为 `SEE LICENSE IN LICENSE`；[上游](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) |
| `zod` | 4.6.7 | 工具输入校验 | MIT；[上游](https://github.com/colinhacks/zod) |

Node.js 提供 `node:sqlite`，本项目无需单独安装 SQLite npm 包。Node.js 及其所含第三方组件由各自发行版提供，遵循 [Node.js 许可说明](https://github.com/nodejs/node/blob/main/LICENSE)。

### server-memory 的许可说明

截至 2026-10-29，本地安装的 `@modelcontextprotocol/server-memory@2.0.0` npm 包声明 `SEE LICENSE IN LICENSE`，但包中没有附带该 LICENSE 文件。[上游许可证快照](https://github.com/modelcontextprotocol/servers/blob/6b36e3c22311faed9bd570547d0d90718846fc20/LICENSE) 说明项目处于 MIT 向 Apache-2.0 的过渡，部分未取得重新授权的贡献仍保留 MIT，非规范文档为 CC-BY-4.0。这不是“该 npm 版本所有内容均为单一许可证”的确认。

本仓库通过 npm 引入依赖，不提交 `node_modules` 或第三方包的拷贝。若将来打包或重新分发这些依赖，应先核实具体发行版本的许可范围，并附齐适用的版权声明、许可证和 NOTICE；不要只附本项目的 MIT 文件。

## 图片与外部服务

- [banner.svg](docs/assets/banner.svg) 为本项目生成的 SVG，像素标题使用本地绘制的方块路径，不包含下载字体、照片或第三方角色素材，随本项目采用 MIT。
- README 的徽章图片由 [Shields.io](https://shields.io/) 提供，通过外部链接显示；产品和平台名称、标志仍属于各自权利人，不代表背书。
- GitHub Actions 使用 `actions/checkout` 和 `actions/setup-node`，来源分别为其同名官方仓库，均采用 MIT；工作流固定完整提交 SHA，版本更新由 Dependabot 提议。

## 数据和费用边界

仓库测试使用虚构记录和临时文件，不分发真实记忆、模型权重或外部数据集。数据库、旧 JSONL、Markdown 阅读副本和备份属于使用者的数据，不包含在仓库分发中。

记忆服务本身不调用付费模型 API；安装依赖、查看在线徽章、运行 Actions 需要相应网络或平台服务。所使用 AI 客户端及模型的费用和数据处理规则由对应服务决定，查询结果进入模型上下文后可能发送给模型服务商。
