import { type CalDate } from './dates.js';
export declare const EXCEPTIONS_FILE = "exceptions.md";
/** 检查器自身出错的 Finding id 的 kind 段（`<检查器>/internal-error`）。登记它等于登记被顶掉的 FAIL，按不合格行处置（契约 §9）。 */
export declare const INTERNAL_ERROR_KIND = "internal-error";
/** 登记到期的上限：运行日起一年（契约 §9）。更远的到期等于长期静音，按不合格行处置。 */
export declare const EXCEPTION_MAX_DAYS = 365;
type ExField = 'ex_id' | 'rule' | 'reason' | 'scope' | 'approver' | 'expires' | 'status';
/** Python 的 `str.lower()` 在本模块输入上与 JS 的 `toLowerCase()` 一致（关闭词与表头词都是 ASCII 或中文；对带 Kelvin 符号等极端输入的差异见 §12.6 D5 同类：不复现）。 */
declare function exClosed(status: string): boolean;
export { exClosed as _exClosed };
/** 拆一行 markdown 表格的单元格。`\|` 是转义的竖线，不拆。 */
export declare function mdCells(line: string): string[];
/** 第一张 markdown 表。返回 [表头行号, 表头单元格, [[行号, 单元格], ...]] 或 null。 */
export declare function firstMdTable(text: string): [number, string[], Array<[number, string[]]>] | null;
export declare function exField(headerCell: string): ExField | null;
export interface ExRow {
    ex_id: string;
    rule: string;
    reason: string;
    scope: string;
    approver: string;
    expires: string;
    expires_date: CalDate;
    status: string;
    lineno: number;
}
/** 项目自有例外行（规则不含 `/`）：只取到期；`expires_date` 解析不了时为 null。 */
export interface OwnRow {
    ex_id: string;
    rule: string;
    expires: string;
    expires_date: CalDate | null;
    error: string | null;
    lineno: number;
}
export type ExceptionsResult = [rows: ExRow[], problems: string[], sourcePath: string | null, own: OwnRow[]];
/**
 * 读例外登记册：配置文件**同目录**的 `exceptions.md`（契约 §9）。不带 `--config` 时就是 `<项目根>/governance/exceptions.md`。
 *
 * 返回 `[rows, problems, sourcePath, own]`：
 * - rows：本工具认领且五项齐全的登记行（规则含 `/`，即 Finding id 的形态）。
 * - problems：本工具认领但不合格的行（行号 + 缺什么；到期晚于 today + 一年、或规则是检查器自身出错 `<检查器>/internal-error` 的，同样不合格）。today 缺省取运行日。
 * - sourcePath：文件路径；文件不存在时为 null。
 * - own：未关闭的项目自有例外行（规则不含 `/`），只取到期。02 §4「到期未清理 CI 转红」对它们同样成立，到期由调用方按运行日判。
 */
export declare function loadExceptions(configDir: string, root?: string | null, today?: CalDate): ExceptionsResult;
/** 纯文本入口；复用登记册原有第一表、关闭优先、项目自有行和到期校验，不做文件访问。 */
export declare function parseExceptionsText(text: string, today?: CalDate, path?: string | null): ExceptionsResult;
