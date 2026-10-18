# DSH 0.2.0-rc.2 approval / AutoReview 与项目 guard 组合研究

> 本报告引用的 `.staging/` 本机提取件未随仓分发；下列路径只保留定位信息，不是可由干净克隆复核的链接。

## 1. 范围、证据身份与限制

事实型、从头研究；出口是源码可回读的因果与建议，不是权限/guard 实施或运行验收。观察日期 2026-10-12（运行时采样 `2026-10-12T00:31:08-07:00`，America/Los_Angeles）。仓库 HEAD `6c704fa62d59dcb97de7bdf5f5aefb3f65e8cd61`，开始时已有 guard、迁移与文档未提交修改，本轮不覆盖它们。

当前安装归档是安装目录下的 `resources/app.asar`（本机路径，不入报告），SHA256 `983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2`。桌面 runtime 版本见`安装包声明`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh/package.json`）。常规文件工具不能遍历 ASAR 虚拟目录，故使用安装的 Electron，以进程级 `ELECTRON_RUN_AS_NODE=1` 运行`定点提取脚本`（本机未随仓证据：`.staging/approval-research-20261012/extract.cjs`）：仅读取指定安装包代码/声明/README，复制到本仓 staging；不启动 DSH GUI/服务、不读取真实 profile。

证据目录：`本轮 ASAR 提取`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/`）；`已有提取`（本机未随仓证据：`.staging/migrate-profile-20261011/host-evidence/`）仅作交叉线索。[重构设计:992–1014](<docs/重构设计-TS插件化.md>)先作定位线索，不替代本轮安装源码。

未读取 credentials、auth 或 session logs；未发 approval 请求/探针；未使用 browser、install、委派、guard 行为运行/测试；未改宿主/真实 profile。本轮只新增此报告及授权 staging 证据。源码结论不等于已确认某次历史调用的实际策略、reviewer 输出、answerer 接线或已安装 guard 版本；这些仍未知。本仓解释性判断未经另一个独立验证者复核，不称运行 PASS。

## 2. 确切 policy 映射：不是“父子都是 never”

| 对象 | sandbox | approval | Auto reviewer |
|---|---|---|---|
| 基础 Read only | read-only | ask | 无，除非另选 Auto |
| 基础 Workspace write | workspace-write | ask | 无 |
| 基础 Full access | danger-full-access | never | 无 |
| 选择 Auto 的父会话 | danger-full-access | ask | 每个支持的工具调用独立 review |
| Auto 父派生的进程内子会话 | 捕获父显式 sandbox override（通常 full access） | never | 保留 Auto identity，继续独立 review |
| Full access 父派生的进程内子会话 | 捕获父显式 sandbox override | never | 不自动变成 Auto |

基础三预设与进程默认策略来自`当前 base patch:245–262`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-base/cordis.patch.yml`），已有提取`对应片段`（本机未随仓证据：`.staging/migrate-profile-20261011/host-evidence/dsh-base/cordis.patch.yml`）一致。Auto 固定 bundle 来自`permission-presets:52–61`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-permission-presets/lib/index.js`）。

进程内 delegation 在第一次 await 前捕获：只继承 Auto/Full access 的 preset identity、父 session **显式** sandbox override，不复制一次性 grant；只要 approval service 存在，子 approval 就 pin `never`，与父 policy 无关。见`child-agent:175–211`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-subagent/lib/types/child-agent.js`）。one-shot 接线见`driver:161–188`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-subagent-in-process-driver/lib/index.js`）；continuable 创建捕获见`continuation:128`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-subagent/lib/types/continuation.js`）、写入见`activation:445`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-subagent/lib/types/continuation-activation.js`）。fork seed 之后再写新 policy，因此旧 seed 不会覆盖新 delegation pin；父后来切策略不会自动改这个子。

Auto identity 在 sandbox 匹配且 approval=never 时仍被 `current()` 识别为 Auto，见`preset derive:295–305`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-permission-presets/lib/index.js`）。所以“子显示 never”不证明 reviewer 未运行。该映射仅限这条进程内 DSH 路径；独立 DSH SDK runtime、ACP/Codex/Claude Code 不可类推（`包说明:107`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-subagent/README.md`））。未核真实 profile 是否覆写预设或当前父 session 是否真选 Auto。

有效 approval 由请求所属 session 最后一个 `approval/policy` override 优先，其次 `config.policy`，最后 ask；不是从父 session 动态取值。`approval:152–164`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-user-approval/lib/index.js`）。

## 3. 核心因果：reviewer allow 不解除 downstream ask

真实执行链是：`tools/pre-execute` waterfall → **仅当最终 gate=ask** 才 `serviceAsk()` → approval outcome → 单调 guards → dispatch body。`tools:874–903`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-tools/lib/types/index.js`）。

