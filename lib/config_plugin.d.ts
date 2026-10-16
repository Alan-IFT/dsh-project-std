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
 * 已安装插件的 node_modules 里没有宿主包，因此这里只能用 createRequire 动态探测，不能静态导入；与 guard 入口同一取舍。
 */
export declare function buildConfig(require?: NodeJS.Require): unknown;
export declare const Config: unknown;
export declare function apply(ctx: Context, raw?: unknown): void;
