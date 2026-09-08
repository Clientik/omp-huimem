<p align="center">
  <img src="../assets/huimem.png" alt="huimem" width="560">
</p>
<h1 align="center">omp-huimem</h1>
<p align="center">为 oh-my-pi 保存项目决策、原因与下一步工作。</p>
<p align="center">
  <a href="../../README.md">English</a> · <a href="README.ru.md">Русский</a> · <strong>简体中文</strong>
</p>

在不同会话之间保留项目知识，无需运行第二个模型。当前事实保存在可读文件中，证据和版本历史保存在本地 SQLite 中。只需一个 OMP 扩展，无需独立的记忆服务器、向量嵌入服务或后台 LLM。

> **预览版 v0.1.0，已在 OMP 18.1.5 上测试。** 暂不支持原版 Pi。这个插件帮助恢复和检查项目上下文，但不能消除模型幻觉。

## 适合谁？

适合使用 AI 开发项目、不想在每次会话中重新解释架构的开发者。尤其适合主要本地模型已经占用可用算力的环境。

- **知识与代码放在一起。** 事实、决策和任务可以人工阅读、修改，并通过 Git 管理。
- **可检查的证据。** 记录必须引用消息或文件中的真实文本；消息 ID 和文件哈希由代码提供。
- **保留修订历史。** 修改会创建同一记录的新版本，不会悄悄覆盖旧版本。
- **明确标记过期信息。** 来源或核心文档变化后，旧记录标记为 `STALE`，需要重新检查。
- **有上限的上下文。** 自动注入的记忆块最多为 8,000 个字符；需要时由代理读取完整来源。

## 安装

需要安装 [OMP](https://github.com/can1357/oh-my-pi) 并配置主模型，也支持本地模型。

```sh
omp plugin install github:Clientik/omp-huimem#v0.1.0
```

将 `starter/` 的**内容**一次性复制到新项目根目录，包括隐藏文件。现有项目请合并配置，不要覆盖已有知识。进入项目根目录启动 `omp`，然后执行：

```text
/project-memory-status
```

让代理使用 `initmem` skill，根据真实代码填写项目地图。架构规则需要针对项目设置；初始模板没有预设规则。

**安装状态：** GitHub 命令符合 OMP 的包机制，但完整安装流程尚未通过我们的验收测试。已验证的备用方式是直接加载：

```sh
git clone --branch v0.1.0 https://github.com/Clientik/omp-huimem.git
# 在工作项目中运行，使用克隆仓库的绝对路径：
omp --extension /absolute/path/omp-huimem/dist/index.js
```

Windows 路径请加引号。直接加载时，如需使用配套 skills，请将 `skills/` 复制到工作项目的 `.omp/skills`。不要同时加载旧的 `project-memory.ts` 扩展。

OMP 18.1.5 的原生 GitHub 安装作用于用户级，不能通过 `--scope project` 改为项目级。记忆数据仍保存在当前项目的 `.memory` 中。

## 记忆分层

| 位置 | 用途 |
| --- | --- |
| `.memory/MEMORY.md` | 当前事实和约束 |
| `.memory/adr/` | 决策及其原因 |
| `.memory/todo.json` | 任务状态 |
| `.memory/PROJECT.md` | 代码地图和工作命令 |
| `.memory/architecture.json` | 明确、可检查的架构限制 |
| `.memory/DESIGN.md` | 界面设计约定 |
| `.memory/runtime/state.sqlite` | 对话片段、证据版本和检查点摘要 |

模板使用 `.memory` 和 `.omp` 两个辅助目录，根目录保留 `AGENTS.md` 与 `.gitignore`。插件代码与项目数据分开存放。

## 工作示例

你说：“使用 PostgreSQL，因为订单和支付需要事务。”扩展保存消息，代理更新事实和决策，并可将证据写入注册表。新会话中，扩展提供简短记忆上下文，帮助代理恢复选择及原因。

决策变化时，代理更新文件并创建记录的新版本。旧引用不能证明旧决策仍然有效；遇到冲突必须检查原始来源。

**对话文本自动保存，但有用知识的提取和维护仍依赖主模型。** 没有第二个 LLM 进程，也不会在会话结束时强制循环保存。

## 取舍与限制

这是面向单个项目、易于检查的记忆系统。它提供来源验证和本地持久化，不需要独立提取服务。目前没有对比基准能证明其效果优于其他记忆系统。

搜索基于文本匹配，不是语义搜索。架构检查匹配指定字符串，不分析完整依赖图。引用验证证明来源，不证明内容正确。文件和 SQLite 写入不是同一个事务。真实上下文压缩、崩溃、并发会话和分支切换仍需更多测试。

8,000 字符不是 token 上限，也不是已经测得的节省比例。使用云端主模型时，注入的记忆上下文会发送给该提供商。

不要将运行时 SQLite 提交到 Git。备份历史前请停止会话，复制整个 `.memory`，包括存在的 WAL/SHM 文件。目前没有自动历史清理。

## 文档与开发

详细用户文档目前为俄语：[使用指南](../GUIDE.md)、[分层说明](../LAYERS.md)、[方案比较](../COMPARISON.md)、[测试结果](../VALIDATION.md)。英文开发资料：[发布流程](../PUBLISHING.md)、[OMP 来源](../OMP-SOURCES.md)。

安装 Bun 后，`bun run build` 构建扩展，`bun run check` 执行 28 项测试及包检查。其中 8 项是在构建产物上重复运行适配器测试。无需额外运行时 npm 依赖，构建产物已包含在仓库中。

保留全部七个 skills。代码及配套 skills 包含 [MIT 许可声明](../../THIRD_PARTY_NOTICES.md)。package.json 的 `private` 用于防止意外发布到 npm，不影响 GitHub 分发。
