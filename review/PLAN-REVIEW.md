# 第五冻结 guard 收口方案独立审查

> 本报告引用的 `.staging/` 本机提取件未随仓分发；下列路径只保留定位信息，不是可由干净克隆复核的链接。

**2026-10-17 收口补记**：本报告写作时引用的 `test/hooks-path.test.mjs` 已在路径层收缩中退役，原 markdown 链接改为文本，报告内容未改；只在收口时补这一句。

事实型／接手；对象为 `PLAN`（本机未随仓证据：`../.staging/guard-closeout-20261012/PLAN.md`），仅写本报告。观察时间 `2026-10-12T01:25:47-07:00`（America/Los_Angeles，主机回读），父会话 `session-16036d35-3dcd-4196-a29a-856ca1c2a536`。本次没有执行 tsc、lib-sync、guard import/call、测试、变异、真实 hooksPath/Git config 查询、启动、安装、提交、源改或委派。

## 1. 结论与准入范围

**原方案尚不能无条件交执行：PASS 4 / FAIL 1 / UNDETERMINED 1，预定 6 项；判定覆盖率 5/6。** A 的执行上下文与临时目录保证需修正；F 的历史事件关联仍缺证据。不是 guard 验收失败的新结论，也不是批准凭据。

机制结论：**不运行 guard 的 noEmit 与现有编译／文本比较路径，和曾拒绝的 decide 反例沙盘不是同一业务执行效果。允许前者而禁止后者在技术与权限边界上合理。** 但不能只根据命令名字判定；必须保持下述确切入口、静态配置和停止点。编译器读取含有 decide 的源码不等于 import/call 它；执行测试则确实调用它。新编译命令若也被宿主拒绝，立即停，不借本报告重试。

本次只给**条件化静态准入意见**，不代表当前宿主已允许执行、历史拒绝已撤销或主模型 No 改成 Ask/allow。若要求“全进程绝对零写”，原 lib-sync **不准入**；它仅满足“主仓源码／产物只读，副作用限制到 owned 临时目录”。若主模型明确 No 覆盖编译本身，本文不能放宽。

| ID | 三态 | 审查结论及成立条件 |
|---|---|---|
| A | FAIL | `原方案:9`（本机未随仓证据：`../.staging/guard-closeout-20261012/PLAN.md`）只写“明确 TMP”且称脚本清自身，不足以精确限定 Windows tmpdir 和失败清理；也未给固定入口。采用 §3 后，仅可条件准入静态编译／原比较脚本，实际执行结果仍未定。 |
| B | PASS | 回归:4–5（`test/hooks-path.test.mjs`，已在路径层收缩中退役）明确 import policy/apply；各测试体调用 decide/lex/apply。只读源码和 [变异清单](<../test/mutations/guard.json>)可进行；node --test、导入测试模块、变异 runner、自拟 matrix 均不可执行。 |
| C | PASS | `原方案:7–11`（本机未随仓证据：`../.staging/guard-closeout-20261012/PLAN.md`）明确编译不算行为验收。类型结果、生成文本一致、静态 QA 各只证明自身判据；行为、专项 QA、变异有效性、真实 profile 均保留 UNDETERMINED。 |
| D | PASS | 不新增源码／权限例外、只处理第五冻结、不混 tag listing 或宿主 grant 的边界明确；当前四份冻结身份已独立核对相同，见 §2。发现实质缺陷仅报告，不能就地修或重构。 |
| E | PASS | 无最终行为验收不提交／安装／部署未验 guard；允许另经现有任务范围 prepare 本地 guard-only patch/manifest，不 apply、不执行它。独立静态 QA 可完成，不能据此宣布五阶段已替代行为验证。 |
| F | UNDETERMINED | [正式资料](<../DSH-FINDINGS.md>)与 `宿主交接`（本机未随仓证据：`../.staging/approval-research-20261012/DSH-HANDOFF.md`）已有静态源码锚点，可交 owner；但历史被拒调用的完整原命令／callId／事件关联不存在于本次输入，无法确认该次来源。保留未知即可准备交接，不能称历史归因已完成或批准渠道已恢复。 |

## 2. 自核身份与静态路径

