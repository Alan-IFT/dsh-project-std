import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { assertText, invalidReview, REASON_MAX_BYTES, reviewText } from './config-governance.js';
import { artifacts, checked, conflict, CONFIG_PATHS, cwdOf, EXCEPTION_PATH, lexicalManaged, projectEntry, snapshot, snapshotDrift } from './config-host.js';
export const name = 'dsh-project-std/config';
export const inject = ['tools', 'fs'];
export function validateConfig(value) {
    if (value === undefined || value === null)
        return { enabled: true, protectNativeEdits: false };
    if (typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Error('config 插件配置须是普通映射');
    const raw = value;
    for (const key of Object.keys(raw))
        if (!['enabled', 'protectNativeEdits'].includes(key))
            throw new Error(`未知 config 插件配置键：${key}`);
    for (const key of ['enabled', 'protectNativeEdits'])
        if (Object.hasOwn(raw, key) && typeof raw[key] !== 'boolean')
            throw new Error(`${key} 必须是布尔值`);
    return { enabled: raw.enabled === undefined ? true : raw.enabled, protectNativeEdits: raw.protectNativeEdits === undefined ? false : raw.protectNativeEdits };
}
/**
 * 宿主 schema 是可选模块：任何不可用情形（缺失、解析或加载失败、形状不符）都省略挂载期 schema。
 * 导入期抛错会让整个 /config 条目无法激活，而安全判定不依赖它——apply 内无条件校验。
 * 已安装插件的 node_modules 里没有宿主包，因此这里只能用 createRequire 动态探测，不能静态导入；与 guard 入口同一取舍。
 */
export function buildConfig(require = createRequire(import.meta.url)) {
    try {
        require.resolve('@deepseek-ai/schemastery');
        const module = require('@deepseek-ai/schemastery');
        const Schema = module?.default ?? module;
        if (typeof Schema?.any !== 'function' || typeof Schema?.transform !== 'function')
            return undefined;
        return Schema.transform(Schema.any(), validateConfig);
    }
    catch {
        return undefined;
    }
}
export const Config = buildConfig();
const services = (ctx) => ctx;
function get(ctx, key) { return services(ctx).get(key); }
/**
 * 模型侧参数 JSON Schema：宿主 defineTool 编译出的就是这个形状（隐式开放根，不写 additionalProperties）。
 * 参数从严拒收由 execute 内的 argsOf 承担。
 */
const PARAMETERS = {
    type: 'object',
    properties: {
        action: { type: 'string', enum: ['inspect', 'review', 'apply'], description: 'inspect 只读事实；review 只读审阅；apply 受控写入' },
        target: { type: 'string', enum: ['project', 'exceptions'], description: '默认 project' },
        content: { type: 'string', description: 'review／apply 的完整替换原文' },
        before_sha256: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'apply 必填；缺文件用 null' },
        after_sha256: { type: 'string', description: 'apply 必填，取自 review 返回' },
    },
    required: ['action'],
};
function argsOf(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('参数须是对象');
    const a = raw;
    for (const k of Object.keys(a))
        if (!Object.hasOwn(PARAMETERS.properties, k))
            throw new Error(`不支持参数 ${k}；root／批准／权限不能由模型指定`);
    if (a.action !== 'inspect' && a.action !== 'review' && a.action !== 'apply')
        throw new Error('未知 action');
    if (a.target !== undefined && a.target !== 'project' && a.target !== 'exceptions')
        throw new Error('未知 target');
    if (a.action === 'inspect' && ['content', 'before_sha256', 'after_sha256'].some(k => Object.hasOwn(a, k)))
        throw new Error('inspect 不接受提案或 hash');
    if (a.action !== 'inspect' && typeof a.content !== 'string')
        throw new Error('review/apply 必须有 content 原文');
    if (a.action === 'review' && ['before_sha256', 'after_sha256'].some(k => Object.hasOwn(a, k)))
        throw new Error('review 的 hash 由工具计算');
    if (a.action === 'apply') {
        if (!Object.hasOwn(a, 'before_sha256') || !(a.before_sha256 === null || typeof a.before_sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.before_sha256)))
            throw new Error('apply 必须显式提供 before_sha256 字符串或 null');
        if (typeof a.after_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.after_sha256))
            throw new Error('apply 必须有 after_sha256');
    }
    return { action: a.action, target: (a.target ?? 'project'), content: a.content, before: a.before_sha256, after: a.after_sha256 };
}
function jsonObject(value) { return JSON.parse(JSON.stringify(value)); }
export function apply(ctx, raw) {
    const opts = validateConfig(raw);
    if (!opts.enabled)
        return;
    const fs = get(ctx, 'fs');
    if (!fs || ['resolve', 'stat', 'lstat', 'contains', 'readBytes', 'writeText'].some(k => typeof fs[k] !== 'function'))
        throw new Error('config 缺必需 fs 服务／契约');
    if (!ctx.tools || typeof ctx.tools.register !== 'function')
        throw new Error('config 缺必需 tools 服务');
    // 注册就绪的定义由本模块直接产出：宿主的 defineTool 属于宿主包，已安装插件无法解析它。
    // 参数校验由 execute 内的 argsOf 承担（宿主 register 只校验 output.schema 与 render）。
    const definition = {
        name: 'std_config', description: 'Inspect governance facts, review proposed content, or apply one validated file using current session authority. No root/approved/permission parameters.',
        parameters: PARAMETERS,
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        async execute(rawArgs, exec) {
            const args = argsOf(rawArgs);
            const { action, target } = args;
            // Capture scalar proposal once. Never re-read mutable args or an external candidate path.
            const content = args.content;
            if (content !== undefined)
                assertText(content);
            const session = exec.agent?.session;
            const initial = await snapshot(fs, exec);
            const current = target === 'project' ? projectEntry(initial) : initial.exceptions;
            const isConflict = conflict(initial);
            if (action === 'inspect') {
                const files = [...initial.candidates, initial.exceptions].map(e => ({ path: e.path, exists: e.stat !== null, type: e.stat?.type ?? null, content: e.text, sha256: e.hash, problem: e.problem, validation: e.text === null ? null : reviewText(e.path === EXCEPTION_PATH ? 'exceptions' : 'project', e.text, e.text, e.hash) }));
                return jsonObject({ root: initial.cwd, target, conflict: isConflict, governanceExists: initial.governanceStat !== null, files, artifacts: await artifacts(fs, initial, exec.signal), note: '候选存在不等于角色确认；只探测有限路径，不读工件正文、不运行脚本' });
            }
            let review;
            if (isConflict)
                review = invalidReview(target, content, current.hash, '两个默认配置候选并存（包括非文件占位），拒绝自行消歧');
            else if (current.problem)
                review = invalidReview(target, content, current.hash, current.problem);
            else
                review = reviewText(target, content, current.text, current.hash);
            if (action === 'review')
                return jsonObject({ ...review, root: initial.cwd, path: current.path, conflict: isConflict });
            if (!initial.governanceStat)
                throw new Error('apply 不创建 governance 父目录；请先由项目维护方准备普通目录');
            if (!review.valid)
                throw new Error(review.problem);
            if (args.before !== review.beforeSha256 || args.after !== review.afterSha256)
                throw new Error('提案 before/after SHA 与当前审阅不匹配');
            if (review.needsApproval) {
                const approval = get(ctx, 'approval');
                if (!approval || typeof approval.request !== 'function')
                    throw new Error('需要审批但 approval 服务不可用');
                const reason = JSON.stringify({ root: initial.cwd, path: current.path, target, before_sha256: review.beforeSha256, after_sha256: review.afterSha256, changes: review.changes }, null, 2);
                if (Buffer.byteLength(reason, 'utf8') > REASON_MAX_BYTES)
                    throw new Error('完整审批 reason 超过 131072 UTF-8 字节；不截断送审');
                const decision = await checked(exec.signal, approval.request({ agent: exec.agent, toolName: 'std_config', callId: exec.callId, reason, signal: exec.signal }));
                if (decision !== 'allowed-once')
                    throw new Error('审批未获得 allowed-once，未写入');
            }
            const final = await snapshot(fs, exec);
            if (exec.agent?.session !== session)
                throw new Error('审阅后 session 发生变化，停止而不重试');
            const drift = snapshotDrift(initial, final);
            if (drift === 'managed')
                throw new Error('审阅后受管配置／例外目标的存在性、类型、版本或原字节发生漂移，停止而不重试');
            if (drift === 'parent')
                throw new Error('审阅后 cwd／root／governance 的身份或类型发生变化，停止而不重试');
            const policyService = get(ctx, 'sandboxPolicy');
            if (fs.sandboxMode !== undefined && (!policyService || typeof policyService.resolve !== 'function'))
                throw new Error('fs 声明有沙箱但 sandboxPolicy 服务不可用');
            const policy = policyService ? await checked(exec.signal, Promise.resolve(policyService.resolve({ session: exec.agent.session }))) : undefined;
            if (fs.sandboxMode !== undefined && policy == null)
                throw new Error('当前 session 沙箱策略不可用');
            exec.signal.throwIfAborted();
            if (exec.agent?.session !== session || cwdOf(exec) !== initial.cwd)
                throw new Error('写入前 session／cwd 漂移');
            const expected = current.stat === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: current.stat.version };
            // Bare await: a committed write is reported as committed even if abort lands afterwards (host write-tool semantics).
            const outcome = await fs.writeText(current.target, content, expected, exec.signal, policy);
            // No speculative observed events: only the actual committed outcome version.
            services(ctx).emit('fs/observed', current.target, { kind: 'present', version: outcome.version }, exec);
            return jsonObject({ applied: true, root: initial.cwd, path: current.path, sha256: review.afterSha256, version: outcome.version, review });
        },
    };
    ctx.tools.register(definition);
    if (opts.protectNativeEdits)
        ctx.on('tools/pre-execute', async (exec, next) => {
            const downstream = await next();
            if (downstream.kind !== 'allow')
                return downstream;
            if (!['write', 'edit', 'str_replace_editor'].includes(exec.name))
                return downstream;
            if (!exec.arguments || typeof exec.arguments !== 'object' || Array.isArray(exec.arguments))
                return downstream;
            const a = exec.arguments;
            // Blacklist of the only confirmed read-only command: unknown/missing commands are treated as mutating.
            if (exec.name === 'str_replace_editor' && a.command === 'view')
                return downstream;
            const path = exec.name === 'str_replace_editor' ? a.path : a.file_path;
            if (typeof path !== 'string' || !path.trim())
                return downstream;
            let cwd;
            try {
                cwd = cwdOf(exec);
            }
            catch {
                return downstream;
            }
            let managed = lexicalManaged(cwd, path);
            if (!managed) {
                // Host-only canonical alias detection. Do not read arbitrary paths or manufacture keys.
                try {
                    const options = { cwd, signal: exec.signal };
                    const root = await checked(exec.signal, fs.resolve(cwd, options));
                    const actual = await checked(exec.signal, fs.resolve(resolve(cwd, path), options));
                    if (fs.contains(root, actual))
                        for (const rel of [...CONFIG_PATHS, EXCEPTION_PATH]) {
                            const known = await checked(exec.signal, fs.resolve(resolve(cwd, rel), options));
                            if (known.targetKey === actual.targetKey) {
                                managed = true;
                                break;
                            }
                        }
                }
                catch {
                    exec.signal.throwIfAborted();
                    return downstream;
                }
            }
            return managed ? { kind: 'deny', reason: '此项目治理文件启用了原生编辑保护。正常维护须从一开始使用 std_config；本次已拒，禁止自动换工具重试。' } : downstream;
        });
}
