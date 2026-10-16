# 检查器契约

本文规定 `tools/std/` 下每个检查器必须满足的接口与行为。**它是并行实现的前提**：满足本契约的检查器可以各自独立编写、独立测试，由 `check_all` 汇总。

标准正文见 [`标准/`](../../标准/README.md)（修订号见 `标准/README.md` 第 3 行）。检查器只做**机械可判定**的部分；判不了的一律输出 `UNDETERMINED`，不猜、不降级为通过。

---

## 1. 三态，且未定不可静默升格

每条检查结果只有三种：

| 状态 | 含义 | 退出码贡献 |
|---|---|---|
| `PASS` | 检查实际执行了，且未发现违规 | 0 |
| `FAIL` | 检查实际执行了，发现违规 | 1 |
| `UNDETERMINED` | 未能判定：适用却对象缺失、配置缺失、依赖不可用（判据本身不适用记 `SKIP`，见下方规则） | 2（未登记）／0（已登记且未过期） |

**这是本工具与普通 linter 的根本区别。** 依据是 [01 §2 N1](../../标准/01-项目管理标准.md) 与 [§5.6](../../标准/01-项目管理标准.md#gates)：适用却没配置或未执行的门记未定，不记通过。

规则：

- **`UNDETERMINED` 永远不能被合并成 `PASS`。** 汇总时三态各自计数，不允许"没有 FAIL 即通过"。退出码另按已登记／未登记分档（见第 9 节「例外登记」）；状态字段、三态计数与逐条列出**不因登记而改变**——登记改变的只有退出码。
- 对象不存在时，先判**是否适用**：不适用记 `SKIP`（不计入三态，但必须给理由）；适用而对象缺失记 `UNDETERMINED`。
- **同一事实只由一个检查器报。** 对象缺失这件事归哪条标准条款，就由执行那条的检查器报；以同一对象为输入的其余检查器记 `SKIP`，证据里写明由谁报。否则采用方得为同一件事登记几行，报告的未定数也虚高。现有一例：工作项目录（`layout.work_root`）不在，由 `layout` 按 01 §3.1 报——项目声明了 `layout.work_root` 而目录不在，任何档都判 `FAIL`（`layout/work-root-absent/<路径>`，声明的落点不成立）；没声明时缺省目录由 L1 起的 `work_current` 一项认，`evidence`、`freshness` 与 `drift`（判据 4）各记一条 `<检查器>/work-root-absent` 的 `SKIP`；两件共用的解析与这条 `SKIP` 都在 `core/docs.ts`（`workRoot`）与 `core/shell.ts`（`workRootAbsent`）。另一例是入口文件不在：由 `layout` 按 01 §3.1 的 ★ 入口报，`entry-budget` 记 `entry-budget/entry-absent` 的 `SKIP`；入口或其余工件是指向项目之外的符号链接时同理，`layout` 记 `layout/outside-root/<路径>` 未定（不跟随链接判在、也不判缺），`entry-budget` 不读、不列出仓目录，记 `SKIP`（目录在项目内、其中单份文件链到仓外时照列不探测，记 `entry-budget/outside-root/<路径>` 未定）。
- 检查器自身崩溃、超时、依赖缺失，一律 `UNDETERMINED`，**不得吞掉异常记 PASS**。依据：该项目已发生过"守卫崩溃却报告为漂移"与"退出 0 却跑了 0 个测试"。

`check_all` 的退出码：有任一 `FAIL` → 1；无 FAIL 但有**未登记**的 `UNDETERMINED` → 2；否则 0（全 PASS/SKIP，或全部未定都已登记且未过期）。**调用方不得把 2 当成功。**

### 1.1 判据落空只能记未定，不许升格为 FAIL、也不许新增配置键去救

**判据靠猜测得出的结论只能是 `PASS` 或 `UNDETERMINED`，永不产出 `FAIL`。**

这里的"猜测"指判据的召回依据不是项目自己声明的事实，而是工具单方面的一份约定：**目录名、文件后缀、字段名、标记词，以及从模板快照抄来的候选路径**。约定命中了可以记 `PASS`——东西确实在那儿，这是看见的事实；约定落空只说明"工具没在它猜的地方找到"，推不出"这个项目没有"，所以记 `UNDETERMINED`。要把某项判成 `FAIL`，先让项目在 `project.yaml` 里声明落点：**声明之后仍然不成立，那才是确定的违规。**

两次实测教训，都是用不确定的前提产出了确定的结论：`check_layout` 按模板候选路径没找到 ★ 工件就判缺失，而外部项目只是把它放在别的名字下；`check_layout` 的状态字段曾是英文单值 `status`，本仓 `PROJECT_STATUS.md` 头部写的是「状态：进行中」，被报成"缺状态字段"。前者已改判未定，后者的词表已并进 `STATUS_FIELDS`（`core/docs.ts`）。

**判据落空的处置是记未定，不是在 §5 里新增一个配置键。** 判据自身的召回位置（阈值、词表、候选清单）不是项目参数，把它做成键，等于让每个采用方替工具修判据；键会一直加下去，而报告并不因此更可信。项目要表达的只有一件事——"这东西在我这儿叫什么、放在哪"，那属于 `layout.artifacts` 一类的**落点声明**，与救判据是两回事。

---

## 2. 每个检查器必须声明覆盖边界

输出里必须带 `scope`，写明**检查了什么、没检查什么**。依据 [01 §5.6](../../标准/01-项目管理标准.md#gates)（控制的覆盖范围本身是状态）与 [04 §6.1](../../标准/04-可靠性安全与运行维护.md#agent-run-observability)（未采到的区间记未知）。

**不再有“内嵌的标准副本”这一类对象。** 标准与工具随插件分发（01 §8），项目里不放副本，所以扫描面就是被扫项目 `git ls-files` 列出的全部文件，没有为工具自身所在目录设的排除，也没有“内嵌目录是否被改”的判据。曾经有过这两样（迁移前旧版的 `adoption/embedded-modified`、`adoption/embedded-untracked`、`adoption/version-mismatch` 与扫描面排除），随内嵌机制一并删除，登记在 `test/cases/expected-changes.mjs`，理由见设计文档 §12.28、§12.33、§12.37。

未覆盖的部分不是"没问题"，是"没看"。例如只扫 `*.md` 的检查器必须写明它不看 `*.service`、`*.sh`、`*.json`——该项目真实吃过这个亏：现有闸门只扫 `scripts/*.sh`，因而看不见两个应用仓里 28 处已断的跨仓引用。

---

## 3. 每个检查器必须自带反例（静默失效探测）

**没有反例测试的检查器，其结果记 `UNDETERMINED`，不记 `PASS`。**

依据 [01 §5.6](../../标准/01-项目管理标准.md#gates) 的四步验收与 [M-10](../../标准/参考资料/M-10-守卫的执行点.md)：守卫存在不等于守卫在执行。每个检查器提供 `selftest()`：

1. 造一个**应该被判 FAIL** 的最小样本，跑检查器，必须得到 FAIL；
2. 造一个**应该被判 PASS** 的最小样本，必须得到 PASS。

任一条不成立即判该检查器故障，其对目标仓库的结论作废、记 `UNDETERMINED`；`selftest()` 返回不足两条（空自检）同样按故障处置。`check_all --selftest` 单独跑这一层。`--selftest` 另跑一组跨检查器反例（`shared-fact`：§1「同一事实只报一次」与共用候选），单个检查器的自检看不见别的检查器，这一层只能在汇总处断言。

---

## 4. 接口

每个检查器是 `src/checks/<name>.ts`（编译到 `lib/checks/<name>.js`），导出：

```ts
export const NAME: string            // 稳定短名，如 'single-authority'
export const STANDARD_REFS: string[] // 它执行标准的哪几条，如 ['01 §1 G2', '01 §2 N2']

export function scope(cfg: Config): { covered: string[]; not_covered: string[] } // 字符串描述，人读
export function run(cfg: Config): Finding[]       // 不抛异常——内部异常转成 UNDETERMINED 的 Finding
export function selftest(): Finding[]             // 见第 3 节。返回两条 Finding：反例与正例各一
```

`cfg` 除了第 5 节那些项目参数，还有若干下划线开头的键。其中两个由 `loadConfig`（`core/config.ts`） 无条件注入，**是本契约的一部分**（此前只有实现知道，检查器全靠它定位被扫描项目，写下来是为了新检查器不必去读 `core/` 才知道该用什么）：

| 键 | 含义 | 检查器该怎么用 |
|---|---|---|
| `cfg._root` | **被扫描项目的根**，`check_all` 的位置参数原样传入，可能是相对路径 | 检查器定位工件一律用它拼路径（`join(cfg._root, rel)`），**不得**用 `os.getcwd()` 或检查器自己的 `__file__` |
| `cfg._path` | 配置文件的实际路径 | 只用于报告与证据。**它落在 `_root` 之内还是之外**，决定了输出里标"外部配置，不在被扫描项目内"还是"在被扫描项目内"。判据是路径包含关系，不是"绝对还是相对"——`--config` 完全可以指向项目内部的绝对路径，那时标"外部配置"是一句**假的溯源陈述** |

`_path` 在不在项目内由 `check_all.ts` 的 `configOutsideRoot(root, path)` 判，返回二元组 `(判定, 原因)`：判定取 `True`（在外）/ `False`（在内）/ `None`（判不了，原因写明为什么）。实现是 `abspath(...)` 加带分隔符的前缀比较——带分隔符是因为 `/t/proj` 不该把 `/t/project/x.yaml` 吞成内部；非绝对的 `path` 先接到 `root` 上再归一化，是因为走默认候选路径时 `_path` 本就是相对被扫根的（`governance/project.yaml`），照当前工作目录解析会把项目内的默认配置判成外部。带分隔符前缀比较在入口冒烟 3d) 有断言，相对路径接到 `root` 上在 3e) 有断言。调用点在全部检查跑完之后，归一化出错也不许崩，按判不了返回 `(None, 原因)`。

这两个键的名字带下划线是为了与项目自己写的配置项区分：**项目的 `project.yaml` 里写 `_root` 或 `_path` 整份拒收**（与下段其余下划线键同一条规则），这两个键只由 `load_config` 解析完注入。

除这两个之外，检查器**自己**也可以约定下划线开头的注入口，只在自检里往 `cfg` 里塞、`load_config` 不产生也不覆盖。目前有一个：`check_links` 的 `_links_files`（由 `check_links.selftest` 注入，取代 `git ls-files` 的结果，让自检不碰真实仓库的 git 索引，见第 3 节）。另有两个由 `check_all` 在**全部检查跑完之后**写入：`_scopes`（各检查器的覆盖边界，在身份封签之内用同一份加载算好，只给 `render` 打印，免得再加载一遍检查器）与 `_exceptions`（登记册路径、有效行数与过期行数，只给 `render` 打报告首部那一行用，见 §9）——检查器跑的时候它们还不存在，不要读。**这类键不是项目配置项**——检查器会当真采信它，写进配置等于让被检查方自己指定检查范围，所以 `load_config` 遇到顶层以 `_` 开头的键**整份拒收**（按解析失败记未定，报行号）；注入口只能由代码往 `cfg` 里塞。新增这类注入口要在本节登记，因为"`cfg` 里都有什么"是契约面，不是实现细节。

`Finding` 的字段：

```ts
{
  check: NAME,
  id: 'check/kind[/key]' | 'check/<sha1(title)[:8]>',   // 由 core/finding 的 finding() 算，检查器不自己拼
  status: 'PASS' | 'FAIL' | 'UNDETERMINED' | 'SKIP',
  title: '一句话说清是什么',         // FAIL 时必须能定位
  where: 'path:line' | null,         // 可定位工件，FAIL 时尽量给
  why: '为什么这算问题',              // 绑到 STANDARD_REFS 的哪一条
  reason: '未定/跳过的原因',           // UNDETERMINED 与 SKIP 必填
  evidence: '原始证据，命令或摘录',    // 可复算
  registered: null | { id: 'EX-007', expires: '2026-12-31' },   // 由汇总层贴，见 §9
}
```

**`why` 必须能追到标准的具体条款。** 追不到的检查项不进本工具——那说明它是实现者的偏好，不是标准的要求。

**`id` 是这条发现的地址**，例外登记（§9）的「规则」列写的就是它，所以它的稳定性是契约面，不是实现细节。`core/finding.ts` 的 `finding(..., { kind, key })` 按两档算：

| 档 | 构成 | 稳定性承诺 |
|---|---|---|
| 给了 `kind` | `check/kind`，再给 `key` 则接 `/` 与归一化后的 key（首尾空白去掉、内部空白折成 `_`、竖线换成 `｜`） | **判据不变它就不变**：标题怎么改、命中几个文件、超期几天，都不影响它。跨工具版本升级时仍须按 §8 的身份重跑核对 |
| 没给 `kind` | `check/` + `sha1(title)[:8]` | **只在同一工具身份内稳定**：标题改一个字就换一个 id，对应的登记行随之失效。这是兜底，不是承诺 |

给 `kind` 的构造点覆盖标题会随命中内容变动的那些判据（`freshness` 的陈旧与超龄工作项、`agg`（`core/shell.ts`） 的全部聚合条（`kind` 必填）、`cross-repo` 的六条、`single-authority` 的溢出／非文档组／数值声明、`links` 的五条未定与两条 FAIL（`missing`、`anchor-missing`；同一文件里同一目标合并成一条，行号进证据）、`derived` 的四条未定与 `behind`（key 为派生物与源）、`header-undeclared`（同一派生物只判一次）两类 FAIL（标题带声明序号），`evidence` 的 `incomplete`、`limits-empty` 与未定 `fields-unrecognized`（key 为文件与条目名；认出的都有值、缺的字段可能在条目里认不出的「标签: 值」行或映射不到的表头列里时记未定，§1.1；没有这种行就是没写，判 FAIL）；另有 `evidence`／`freshness`／`drift` 的 `work-root-absent` 与 `entry-budget` 的 `entry-absent`、`candidate-over`、`doc-over`、`merged-over`，`adoption` 的 `wildcard-allow`，`exception-register` 的 `own-expired`，检查器崩溃与自检闸门不过的 `internal-error`（§9：不可登记），`cross-repo` 的 `enum-failed`、`adoption` 的 `settings-invalid`，`unreadable`（`core/shell.ts`） 与 `outsideRoot`（`core/shell.ts`） 的 `unreadable`／`outside-root`（读不了、出仓的文件是对象的事，不是检查器故障，不落兜底 id；检查器内同一文件只报一次），标题带路径、行数或摘录），**`key` 一律取判据自己的稳定量**（路径、仓名、`数字:量词:名词键` 三元组），不取计数与样本文本。其余构造点用兜底 id。写新检查器时：**标题里会出现数字或摘录的，就必须给 `kind`（能定位到具体对象的再给 `key`）**。

---

## 5. 配置

项目根的 `governance/project.yaml`，检查器只从这里取项目相关参数，**不硬编码路径**。例外登记在同目录的 `governance/exceptions.md`（§9）。采用的标准版本不在项目里记：它由工具的依赖锁定文件钉住，检查报告自带本次依据的工具与标准内容的摘要（§8）。

```yaml
tier: L1                            # 必填：L0 | L1 | L2 | L3，决定该有哪些工件
tailoring:                          # 裁剪：不适用的部分与理由
  - check: cross-repo
    applicable: false
    reason: 单仓项目
layout:
  entry:                            # 入口文件，受行数预算约束
    - AGENTS.md
  docs_root: docs
  work_root: docs/state/work        # 工作项目录
  artifacts:                        # 本项目给分档工件起的实际路径，键是工件 role
    status: PROJECT_STATUS.md
  frozen:                           # 只读归档区，不参与新鲜度与更新义务
    - docs/features
  rule_files:                       # 退役仓里"会被当成现行规则读入"的位置
    - .agents/
    - AGENTS.md
budgets:                             # 参数，项目可改；默认见 01 §3.7
  entry_lines: 150
  stale_days: 90                     # 文档多久不动算陈旧
  work_item_stale_days: 14           # 进行中的工作项多久不动算失活
  duplicate_min_lines: 3             # 重复文本判据的下限
  duplicate_min_chars: 60
metadata_fields:                     # 01 §3.5 的日期字段名
  - updated_at
metadata_required:                   # 哪些路径前缀下的文档必须带元信息
  - docs/decisions
work_item_done_states:               # 项目自有的完成态词，并入 01 §4.1 done 的别名
  - 已交付
work_item_in_progress_states:        # 项目自有的进行中态词，并入 in_progress 的别名
  - 开发中
derived:                             # 派生工件：改源不改产物，见 01 §3.4
  - artifact: docs/map.html
    source: docs/map.json
    regen: make map
repos:                               # 多仓系统，见 01 §3.8；单仓省略
  - name: control-plane
    path: .
    role: system                     # system | app | retired | archived
    former_names:                    # 可选：这个仓改名前叫过什么
      - control-plane-ops
```

**采用的标准版本不在本文件，也不在项目里的任何文件。** 版本由工具的依赖锁定文件（profile 的 `package.json` 与 `pnpm-lock.yaml`）钉住，机器维护、带完整性校验；报告自带的 `tool-identity`（§8）是本次实际跑的那套检查器与契约的内容摘要。此处从前有过一个 `standard_version` 键，也曾有过项目手写的 `governance/STANDARD_VERSION`：都是人维护、机器不核对的第二份声明，已删除；采用项目 `project.yaml` 里若还留着这一行，属可选清理，删不删都不产生后果。`adoption` 检查器**不读、不比对任何版本声明**，只判 `compatibility.policy`。

**只用块状列表（短横线），不要用 `[a, b]` 这种流式写法**——解析器按"歧义即拒绝"拒收它，本文此前的示例写成流式，照抄会让整份配置解析失败，已改正。唯一接受的流式写法是空列表 `[]`：它没有歧义，且 `metadata_required` 要靠它区分"声明一类都没有"与"没声明"。

上面每个键的类型、是否必填、以及缺了会怎样。**写成表中类型以外的形状**（列表键写成标量或映射、映射键写成标量、字符串键——`tier`、`layout.docs_root`、`layout.work_root`、`layout.artifacts.*`、`repos[]`／`derived[]`／`tailoring[]` 的字符串字段——写成列表或映射；`compatibility.policy` 本就可以是映射或列表，不在此列）整份配置按解析失败记未定，报键名与行号——不静默误读，也不让检查器崩溃；值为空与不写同义：

| 键 | 类型 | 必填 | 缺省行为 |
|---|---|---|---|
| `tier` | 字符串 `L0`/`L1`/`L2`/`L3` | **是** | `check_layout` 整条记 `UNDETERMINED`——不猜该项目该有哪些工件。取值不在四档内同样记未定，不归到最近的一档 |
| `tailoring` | 列表，每项 `check` / `applicable` / `reason` | 否 | 视为没裁剪任何检查。`check` 可写检查器短名，也可写 `layout:<role>` 或裸 `<role>` 单裁一个工件；写了对不上的名字裁剪不生效，记一条未定（`tailoring/unknown-check/<名字>`）。裁掉 `adoption` 时内嵌目录只读（01 §8）与 `compatibility.policy` 必填（01 §5.3）两项不可裁剪，照判 |
| `layout.entry` | 字符串列表 | 否 | `layout` 与 `entry-budget` 共用 `src/core/docs.ts` 的 `entryFiles`：先回退到 `layout.artifacts.entry`（同是项目声明，据此照常判 `FAIL`）；两者都没配才按候选 `CONTEXT.md`、`AGENTS.md` 的顺序取第一个存在的（同时存在几个也只取第一个，证据列出其余），证据注明来自候选。候选是 §1.1 的工具约定：`layout` 命中记 `PASS`、全不在记一条 ★ 未定，`entry-budget` 在预算内记 `PASS`、超预算记未定（`candidate-over`），声明之后仍超才判 `FAIL`；入口不在由 `layout` 报，`entry-budget` 记 `SKIP`（§1）。`cross-repo` 的入口相关判据仍记 `UNDETERMINED`：它要在每个仓里认同一组入口名，且那几条判据的结论以 `FAIL` 为主，候选来源下只剩通过与未定 |
| `layout.docs_root` | 字符串 | 否 | 取常量 `docs`（01 §3.1 文档树的根），`freshness`／`drift` 在 `evidence` 里注明用的是默认，`layout` 在覆盖边界里注明（它只拿它给候选路径改基，候选本就是提示，§1.1）。解析只在 `docsRootOf`（`core/docs.ts`） 一处，`layout`／`freshness`／`drift` 与各缺省路径的改基共用 |
| `layout.work_root` | 字符串 | 否 | 取常量 `docs/state/work`（01 §3.1；`docs/` 随 `layout.docs_root` 改基，与 `check_layout` 的候选同一规则），并在 `evidence` 里注明用的是默认。它也是 `check_layout` 的 `work_current`（实时状态源）一项在未声明 `layout.artifacts.work_current` 时认的落点——目录不在由 `layout` 报一次（声明了却不在，任何档判 `FAIL`），`evidence`／`freshness`／`drift` 记 `SKIP`（§1）。解析只在 `workRoot`（`core/docs.ts`） 一处 |
| `layout.artifacts` | 映射，`<role>: 路径` | 否 | 按分档快照里的候选路径找；给了就只认它，不再猜候选。`status` 的候选（`WORK.md`、`docs/state/STATUS.md`，取自模板 L0 树与 01 §3.1）在 `STATUS_CANDIDATES`（`core/docs.ts`），`check_layout` 与 `check_drift` 共用。**★ 工件（入口/验收/状态）没声明落点时，候选未命中记 `UNDETERMINED` 而不是 `FAIL`**（§1.1）；声明了却不存在才是 `FAIL`。role 名见 `check_layout` 的 `_TIER_ITEMS`（`entry`/`acceptance`/`status`/`playbook`/`failures`/…） |
| `layout.frozen` | 路径前缀列表 | 否 | 视为没有只读归档区，全仓都承担更新义务 |
| `layout.rule_files` | 路径/前缀列表，以 `/` 结尾按目录递归 | 否 | 缺省取常量 `.harness/rules/` 与 `AGENTS.md`，并在 `evidence` 里注明用的是缺省清单。只有 `cross-repo` 判退役仓时用它。退役仓若还有别的规则落点（例如曾按旧宿主落地的目录），在本键里自己列出来，写了的照旧认 |
| `budgets.entry_lines` | 正整数 | 否 | 取 01 §3.7 默认 150 并注明未校准；不是正整数记 `UNDETERMINED` |
| `budgets.status_lines` / `work_item_lines` / `handoff_lines` / `module_lines` | 正整数 | 否 | 缺失即该类不判，记 `SKIP`（`budget-undeclared/<键>`）——01 §3.7 的 80 / 150 / 60 / 200 是参考值，不取来当门槛；不是正整数记 `UNDETERMINED`（`budget-invalid/<键>`）。对象见下方「01 §3.7」一节 |
| `compatibility.policy` | 非空（字符串、映射或列表） | **是**（01 §5.3） | `check_adoption` 判 `FAIL`（`adoption/compatibility-policy`）。只判有没有，不判内容；写成指向项目里权威位置的指针也算 |
| `budgets.stale_days` | 正整数 | 否 | 取常量 90 并注明未校准；不是正整数记 `UNDETERMINED` |
| `budgets.work_item_stale_days` | 正整数 | 否 | 取常量 14 并注明未校准；不是正整数记 `UNDETERMINED` |
| `budgets.duplicate_min_lines` | 整数 ≥2 | 否 | 取常量 3 并注明未校准；写了却不是 ≥2 的整数，整份配置按解析失败记未定（报行号），不取默认 |
| `budgets.duplicate_min_chars` | 整数 ≥1 | 否 | 取常量 60 并注明未校准；写了却不是 ≥1 的整数，同上 |
| `metadata_fields` | 字符串列表（也接受单个字符串） | 否 | 取常量 `updated_at` 并注明未校准；未声明时 `layout` 查 ★ 工件头部缺元信息只记未定（`layout/meta-unrecognized`，§1.1），`freshness` 对 `metadata_required` 命中的无日期文档也只记一条聚合未定（`freshness/undated-fields-default`），声明后仍缺才判 `FAIL`；写成别的形状（映射、空列表）同样按未配处理。解析只在 `dateFieldsOf`（`core/docs.ts`） 一处，`layout` 与 `freshness` 共用 |
| `metadata_required` | 路径前缀列表；元素以 `!` 起头为排除前缀 | 否 | 见下方专段。给了就**只认这份清单**：命中任一包含前缀、且不命中任何 `!` 排除前缀的才算（D-133，如 `- docs/decisions` 加 `- "!docs/decisions/INDEX.md"`；须加引号，裸 `!` 在 YAML 里是标签，解析器按歧义拒收），判定只在 `metadataRequiredHit`（`core/config.ts`） 一处，被排除的与不在清单内的同样对待——排除只免缺日期、缺状态两类结论，带日期的照按日期判陈旧；以 `!` 起头的真实路径因此无法写成包含前缀（没有转义写法）；开头的 `./` 去掉后再匹配（`./docs` 即 `docs`，排除同理）；排除前缀不落在任何包含前缀之下（只有排除没有包含即属此列）或与某条包含前缀相同时整份配置拒收；`freshness` 扫的是 `layout.docs_root` 与清单各前缀的并集，文档根之外的前缀（根下的验收文件、L1 的 `work/`）照扫（D-131：此前只扫文档根，那些前缀一条结论都不出）；命中的文档头部没认出状态字段（`STATUS_FIELDS`（`core/docs.ts`），工具词表）的汇成一条未定（`freshness/no-status-field`，§1.1），不判 `FAIL`、不判取值；`layout` 已查元信息的验收、状态工件（缺日期同样不重报；`layout` 整个被裁或该工件在 tailoring 里登记不适用时 `layout` 不查，改由 `freshness` 报）与工作项目录里的 `WI-*`（`freshness/no-status`）不在此列（§1 同一事实只报一次）；元素（排除前缀按去掉 `!` 之后）写成空、`.`、`./` 或以 `/`、`..` 起头时整份配置按解析失败拒收（报键名与行号，与 `duplicate_*` 写错同口径），不猜整仓也不当不命中；显式写空列表 `[]` 即声明项目没有 01 §3.5 那六类文档，无日期文档整轮记一条 `SKIP`；键缺失或值为空时只按目录名约定**分组**，缺日期的无论约定命中与否都**记未定**（§1.1：约定不产出 `FAIL`），不记不适用 |
| `work_item_done_states` | 字符串列表（大小写不敏感） | 否 | **并入** `done` 一态的词表，不替换缺省；声明词与六态别名或另一个键撞词（归到不同态）时整份配置拒收，报键名、行号与冲突词，与 `duplicate_*` 写错同口径。状态值由 `stateClass`（`core/cfg.ts`） 一处归到 01 §4.1 六态：去装饰、截括注后取开头的状态词（其后跟日期、说明也照认），按六态别名（`WORK_ITEM_STATES`（`core/cfg.ts`））加这两个键的声明词归类；`freshness` 只巡检归为 `in_progress` 的，`evidence` 只查归为 `done` 的 |
| `work_item_in_progress_states` | 字符串列表 | 否 | **并入** `in_progress` 一态的词表，不替换缺省。归不进六态的状态由 `freshness` 记一条聚合未定（`freshness/unknown-state`，§1.1），`evidence` 记 `evidence/unknown-state-by-freshness` 的 `SKIP` 指向它；`freshness` 被裁剪或该件落在 `layout.frozen`（`freshness` 不读其状态）时改由 `evidence` 记 `evidence/unknown-state` 未定，仍只报一次。工作项目录里带状态字段的文件是工作项还是文档只由 `statusKind`（`core/docs.ts`） 一处分（D-134）：`WI-*` 命名或值属六态／声明词的是工作项；其余的 `layout.artifacts` 声明工件是文档，值属 01 §3.5 文档四值（`DOC_STATES`（`core/cfg.ts`），含中文别名）的记 `freshness/document-state` 的 `SKIP`，不巡检活性、不查完成证据，认不出的记 `freshness/unknown-doc-state` 未定；未声明的文件写文档四值或认不出的词，仍记 `freshness/unknown-state`。两个声明键的词撞上文档四值同样整份拒收。状态字段只从头部区域读（`headOf`（`core/docs.ts`）：以 `---` 起头的 YAML 头里有状态字段时只取它，否则取到第一个二级及以下标题之前），`layout` 查 ★ 工件状态字段也用这一处，小节里的同名字样不算 |
| `derived` | 列表，每项 `artifact` / `source` / `regen` | 否 | `check_derived` 整条记 `SKIP`——不猜哪些文件是生成的 |
| `repos` | 列表，每项 `name` / `path` / `role`；`name` 不得重名（重名时 `cross-repo` 整条记未定）；**`path` 只有 `role: archived` 可省略**（01 §3.8 的 archived 就是"已移出工作区，只在远端"）| 否 | `cross-repo` 记 `SKIP`：未声明或不足两个条目记不适用（单仓项目，01 §3.8）。`role` 取 `system`/`app`/`retired`/`archived`。`archived` 省略 `path` 或 `path` 在本机不存在时，"各仓可定位"一条按定义记 `PASS`，凡需读该仓本地文件的各条（入口、退役仓失效标记、跨仓引用）对它记 `SKIP`；给了 `path` 且目录在则照读照判。`retired` 不享受这条——它仍要求本地有检出可核 |
| `repos[].former_names` | 字符串列表 | 否 | **不声明就一字不查**——不猜哪个名字是旧名（判据八）。别名与任何在册 `name` 相撞（不分大小写）时该项记 `UNDETERMINED` 且不扫描：那种情况下命中的多半是在役引用 |

**缺配置项时记 `UNDETERMINED` 并写明缺哪一项，不取默认值当事实。** 例外见上表"缺省行为"一列：`budgets` 的全部键（`status_lines`／`work_item_lines`／`handoff_lines`／`module_lines` 四个除外，缺失即该类不判、记 `SKIP`），以及 `layout.docs_root`、`layout.work_root`、`layout.rule_files`、`metadata_fields`、两个 `work_item_*_states`（缺省词表恒在，声明只并入），缺失时取常量兜底而不是记未定；`repos` 与 `derived` 是另一类例外——缺失时整条记 `SKIP`（不适用），既不取默认也不记未定：单仓项目按 01 §3.8「单仓项目记不适用」，未声明派生关系时主从由项目指定、不由检查器推定（01 §3.4）；**取了默认就必须在 `evidence` 里写明"用的是默认值，项目未校准"**，让读报告的人知道这个结论建立在工具的假设上。**被多个检查器读的键，常量缺省只在 `core/` 写一处**（01 §1 G2）：同一个键不得被一个检查器取常量兜底、另一个记未定。`check_layout` 按分档快照找候选路径、`entryFiles`（`core/docs.ts`） 在 `layout.entry` 未配时找入口候选名，都不算缺省——候选是 §1.1 所说的工具约定（提示），命中只许记通过或未定、未命中只记未定，不当作该键的取值。除这些之外的键缺失一律记 `UNDETERMINED`。

### 01 §3.7 给了六项篇幅预算，本工具执行其中五项

按 §2「未覆盖的部分不是没问题，是没看」，这里把边界写死。五项都在 `check_entry_budget`：

| 01 §3.7 的预算项 | 默认值（后四项为参考值） | 预算键 | 对象（先认项目声明，未声明才按候选） |
|---|---|---|---|
| `AGENTS.md`（入口） | 150 行 | `budgets.entry_lines` | `layout.entry` 列出的文件，未配时是候选里第一个存在的那个（§5） |
| `STATUS.md` | 80 行（参考值） | `budgets.status_lines` | `layout.artifacts.status`，须是文件；候选 `STATUS_CANDIDATES`（`core/docs.ts`）。声明为目录时记 `SKIP`（`status-dir`）：80 行是单份 STATUS 的预算，目录形态下没有对应对象 |
| 工作项 | 150 行（参考值） | `budgets.work_item_lines` | `layout.work_root` 下直接一层、头部带状态字段的 `*.md`；未配时是缺省目录 |
| 交接 | 60 行（参考值） | `budgets.handoff_lines` | `layout.artifacts.handoff`，文件或目录下直接一层的 `*.md`；候选 `HANDOFF_CANDIDATES`（`core/docs.ts`） |
| 模块文档 | 200 行（参考值） | `budgets.module_lines` | `layout.artifacts.modules`，同上；候选 `docs/architecture/modules`（随 `layout.docs_root` 改基） |
| `INDEX.md` | 每份文档一行 | — | **不执行**：预算不是行数，一行里有没有摘要以外的内容要读内容（§7） |

**后四项只在项目声明了对应预算键时判**：01 §3.7 说表中数字只是试验参数、不是合格门槛，所以未声明的记 `SKIP`（`budget-undeclared/<键>`），参考值只写进说明；入口一项照旧，未声明取 150 判——它与另外四类不同：入口文件每次会话都会加载，预算直接决定每次会话的固定上下文成本，所以默认值即判；另外四类按需读取，超了的代价随项目而异，由项目声明了预算才判。声明了预算之后的三态：落点来自项目声明（`layout.work_root` 未配时的缺省目录不算声明）且超预算判 `FAIL`（`doc-over/<路径>`）；落点来自候选只记未定（`candidate-over/<路径>`，§1.1）；在预算内汇成一条 `PASS`（`docs-within`）；某类一份都没有记 `SKIP`（`<role>-absent`），在不在归 `layout` 报。**同一份文件同时是几类工件**（如采用方把工作项目录同时声明为交接或状态）：超过其中最宽的预算才判 `FAIL`，只超较紧的记未定（`merged-over/<路径>`）——01 §3.7 按文档类给预算，没写合并承担几类职责的文件用哪条。`layout.frozen` 下的文件不数。

预算键不是正整数记未定。键跟着检查器一起来：此前 `budgets.status_lines` 与 `budgets.work_item_lines` 因为没有读者被删过，现在有了读者才重新加上。

### `metadata_required` 的两件事，都容易踩

**一、它是整体替换，不是追加。** 一旦写了它，目录名约定就**整份失效**。项目只写 `docs/ops`（因为注意到 runbook 在那儿），`docs/architecture`、`docs/decisions` 会**同时失去**元信息要求，而报告只会安静地把它们记成"不要求元信息"。要保留原有约定就得把它们一并写进清单。

**二、不配它的后果，是"未定"而不是"不适用"。** `freshness` 判一份文档属不属于 01 §3.5 的六类（验收、架构、模块、契约、ADR、runbook），靠的是路径里有没有出现那几个目录名。这是**约定，不是判定**，两头都会错：RCMS 的 runbook 放在 `docs/ops/`，9 份全部落空；本仓是中文文档树（`docs/架构图`、`docs/审计记录`），35 份 100% 落空。反过来，叫 `architecture` 的目录里也可能放着别的东西。

按 §1.1，目录名约定**命中也只记未定**：它说明"像"，推不出"这份必须带日期"。未配 `metadata_required` 时，约定命中的缺日期文档汇成一条 `UNDETERMINED`（`freshness/undated-by-convention`），此前判 `FAIL`，与 §1.1 矛盾，已改（D-123）。

未配 `metadata_required` 且目录名约定未命中时，那些缺日期字段的文档**不逐份记 `SKIP`**——`SKIP`（不适用）是确定结论，而"这份文档算不算重要文档"要看内容，按 §7 机械判不了。它们汇总成**整轮一条 `UNDETERMINED`**，证据里列出路径。代价是这类项目的退出码从 0/1 变 2；收益是"这里没看"从报告末尾的不适用堆里挪到了未定区。配了 `metadata_required` 之后，命中记 `FAIL`（日期字段名也须在 `metadata_fields` 声明，否则只记未定，见 §5 表）、未命中记 `SKIP`，两边都是确定结论。写成空列表 `[]` 是"一类都不要求"的声明，无日期文档整轮汇成一条 `SKIP`——**它与不写这个键不是一回事**：空列表是项目的声明，可给确定结论；键缺失或值为空是没声明，只能记未定。声明错了由写下它的人负责，工具不复核。

**只读被扫项目之内的文件。** 读任何文件前按真实位置（跟随符号链接后）判它在不在项目根之下，不在的不读、记 `UNDETERMINED`（`links` 的链接目标同理，`links/outside-root`）；配置里值为项目内路径的键（`layout.entry`、`layout.docs_root`、`layout.work_root`、`layout.artifacts.*`、`layout.frozen`、`layout.rule_files`、`metadata_required`、`derived[].artifact/source`）写了 `..` 段或绝对路径，整份配置按解析失败记未定；`repos[].path` 除外（兄弟仓本来就在项目之外，01 §3.8），但经它读到的文件须落在该仓自己的真实位置之内，越出去记未定；链接目标不在任何声明仓之内的记 `cross-repo/outside-repos` 未定。字面就在项目之外的路径连存在性也不探测。配置解析失败的报错只给路径与行号，不回显文件内容。被扫仓 `.git/config` 里会执行外部程序的配置（`core.fsmonitor`、钩子、textconv、过滤器等）由 `hardenedEnv`（`core/git.ts`；返回加固后的环境副本，不改进程环境） 与 `filter_env` 一律压掉（`log.showSignature` 也在内，否则 `git log` 会对签名提交调被扫方指定的 gpg 程序）。

配置也可由 `check_all --config PATH` 从被扫描项目之外给出，此时 `_root` 仍是被扫描项目、`_path` 记配置的实际路径；这是扫描只读/第三方项目而不往其中写入任何文件的唯一受支持方式；外部配置缺失或解析失败一律记 `UNDETERMINED`，不回退到 `<root>/governance/`。

---

## 6. 输出

默认人读的文本：先给**检查器身份行**（见 §8），再给三态计数，再按 `FAIL` → `UNDETERMINED` → `SKIP` 排，`PASS` 只给计数不逐条列。`--json` 输出机器可读的 Finding 数组，供上层工具消费。

身份块在 `--json` 里是数组中一条 `check: "tool-identity"` 的 Finding，状态 `SKIP`（它是记录不是判定，不计三态、不影响退出码），逐文件哈希放在 `evidence` 里。这样 `--json` 仍然是一个 Finding 数组，不必为它改顶层形状。

**不输出分数、不输出百分比、不输出"健康度"。** 依据 [01 §4.8](../../标准/01-项目管理标准.md#delivery-metrics)：合成指标会把未定折算成部分通过。

---

## 7. 检查器只做机械判定

能机械判定的才写成检查器。**判不了的交给人：走查条目集中在 [`templates/agent-skills/code-review.md`](../../templates/agent-skills/code-review.md)**（如：记录所述事件是否真在那个日期发生、同一份文档里两处口径是否一致这一类），不要做成"用模型判一下"的检查器——那会让检查结果本身不可重复（见 [04 §6.2](../../标准/04-可靠性安全与运行维护.md#agent-run-observability)）。

具体地：文件是否存在、链接是否可达、行数是否超预算、同一字符串是否出现在两处、时间戳是否超期、字段是否齐全——可以。某段文字写得好不好、某条规则该不该存在、某个设计是否合理——不可以。

---

## 8. 报告必须钉住检查器自己的版本身份

来自一次实跑：扫描一个外部项目的过程中，本工具被另一条线并行改写；旧版对同一项目给 30 条 `FAIL`，新版给 9 条。两份报告都自称是"对该项目的结论"，而**没有任何字段能分辨它们是哪一套跑出来的**。结论：符合性报告不钉检查器版本身份就**不可复算**。

**身份是内容哈希，不是提交号。** 提交号覆盖不了工作区未提交的改动——上面那次正是未提交态；决定行为的是文件内容，不是提交指针。

- 进哈希的文件：插件包 `lib/` 下的全部 `.js`（编译产物，运行的就是它，逐个）+ **`CONTRACT.md`**。契约进身份是因为 `contractExamplesSelftest` 会读它、它进自检闸门，改了它就可能改变放行与否。
- 各文件 sha256 **对行尾归一化后的字节算**（`\r\n`、`\r` 一律作 `\n`，其余字节不动），外加一个合并摘要（把 `路径 哈希` 逐行拼起来再 sha256）。为什么归一化：上列文件是 JavaScript 源码与按文本读入的契约，行尾不改变它们的任何行为，进哈希只会把同一套工具算成两枚身份——已发生：2026-09-11，`7e0522f` 的 `tools/std` 一字未改，LF 检出与 CRLF 检出得两枚身份，两次 `git status --porcelain` 都为空，dirty 标记对这种漂零信号。仓库根的 `.gitattributes` 把检出钉在 LF 是给 git 的，不是给身份的：它不在上列文件里、不随 `git archive` 或摘目录分发走，身份不得依赖它。
- `git rev-parse HEAD` 与 `git status --porcelain` 只作**旁证与 dirty 标记**，不作身份。
- **脏工作区允许扫**，但报告必须显式标 `dirty` 并附逐文件哈希。
- **扫描前后各取一次**，摘要与文件集合都必须一致（新增一个检查器的 `.js` 也算变）。不一致则本次结论**作废**——不是加一句"存疑"，是把已有结论整份丢掉，只留一条 `UNDETERMINED` 说明作废原因，等检查器稳定后重跑。

**这一节约束的是工具，不是人的自觉。** 一条只有人能遵守的报告纪律放进契约，既越出"每个检查器必须满足的接口与行为"这个范围，又必然被忘——那正是 [M-10](../../标准/参考资料/M-10-守卫的执行点.md) 说的"守卫存在不等于守卫在执行"。所以：`check_all` 自己在文本输出头部与 `--json` 里产出身份块，`_entry_smoke_selftest` 有对应断言（文本含身份行、`--json` 含 `tool_identity_digest`）。

`--json` 里那条 Finding 的 `evidence` 长这样，它同时是本工具 yaml 子集能解析的形状：

```yaml
tool_identity_digest: f24d0d3ec39ff5551c006cdc55574a7dc8d6cd1a0fee4d644a55895f6f032ba8
tool_identity_git_head: a3b66cca003121ee1fe4aea034b069b216277461
tool_identity_dirty: True
tool_identity_files:
  - lib/check_all.js 0a59ea87bc6b56431fddf7ad3fbd07a75b14312c51f1001322b6cf6752301d69
  - CONTRACT.md 2b19a50dbb67d7569b0c69f23073f507b4382e34ed9887d666375ab0437ac319
```

---

## 9. 例外登记：未定项逐条登记，登记只改退出码

未定项不是待办堆。项目可以对**某一条**未定写下"我看过了，接受到什么时候、谁批的"——这一条登记之后，它仍然是 `UNDETERMINED`、仍然逐条列在报告里、仍然计入未定计数，**变的只有退出码**：全部未定都已登记且未过期时退出 0，只要还有一条没登记就退出 2。依据 [02 §10.1](../../标准/02-项目架构描述规范.md)：验收必需的检查失败或未定时，「修复、补证或经项目授权登记带范围/到期的例外后再判」，且「到期未清理按例外规则 CI 转红」；以及 [01 §5.6](../../标准/01-项目管理标准.md#gates)：登记不重写结论。

**文件位置：配置文件同目录的 `exceptions.md`**（纯文本路径，不是链接：`governance/` 由采用项目自己写，本工具不往交付面里链它）。不带 `--config` 时就是 `<项目根>/governance/exceptions.md`；`--config PATH` 时读 `PATH` 旁边那一份。取不到即**全部未登记**，不回退去别处找。报告首部在「配置 ·」行之后打一行「登记 · <路径>（N 行有效）」或「登记 · 无」；有已过期的行时该行写作「登记 · <路径>（N 行有效，其中 M 行已过期）」，N 仍按本节「一行有效」的定义计，M 只是提醒，不改变 N。

**表头按「包含」匹配第一张 markdown 表**，先命中者为准：整格等于 `id`（不区分大小写，按包含会把「Rule ID」「valid until」「Provider」吞成编号列）或含 `编号` → 编号，`规则` → 规则，`理由`、`范围`、`批准`、`到期`、`状态` 各对一列。多列命中同一字段时按先命中者取，并记一条不合格。列的顺序、多出来的列（`偏离`、`替代检查`……）都不影响解析。

**判定顺序写死，先判关闭**：`状态` 格按逗号、分号、顿号、斜杠切段，任一段（去掉首尾的加粗与反引号）以 `关闭` / `已关闭` / `closed` / `done` / `已处理` **整词**开头的行——关闭词后面只许是段尾、空白、加粗或反引号、括号、冒号或句号（「没关闭」「not yet closed」「open (to be closed)」「已处理中」「done? 否」「closed-loop 待复核」都不算）——不登记、不报过期、不参与有效性校验——它是历史记录，不是生效中的例外。

**一行有效要五项齐全**：规则、理由、范围、批准人非空，到期能被解析（整格是 `YYYY-MM-DD` 或 ISO8601，「日期 + 任意文字」不算）。**到期必填**，没有到期的登记就是一键静音；**到期不得晚于运行日 + 365 天**，更远的同样是长期静音，按不合格行处置（`invalid-rows`，原因里写上限日期）。`替代检查`／补偿控制这一列本工具**不校验**——那一列写的是项目自己的补偿措施，机械判不了它是否落实（§7）。到期由工具按**运行日**比较，基准日写进证据；过了期该行自动失效，对应发现回到未登记，并多出一条 `exception-register/expired`。

**规则列写的是 Finding id**（报告里每条未定下面那行 `id：…`，直接抄）。比较前去首尾空白、剥首尾反引号，然后**精确相等**才算命中。与项目自己的门号例外（`G6`、`G9` 之类）共用一张表：**规则列不含 `/` 的行本工具不登记、不校验五项**——那是项目的门，不是本工具的发现，拿去匹配只会成批报孤儿。**但它们的到期照判**（[02 §4](../../标准/02-项目架构描述规范.md)：依赖规则的例外「带到期；到期未清理 CI 转红」）：未关闭且到期早于运行日的判 `FAIL`（`exception-register/own-expired/<编号>`，编号为空取规则列），到期写不成日期的汇成一条未定（`exception-register/own-undated`），到期晚于运行日 + 365 天的同样汇成一条未定（`exception-register/own-too-far`，原因里写上限日期；它在登记之后才产出，不可登记）；其余未到期的不出发现。规则含 `/` 却匹配不到本次任何**未定**发现（含匹配到 `PASS`／`SKIP`／`FAIL`）的行即为孤儿，出一条 `exception-register/orphan`（判据变了、该条已不是未定，或抄错了，都该清理——留着的死行会在日后该条转回未定时静默复活）。

**FAIL 不可登记。** 本工具的 FAIL 按 §1.1 只在项目自己声明的事实下产出，那是确定的违规，处置是修或改声明。**检查器自身出错的未定同样不可登记**：崩溃或自检闸门不过（id 为 `<检查器>/internal-error`）会顶掉该检查器（或它的某条判据）本次的结论，登记它等于登记被顶掉的 FAIL；规则列写这类 id 的行按不合格行处置，那条未定照旧计入退出码 2。读不了的文件（`unreadable/<路径>`）、列不出某仓的文件（`cross-repo/enum-failed/<仓>`）、配置写错（如 `adoption/settings-invalid`）等有专门 kind 的未定是对象的事，不在此列。整块判据在本项目不适用走 `tailoring`（§5）——那是"这个检查器对我不适用"，粒度是整个检查器；例外登记是"这一条发现我看过并接受到某日"，粒度是单条发现。两者不可互换。

**与 §1.1 的关系**：登记**不是配置键**，也不改任何判据的召回位置。§1.1 禁的是"替工具修判据"的键——那会让每个采用方各自把召回改一遍；登记不动召回，它承认发现成立，只记录人对它的处置。

**与 01 §5.5 同行标记词的关系**：差别在于它是**独立于被检查对象的一份登记册**——每行带批准人与到期、超期自动失效、可被上一级抽查；贴在被检查行上的注释这三件都没有，不算登记。

**已知边界**（不加代码处理，写在这里）：

- 登记表里复述的数值会被 `single-authority` 的判据 3 算进文件数，于是那条发现的标题计数会变——但它的 `id` 不变，登记仍然有效。
- 登记表若落在 `layout.docs_root` 之内，会被 `freshness` 当成一份文档巡检。项目自行用 `layout.frozen` 处理。

## 10. 配置治理候选接口

此节仅定义新增 `./config` 子插件与只读 CLI；不改变前九节检查器、旧配置加载优先级或例外消费者语义。模型理解项目并提出文本，插件不裁决业务政策。当前候选未安装／未发布；共享 Desktop 为已验收的 a035 固定包，路径 guard 默认关闭。

- 插件名 `dsh-project-std/config`，必需注入 `tools`、`fs`。配置仅普通映射的两个布尔键 `enabled`（默认 true）、`protectNativeEdits`（默认 false）；未知键和非布尔拒收（apply 内无条件校验，这是安全依据；宿主能解析并成功加载形状匹配的 schemastery 时另在挂载期校验。该包入口无法解析（含已安装但入口文件缺失）或加载结果形状不符时省略挂载期 schema；入口可解析但加载过程报错则抛出），缺必需服务不静默半注册。bundle 增加第三稳定 id `dsh-project-std-config`，原主／技能配置不变。
- `std_config` 参数：`action: inspect|review|apply` 必填，`target: project|exceptions` 默认 project，review/apply 的 `content` 为完整替换原文；apply 另须显式 `before_sha256: string|null` 及 `after_sha256:string`。缺文件 before 为 null，不能省略。execute 拒绝所有额外参数，包括 root、approved、permission；模型自报批准无效。
- root 仅取本次 agent/session.header.cwd 的完全限定绝对路径。固定 project 候选为 governance/project.yaml、governance/project.yml；例外为 governance/exceptions.md。两个 project 候选同时存在（包括目录、链接占位），inspect 明示 conflict，两个 target 的 review 返回 invalid，apply 拒绝；不自动选择、删除或改名。首次缺配置允许只读提案，但需人审后方可创建；governance 父目录必须已是普通目录。
- inspect 返回固定文件的存在性／类型、原文、原字节 SHA、验证结果及有限工件候选来源：复用入口、状态、交接、docs/work root 的默认候选，加有效配置声明的入口／根／工件路径；逐路径内容无关探测，不递归全仓、不读工件正文、不跑 scripts。存在不等于语义角色确认。inspect 对象字段为 `root,target,conflict,governanceExists,files,artifacts,note`；files 固定顺序 project.yaml、project.yml、exceptions.md，每项 `path,exists,type,content,sha256,problem,validation`，缺失内容／hash／验证为 null。artifacts 每项为 `path,sources,exists,type,problem`；未跟随或无法确认的候选保留 problem，不将存在性当角色授权。
- review 返回 `valid,target,beforeSha256,afterSha256,needsApproval,changes,problem?`，工具面另加 `root,path,conflict`；CLI 只返回 review 核心。apply 成功返回 `applied,root,path,sha256,version,review`，不是批准凭证，不可重用作后续授权。changes 使用 JSON Pointer 层级地址，before/after 均为 `{present:false}` 或 `{present:true,value:JSON值}`；保留未知字面键、null、数组及空容器，不用点扁平化混淆键名。只剥一个 BOM 解析，raw SHA 包含 BOM／CRLF。原文每份最多 32768 UTF-8 字节；拒无效 UTF-8、孤立 surrogate 及解析后的非有限数，不让 JSON 静默丢值。
- 首版自动方向仅限实际嵌套 budgets 下 entry_lines、stale_days、work_item_stale_days、status_lines、handoff_lines、work_item_lines、module_lines、duplicate_min_lines、duplicate_min_chars：双侧均明示正安全整数且改变时，增大 relax、减小 tighten。新增、删除、缺省、null、不可比以及所有其它字段变更为 unknown，不通过默认值消去声明来源；任一 relax／unknown 均需审批，不被其它 tighten 抵消。仅成功解析验证后的键序／注释等值变化 equivalent；无效基线不能当空配置修复放行。
- exceptions 复用原第一 Markdown 表、表头、关闭优先、own 行、365 天及 internal-error 逻辑。新旧文本均拒 problems 或 own[].error；任何原文变化统一 unknown，并提供实际完整前后文本。表里的批准人不是宿主批准；一次 apply 只改一个文件，无配置＋例外事务。
- apply 在同调用内捕获 content/target，重新 snapshot/review，验证 validity 及两个 hash；仅 needsApproval 时调用 `ctx.get('approval').request({agent,toolName:'std_config',callId,reason,signal})`。reason 含根、目标、hash、所有非等价变化实际值／原因（例外完整前后原文），最多 131072 UTF-8 字节，超限拒收不截断。只接受本次 allowed-once；无服务／never／拒绝／取消／不可用／无开放 turn／异常均零写入。明确 strict/equivalent 不新增审批服务前提；所有 apply 都需要有效 agent/root。宿主外层 Auto allow 不替代主体 ask，不创建批准 token、cache 或模型权限字段。
- 宿主 fs 通过真实 resolve/lstat/stat/readBytes、同步 contains 获取 opaque identity，stat/read/stat 绑定稳定版本与原字节 hash；根及父目录拒链接／非目录，目标仅普通文件或缺失。批准后及 strict 路径重读完整 snapshot，比对 cwd、canonical root/governance target key 与目录 type（不比较目录 version/size，免被无关兄弟项误拒；换链／换类型仍拒），以及双候选与例外三个受管文件的存在性、type、version、size、原字节 hash／problem；受管目标漂移与父级身份／类型变化分别报错，任一漂移停止不重试，并发写入的竞争交宿主 CAS，每次 await 后核取消。写前重新通过 sandboxPolicy.resolve({session}) 取得当前策略，不设 mode override 或旧宽 fallback；fs 声明沙箱而无服务则失败关闭，裸 fs 不伪造沙箱。
- 写入只用 ctx.fs.writeText 的 replaceIfVersion／createIfAbsent，成功后仅用实际 outcome.version 发 fs/observed present（writeText 返回后不再做取消检查，已提交写入如实报告 applied）；不提前改别的工具的 observed 状态。后端的同 target 队列／版本检查不等于跨候选原子锁、两文件事务或恶意外部进程的 OS CAS。host 无 link count，不能宣称完整 hardlink 防护；目录换链仍有宿主承认的 TOCTOU 边界。
- opt-in 原生保护先 await next，非 allow 决定原样保留；仅当前根固定治理路径的 write/edit file_path 与 str_replace_editor path 拒绝；str_replace_editor 为黑名单，只放行已确认只读的 view，未知／缺失命令按变更拒绝；read 及正常其它路径不误伤。canonical alias 仅经宿主 resolve 比较、不借 Node fs 越根读。Shell、不透明工具、外部写者未覆盖；原动作已拒后禁止自动换专用入口重试。
- `std-check config-review [ROOT] --candidate PATH [--target project|exceptions] [--json]` 独立严格 parser；空值、重复、多余／不支持 flag 退出 2，不向旧 check/migrate parser 增加键或开关。允许显式根外 candidate 只读，基线仅根内固定路径；均 bounded regular UTF-8、不跟随链接／隐藏越界父路径。输出实际值及真实换行或 JSON review，退出 0 只表示 valid review，非批准；无效／错误退出 2。没有 CLI apply／approved 功能。可执行步骤见工具 README「配置治理」。
