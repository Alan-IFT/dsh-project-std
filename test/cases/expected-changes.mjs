// TS 版与迁移前 Python 版**有意不一致**的清单：对应的机制已废弃（内嵌 .std/、Claude Code 的 settings.json、STANDARD_VERSION、Python 专有现象），
// 每条写明理由，不静默。Python 版已删除，所以这份登记不再被比对脚本读取，只作为「这些检查为什么没有了」的记录，
// 由 check-adoption.test.mjs 核对登记理由与 adoption 的 selftest 清单；同一修复工具的迁移前后对账不引用本历史消失登记。
// 设计文档 §12.37 有同一份的人读版本。

export const ADOPTION = {
  vanished_findings: [
    {"id":"adoption/60a5c980","reason":"「内嵌目录只读：非内嵌运行，不适用」——它的唯一内容就是在说一个已不存在的机制（采用项目内嵌 .std/，D-135 起不再有）；留着只是给每份报告塞一条永远 SKIP 的噪音。用户 2026-10-07 决定不迁"},
    {"id":"adoption/settings-absent","reason":"「免审批清单判据本宿主无对象，未判」——读的是 Claude Code 的 .claude/settings.json，该宿主已废弃；DSH 的审批策略是会话级旋钮，没有项目级入库清单可读。用户 2026-10-07 决定不迁"},
    {"id":"adoption/8baf1c92","reason":"「governance/STANDARD_VERSION 记了版本值」——判据对象（项目里的版本文件）已移除。版本记录判据随 governance/STANDARD_VERSION 一起移除（设计 §12.33）：采用的标准版本改由 profile 的锁文件钉住、报告自带 tool-identity 摘要，零人工。 四个真实仓的这条 PASS 随之消失，不是回归"},
    {"id":"adoption/8714bd62","reason":"「governance/STANDARD_VERSION 记了采用日期」——同上，采用日期是对账线索而非标准原文的要求（原判据自己的 why 就这么写），载体消失后无处可读。版本记录判据随 governance/STANDARD_VERSION 一起移除（设计 §12.33）：采用的标准版本改由 profile 的锁文件钉住、报告自带 tool-identity 摘要，零人工。"},
  ],
  renamed_findings: [
    {"from":"adoption/e4ecca44","to":"adoption/0a63fe45","reason":"「项目已裁剪本检查」那条 SKIP 的标题原为「…（内嵌目录只读与 compatibility.policy 不可裁剪，照判）」，去掉「内嵌目录只读」后标题变了；它没给 kind，id 是标题的 sha1 前 8 位，所以 id 跟着变。四个真实仓都没裁剪 adoption，黄金样本里没有这条；SKIP 不可登记（只有未定可登记），所以没有登记会失效的后果"},
  ],
  vanished_probes: [
    {"id":"adoption/d5d57eb2","reason":"标题把 compatibility.policy 与免审批清单的通配放行合在一起；通配放行（_wildcard_allow / _settings_allow）随废弃宿主一起删。compatibility.policy 部分由 added_probes 里的新探针接住"},
    {"id":"adoption/4ae5a1cf","reason":"内嵌修订号比对（STANDARD_VERSION 与内嵌 .std/标准/README.md 第 3 行比对）——内嵌机制废弃"},
    {"id":"adoption/2c6591e7","reason":"内嵌目录只读（git status 查 .std/ 有没有被改）——内嵌机制废弃"},
    {"id":"adoption/abf28bac","reason":"「非内嵌运行时不产出内嵌修订号比对」——内嵌机制废弃，没有对象"},
    {"id":"adoption/696e975a","reason":"反例：只有采用日期读不出版本值——版本文件的解析随判据移除。版本记录判据随 governance/STANDARD_VERSION 一起移除（设计 §12.33）：采用的标准版本改由 profile 的锁文件钉住、报告自带 tool-identity 摘要，零人工。"},
    {"id":"adoption/1c53f34a","reason":"反例：版本文件缺失判 FAIL——判据对象移除。版本记录判据随 governance/STANDARD_VERSION 一起移除（设计 §12.33）：采用的标准版本改由 profile 的锁文件钉住、报告自带 tool-identity 摘要，零人工。"},
    {"id":"adoption/edd4408c","reason":"反例：空版本文件的两种结论——判据对象移除。版本记录判据随 governance/STANDARD_VERSION 一起移除（设计 §12.33）：采用的标准版本改由 profile 的锁文件钉住、报告自带 tool-identity 摘要，零人工。"},
    {"id":"adoption/282ba859","reason":"只有版本值没有采用日期记未定——判据对象移除。版本记录判据随 governance/STANDARD_VERSION 一起移除（设计 §12.33）：采用的标准版本改由 profile 的锁文件钉住、报告自带 tool-identity 摘要，零人工。"},
    {"id":"adoption/0f6cfe3d","reason":"正例：示例项目的版本文件实物形状判 PASS——判据对象移除。版本记录判据随 governance/STANDARD_VERSION 一起移除（设计 §12.33）：采用的标准版本改由 profile 的锁文件钉住、报告自带 tool-identity 摘要，零人工。"},
    {"id":"adoption/4e9c2b66","reason":"正例证据里带原样版本值与限定——判据对象移除。版本记录判据随 governance/STANDARD_VERSION 一起移除（设计 §12.33）：采用的标准版本改由 profile 的锁文件钉住、报告自带 tool-identity 摘要，零人工。"},
    {"id":"adoption/3047fbba","reason":"变异验证：对版本值不敏感而「比对工具常量」的变异体被抓住——被守的对象（对版本值的判定）已不存在。「不与工具侧常量比对」这条硬约束的对象随之消失，不再有可比的版本值。版本记录判据随 governance/STANDARD_VERSION 一起移除（设计 §12.33）：采用的标准版本改由 profile 的锁文件钉住、报告自带 tool-identity 摘要，零人工。"},
  ],
  added_probes: [
    {"id":"adoption/f32dd8ac","reason":"替代 adoption/d5d57eb2 的前一半：compatibility.policy（01 §5.3）缺、空串、空列表、false 判 FAIL，有值（字符串、映射、0）PASS。原探针把它与免审批清单的通配放行合在一条里，后一半随废弃宿主删除，前一半不能跟着丢"},
    {"id":"adoption/b6031618","reason":"裁剪 adoption 时本检查记一条 SKIP、compatibility.policy 照判（不可裁剪，D-126）。原先这条行为只被真实实现的直接断言守着、没有自检探针；版本记录判据移除后，adoption 只剩 compatibility.policy 一个判据，这条「不可裁剪」成了它最容易被悄悄破坏的地方，值得进自检"},
  ],
}