Auto listener 使用 prepend，只在 preset=Auto 生效；外层 `run_code` transport 排除，PTC inner 仍 review。`auto:462–470`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-experimental-auto-review/lib/index.js`）。其关键分支`auto:478–489`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-experimental-auto-review/lib/index.js`）：

- reviewer failure → deny，不执行 body。
- reviewer deny + session override never → AutoReviewDeniedError，终止，不走下游。
- 其余先 `await next()`；**reviewer allow 就直接返回 downstream，绝不强改 allow**。
- reviewer deny + downstream 非 allow → 保留 downstream（含 ask/deny/cancel）；只有 downstream allow 才生成 Auto 自己的 ask。

本仓 guard 先取得下游，按 allow < ask < deny 合并，只收紧；异常/未知下游变 ask；[guard index:61–99](<src/guard/index.ts>)。因此：

| reviewer | 项目/其它 downstream | approval | 结果（其它 guard 仍可拒绝） |
|---|---|---|---|
| allow | allow | ask 或 never | 不调用 approval；可执行 |
| allow | ask | ask | 路由 answerer；只有 allowed-once 可继续 |
| allow | ask | never | rejected → deny；body 不执行 |
| allow | deny | 任意 | 保留 deny；不能批准修复 |
| deny | 任意 | 子 override never | Auto 最终 deny |
| deny | allow | ask | Auto ask，交给 answerer |
| deny | ask/deny | ask | 保留更下游决定/原因 |

这直接解释 **Auto 父仍会问、Auto 子仍会自动拒绝 guard ask**。把 Full access 改成 Auto 只让父 ask 有应答机会，不会消除项目的 ask，也不会让子继承父的审批能力。

安装 reviewer policy 文本`auto:20–41`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-experimental-auto-review/lib/index.js`）第21行声称 allow 后立即 full access/no later confirmation；这与组合实现保留下游 ask 有语义张力。应向宿主维护者指出，而不是把 prompt 当作授权、先删除/降级 downstream 决定。中高风险分级与可授权来源也在该段：low 普通本地工作、medium 精确当前 human/direct-parent 授权、high 拒绝；未运行模型，不保证分类正确。

## 4. 为什么 never 只拒 ask，而非拒所有命令

`never` 的确定性拒绝在 approval service 内，位于 `approval/request` answerer waterfall **之前**：`approval:172–176`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-user-approval/lib/index.js`）。普通 gate=allow 不进入该服务，因此可执行；文件 sandbox=full access 与 approval=never 是不同维度。工具 body 自己发起的审批（例如请求更宽 sandbox retry）同样受 never 限制。

