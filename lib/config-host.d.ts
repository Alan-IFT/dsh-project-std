import type { ToolExecution } from '@deepseek-ai/dsh-tools';
export interface FsTarget {
    readonly targetKey: string;
    readonly displayPath: string;
}
export interface FsStat {
    type: 'file' | 'directory' | 'other';
    version: string;
    size: number;
}
export interface FsLstat extends Omit<FsStat, 'type'> {
    type: FsStat['type'] | 'symlink';
}
export interface GovernanceFs {
    resolve(path: string, options: {
        cwd: string;
        signal: AbortSignal;
    }): Promise<FsTarget>;
    stat(target: FsTarget, signal: AbortSignal): Promise<FsStat | undefined>;
    lstat(path: string, options: {
        cwd: string;
        signal: AbortSignal;
    }, signal: AbortSignal): Promise<FsLstat | undefined>;
    contains(parent: FsTarget, target: FsTarget): boolean;
    readBytes(target: FsTarget, signal: AbortSignal, maxBytes: number): Promise<Uint8Array>;
    writeText(target: FsTarget, content: string, expected: {
        kind: 'replaceIfVersion';
        version: string;
    } | {
        kind: 'createIfAbsent';
    }, signal: AbortSignal, policy?: unknown): Promise<{
        version: string;
    }>;
    readonly sandboxMode?: string;
}
export interface Entry {
    path: string;
    target: FsTarget;
    stat: FsLstat | null;
    text: string | null;
    hash: string | null;
    problem: string | null;
}
export interface Snapshot {
    cwd: string;
    root: FsTarget;
    rootStat: FsLstat;
    governance: FsTarget;
    governanceStat: FsLstat | null;
    candidates: Entry[];
    exceptions: Entry;
}
export declare const CONFIG_PATHS: readonly ['governance/project.yaml', 'governance/project.yml'];
export declare const EXCEPTION_PATH = "governance/exceptions.md";
export declare function cwdOf(exec: Pick<ToolExecution, 'agent'>): string;
export declare function absoluteRoot(cwd: string): boolean;
export declare function checked<T>(signal: AbortSignal, p: Promise<T>): Promise<T>;
export declare function snapshot(fs: GovernanceFs, exec: ToolExecution): Promise<Snapshot>;
export declare const conflict: (s: Snapshot) => boolean;
export declare const projectEntry: (s: Snapshot) => Entry;
/** Compare identity tokens, not reconstructed paths; target keys and versions remain opaque. */
export declare function snapshotDrift(a: Snapshot, b: Snapshot): null | 'managed' | 'parent';
export declare function artifacts(fs: GovernanceFs, s: Snapshot, signal: AbortSignal): Promise<Array<{
    path: string;
    sources: string[];
    exists: boolean;
    type: string | null;
    problem: string | null;
}>>;
export declare function lexicalManaged(cwd: string, path: string): boolean;
