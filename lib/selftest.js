// 汇总层与 stdlib 层的自检（对应 tools/std/check_all.py 的 `--selftest` 分支里各 `_*_selftest`；设计 §12.31）。
//
// 契约 §3：单个检查器的 selftest 看不见别的检查器，也看不见入口与 stdlib——这些只能在汇总层断言。每条探针的**标题与 Python 版逐字相同**（id 是标题的哈希，
// 例外登记册和黄金样本都按它认），所以标题不许改。断言本身按 TS 的函数重写，对象不存在的（Python 专有机制）在 test/cases/expected-changes.mjs 的 CHECK_ALL 里各登记了理由，不假装通过。
//
// 本文件不进检查器表（`checks/index.ts`）：它是汇总层自己的自检，由 `runAll` 之外的 `--selftest` 入口追加。
import { chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS } from './checks/index.js';
import { loadConfig } from './core/config.js';
import { parseDate } from './core/dates.js';
import { entryFiles, findField, itemStatus } from './core/docs.js';
import { exField, loadExceptions, _exClosed } from './core/exceptions.js';
import { FAIL, PASS, SKIP, UNDETERMINED, finding } from './core/finding.js';
import { spawnSync } from 'node:child_process';
import { gitGrep } from './checks/cross_repo.js';
import { MAX_READ_BYTES, OutsideRoot, __testHooks, readBytes, readText } from './core/fs.js';
import { fixtureEnv, gitTrack } from './core/fixture.js';
import { gitVersionProblem } from './core/git.js';
import { probe, probeCrashed, runGuarded, undeterminedFromException } from './core/shell.js';
import { ConfigError, parseYamlSubset } from './core/yaml.js';
import { writeText } from './core/fixture.js';
import { render, runOne, tailoringUnknown, identityLine } from './check_all.js';
import { contractExamplesSelftest, entrySmokeSelftest, sharedFactSelftest } from './selftest_shared.js';
import { gitEnvSelftest, hostileGitConfigSelftest } from './selftest_git.js';
const CHECK = 'stdlib';
const J = (v) => JSON.stringify(v);
function withTmp(fn) {
    const base = mkdtempSync(join(tmpdir(), 'stdlib-'));
    try {
        return fn(base);
    }
    finally {
        rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    }
}
/** 写一份 governance/<name> 再读：返回 `[cfg, problem]`。 */
function load(tmp, body, name = 'project.yaml', raw) {
    const gov = join(tmp, 'governance');
    mkdirSync(gov, { recursive: true });
    writeFileSync(join(gov, name), raw ?? Buffer.from(body ?? '', 'utf8'));
    return loadConfig(tmp);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const SMOKE_ENTRY_TXT = '# 冒烟仓\n\n这个仓只为跑通入口冒烟自检而存在，内容不参与任何判定。\n';
const SMOKE_CONFIG_TXT = 'layout:\n  entry:\n    - AGENTS.md\n  docs_root: docs\n  frozen:\n    - docs/archive\nbudgets:\n  entry_lines: 150\n';
/** 本平台造不出夹具、如实记 SKIP 的断言（标题带「（未跑）」，与 Python 版同——id 因此不同于真跑时的 PASS 探针，两边按平台各自出现）。 */
const skipProbe = (title, reason) => finding(CHECK, SKIP, `stdlib：${title}（未跑）`, { reason });
/** `(os.mkfifo if hasattr(os, "mkfifo") else os.mkdir)(path)`：有 mkfifo 的平台建 FIFO，否则目录占位。 */
function replaceWithFifo(path) {
    if (process.platform !== 'win32' && spawnSync('mkfifo', [path]).status === 0)
        return;
    mkdirSync(path);
}
const errName = (e) => e?.constructor?.name ?? 'Error';
const byName = (name) => CHECKS.find((m) => m.NAME === name);
/**
 * stdlib 层：配置读取与路径护栏，每条样本都来自一次实测的误读或越界（D-123）。
 * 返回的 Finding 与 Python 版同标题；Python 专有、对象在 TS 里不存在的 8 条不在这里（见 expected-changes.json）。
 */
export function stdlibSelftest() {
    const cases = [];
    const skipped = [];
    const add = (title, ok, ev) => { cases.push({ title, ok, ev: typeof ev === 'string' ? ev : J(ev) }); };
    try {
        withTmp((base) => {
            let n = 0;
            const fresh = (tag) => { const d = join(base, tag + '-' + n++); mkdirSync(d, { recursive: true }); return d; };
            // 安全 2：配置是指向项目之外的符号链接 → 不读、不回显内容
            const outDir = fresh('outside'), proj1 = fresh('p1');
            const secret = join(outDir, 'secret.txt');
            writeText(secret, 'tier: TOPSECRET\n'); // 合法配置：护栏失效时会被当成项目配置读进来
            mkdirSync(join(proj1, 'governance'), { recursive: true });
            let linked = true;
            try {
                symlinkSync(secret, join(proj1, 'governance', 'project.yaml'));
            }
            catch {
                linked = false;
            }
            if (linked) {
                const [cfg, prob] = loadConfig(proj1);
                add('配置经符号链接指向项目之外应拒读且不回显内容', !!prob && !prob.includes('TOPSECRET') && Object.keys(cfg).length === 0, prob);
            }
            // 安全 2：配置里的路径带 .. 或绝对路径 → 整份拒收
            for (const [tag, body] of [['p2', 'tier: L1\nlayout:\n  entry:\n    - ../outside/secret.md\n'], ['p3', 'tier: L1\nlayout:\n  artifacts:\n    status: /etc/passwd\n'], ['p4', 'tier: L1\nmetadata_required:\n  - docs/../../x\n']]) {
                const [cfg, prob] = load(fresh(tag), body);
                add(`配置路径含 .. 或绝对路径应拒收（${tag}）`, !!prob && Object.keys(cfg).length === 0, prob);
            }
            // 安全 2：不回显解析失败行的内容
            {
                const [, prob] = load(fresh('p5'), 'tier: L1\nTOPSECRET-LINE\n');
                add('解析失败的报错不回显行内容', !!prob && !prob.includes('TOPSECRET'), prob);
            }
            // 安全 2：read_text 给了 root 就不跟随指向项目之外的符号链接
            {
                const proj = fresh('p7');
                try {
                    symlinkSync(secret, join(proj, 'a.md'));
                    try {
                        readText(join(proj, 'a.md'), proj);
                        add('read_text 不跟随指向项目之外的符号链接', false, '读到了');
                    }
                    catch (e) {
                        add('read_text 不跟随指向项目之外的符号链接', e instanceof OutsideRoot && !e.message.includes('TOPSECRET'), e.message);
                    }
                }
                catch { /* 建不了符号链接的平台：此条不成立（Python 版同条件下 os.symlink 会抛，整条记 FAIL；这里不假装构造成功） */ }
            }
            // A2／A3／A15：读被扫文件只走 readBytes——超限不读
            {
                const proj = fresh('p16');
                const tryRead = (fn) => { try {
                    const r = fn();
                    return `读到：${J(r.slice(0, 4).toString())}`;
                }
                catch (e) {
                    return errName(e);
                } };
                const big = join(proj, 'big.md');
                writeFileSync(big, '');
                truncateSync(big, MAX_READ_BYTES + 1); // 稀疏文件，不占盘
                const got = [tryRead(() => readText(big, proj)), (() => { try {
                        return `读到：${J([...readBytes(big, proj, 4)])}`;
                    }
                    catch (e) {
                        return errName(e);
                    } })()];
                add('超过 MAX_READ_BYTES 不读（TooLarge），只读头部时照读', got[0] === 'TooLarge' && got[1] === '读到：[0,0,0,0]', got);
                // Windows 没有 FIFO，目录占位**不等价**（对目录打开直接抛 PermissionError，走不到「是不是常规文件」的判定，测的不是同一条分支）。
                // 所以不换夹具，如实记 SKIP（本平台未验证）；该断言只能在 POSIX 上验证。
                if (process.platform !== 'win32') {
                    const fifo = join(proj, 'fifo.md');
                    const mk = spawnSync('mkfifo', [fifo]);
                    if (mk.status === 0)
                        add('FIFO 不读、不阻塞（NotRegular）', tryRead(() => readText(fifo, proj)) === 'NotRegular', tryRead(() => readText(fifo, proj)));
                    else
                        skipped.push(skipProbe('FIFO 不读、不阻塞（NotRegular）', '本平台造不出 FIFO（mkfifo 不可用）；该断言只能在有 mkfifo 的 POSIX 上验证，本次未验证，不折算为通过'));
                }
                else {
                    skipped.push(skipProbe('FIFO 不读、不阻塞（NotRegular）', '本平台（Windows）没有 FIFO；目录占位走的是另一条分支（PermissionError），不等价，故不换夹具；该断言只能在 POSIX 上验证，本次未验证，不折算为通过'));
                }
            }
            // 配置 _links_files（A5）：顶层 _ 开头的键是代码注入口，整份拒收并给行号
            {
                const [cfg, prob] = load(fresh('p17'), 'tier: L1\n_links_files:\n  - CLAUDE.md\n');
                add('配置写 _links_files 整份拒收并给行号', Object.keys(cfg).length === 0 && (prob ?? '').includes('第 2 行'), prob);
            }
            // bug 6：GBK 编码的配置不崩，记未定
            {
                const [, prob] = load(fresh('p8'), null, 'project.yaml', Buffer.from([0x74, 0x69, 0x65, 0x72, 0x3a, 0x20, 0x4c, 0x31, 0x0a, 0x6c, 0x61, 0x79, 0x6f, 0x75, 0x74, 0x3a, 0x0a, 0x20, 0x20, 0x64, 0x6f, 0x63, 0x73, 0x5f, 0x72, 0x6f, 0x6f, 0x74, 0x3a, 0x20, 0xce, 0xc4, 0xb5, 0xb5, 0x0a]));
                add('非 UTF-8 编码的配置应报未定，不抛 UnicodeDecodeError', !!prob, prob);
            }
            // bug 7：BOM 不进首键
            {
                const [cfg, prob] = load(fresh('p10'), null, 'project.yaml', Buffer.from('\ufefftier: L1\n', 'utf8'));
                add('带 BOM 的配置首键读作 tier', cfg.tier === 'L1' && !prob, prob ?? cfg);
            }
            // A11／C21／A4：列表键写成标量或映射 → 整份拒收并报键名与行号
            for (const [tag, body, key] of [
                ['p19', 'tier: L1\nlayout:\n  frozen: docs/archive\n', '第 3 行 layout.frozen'],
                ['p20', 'tier: L1\ntailoring:\n  check: layout\n  applicable: false\n', '第 2 行 tailoring'],
                ['p21', 'tier: L1\nlayout:\n  entry: 5\n', '第 3 行 layout.entry'],
                ['p22', 'tier: L1\nwork_item_done_states:\n  done: x\n', '第 2 行 work_item_done_states'],
                ['p23', 'tier: L1\nrepos:\n  - name: a\n    path: .\n    former_names: b\n', '第 5 行 repos[0].former_names'],
                ['p28', 'tier: L1\nlayout:\n  work_root:\n    - a\n', '第 3 行 layout.work_root'],
                ['p29', 'tier: L1\nlayout:\n  docs_root:\n    k: v\n', '第 3 行 layout.docs_root'],
                ['p30', 'tier: L1\nlayout:\n  artifacts:\n    status:\n      - a\n', '第 4 行 layout.artifacts.status'],
                ['p31', 'tier: L1\nrepos:\n  - name: a\n    path:\n      - x\n', '第 4 行 repos[0].path'],
                ['p37', 'tier: L1\nwork_item_done_states:\n  - 验证中\n', '第 2 行 work_item_done_states 的「验证中」'],
                ['p38', 'tier: L1\nwork_item_in_progress_states: done\n', '第 2 行 work_item_in_progress_states 的「done」'],
                ['p41', 'tier: L1\nwork_item_done_states: 已取代\n', '第 2 行 work_item_done_states 的「已取代」'],
                ['p39', 'tier: L1\nwork_item_done_states: closed\nwork_item_in_progress_states: Closed\n', '第 3 行 work_item_in_progress_states 的「closed」'],
            ]) {
                const [cfg, prob] = load(fresh(tag), body);
                add(`配置键形状不对整份拒收（${key}）`, Object.keys(cfg).length === 0 && (prob ?? '').includes(key), prob);
            }
            // A10：列表项空值取 None；a: b: c、引号不闭合拒收
            {
                const got = [parseYamlSubset('r:\n  - name: a\n    former_names:\n  - name: b\n'), parseYamlSubset('d:\n  - artifact: x\n    source:\n    regen: y\n')];
                for (const text of ['a: b: c\n', 'a: "x" y"\n', 'a: "unterminated\n']) {
                    try {
                        got.push(parseYamlSubset(text));
                    }
                    catch (e) {
                        got.push(e instanceof ConfigError && e.message.includes('第 '));
                    }
                }
                add('YAML 子集：列表项空值为 None，a: b: c 与引号不闭合拒收并给行号', J(got) === J([{ r: [{ name: 'a', former_names: null }, { name: 'b' }] }, { d: [{ artifact: 'x', source: null, regen: 'y' }] }, true, true, true]), got);
            }
            // A9：YAML 子集两处平方级（长空白行、满行引号）改线性
            {
                const t0 = performance.now();
                for (const text of ['a' + ' '.repeat(100000) + 'b\n', 'k: a' + "'".repeat(100000) + '\n']) {
                    try {
                        parseYamlSubset(text);
                    }
                    catch (e) {
                        if (!(e instanceof ConfigError))
                            throw e;
                    }
                }
                const spent = (performance.now() - t0) / 1000;
                add('YAML 子集解析 10 万字符的长空白行与满行引号在 2 秒内', spent < 2, `${spent.toFixed(2)}s`);
            }
            // A8／C05：find_field 不跨行吞值、空值等于缺字段、build-status 不算 status
            {
                const got = [findField('# WI\n\n状态：\n\n## 背景\n', ['状态']), itemStatus('# WI\n\nstatus:\n\ndone\n'), findField('build-status: passing\n', ['status']), findField('- status: done\n', ['status'])];
                add('find_field 不跨行、空值算缺失、前缀 - 不命中', J(got) === J([[null, null], null, [null, null], ['done', 'status']]), got);
            }
            // bug 8：YAML 子集不静默误读——能对的读对，读不对的拒收并给行号
            for (const [text, want] of [['a:\n  - "a: b"\n  - https://x\n', { a: ['a: b', 'https://x'] }], ['"tier": L1\n', { tier: 'L1' }], ["reason: don't do it # 注释\n", { reason: "don't do it" }], ['x: "a # b" # c\n', { x: 'a # b' }]]) {
                let got;
                try {
                    got = parseYamlSubset(text);
                }
                catch (e) {
                    got = `拒收：${e.message}`;
                }
                add(`YAML 子集读对 ${pyRepr24(text)}`, J(got) === J(want), got);
            }
            for (const text of ['a:\n  - name: x\n    path: .\n    path: y\n', '---\ntier: L1\n']) {
                let got, ok;
                try {
                    parseYamlSubset(text);
                    got = '';
                    ok = false;
                }
                catch (e) {
                    got = e.message;
                    ok = e instanceof ConfigError && got.includes('第 ');
                }
                add(`YAML 子集对歧义写法拒收并给行号 ${pyRepr24(text)}`, ok, got);
            }
            // B4：配置是指向项目之外（且不存在）的软链接 → 先判真实位置，不去探测目标在不在
            {
                const proj = fresh('p14');
                mkdirSync(join(proj, 'governance'), { recursive: true });
                try {
                    symlinkSync(join(outDir, 'nope.yaml'), join(proj, 'governance', 'project.yaml'));
                    const [, prob] = loadConfig(proj);
                    add('配置软链到项目之外且目标不存在：报越界，不报「未找到」（没探测目标）', !!prob && prob.includes('之外'), prob);
                }
                catch { /* 建不了符号链接 */ }
            }
            // B4：例外登记册是指向项目之外的软链接 → 不读、不回显，记一条问题
            {
                const proj = fresh('p15');
                mkdirSync(join(proj, 'governance'), { recursive: true });
                try {
                    symlinkSync(secret, join(proj, 'governance', 'exceptions.md'));
                    const [rows, probs] = loadExceptions(join(proj, 'governance'), proj);
                    add('例外登记册软链到项目之外：不读、不回显内容', rows.length === 0 && probs.length > 0 && !probs.some((x) => x.includes('TOPSECRET')) && probs.some((x) => x.includes('之外')), probs);
                }
                catch { /* 建不了符号链接 */ }
            }
            // 裁定 6：拒收信息带行号并指明不支持的写法
            {
                const msgs = [];
                for (const [text, want] of [['---\ntier: L1\n', '文档分隔符'], ['tier:L1\n', '冒号后没有空格'], ['a:\n- x\n', '列表项与它的键同列'], ['a:\n  - key:\n', '后面没有值']]) {
                    try {
                        parseYamlSubset(text);
                        msgs.push([text, null]);
                    }
                    catch (e) {
                        const m = e.message;
                        msgs.push([text, m.includes('第 ') && m.includes(want) ? m : '缺行号或写法：' + m]);
                    }
                }
                add('YAML 子集拒收信息带行号并指明写法', msgs.every(([, m]) => m !== null && !m.startsWith('缺')), msgs);
            }
            // duplicate_* 阈值写错是配置错误（带行号、整份拒收），不静默用默认
            for (const [tag, body] of [['p11', 'tier: L1\nbudgets:\n  duplicate_min_lines: 1\n'], ['p12', 'tier: L1\nbudgets:\n  duplicate_min_chars: yes\n']]) {
                const [cfg, prob] = load(fresh(tag), body);
                add(`duplicate_* 阈值写错整份拒收并给行号（${tag}）`, Object.keys(cfg).length === 0 && !!prob && prob.includes('第 3 行'), prob);
            }
            {
                const [, prob] = load(fresh('p13'), 'tier: L1\nbudgets:\n  duplicate_min_lines: 4\n');
                add('duplicate_* 阈值合法照常读', !prob, prob);
            }
            // bug 4：字段名两侧的加粗与反引号
            add('**状态**：done 读得出状态', itemStatus('# x\n\n**状态**：done\n') === 'done' && itemStatus('`status`: in_progress\n') === 'in_progress', itemStatus('# x\n\n**状态**：done\n'));
            // bug 12：关闭态只认整格等于或以关闭词开头
            {
                const closed = ['关闭', '已关闭（09-01）', '**done**', '**已过期，已处理**（06-28 对账）', '没关闭', 'not yet closed', 'open (to be closed)', '待关闭', '已处理中', 'done? 否', 'closed-loop 待复核'].map(_exClosed);
                add('例外登记的关闭态只认段首整词：没关闭/not yet closed/已处理中/done? 否/closed-loop 不算关闭', J(closed) === J([true, true, true, true, false, false, false, false, false, false, false]), closed);
            }
            // A12：表头 id 只认整格；到期只收纯日期
            {
                const got = ['到期 / valid until', 'Rule ID', 'Provider', ' ID ', '编号'].map((h) => exField(h));
                const d1 = parseDate('2026-12-31 以后再说', true)[0], d2 = parseDate('2026-12-31', true)[0];
                got.push(d1, d2 === null ? null : `${d2.year}-${d2.month}-${d2.day}`);
                add('登记册表头 id 整格匹配、到期不认「日期 + 文字」', J(got) === J(['expires', null, null, 'ex_id', 'ex_id', null, '2026-12-31']), got);
            }
            // A14：git < 2.31 静默忽略 GIT_CONFIG_COUNT，加固全失效——认出来记未定，不静默照跑
            {
                const vers = ['git version 2.25.1\n', 'git version 2.31.0\n', 'git version 2.39.3 (Apple Git-146)\n', ''].map((v) => gitVersionProblem(v) === null);
                add('git 版本 2.25 与认不出的版本报问题，2.31 起放行', J(vers) === J([false, true, true, false]), vers);
            }
            // 低：身份行在 git 不可用时不写成「git git 退出码」
            {
                const line = identityLine({ digest: '0'.repeat(64), files: [], git_head: 'git 退出码 128', dirty: null, dirty_detail: 'git 退出码 128' });
                add('身份行 git 不可用时措辞不重复', !line.includes('git git'), line);
            }
            // 低：裁剪写成不存在的检查器名要报出来
            {
                const unk = tailoringUnknown({ tailoring: [{ check: 'derived', applicable: false }, { check: 'derived-artifacts', applicable: false }, { check: 'layout:playbook', applicable: false }] });
                add('裁剪写成不存在的名字（derived）记未定，写对的不报', J(unk.map((f) => f.id)) === J(['tailoring/unknown-check/derived']), unk.map((f) => f.id));
            }
            // 替代 stdlib/efb0793f（检查器 sys.exit(0) 转未定）：Node 里「检查器自己结束了进程」接不住，所以改成机械禁止 `process.exit`（scripts/check-py-semantics.mjs 的 process-exit 规则）；
            // 这里钉的是剩下唯一的崩溃形态——抛出任何东西（Error、字符串、undefined）——在自检与运行两处都转未定，且不带走进程。
            {
                const mkThrow = (where, what) => ({
                    NAME: 'throws',
                    selftest: () => { if (where === 'selftest')
                        throw what; return [finding('throws', PASS, '反例'), finding('throws', PASS, '正例')]; },
                    run: () => { throw what; },
                    scope: () => ({ covered: [], not_covered: [] }),
                });
                const got = ['selftest', 'run'].flatMap((where) => [new Error('x'), 'boom', undefined].map((what) => runOne('throws', mkThrow(where, what), {}).map((f) => f.status)));
                add('检查器抛出任何东西（含非 Error）在自检与运行两处都应转未定', got.every((g) => J(g) === J([UNDETERMINED])), got);
            }
            // R124-4：tailoring 写成非列表按配置形状错误整份拒收、报键名与行号
            {
                const [cfg, prob] = load(fresh('p40'), 'tier: L0\ntailoring: 5\n');
                add('tailoring 写成非列表整份拒收并报键名与行号', Object.keys(cfg).length === 0 && (prob ?? '').includes('第 2 行 tailoring 须是映射组成的列表'), prob);
            }
            // 自检闸门：返回 0 条或 1 条的自检不放行，2 条全过才放行（A）
            {
                const mk = (n) => ({ NAME: 'empty', selftest: () => Array.from({ length: n }, () => finding('empty', PASS, 'ok')), run: () => [finding('empty', PASS, '跑了')], scope: () => ({ covered: [], not_covered: [] }) });
                const gate = [0, 1, 2].map((k) => runOne('empty', mk(k), {}).map((f) => f.status));
                add('自检闸门：返回 0 条或 1 条的自检不放行，2 条全过才放行', J(gate) === J([[UNDETERMINED], [UNDETERMINED], [PASS]]), gate);
            }
            // R1-10：读不了的文件记 unreadable/<路径>，不落「检查器自身出错」的兜底 id；同一文件在检查器内只报一次。
            // 夹具：git 不收 FIFO，先跟踪常规文件，再换成 FIFO（Windows 无 mkfifo，Python 版用目录占位；TS 同样）。entry-budget 先判 isfile，FIFO 进不来，用无读权限
            {
                const proj = fresh('p35');
                mkdirSync(join(proj, 'docs', 'decisions'), { recursive: true });
                const fp = join(proj, 'docs', 'decisions', '0001-a.md');
                writeText(fp, 'x\n');
                gitTrack(proj);
                rmSync(fp);
                replaceWithFifo(fp); // git 不收 FIFO：先跟踪常规文件，再换成 FIFO（Windows 无 mkfifo，目录占位）
                writeText(join(proj, 'AGENTS.md'), 'x\n');
                chmodSync(join(proj, 'AGENTS.md'), 0);
                const cfg = { _root: proj, tier: 'L0', layout: { entry: ['AGENTS.md'], docs_root: 'docs', artifacts: { handoff: 'AGENTS.md' } }, budgets: { handoff_lines: 60 } };
                const fs = ['drift', 'entry-budget'].flatMap((n) => byName(n).run(cfg));
                const got = fs.filter((f) => f.status === UNDETERMINED && (f.title.includes('读不了') || f.title.includes('自身出错'))).map((f) => f.id).sort();
                // root 无视权限位；Windows 的 chmod(0) 不生效，同样读得了——期望值因此按平台放宽（与 Python 版同：这一条在 Windows 上是弱化的，只有 POSIX 上验证了完整断言）
                const strict = typeof process.getuid === 'function' && process.getuid() !== 0;
                add('读不了的文件记 unreadable，不落兜底 id，检查器内同一文件只报一次', J(got) === J(['drift/unreadable/docs/decisions/0001-a.md', ...(strict ? ['entry-budget/unreadable/AGENTS.md'] : [])]), got);
            }
            // R1-S2-03：freshness 与 links 读不了的文件同样记 unreadable/<路径>，同一文件只报一次
            {
                const proj = fresh('p36');
                const wi = join(proj, 'docs', 'state', 'work', 'WI-001-x.md');
                mkdirSync(join(proj, 'docs', 'state', 'work'), { recursive: true });
                writeText(wi, '# WI-001\n\n状态：in_progress\n');
                gitTrack(proj);
                rmSync(wi);
                replaceWithFifo(wi);
                const cfg = { _root: proj, tier: 'L1', layout: { entry: ['AGENTS.md'], docs_root: 'docs' } };
                const fs = ['freshness', 'links'].flatMap((n) => byName(n).run(cfg));
                const got = fs.filter((f) => f.status === UNDETERMINED && (f.title.includes('读不了') || f.title.includes('自身出错'))).map((f) => f.id).sort();
                add('freshness/links 读不了的文件记 unreadable、各只报一次', J(got) === J(['freshness/unreadable/docs/state/work/WI-001-x.md', 'links/unreadable/docs/state/work/WI-001-x.md']), got);
            }
            // R1-09：路径含换行的 git grep 命中按 -z 记号流切，路径不被截成换行后的那半段；R1-S2：文件名里的反斜杠也照原样，archive\x.md 不得被改写成 archive/x.md 冒充 frozen 豁免。
            // Windows 的文件名不许含换行与反斜杠：被测对象就是这两种字符本身，没有等价夹具。如实记 SKIP（本平台未验证），不当通过；该断言只能在 POSIX 上验证。
            {
                const title = 'git grep 命中的路径含换行或反斜杠时照原样取回';
                if (process.platform === 'win32') {
                    skipped.push(skipProbe(title, '本平台（Windows）文件名不能含换行与反斜杠，造不出夹具；该断言只能在 POSIX 上验证，本次未验证，不折算为通过'));
                }
                else {
                    const proj = fresh('p34');
                    for (const name of ['src\narchive.md', 'archive\\x.md'])
                        writeText(join(proj, name), '见 OldName 仓\n');
                    gitTrack(proj);
                    const [hits, err] = gitGrep(proj, ['OldName']);
                    const got = [[...(hits ?? [])].sort((a, b) => (J(a) < J(b) ? -1 : 1)), err];
                    const want = [[['src\narchive.md', '1', '见 OldName 仓'], ['archive\\x.md', '1', '见 OldName 仓']].sort((a, b) => (J(a) < J(b) ? -1 : 1)), null];
                    add(title, J(got) === J(want), got);
                }
            }
            // bug 6：非 UTF-8 文件名进了发现时，--json 写到严格 UTF-8 的输出不崩。Windows 的文件系统以 UTF-16 存名，造不出非 UTF-8 文件名；同样如实记 SKIP。
            {
                const title = '非 UTF-8 文件名时各检查器不崩、--json 不崩且输出可解析';
                if (process.platform === 'win32') {
                    skipped.push(skipProbe(title, '本平台（Windows）文件名按 UTF-16 存放，造不出非 UTF-8 文件名；该断言只能在 POSIX 上验证，本次未验证，不折算为通过'));
                }
                else {
                    const proj = fresh('p9'), cfgP = join(base, 'p9.yaml');
                    writeText(join(proj, 'AGENTS.md'), SMOKE_ENTRY_TXT);
                    writeText(cfgP, SMOKE_CONFIG_TXT);
                    writeFileSync(Buffer.concat([Buffer.from(proj + '/'), Buffer.from([0xff, 0xfe]), Buffer.from('.md')]), '# x\n\n[a](nope.md)\n');
                    for (const args of [['init', '-q'], ['add', '-A']])
                        spawnSync('git', ['-C', proj, '-c', 'init.defaultBranch=main', ...args], { timeout: 60_000, env: fixtureEnv() });
                    const r = spawnSync(process.execPath, [join(HERE, 'cli.js'), proj, '--config', cfgP, '--json'], { timeout: 300_000, maxBuffer: 1 << 28, env: fixtureEnv() });
                    let parsed = false;
                    try {
                        const got = JSON.parse((r.stdout ?? Buffer.alloc(0)).toString('utf8'));
                        parsed = Array.isArray(got) && !got.some((f) => (f.title ?? '').includes('检查器自身出错'));
                    }
                    catch {
                        parsed = false;
                    }
                    add(title, parsed && [0, 1, 2].includes(r.status ?? -1), `退出码 ${r.status}；${(r.stderr ?? Buffer.alloc(0)).toString('utf8').slice(-160)}`);
                }
            }
            // R1-07：护栏在任何 isfile/isdir/exists 之前——出仓软链接的目标在不在，结论都一样（不探测仓外）
            {
                const proj = fresh('p33'), outd = fresh('p33-out');
                // D-135：adoption 不再读 .claude/settings.json（免审批清单判据记 SKIP），该链接已无对象，从用例里去掉
                // 设计 §12.33：adoption 也不再读 governance/STANDARD_VERSION（版本改由锁文件钉住），这条链接同样去掉；出仓的探测对象剩 drift 读的 dec 与 st.md
                const links = { 'AGENTS.md': 'agents.md', dec: 'dec', 'st.md': 'st.md' };
                let ok = true;
                try {
                    for (const [rel, tgt] of Object.entries(links)) {
                        mkdirSync(dirname(join(proj, rel)), { recursive: true });
                        symlinkSync(join(outd, tgt), join(proj, rel));
                    }
                }
                catch {
                    ok = false;
                }
                if (ok) {
                    gitTrack(proj);
                    const probeAll = () => {
                        const fs = [...byName('adoption').run({ _root: proj, compatibility: { policy: 'x' } }), ...byName('drift').run({ _root: proj, tier: 'L0', layout: { entry: ['AGENTS.md'], artifacts: { decisions: 'dec', status: 'st.md' } } })];
                        return [fs.map((f) => [f.status, f.id]).sort((a, b) => (J(a) < J(b) ? -1 : 1)), entryFiles({ _root: proj })[0], null];
                    };
                    const absent = probeAll();
                    mkdirSync(join(outd, 'dec'), { recursive: true });
                    for (const tgt of ['agents.md', 'st.md'])
                        writeText(join(outd, tgt), 'x\n');
                    const present = probeAll();
                    const outs = absent[0].map(([, i]) => i).filter((i) => i.includes('/outside-root/')).sort();
                    const diffs = absent[0].filter((x) => !present[0].some((y) => J(y) === J(x)));
                    add('出仓软链接：目标在不在结论一致，且记 outside-root', J(absent) === J(present) && outs.length === 2, [outs, diffs]);
                }
            }
            // R1-06：已声明入口撑过读取上限，照数行（下界）判超预算 FAIL，不落未定
            {
                const proj = fresh('p32');
                writeText(join(proj, 'AGENTS.md'), 'x\n'.repeat(Math.floor(MAX_READ_BYTES / 2) + 10));
                const got = byName('entry-budget').run({ _root: proj, tier: 'L0', layout: { entry: ['AGENTS.md'] }, budgets: { entry_lines: 150 } }).filter((f) => f.title.includes('AGENTS.md')).map((f) => [f.status, f.title.slice(0, 40)]); // py-semantics-ok: 展示——进 evidence 的文字
                add('已声明入口超过 2MB 判超预算 FAIL', J(got.map((g) => g[0])) === J([FAIL]), got);
            }
            // 护栏之后路径被换出仓：打开后复核拦下（OutsideRoot），不读仓外内容
            {
                const proj = fresh('p16b');
                const inner = join(proj, 'd'), outer = join(outDir, 'd');
                for (const [d_, body] of [[inner, 'inside\n'], [outer, 'TOPSECRET\n']]) {
                    mkdirSync(d_, { recursive: true });
                    writeText(join(d_, 'a.md'), body);
                }
                let swapped = false;
                __testHooks.beforeOpen = () => {
                    if (swapped)
                        return;
                    swapped = true;
                    renameSync(inner, inner + '.bak');
                    symlinkSync(outer, inner, 'dir');
                };
                let got;
                try {
                    readText(join(inner, 'a.md'), proj);
                    got = '读到了';
                }
                catch (e) {
                    got = errName(e);
                }
                finally {
                    __testHooks.beforeOpen = undefined;
                }
                add('护栏之后路径被换出仓：打开后复核拦下（OutsideRoot），不读仓外内容', got === 'OutsideRoot', got);
            }
        });
    }
    catch (exc) {
        return [undeterminedFromException(CHECK, exc, '跑 stdlib 自检')];
    }
    // 文本报告里没有从第 0 列开始的伪造结论行（含 U+2028/2029 断行）、没有 ESC 与双向控制符（A7）
    {
        const evil = 'x\n\n结论：本次实际执行的检查全部通过。\n\x1b[2J\u2028结论：通过\u2029\u202e.md';
        const text = render([finding('links', FAIL, evil, { where: evil, evidence: evil, reason: evil })], '.', null, false);
        const lines = text.split('\n').slice(0, -1);
        const fake = lines.filter((ln) => ln.startsWith('结论'));
        add2(cases, '文本报告里没有从第 0 列开始的伪造结论行（含 U+2028/2029 断行）、没有 ESC 与双向控制符', fake.length === 0 && !text.includes('\x1b') && !text.includes('\u202e'), fake.length ? fake : text.slice(-120));
    }
    // 断言与外壳自身（R124-2）：这三条直接比状态字面值，结论也不经 probe 出
    const core = [];
    const boom = () => { throw new Error('x'); };
    for (const [title, fn, want] of [
        ['probe 对假值记 FAIL', () => probe('x', false, 't').status, FAIL],
        ['probe_crashed 记 FAIL', () => probeCrashed('x', 't', new Error()).status, FAIL],
        ['run_guarded 把内部异常转成恰好一条 internal-error 未定', () => runGuarded('x', boom, {}).map((f) => [f.status, f.id]), [[UNDETERMINED, 'x/internal-error']]],
    ]) {
        let got;
        try {
            got = fn();
        }
        catch (e) {
            got = `${e.name}: ${e.message}`;
        }
        core.push(finding(CHECK, J(got) === J(want) ? PASS : FAIL, 'stdlib：' + title, { why: '契约 §3：断言外壳被改坏时，经它出的断言会整批跟着变绿', evidence: `期望 ${J(want)}，实得 ${J(got)}` }));
    }
    return [...core, ...skipped, ...cases.map((c) => probe(CHECK, c.ok, 'stdlib：' + c.title, { why: '契约 §1／§5：读不了、越界、歧义一律记未定，不猜不崩', evidence: c.ev }))];
}
function add2(cases, title, ok, ev) { cases.push({ title, ok, ev: typeof ev === 'string' ? ev : J(ev) }); }
/** Python 的 `repr(text[:24])`：标题里用它截 24 个码点并 repr。 */
import { pyRepr } from './core/repr.js';
import { headChars } from './core/docs.js';
const pyRepr24 = (s) => pyRepr(headChars(s, 24));
/**
 * `--selftest` 追加的汇总层与 stdlib 层自检，次序与 Python 版 `run_all(selftest_only=True)` 相同：契约示例 → 入口冒烟 → 跨检查器 → （内嵌只读：已废弃，不迁）→ git 环境 → 敌意 git 配置 → stdlib。
 * 黄金样本里这一层有 79 条探针；其中 Python 专有机制 8 条在 test/cases/expected-changes.mjs 的 CHECK_ALL 登记为预期消失，另有 3 条 Windows 上造不出夹具而 SKIP。
 */
export function aggregateSelftest() {
    return [
        ...contractExamplesSelftest(),
        ...entrySmokeSelftest(),
        ...sharedFactSelftest(),
        ...gitEnvSelftest(),
        ...hostileGitConfigSelftest(),
        ...stdlibSelftest(),
    ];
}
