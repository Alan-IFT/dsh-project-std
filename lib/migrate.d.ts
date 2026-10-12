export type StepKind = 'deterministic' | 'judgement';
export type Hit = [string, number, string];
export interface Step {
    id: string;
    kind: StepKind;
    title: string;
    commands?: string[];
    hits?: Hit[];
    advice?: string;
    verify: string;
    rollback: string;
    blocked?: string;
    /** 无 blocked 不代表可立即执行，尤其删除必须满足这些条件。 */
    prerequisites?: string[];
}
export type Category = 'execution' | 'documentation' | 'retained' | 'review';
export interface Candidate {
    path: string;
    category: Category;
    reason: string;
    evidence: Hit[];
    tracked: boolean;
    executionShape: boolean;
}
export interface Issue {
    stage: 'inventory' | 'config' | 'read' | 'hooks';
    path: string;
    reason: string;
}
export interface Plan {
    root: string;
    facts: Record<string, string | boolean | number | null>;
    steps: Step[];
    coverage: {
        inventory: 'complete' | 'failed';
        config: 'loaded' | 'unknown';
        trackedFiles: number | null;
        readFiles: number;
        excludedStd: number;
        binaryFiles: string[];
        supplementaryHooks: string[];
        scope: string;
        total: number;
        omitted: number;
        omittedLocations: Array<{
            path: string;
            total: number;
            omitted: number;
        }>;
    };
    issues: Issue[];
    candidates: Candidate[];
    warning?: string;
    notApplicable?: string;
}
export type HookKind = 'githooks-script' | 'precommit-framework' | 'custom-hooks-dir' | 'unknown' | 'none';
declare function grepLines(text: string, re: RegExp): Array<[number, string]>;
export declare function findHooks(root: string): Array<{
    kind: HookKind;
    path: string;
}>;
/** 一次索引枚举；配置路径由 main 转发，外部配置仅按显式授权读取。 */
export declare function plan(root: string, installed?: boolean | {
    ok: false;
    why: string;
}, configPath?: string | null): Plan;
export declare function renderPlan(p: Plan): string;
export declare const _internal: {
    grepLines: typeof grepLines;
};
export {};
