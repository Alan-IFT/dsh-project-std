import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-project-std/config";
export declare const inject: string[];
export interface ConfigPluginOptions {
    enabled: boolean;
    protectNativeEdits: boolean;
}
export declare function validateConfig(value?: unknown): ConfigPluginOptions;
/**
 * 宿主 schema 是可选模块：任何不可用情形（缺失、解析或加载失败、形状不符）都省略挂载期 schema。
 * 导入期抛错会让整个 /config 条目无法激活，而安全判定不依赖它——apply 内无条件校验。
 * 它是可选能力、不保证在位（可能由别的插件带来，也可能一个都没有），所以只能动态探测；
 * 而运行时服务包（如 dsh-tools）在真机 profile 的 node_modules 里并不存在，静态导入会让条目直接导入失败。
 */
export declare function buildConfig(require?: NodeJS.Require): unknown;
export declare const Config: unknown;
export declare function apply(ctx: Context, raw?: unknown): void;
