import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-project-std/config";
export declare const inject: string[];
export interface ConfigPluginOptions {
    enabled: boolean;
    protectNativeEdits: boolean;
}
export declare function validateConfig(value?: unknown): ConfigPluginOptions;
/** Only an unresolvable schemastery falls back (apply() still validates); a resolvable but broken package surfaces its load error. */
export declare function buildConfig(require?: NodeJS.Require): unknown;
export declare const Config: unknown;
export declare function apply(ctx: Context, raw?: unknown): void;