仓根 `D:\Programs\AI辅助开发规范及工作流确定`，分支 `main`，HEAD `6c704fa62d59dcb97de7bdf5f5aefb3f65e8cd61`；只读 `git --no-optional-locks rev-parse HEAD`、`symbolic-ref --short HEAD`、`status --short` 回读。开始时 17 个 tracked dirty 与两项 untracked（[研究报告](<../DSH-FINDINGS.md>)、hooks 回归（`test/hooks-path.test.mjs`，已在路径层收缩中退役））；不清理、暂存、还原它们。迁移独立提交 eecf045 的状态属父任务给定，本次未访问其 worktree，不代验、不改变。

`Get-FileHash -Algorithm SHA256 -LiteralPath ...` 自核结果（不运行对象代码），四份逐项等于 [设计:1012](<../docs/重构设计-TS插件化.md>)：

| 对象 | SHA256 |
|---|---|
| [源](<../src/guard/policy.ts>) | `648660cb329f1a9d7f5b647255e27dde9a0ad6bf20b3a7a0dbe896142b7ceb97` |
| 回归（`test/hooks-path.test.mjs`，已在路径层收缩中退役） | `b87b29dc89c0d1540a65233bfb3e1fc593a22ba1c3b4bfe6dc6ba69603707863` |
| [JS](<../lib/guard/policy.js>) | `19500c8a90f0ce6d7d99c3f022884250e3bddb7a857ffc489463b2a775332c93` |
| [声明](<../lib/guard/policy.d.ts>) | `8dac6ae8425ab7ad1579824fac072ecc261ac36beeafbbe9c113fbfe43dd49fc` |
| [变异清单](<../test/mutations/guard.json>) | `f47dc9e9f9f92b60321e53ae8134cf6d36ee1d6ea0725fbe87433d1de7ef28fb` |

静态调用链已读实物：

- [package:40–45](<../package.json>)：typecheck 为 tsc --noEmit；test **先写 root lib 再执行全部 test**，不准入；不走 pnpm/npm 包装或生命周期。
- [tsconfig](<../tsconfig.json>)：无 extends、references、plugins、incremental/composite；include=src，rootDir=src，outDir=lib。noEmit 覆盖产出；原 lib-sync 用 --outDir 覆盖根 lib。静态 import 解析读取依赖，不调用本仓模块顶层业务。
- [tsc 入口](<../node_modules/typescript/bin/tsc>)仅 import [启动器](<../node_modules/typescript/lib/tsc.js>)；Windows 启动器通过 execFileSync 且 stdio=inherit 启动 native tsc。 [定位器](<../node_modules/typescript/lib/getExePath.js>)只读 package/解析平台包/exists，不 import guard、不安装；本地为 TypeScript 7.0.2，解析到 `Windows 平台包 node_modules/.pnpm/@typescript+typescript-win32-x64@7.0.2/node_modules/@typescript/typescript-win32-x64/package.json`（Linux 安装不含此包） 的 native tsc。
- [lib-sync:5–39](<../scripts/check-lib-sync.mjs>)只 import Node 内建模块，spawn 同一 tsc，读取 tmp 与根 lib，CRLF→LF 后逐文件比较；没有 import guard 或调用 decide，没有运行生成 JS。它证明规范化文本一致，**不是严格原字节一致**。
- [第五冻结源:729–764](<../src/guard/policy.ts>)静态首位证明后仅 child frame 一对一 word/NUL 投影、queryKey=null 召回 ask；[扫描位置:959–988](<../src/guard/policy.ts>)在 CD continue 前；[主查询:1023–1042](<../src/guard/policy.ts>)不清已有 ask。相关 [JS:969–1024](<../lib/guard/policy.js>)与声明公开结构人工对应。不是全文件同步证明，也不重复做宽审查。
- 新增回归:456–510（`test/hooks-path.test.mjs`，已在路径层收缩中退役）覆盖 CD 静态受控/query/ANY、nested 受控及后续 query 不消警；[G37/G41/G43](<../test/mutations/guard.json>)对应前置扫描与静态子候选召回。仅核存在与语义指向，不宣称运行通过／变异可杀。
- [适配层:61–99](<../src/guard/index.ts>)保留下游 ask/deny；不能借编译或 reviewer allow 消除它。

