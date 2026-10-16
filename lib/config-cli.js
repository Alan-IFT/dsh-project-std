// Independent read-only parser: no additional flags leak into check/migrate.
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { decodeRaw, invalidReview, reviewText, sha256, TEXT_MAX_BYTES } from './config-governance.js';
import { CONFIG_PATHS, EXCEPTION_PATH } from './config-host.js';
export function parseConfigReviewArgs(argv) {
    const args = { root: '.', candidate: '', target: 'project', json: false };
    const seen = new Set();
    let rootSet = false;
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--json') {
            if (seen.has('--json'))
                return '--json 不得重复';
            seen.add('--json');
            args.json = true;
            continue;
        }
        if (t === '--candidate' || t.startsWith('--candidate=') || t === '--target' || t.startsWith('--target=')) {
            const key = t.split('=')[0];
            if (seen.has(key))
                return `${key} 不得重复`;
            seen.add(key);
            const value = t.includes('=') ? t.slice(t.indexOf('=') + 1) : argv[++i];
            if (value === undefined || !value.trim() || value.startsWith('-'))
                return `${key} 需要非空值`;
            if (key === '--candidate')
                args.candidate = value;
            else if (value === 'project' || value === 'exceptions')
                args.target = value;
            else
                return '--target 只接受 project 或 exceptions';
            continue;
        }
        if (t.startsWith('-'))
            return `不认识的参数：${t}`;
        if (!t.trim() || rootSet)
            return `多余或空的位置参数：${t}`;
        rootSet = true;
        args.root = t;
    }
    return args.candidate ? args : '必须指定 --candidate PATH（允许根外的显式只读候选）';
}
function statOptional(path) {
    try {
        return lstatSync(path, { bigint: true });
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return undefined;
        throw e;
    }
}
/** Check every existing ancestor before opening. CLI never follows hidden links outside root. */
function ordinaryParents(path, allowAbsent) {
    const absolute = resolve(path), root = parse(absolute).root;
    let current = root;
    for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
        current = join(current, part);
        const st = statOptional(current);
        if (!st) {
            if (allowAbsent)
                return;
            throw new Error(`路径不存在：${current}`);
        }
        if (st.isSymbolicLink())
            throw new Error(`不跟随符号链接：${current}`);
        if (current !== absolute && !st.isDirectory())
            throw new Error(`父路径不是普通目录：${current}`);
    }
}
const version = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
function boundedFile(path) {
    ordinaryParents(path, false);
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
        throw new Error('候选／基线须是普通文件');
    if (before.size > BigInt(TEXT_MAX_BYTES))
        throw new Error('文件超过 32768 字节');
    const fd = openSync(path, 'r');
    try {
        const first = fstatSync(fd, { bigint: true });
        const bytes = Buffer.alloc(TEXT_MAX_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, null);
            if (!count)
                break;
            length += count;
        }
        const last = fstatSync(fd, { bigint: true }), after = lstatSync(path, { bigint: true });
        if (!first.isFile() || version(before) !== version(first) || version(first) !== version(last) || version(first) !== version(after))
            throw new Error('文件读取期间发生变化');
        const raw = bytes.subarray(0, length);
        return { text: decodeRaw(raw), hash: sha256(raw) };
    }
    finally {
        closeSync(fd);
    }
}
export function renderConfigReview(r) {
    const lines = [`配置审阅：${r.valid ? 'valid' : 'invalid'}`, `target=${r.target}`, `before=${r.beforeSha256 ?? '(missing)'}`, `after=${r.afterSha256}`, `needsApproval=${r.needsApproval}（不是批准）`];
    if (r.problem)
        lines.push(`problem=${r.problem}`);
    for (const c of r.changes)
        lines.push(`${c.path || '(root)'}: ${c.direction} — ${c.reason}`, `  before=${JSON.stringify(c.before)}`, `  after=${JSON.stringify(c.after)}`);
    return lines.join('\n');
}
export function runConfigReview(argv, io) {
    const args = parseConfigReviewArgs(argv);
    if (typeof args === 'string') {
        io.err(`std-check config-review: ${args}`);
        return 2;
    }
    try {
        const root = resolve(args.root);
        ordinaryParents(root, false);
        if (!lstatSync(root).isDirectory())
            throw new Error('root 须是普通目录');
        const canonicalRoot = realpathSync(root);
        ordinaryParents(join(root, 'governance'), true);
        const gov = statOptional(join(root, 'governance'));
        if (gov && !gov.isDirectory())
            throw new Error('governance 须是普通目录');
        const candidates = CONFIG_PATHS.map(p => ({ path: join(root, p), stat: statOptional(join(root, p)) }));
        const candidate = boundedFile(resolve(args.candidate)); // Explicitly authorized read-only path, may be outside root.
        let result;
        if (candidates.filter(e => e.stat !== undefined).length > 1)
            result = invalidReview(args.target, candidate.text, null, '两个默认配置候选并存（包括链接／目录占位），不自行消歧');
        else {
            const path = args.target === 'project' ? (candidates.find(e => e.stat !== undefined)?.path ?? candidates[0].path) : join(root, EXCEPTION_PATH);
            ordinaryParents(path, true);
            const st = statOptional(path);
            let before = null;
            if (st) {
                const rel = relative(canonicalRoot, realpathSync(path));
                if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
                    throw new Error('基线越出项目根');
                before = boundedFile(path);
            }
            result = reviewText(args.target, candidate.text, before?.text ?? null, before?.hash ?? null);
        }
        io.out(args.json ? JSON.stringify(result, null, 2) : renderConfigReview(result));
        return result.valid ? 0 : 2;
    }
    catch (e) {
        io.err(`std-check config-review: ${e.name}: ${e.message}`);
        return 2;
    }
}
