import { type Config } from './cfg.js';
export declare const CONFIG_CANDIDATES: readonly ['governance/project.yaml', 'governance/project.yml'];
type Problem = string;
/** metadata_required 列表拆成（包含前缀, 排除前缀）；`!` 起头的是排除（D-133）。只做写法归一（`\` 改 `/`，开头的 `./` 去掉），不校验。 */
export declare function metadataPrefixes(v: readonly unknown[]): [string[], string[]];
/** rel 是否在项目声明的 metadata_required 之内；全仓只此一处判定（D-133）。未配（不是列表）返回 null。 */
export declare function metadataRequiredHit(cfg: Config, rel: string): boolean | null;
/** 读并解析一份配置。返回 [cfg, problem]；报错只给路径与行号，不回显文件内容。 */
export declare function validateConfigText(text: string, shown?: string): [Config, Problem | null];
/**
 * 读配置。默认读 <root>/governance/project.yaml。
 * configPath 给了就读那个文件，可以在被扫描项目之外——这样才能在不往被测项目写任何东西的前提下扫只读项目。
 * 此时 cfg._root 仍是被扫描的 root，cfg._path 记配置文件的绝对路径。
 *
 * 返回 [cfg, problem]。problem 非 null 时 cfg 为 {}，调用方据此记未定，不得取默认值当事实（契约 §5）。
 */
export declare function loadConfig(root: string, configPath?: string | null): [Config, Problem | null];
export {};