工具身份自核：PATH 中 `node` 缺失，`Get-Command node -ErrorAction Stop` 普通退出 1，后续语句未执行；它不是工具拒绝，不可据此安装或换业务通道。通过宿主依赖目录声明确定固定 Node，文件版本 `24.21.0`，SHA256 `ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32`；平台 native tsc SHA256 `f9ecfbdc93753d2c972d66a8d0d75f5bd737fd4a5f88b422d9091ea282bcb2c7`。原入口 tsc SHA `2219f428a7e55aaf1f7ad85b9b0f0cf5078aeb76ccc9a7c6036c92d48f492ffd`，启动器 SHA `cbdfbf11c26ed00dfc073155e316a42d6d6d8a387be61006b82fa9aa93ac572e`，定位器 SHA `96c10fd3a18e165d7323de8e314ac8d755ad96811f9fbc304a5b3ba4e05285cc`。native 二进制未反编译、未运行；这里只能对既有标准编译器路径作条件判断，不声称审计过其全部内部实现。

## 3. 可交独立执行的 exact commands / context（本次未执行）

### 必需前置与停止点

1. 先确认执行席仍是获准的静态任务范围；**本审查代理 onlywrite 本报告，不执行以下命令**。root 只读，写范围仅已约定 execution 与 executor-owned tmp。不得改 preset/profile/Git config、安装依赖、产生 approval marker。
2. 重新静态回读 §2 的文件、哈希及 tsc 符号链接链；出现变化，停止，回审查，不擅改入口适应。NODE_OPTIONS、NODE_PATH 当前均未设置；后来发现设置、preload/loader、非既定二进制或配置增加 extends/plugins/references 时停止，不先清环境后试。
3. owned tmp 固定为 `.staging/guard-closeout-20261012/execution/owned-tmp` 的绝对路径，由执行席在其独占写范围创建并验证；首次必须不存在，不复用不明目录。检查根与全部中间组件不是外部 reparse/symlink，解析后仍在本次 execution。创建失败、归属未知、已有异物即停止；不删除它以“清环境”。
4. 原脚本取的是 `os.tmpdir()`，不是 --TMP 参数。Windows 需要同时设置 **TEMP 与 TMP**，仅当前 PowerShell 进程／其子进程，不能 SetEnvironmentVariable(User/Machine)。确认回读精确等于 own path；保留调用前值并在该工具调用结束恢复，不能把设置变为持久策略。
5. 本次实物 [脚本:18,36,38–39](<../scripts/check-lib-sync.mjs>)在 try 中 process.exit(1/2)，这些分支会直接结束进程，**finally 不能保证执行**；预检查缺 tsc 时尚未 mkdtemp。故不能承诺失败自清理。运行后列出 own tmp 下实际目录并记账；若遗留，先核实实际路径／所有权／调用已结束，再按已有写权限单独处理；本审查不授权新增删除动作，也不要求修改脚本。
6. 原脚本 spawnSync 捕获 stdio，在受限 sandbox 有已知 EPERM 边界。当前 danger-full-access 不等于永久成功保证；EPERM、approval rejection、其他执行环境限制均记录原结果并停。**不换 stdio、native 直调、改 runner、绕包或换工具／子代理／fixture/profile 重发相同效果**。普通编译错误或 lib 不一致也停止依赖放行，报告，不能本轮源改或构建根 lib 修绿。

执行工具 `pwsh` 的 `workdir` 必须明确为 `D:\Programs\AI辅助开发规范及工作流确定`，不通过 cd 改变解析上下文。每个入口各调用一次，前置判据已通过后才能执行；原始完整 stdout/stderr、工具退出码和命令／cwd／环境／身份写到 execution，由独立 QA 回读。若输出异步化先收实际结果，不用空输出当成功。

**N1：零 emit 静态类型检查**（不得额外 build/test/import）：

```powershell
& 'C:\Users\indep\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' 'D:\Programs\AI辅助开发规范及工作流确定\node_modules\typescript\bin\tsc' '-p' 'D:\Programs\AI辅助开发规范及工作流确定\tsconfig.json' '--noEmit'
```

**L1：只运行未修改的既有比较入口**（生成只在 own tmp，不复制回根 lib）。同一工具调用使用以下确切进程环境与入口；own tmp 已按前置核验：

```powershell
$beforeTemp = $env:TEMP
$beforeTmp = $env:TMP
try {
  $env:TEMP = 'D:\Programs\AI辅助开发规范及工作流确定\.staging\guard-closeout-20261012\execution\owned-tmp'
  $env:TMP = 'D:\Programs\AI辅助开发规范及工作流确定\.staging\guard-closeout-20261012\execution\owned-tmp'
  & 'C:\Users\indep\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' 'D:\Programs\AI辅助开发规范及工作流确定\scripts\check-lib-sync.mjs'
} finally {
  $env:TEMP = $beforeTemp
  $env:TMP = $beforeTmp
}
```

