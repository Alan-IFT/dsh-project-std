// Structural seam matching the installed dsh-fs contract; no Node filesystem fallback.
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { decodeRaw, sha256, TEXT_MAX_BYTES } from './config-governance.js';
import { validateConfigText } from './core/config.js';
import { parseBody } from './config-governance.js';
import { DEFAULT_DOCS_ROOT, DEFAULT_WORK_ROOT, ENTRY_CANDIDATES, STATUS_CANDIDATES, HANDOFF_CANDIDATES } from './core/docs.js';
export const CONFIG_PATHS = ['governance/project.yaml', 'governance/project.yml'];
export const EXCEPTION_PATH = 'governance/exceptions.md';
export function cwdOf(exec) {
    const cwd = exec.agent?.session?.header?.cwd;
    if (!exec.agent || typeof cwd !== 'string' || !absoluteRoot(cwd))
        throw new Error('必须有当前 agent/session 的完全限定绝对 cwd；不接受 root 参数');
    return cwd;
}
export function absoluteRoot(cwd) {
    return isAbsolute(cwd) && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(cwd));
}
export async function checked(signal, p) { const value = await p; signal.throwIfAborted(); return value; }
const sameStat = (a, b) => a == null || b == null ? a == null && b == null : a.type === b.type && a.version === b.version && a.size === b.size;
export async function snapshot(fs, exec) {
    exec.signal.throwIfAborted();
    const cwd = cwdOf(exec), opts = { cwd, signal: exec.signal }, signal = exec.signal;
    const rootStat = await checked(signal, fs.lstat(cwd, opts, signal));
    if (rootStat?.type !== 'directory')
        throw new Error('session cwd 必须是普通目录，不能是链接');
    const root = await checked(signal, fs.resolve(cwd, opts));
    const governanceStat = await checked(signal, fs.lstat(join(cwd, 'governance'), opts, signal));
    if (governanceStat && governanceStat.type !== 'directory')
        throw new Error('governance 必须是普通目录，不能是链接');
    const governance = await checked(signal, fs.resolve(join(cwd, 'governance'), opts));
    if (!fs.contains(root, governance))
        throw new Error('governance 越出项目根');
    async function entry(path) {
        const full = join(cwd, path);
        const st = await checked(signal, fs.lstat(full, opts, signal));
        const target = await checked(signal, fs.resolve(full, opts));
        const result = { path, target, stat: st ?? null, text: null, hash: null, problem: null };
        if (!fs.contains(root, target) || !fs.contains(governance, target)) {
            result.problem = '目标越出受管目录';
            return result;
        }
        if (!st)
            return result;
        if (st.type !== 'file') {
            result.problem = '目标不是普通文件（链接／目录／其它占位）';
            return result;
        }
        if (st.size > TEXT_MAX_BYTES) {
            result.problem = '文件超过 UTF-8 字节上限';
            return result;
        }
        const first = await checked(signal, fs.stat(target, signal));
        if (!sameStat(st, first) || first?.type !== 'file')
            throw new Error(`${path} 身份变化`);
        const bytes = await checked(signal, fs.readBytes(target, signal, TEXT_MAX_BYTES));
        const second = await checked(signal, fs.stat(target, signal));
        const last = await checked(signal, fs.lstat(full, opts, signal));
        if (!sameStat(first, second) || !sameStat(first, last))
            throw new Error(`${path} 读取期间变化`);
        result.hash = sha256(bytes);
        try {
            result.text = decodeRaw(bytes);
        }
        catch (e) {
            result.problem = e.message;
        }
        return result;
    }
    // Probe both candidates for either target. A directory/link is present, not absent.
    const candidates = [];
    for (const path of CONFIG_PATHS)
        candidates.push(await entry(path));
    const exceptions = await entry(EXCEPTION_PATH);
    return { cwd, root, rootStat, governance, governanceStat: governanceStat ?? null, candidates, exceptions };
}
export const conflict = (s) => s.candidates.filter(e => e.stat !== null).length > 1;
export const projectEntry = (s) => s.candidates.find(e => e.stat !== null) ?? s.candidates[0];
/** Compare identity tokens, not reconstructed paths; target keys and versions remain opaque. */
export function snapshotDrift(a, b) {
    // Directories (cwd/root/governance): identity + type only; unrelated sibling churn changes their version/size.
    const parent = (s) => [s.cwd, s.root.targetKey, s.rootStat.type, s.governance.targetKey, s.governanceStat?.type ?? null];
    if (JSON.stringify(parent(a)) !== JSON.stringify(parent(b)))
        return 'parent';
    // The three managed files keep full existence/type/version/size/raw-hash/problem comparison.
    const entry = (e) => [e.path, e.target.targetKey, e.stat, e.hash, e.problem];
    const managed = (s) => [s.candidates.map(entry), entry(s.exceptions)];
    return JSON.stringify(managed(a)) === JSON.stringify(managed(b)) ? null : 'managed';
}
export async function artifacts(fs, s, signal) {
    const paths = new Map();
    const add = (path, source) => {
        if (typeof path !== 'string' || !path.trim())
            return;
        const rel = path.replaceAll('\\', '/');
        if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || rel.split('/').some(p => p === '..' || p === ''))
            return;
        const sources = paths.get(rel) ?? [];
        sources.push(source);
        paths.set(rel, sources);
    };
    for (const [candidates, role] of [[ENTRY_CANDIDATES, 'entry'], [STATUS_CANDIDATES, 'status'], [HANDOFF_CANDIDATES, 'handoff'], [[DEFAULT_DOCS_ROOT], 'docs_root'], [[DEFAULT_WORK_ROOT], 'work_root']])
        for (const p of candidates)
            add(p, `default:${role}`);
    if (!conflict(s)) {
        const text = projectEntry(s).text;
        if (text !== null) {
            const [cfg, problem] = validateConfigText(parseBody(text));
            if (!problem) {
                const layout = cfg.layout;
                if (layout && typeof layout === 'object' && !Array.isArray(layout)) {
                    const l = layout;
                    for (const key of ['entry', 'docs_root', 'work_root'])
                        for (const p of Array.isArray(l[key]) ? l[key] : [l[key]])
                            add(p, `declared:layout.${key}`);
                    const arts = l.artifacts;
                    if (arts && typeof arts === 'object' && !Array.isArray(arts))
                        for (const [role, value] of Object.entries(arts))
                            for (const p of Array.isArray(value) ? value : [value])
                                add(p, `declared:layout.artifacts.${role}`);
                }
            }
        }
    }
    const result = [];
    for (const [path, sources] of paths) {
        const opts = { cwd: s.cwd, signal };
        let st, problem = null;
        // Content-free bounded path probes only; never follow a link in any segment.
        let prefix = s.cwd;
        for (const part of path.split('/')) {
            prefix = join(prefix, part);
            st = await checked(signal, fs.lstat(prefix, opts, signal));
            if (!st)
                break;
            if (st.type === 'symlink' || st.type === 'other') {
                problem = '链接或特殊对象未跟随';
                break;
            }
            const resolved = await checked(signal, fs.resolve(prefix, opts));
            if (!fs.contains(s.root, resolved)) {
                problem = '越出项目根，未读取';
                break;
            }
        }
        result.push({ path, sources, exists: st !== undefined, type: st?.type ?? null, problem });
    }
    return result;
}
export function lexicalManaged(cwd, path) {
    const rel = relative(cwd, resolve(cwd, path));
    const normalize = (s) => process.platform === 'win32' ? s.toLowerCase() : s;
    return [...CONFIG_PATHS, EXCEPTION_PATH].some(p => normalize(p.split('/').join(sep)) === normalize(rel));
}