`serviceAsk:1093–1128`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-tools/lib/types/index.js`）将 allowed-once → allow、rejected → `the user rejected tool ...`、cancelled/unavailable → 各自拒绝文案。policy-never 和人按拒绝都落同一个 rejected，**通用文案不能证明是人工拒绝，也不能倒推出该次原因就是 never**。ask.reason/displayReason 被送进请求但 rejected 最终文案不保留 reason；源码可以说明丢失路径，缺 callId/事件关联不能确认某次调用。

## 5. Answerer 做什么、不做什么

审批服务不自带提示 UI；answerer 是 `approval/request` waterfall listener，可以为其拥有的 agent 返回 outcome 或 `next()`。只有 allowed-once 是 grant；无终端 answerer、抛错或非法返回值 → unavailable，signal abort → cancelled。标准合同见`approval README:28–52`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-user-approval/README.md`）与`实现:128–188`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-user-approval/lib/index.js`）。

Web UI 通过`client:355–357`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-client-ui-approval/lib/client.js`）注册 listener，`answerApproval:284–309`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-client-ui-approval/lib/client.js`）按 session scope 创建 pending interaction 并等待结果。不属它的 session 就 next。**ask 不等于必有可用 UI/answerer**；never 时 answerer 根本不会收到请求，注册 prepend answerer 也不能绕过 never。AutoReview 是 pre-execute reviewer，不是替所有 downstream ask 自动答 allowed-once 的 answerer。

## 6. 官方能力复用与 ownership

继续复用已安装官方 SDK/包能力：`tools/pre-execute`、PreToolDecision ask.reason/displayReason/deny.info、`ctx.approval.request()`、公开 `config`/`overrideOf(session)`、`permissionPresets.current()`及现有 approval/asked、approval/decided 审计；不另建批准文本、魔法文件、工具旁路、假 approval。公开读取可以描述策略，但不证明 answerer 可用；不调用 private effectivePolicy、不发请求探测可用性。`官方 README 限制:154–157`（本机未随仓证据：`.staging/approval-research-20261012/host-evidence/dsh-user-approval/README.md`）明确：只有 one-shot grant，无 allow-always/remembered-rule/revocation/grant store，且 request 本身不携带工具 arguments。

| owner | 职责 |
|---|---|
| Host | sandbox/preset/session policy、子权限 seed、可信人侧来源与审批应答路由、精确 request/call identity、拒绝来源诊断、grant 生命周期/审计 |
| 项目插件 | 本项目受控动作与路径风险分类、返回标准 ask/allow、保留下游 deny/ask、给出可读原因与边界；不得擅改 host policy |
| Git hooks | 版本控制提交闸门；与 tool approval 是不同执行点，不等价、不能互相宣称全覆盖 |

建议宿主问题单：区分 policy-never/human-rejected/cancelled/unavailable 的结构化来源并保留原 ask.reason；提供无副作用的有效 policy/answerer route 诊断；校正 reviewer prompt 的 no-later-confirmation 承诺。当前只形成交接，不改宿主、不发 issue。

## 7. 本仓 guard 当前边界与建议（未实施）

本仓 policy 只产 allow/ask，不产 deny；[policy:3–11](<src/guard/policy.ts>)。没有命中的普通 write/edit 与非 shell 工具默认 allow，[policy:914–932](<src/guard/policy.ts>)。因此“guard 或 never 全拒命令”不成立；组合 ask 的过宽与子 never 是两个不同问题。

当前仍有保守/过宽规则：`git tag` 无条件 ask，连只列标签也问；[policy:795](<src/guard/policy.ts>)。hooksPath 还有 ANY token 召回，[policy:813–817](<src/guard/policy.ts>)；config 精确查询豁免只针对证明出的 key，[policy:559–601](<src/guard/policy.ts>)及[807–808](<src/guard/policy.ts>)，并非所有 `git config` 查询/写入的全面分类。动态/歧义 Git argv、过长/解析不出的 shell 继续 ask；有漏问与误问风险，不是完整 shell 安全边界。

hooksPath 第五冻结修复的静态 PASS/运行未验收/未安装状态，仅由[设计:1010–1012](<docs/重构设计-TS插件化.md>)记录，本轮没有运行来确认，不升级为“已修好”“真实 profile 已启用”。工作树代码、生成产物与真实 profile 必须分别核版本。钩子运行覆盖与未覆盖路径见[仓库工作须知:105–113](<docs/附录-载体实例/仓库工作须知.md>)，不因 guard ask 被采纳就称全部受控。

推荐后续方案，而非本轮变更：

1. **按实际后果分类，减少误送审而不减安全标准。** 普通项目本地读取/可逆写入、格式化、lint/test/build、非破坏性 Git 操作 allow；用静态、精确 argv/路径证明区分 config 读写及 tag listing 与发布动作。不要给整个 shell、解释器或包管理器通配免审批。歧义保持 ask，不把低风险推断覆盖真实更下游拒绝。
2. **用户 bounded grant 由 Host 的 Agent 外通道管理。** 用户明确对象/动作/工作区或环境/参数范围/次数或期限/复审撤销条件，Host 绑定不可混淆的 session+callId+pending action arguments（必要时摘要与版本）；插件只消费可信窄授权，不由执行 Agent 自填 marker、理由或 approve flag。执行前核对参数一致且授权未过期、不冲突，不做事后匹配“相似命令”。已有 request 不带 arguments，需 Host 使用可信 pending-call 关联或扩展 seam，不能拿 reason 当精确 scope。
3. **该 grant 不是当前 SDK 已有能力。** 先复用 one-shot allowed-once 和既有正常人侧审批；若要跨调用 bounded grant，须宿主新增/正式契约化，不能项目插件造 allow-always 存储。既有 never/deny 不被它偷偷解除；独立 downstream deny 仍最终拒绝，原始 ask 不因 reviewer allow 被提前删除。需要变更上游策略的，由用户从正常 Host 入口显式操作，拒绝后停止，不拆命令/换工具/子代理/免审批 Shell 绕过。
4. **Auto parent ask + child never 的用途有限。** 父能把 reviewer deny 或插件 ask 送给人，子只能执行 reviewer 与 downstream 均 allow 的调用。父的 medium 授权让 child reviewer 可能 allow，但不能清除插件独立 ask。需要交互审批的动作由可审批父会话按既有授权接手；本轮不执行该动作，不给子提权。

## 8. 完成与接续

已完成安装 ASAR 只读源码定位、父/子映射与组合因果报告；未编码 guard/host 功能、未测试 guard、未安装启用/部署、未确认真实 profile 或历史拒绝来源。没有启动后台 job 或浏览器/服务；`job_list` 返回 `(no background jobs)`，无需停止共享资源。仅静态核对：报告 39 个仓内链接目标均存在、缺失 0；`git diff --check` 退出 0（不包含未跟踪报告，也不代表 guard 验收）。未运行项目自检或行为测试。

默认合同消费：使用[合同](<CONTEXT_MANIFEST.md>)确定事实型边界、[登记表](<docs/决策日志.md>)核授权边界、[总览](<docs/00-总览.md>)核事实出口、[工作须知](<docs/附录-载体实例/仓库工作须知.md>)核已有 gate/guard 限制；重构设计只是待核线索。未改规范条文，不产生新授权或生效规则。
