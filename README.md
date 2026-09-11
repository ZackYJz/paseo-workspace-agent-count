# Workspace Agent Count

Paseo 0.8.0 插件：让你随时看到每个 workspace 下有几个会话（agent）。

Paseo 0.8 仍然没有侧栏行徽标 API，所以这个插件提供两种呈现方式：只读的总览始终开启，标题前缀可选且会改写数据。

| 呈现 | 位置 | 是否改写数据 | 默认 |
| --- | --- | --- | --- |
| **Agent 总览** | 侧栏入口，列出**每个 workspace 下全部会话的标题**，点会话直接跳到那个 tab | 否 | 开启 |
| **标题前缀** | 改写成 `(3) 原标题`，因此也出现在原生侧栏行上 | **是** | 关闭 |

只有标题前缀能把数字放上原生侧栏行。它写入持久化的 workspace 标题，所以默认关闭；关闭状态下插件会自动把历史装饰恢复成原标题。

**刻意不提供 workspace 内的顶栏数量按钮**：进到某个 workspace 时，左栏已经列出它的全部会话，那个位置只能重复你已经看到的信息。这个插件的价值在于不打开也能横向比较。

## Agent 总览

信息层级是 **项目 → workspace → 会话**，全部展开不折叠。侧栏行本身只能显示 workspace 名（而那个名字就来自第一个会话的标题），所以这个页面存在的理由就是把剩下的会话标题摊出来。

展示规则全部定义在 `shared/presentation.ts` 里并有测试覆盖：

- **会话标题占满宽度、最多 3 行**。这是整个页面的目的，不为了密度牺牲它。
- **一条对齐轴，不画引导线**。会话行与卡片头共用同一水平 padding 与 gap，状态点放在一个与计数徽章等宽的 gutter 里居中：点必然落在计数正下方，会话标题必然与 workspace 标题同轴。嵌套关系靠缩进与间距表达，竖线和横向分割线只会留下对不齐的残笔。
- **计数徽章是中性色**（surface2 底 + muted 字）。颜色只留给状态：色点、状态胶囊、顶部汇总。一墙同色实心圆会把 accent 的语义抽干，还会压过标题。
- **只有例外才打文字标签**。空闲/已关闭是常态，逐行标“空闲”只会淡化真正需要你处理的行；这些状态仍由左侧色点表达。
- **排序把需要你处理的置顶**：等待授权 > 出错 > 需要处理 > 运行中 > 已完成 > 空闲 > 已关闭 > 已归档；同优先级按创建时间升序，等得久的在前。workspace 同理，再按会话数降序、名称升序。
- **workspace 状态用 host 自己的汇总**（`needs_input`/`failed`/`attention`/`running`/`done`），不自己从 agent 重推，因此与原生侧栏不会矛盾；非静止状态才画胶囊。
- **provider 列只在目录真的混用时才出现**。全部是 pi 时它每行都一样，那是噪音不是信息；空字符串不算第二个值（早期记录没有该字段），否则列会打开然后每行都挂着同一个词。真的混用时，缺失值显示为 `—`。
- `diffStat` 非零时在卡片头显示 `+12 −3`，提醒哪个 workspace 里还压着未提交改动。
- **已归档会话置灰但仍列出**，因为计数口径包含它们 —— 否则会出现“2 个会话”却只看得到 1 行。
- 顶部汇总只在非零时显示胶囊：`需要处理 N`、`运行中 N`，加上 `N 个会话 · N 个 workspace`。

交互：会话行可点，走 `navigation.openAgent({ agentId })` **直接打开那个 tab**，不需要先进 workspace 再找；卡片头可点，走 `openWorkspace`。旧 host 没有 `navigation` 时降级为不可点的只读行，而不是给一个按了没反应的按钮。

配色只用 `theme.colors` 里的 `statusDanger`/`statusWarning`/`statusSuccess`/`accent`/`foregroundMuted`/`surface*`/`border`，不写死颜色，换主题自动跟随。

## 计数口径

`shared/tally.ts` 的 `tallyAgents` 是**唯一权威定义**，两种呈现都用它，所以不会互相矛盾：

- 按准确的 workspace ID 统计全部保留的 Agent 记录，包括已归档和已关闭的会话。
- 不按目录混算，不统计终端/浏览器标签，没有 workspace 的 agent 不计入。
- 跨页重复出现的同一条记录只算一次。
- `initializing` / `running` 的 agent 会把所属 workspace 标为 busy，**标题改写在 busy 期间暂停**；总览不用这个值，它直接显示 host 自己的 workspace 状态。

已删除的会话不计入；总数只统计当前可列出、非归档中的 workspace。

## 刷新机制

**daemon 侧（标题模式）**：`index.server.ts` 注册了 5 个生命周期事件——`agent.created`、`agent.archived`、`workspace.created`、`workspace.archived`、`agent.turn_ended`。这些事件投递到插件子进程，**不需要任何客户端连接**。`agent.turn_ended` 用于解除 busy 期间的写入暂停。

**client 侧（总览）**：`client/directory.ts` 订阅 agent 与 workspace 两个目录，把订阅当作变化信号，每次变化重新完整读取两个目录。刷新是合并的：读取期间到达的新变化会补一次尾随刷新，不会被时间节流丢弃。读取失败时保留上一份快照并显示原因，绝不把失败当成 0。