上述 try/finally 仅复原进程 TEMP/TMP，不封装已拒 guard、不会替换比较脚本的业务、不保证其 own 子目录已删除。L1 无成功回执不追加直接编译／自写 copydiff“补证”。脚本 exit 0 仅记 lib 文本同步 PASS；exit 1 记同步 FAIL；exit 2／启动异常记运行检查 UNDETERMINED 并保留脚本自报措辞，不折成 guard 行为 FAIL/PASS。N1、L1 无论成功与否均不推翻禁止行为运行的 No。

## 4. 收口材料与宿主指引

- 最小 guard-only patch 只含 §2 五份对象相对 HEAD 的真实 delta（包括未跟踪回归），manifest 记录基线／当前文件 hash、恢复前提和行为未验；不能夹带当前 migrate/main 文档产品变更，不能 apply／commit／安装。发布用 d.ts 仍需纳入 scope，因为相对 HEAD 脏，不因相对上次冻结同值省略。
- 独立 QA 的入口只读 execution 原始命令与结果、冻结/前后 hash、owned tmp 清理状态与 scope；不执行 guard，不再编译，不碰迁移 worktree／共享 profile。测试、专项动态矩阵、变异、真实 DSH 运行仍是显式未定列表。完整行为验证计划移交可审批父会话，但不在当前通道运行。
- `宿主 approval 源:152–176`（本机未随仓证据：`../.staging/approval-research-20261012/host-evidence/dsh-user-approval/lib/index.js`）确实在 answerer 前因 never 返回 rejected；`tools:1093–1128`（本机未随仓证据：`../.staging/approval-research-20261012/host-evidence/dsh-tools/lib/types/index.js`）将其与人工 No 共用通用文案；`Auto:480–484`（本机未随仓证据：`../.staging/approval-research-20261012/host-evidence/dsh-experimental-auto-review/lib/index.js`）保下游决定；`子策略`（本机未随仓证据：`../.staging/approval-research-20261012/host-evidence/dsh-subagent/lib/types/child-agent.js`）pin never。这些是静态自核的机制，不是对某次历史调用的事件确认。
- owner 接手资料应沿现有 [报告](<../DSH-FINDINGS.md>)／`问题交接`（本机未随仓证据：`../.staging/approval-research-20261012/DSH-HANDOFF.md`）补一条该次历史调用字段表：完整 command、cwd、工具／session/callId、当次 preset/effective policy、asked.reason、decided.outcome/source、body 是否执行；缺失逐格写 unknown，不用本轮哈希／采样补造历史事件。提取来源、版本和源码路径已可回读，无需再做广泛研究。
- 确需行为验收时由用户／Host owner 从现有 DeepSeek Harness Web GUI `http://127.0.0.1:19387` 的正常权限入口，按 [采用说明](<../tools/std/README.md>)选择审批可用的**父会话**并核对应答通道；界面/登录/实际 answerer 仍未实测，不能承诺切 Auto 就能批子调用。不创建新 grant 引擎、不替用户改 preset、不要求把所有 No 变 Ask。交接本身不等于人已批准某个 pending call。

## 5. 收工回执与盲区

本次写集仅本报告，已有 root dirty 保护；没有后台 job／服务／浏览器／子代理，收工 `job_list` 回执 `(no background jobs)`。写后 status 相对开始仅新增 review/，五份 guard 对象 SHA256 再次逐项相同；不将 Git status 等同全仓逐字节不变证明。仅静态文件读取、hash 与非 hooks/config 的 Git 身份回读；glob 查询 review/ 与 node_modules/@typescript 时发现路径不存在，是正常查找失败，已据确切包符号链接路径补读，不是权限绕过。未运行项目自检、noEmit、lib-sync 或 guard 业务。已提前向父会话说明 A 的 TEMP/TMP、失败残留与 stdio 边界。

停止于独立方案审查；下一原子动作由父模型决定是否采纳 §3 的必要修正并交静态执行。无法满足前置条件就保留 prepare/交接，不继续试运行。**第五冻结仍是局部静态 PASS、整体行为未验收、未安装／启用／部署。**
