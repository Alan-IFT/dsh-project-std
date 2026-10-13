export type Verdict = {
    kind: 'allow';
} | {
    kind: 'ask';
    reason: string;
};
export interface ProjectPolicy {
    readonly root: string;
    readonly protect: readonly string[];
}
export interface GuardConfig {
    readonly enabled: boolean;
    readonly policyVersion: 2;
    readonly projects: readonly ProjectPolicy[];
}
export interface ToolCall {
    name?: unknown;
    arguments?: unknown;
    agent?: {
        session?: {
            header?: {
                cwd?: unknown;
            };
        };
    };
}
export declare function normalizeForCompare(value: string, platform?: NodeJS.Platform): string;
/** schema 与 apply 共用完整输入；旧配置和错误规则明确报错，不自动升级或丢项。 */
export declare function validateConfig(raw: unknown, platform?: NodeJS.Platform): GuardConfig;
/** 只消费已校验配置和已知 native write/edit；相对目标严格按会话 cwd 解析。 */
export declare function decide(exec: ToolCall, config: GuardConfig, platform?: NodeJS.Platform): Verdict;
