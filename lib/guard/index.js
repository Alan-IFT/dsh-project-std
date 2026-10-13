// 最小显式项目路径层；不解析 Shell/Git，不承担宿主权限或通用风险判定。
import { createRequire } from 'node:module';
import { decide, validateConfig } from './policy.js';
export const name = 'dsh-project-std';
export const inject = [];
// schema 是宿主提供的可选模块；无 schema 时 apply 仍严格校验。
function buildConfig() {
    let module;
    try {
        module = createRequire(import.meta.url)('@deepseek-ai/schemastery');
    }
    catch {
        return undefined;
    }
    const Schema = module?.default ?? module;
    if (typeof Schema?.any !== 'function' || typeof Schema?.transform !== 'function')
        return undefined;
    // 不先 object 投影：legacy/未知键必须完整到达同一校验器。
    return Schema.transform(Schema.any(), validateConfig);
}
export const Config = buildConfig();
export function apply(ctx, rawConfig) {
    const config = validateConfig(rawConfig);
    if (!config.enabled)
        return;
    ctx.on('tools/pre-execute', async (exec, next) => {
        const downstream = await next();
        if (downstream.kind !== 'allow')
            return downstream;
        const verdict = decide(exec, config);
        return verdict.kind === 'ask' ? verdict : downstream;
    });
}