export const CHECK_ALL = {
  vanished_probes: [
    {"id":"shared-fact/251040cc","reason":"内嵌仓 .std/ 有未暂存改动：adoption 必须报 embedded-modified FAIL——对象是 .std/ 内嵌机制，D-135 起采用项目不再内嵌 .std/，adoption 的该判据已于 §12.28 删除，没有对象"},
    {"id":"stdlib/7011541d","reason":"1200 层嵌套不抛 RecursionError——Python 递归上限的专有现象；TS 版 YAML 解析的深度限制是 MAX_DEPTH 抛 ConfigError，由 test/yaml.test.mjs 直接钉"},
    {"id":"stdlib/c7bca0ea","reason":"read_bytes 每读一份只做 3 次 realpath——对象是 Python 的 os.path.realpath 调用次数（性能计数）；TS 用 realpathSync.native，次数由 test/fs.test.mjs 钉"},
    {"id":"stdlib/c563c6ba","reason":"settings.json 深嵌套记这一条未定——对象是 adoption._settings_allow 读 .claude/settings.json，该判据已于 §12.28 随 Claude Code 宿主一起删除"},
    {"id":"stdlib/b1ec005d","reason":"stdlib 与检查器按源码加载，不读 __pycache__ 里的 pyc——Node 没有 pyc；ESM 加载的就是 lib/*.js，其与 src/ 的一致性由 check-lib-sync 钉"},
    {"id":"stdlib/b73f92ac","reason":"一次扫描 discover 一次、ls-files 同模式不重跑、缓存随扫描关闭——TS 没有 discover（检查器在 checks/index.ts 的显式表里登记，设计 §12.31 取舍 4）；ls-files 缓存的断言保留为 added_probes 里的替代探针"},
    {"id":"stdlib/fe15947f","reason":"字面在项目之外的路径不做 realpath 探测——对象是 Python 里对 os.path.realpath 的替换计数；TS 的 inside() 在 fs.ts 里有同义断言（test/fs.test.mjs），且无法替换 ESM 命名导出来计数"},
    {"id":"stdlib/831d0e65","reason":"工具目录里同名标准库模块不被导入执行——Python 的 sys.path[0] 劫持；Node 的模块解析不吃这个"},
    {"id":"stdlib/efb0793f","reason":"检查器里 sys.exit(0) 转未定——Node 的 process.exit 同步结束进程、接不住；TS 版改为机械禁止检查器代码里出现 process.exit（scripts/check-py-semantics.mjs 扩展，设计 §12.31 取舍 3），见 added_probes"},
  ],
  added_probes: [
    {"id":"stdlib/3ac5e0b9","reason":"替代 stdlib/efb0793f 的『检查器崩溃转未定』：Node 里检查器调 process.exit 接不住，由 scripts/check-py-semantics.mjs 的 process-exit 规则在源码层机械禁止（test/py-semantics.test.mjs 钉）；剩下唯一的崩溃形态是抛出任何东西，含 JS 特有的非 Error（字符串、undefined），这条钉它在自检与运行两处都转未定"},
  ],
}