**流式噪音过滤**：`shared/changes.ts` 定义变化键，只包含生命周期与身份字段（agent 的 `workspaceId`/`status`/`archivedAt`，workspace 的 `title`/`name`/`archivingAt`）。流式输出每个片段都会改写 `updatedAt`/`activityAt`，但不影响计数，因此不触发重读。daemon 与 client 共用同一套键定义。

订阅建立时会用 seed 页预填变化键，否则启动后每条记录的第一次流式事件都会被误判为新变化，触发一轮全量重读。

Paseo 0.8 为每个 observation 由服务端签发 ID 并在重连时重签，因此请求携带空 `subscribe: {}`，不自己指定 ID。

## 标题模式（可选）

**settings 文档是唯一真相**（`titleCounts`，host 作用域），daemon 台账里的 `paused` 只是它的镜像。`client/title-mode.ts` 是决定"偏好对应哪个动作"的唯一地方，settings 开关、两个 ⌘K 命令、客户端连接时的对账都走它，因此不会互相打架。

- 打开：写入 settings → `counter.update { action: "resume" }` → 开始装饰标题。
- 关闭：写入 settings → `counter.update { action: "restore" }` → 恢复原标题并暂停。
- 客户端连接时读取 settings 并对账。首次升级到本版本时 `titleCounts` 默认为 false，因此会自动清掉旧版本留下的前缀。
- settings 写入由 host 做 revision 校验，其他客户端的并发改动会以冲突报错而不是被覆盖；写入失败时不会触碰台账。
- 写回时保留 schema 未声明的键，避免新版本插件的数据被旧版本抹掉。

⌘K 命令：`在标题前显示 Workspace 会话数量` / `恢复原标题并停止改写 Workspace 标题`。

### 台账与恢复

恢复记录位于 `$PASEO_HOME/plugin-data/workspace-agent-count.json`（默认 `~/.paseo/plugin-data/workspace-agent-count.json`），权限 0600，写入走临时文件 + rename 原子替换。**台账损坏时明确报错，绝不替换成空台账。** 关闭标题模式前不要删它。

- 写入前先保存恢复数据，进程失败也不会丢掉原标题。
- 用户手动改的标题优先：只有当前标题仍等于插件自己写过的值时才回滚，绝不盲目覆盖手动改名。旧版 `原标题 · N agents` 装饰会自动迁移为 `(N) 原标题`。
- 无 compare-and-set 接口（0.8.0 的 `setTitle` 是无条件写入），所以写入前会重读一次标题，发现变化就跳过本次更新；最后一次读取到写入之间的极短竞争窗口无法完全消除。需要连续编辑多个标题时，先关闭标题模式。
- 已不在活动 workspace 列表中的记录不会被强制修改，恢复记录会保留；重新显示它们后可再次关闭标题模式来清理。
- 标题是原生纯文本，不能单独设置前缀的颜色、字号或徽标背景；长标题仍遵循 Paseo 自己的截断规则。
- 停用或卸载插件不会自动改回已持久化的标题。先关闭标题模式（或运行恢复命令）再卸载。

### 创建期间的保护

初始化中或运行中的 agent 所在 workspace 暂停标题更新，直到生命周期变化后重新检查。新建空 workspace 不写入 `(0)` 标记，避免干扰 Paseo 的草稿提交流程。数量因此可能延迟到当前回合结束才更新。

这是插件侧降低干扰的措施，不修复 Paseo 的待发送草稿清理缺陷（0.7.2 上实测，0.8.0 尚未复验）；SDK 没有草稿创建锁或原子条件写入。

只读的总览不需要这套保护，因为它不写任何东西。

## 已知限制

- **没有 `agent.deleted` / `workspace.deleted` 生命周期事件**，删除只能靠目录订阅发现。
- 0.7.2 上实测"部分删除/离线归档通知只发给操作发起连接"，0.8.0 未复验。归档现在多了一条 `agent.archived` / `workspace.archived` 事件通道，纯删除仍只依赖订阅。不以定时轮询掩盖这个问题。
- 总览 surface 在 `navigation` 不可用的旧 host 上降级为不可点击的只读列表。

## 开发与安装

```sh
npm install
npm test
npm run typecheck
paseo plugin install /absolute/path/to/paseo-workspace-agent-count
paseo plugin ls
paseo plugin logs workspace-agent-count
```

修改源码后执行 `paseo plugin reload workspace-agent-count`，不需要重启 daemon。

代码按 0.8 双入口结构组织：

```
index.client.tsx    侧栏入口、settings 屏、⌘K 命令、连接时对账
index.server.ts     注册 settings 与 RPC，接生命周期事件
client/             React Native UI 与目录订阅
server/             标题台账与 daemon 侧目录订阅
shared/             计数口径、状态词汇与排序、分页、变化键、RPC/settings 契约、贡献 ID
```

`shared/` 会同时编进 daemon 与 app 两个 bundle，所以它不能导入 `@getpaseo/client` 或 `@getpaseo/plugin/server` 的类型；需要的字段用结构化接口声明（`TallyAgent`、`PresentedAgent`），两边的 SDK 对象自然满足。

`paseo-plugin.json` 声明 `requirements.paseo: ^0.8.0`。`react` / `react-native` / `@types/react` 只是开发期类型检查依赖，运行时模块由 Paseo 提供；`react` 钉在 19.1.4 是因为 `@getpaseo/plugin` 要 `~19.1.0` 而 `react-native` 0.81.6 要 `^19.1.4`，19.1.4 是两者交集。

插件不修改 Agent 消息、模型、文件或会话生命周期。
