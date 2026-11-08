# Blackboard Orchestrator

这是本机自用的双向交接工具。Codex CLI 与 DeepSeek Harness（DSH）可以按你的要求唤起对方的新会话或已有会话；是否继续交接、审查或返回原会话，由你的任务描述和 Agent 决定。控制器不会自动安排固定流程。

需要 Node.js 24.9 或更新版本、Git、已登录的 `codex`、已配置模型的 `dsh` 和 pnpm。当前实现针对本机 Codex app-server 与 DSH Web Host；两端仍分别使用各自的模型和权限。

## 安装

```bash
cd ~/Project/blackboard-orchestrator
node src/cli.mjs setup
```

安装会注册 Codex 本地 MCP、安装两端技能、以本地 bundle 的形式安装 DSH 插件，并将 `.codex-dsh/` 加入当前用户的 Git 忽略文件。项目的 `.gitignore` 不会被修改。添加 MCP 前会将已有的 Codex 配置备份到运行目录的 `backups/`。

如已打开的 Codex 会话看不到工具或技能，请新开 Codex 会话；DSH 未显示插件或工具时，请重启 DSH Web Host。DSH 的插件页中可查看或启停 `blackboard-relay`。

无需预先启动控制器。首次交接时会自动启动并保持常驻；如果没有 DSH Web Host，会启动一个并尝试打开浏览器。也可以手动管理：

```bash
node src/cli.mjs start
node src/cli.mjs web
node src/cli.mjs stop
```

`stop` 停止控制器，保留 DSH Web Host。`web` 显示的地址含本机访问凭据，请勿分享。等待期间控制器不会主动发起模型回合。

更新项目代码后，先确认交接任务已停稳，运行 `node src/cli.mjs stop`，重启 DSH Web Host 并重新打开 Codex 会话。下一次交接会按需启动新控制器。

## 从对话发起

在 Codex CLI 中，可以输入：

> `$to-dsh` 请先和我确认实现计划，然后交给 DSH 在当前项目实现并测试；完成后交回这个 Codex 会话审查，先向我报告。

在 DSH WebUI 中，可以输入：

> `/to-codex` 请让 Codex 先规划这个需求；我批准后交给一个新的 DSH 会话实现，再交回同一个 Codex 会话审查，最后回到当前会话告诉我结果。

也可以直接使用自然语言。技能会提供调用说明，Agent 根据实际任务选择会话和工具参数；技能本身不是不经过模型的程序命令。双方均可使用 `blackboard_sessions` 查看任务中的会话 ID，以精确指定原会话或要求新会话。新建 Codex 会话时会尝试打开原生终端；无法自动打开时可用下面的 `tui` 命令。

代码修改前先在任一参与会话中向你说明计划并取得明确批准。只读规划可以先交接。批准记录由 Agent 写入任务，属于协作式约束；仍须遵守两端原生的权限和审批机制。涉及新项目或其他重要范围变化时，先取得你的同意。

## 工作区与交接材料

交接时可以指定目标工作区。DSH 现有会话的沙箱工作区由原生会话决定；不匹配时请新建对应工作区的 DSH 会话，或通过 DSH 原生机制调整权限。Codex 使用指定线程及其原生权限。

单项目任务的材料保存在实际项目的 `.codex-dsh/tasks/<任务ID>/`。涉及多个项目时保存在 `~/.local/share/blackboard-orchestrator/tasks/<任务ID>/`；任务经批准扩展到其他项目时会迁移到该位置，并保留旧路径引用。控制信息位于 `~/.local/share/blackboard-orchestrator/`。

如设置 `BLACKBOARD_DATA`，所有启动 Codex MCP、DSH Host 和控制器的环境必须使用相同值。交接材料存放在本地，信号只传控制信息；Agent 的本地工具调用和模型服务请求仍可能包含任务内容。

涉及代码的任务，每次跨端交接前都要求源和目标 Git 工作区干净；非 Git 目录只支持只读任务。Agent 可根据任务自行建分支和提交，控制器不会自动暂存、提交、合并或推送。并发处理同一仓库时请使用不同 worktree。工作区检查遵循 Git 的忽略规则。

## 模型与权限

默认使用 `config.example.json`；如需自定义，可复制为 `config.json` 并修改。配置中可以分别设置两端的模型、提供方和推理强度；值为 `null` 时继承原生默认值。也可以在对话中指定本次任务的型号和强度。模型及权限选项从当前两端动态获取：

```bash
node src/cli.mjs models
```

对话中的 `blackboard_options` 可查询指定会话的权限预设；明确要求后，Agent 可调用 `blackboard_set_permission` 调整当前或任务中另一会话的权限。任务内的临时调整默认在结束时尽力恢复；要求持续生效时会保留。Codex 调整从下一回合生效；如果同时要求继续工作，工具会在同一会话接续。DSH 调整对后续受限工具调用生效，不改变已经运行的命令。原生审批和权限限制仍然适用。

未关联任务时，可以明确要求权限在会话中持续生效；如需临时调整，请同时说明要继续完成的工作，以便工具确定恢复时机。

## 查看与处理问题

```bash
node src/cli.mjs status
node src/cli.mjs status <任务ID>
node src/cli.mjs report <任务ID>
node src/cli.mjs tui <任务ID> [--session <Codex会话ID>]
node src/cli.mjs pause <任务ID>
node src/cli.mjs resume <任务ID> --retry
```

当前活跃端可以继续与你对话。手工接手另一端或修改同一任务代码前，先暂停该任务并确认原会话及后台命令已停止。不同任务可并发；端口、数据库、GPU 等共享资源只做尽力发现，出现争用时人工处理。

超时、插件不可用、权限失败或控制器异常时会保留现场并阻断，不会自动重放结果不明的工作。恢复前请检查两端原生界面、工作区和后台进程。如果 DSH 插件被关闭，工具会尝试通过已知的本机 Host 重新启用；无法自动启用时，请在 DSH 插件页手动启用后重试。

## 验证

```bash
npm test
```

测试使用临时仓库和模拟的会话服务，覆盖多次交接、工作区检查、权限恢复及桥接状态；真实的 Codex 和 DSH 集成仍需在本机环境中验证。

更多内容见 [功能说明](docs/FEATURES.md) 和 [架构与技术实现](docs/ARCHITECTURE.md)。
