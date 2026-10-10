// UTF-8 校验：给出首个**无效序列**的完整诊断（起点、终点、原因）。Node 的 TextDecoder fatal 模式只抛「数据无效」，什么都不给；
// Python 的 UnicodeDecodeError 给 start/end/reason，而两处报错信息要用它们：配置读取写「第 N 字节起解不开」，例外登记册读不了时把 Python 的整句异常文本带进 finding 的 reason。
//
// 规则对着 Unicode 标准 Table 3-7（well-formed UTF-8 byte sequences）与 Python 的解码器：
//   00..7F；C2..DF 80..BF；E0 A0..BF 80..BF；E1..EC 80..BF 80..BF；ED 80..9F 80..BF（排除代理）；EE..EF 80..BF 80..BF；
//   F0 90..BF 80..BF 80..BF；F1..F3 80..BF 80..BF 80..BF；F4 80..8F 80..BF 80..BF。C0、C1、F5..FF 永远无效。
// 「起点」是**第一个无效序列的第一个字节**：Python 在 `a\xe4b` 里报 start=1（\xe4 起，因为 b 不是后继字节），不是 2。
// 终点（end，开区间）：无效起始字节占 1 字节；后继字节不合规时，已经读到的合规字节都算进序列（`e0 a0 00` 报 0..2，end=2，不含那个错字节）；
// 被截断时到数据末尾。这与 Python 的行为逐一核对：整套规则对一组边界字节按长度 1 到 4 穷举（规格与规模见 test/cases/utf8-start.mjs 与设计文档 §12.11，不在这里重复数字）。
/** 首个无效序列的诊断；整段合法返回 null。 */
export function diagnoseUtf8(b) {
    let i = 0;
    const n = b.length;
    while (i < n) {
        const c = b[i];
        if (c < 0x80) {
            i++;
            continue;
        }
        let need, lo = 0x80, hi = 0xbf;
        if (c >= 0xc2 && c <= 0xdf)
            need = 1;
        else if (c === 0xe0) {
            need = 2;
            lo = 0xa0;
        }
        else if (c >= 0xe1 && c <= 0xec)
            need = 2;
        else if (c === 0xed) {
            need = 2;
            hi = 0x9f;
        }
        else if (c >= 0xee && c <= 0xef)
            need = 2;
        else if (c === 0xf0) {
            need = 3;
            lo = 0x90;
        }
        else if (c >= 0xf1 && c <= 0xf3)
            need = 3;
        else if (c === 0xf4) {
            need = 3;
            hi = 0x8f;
        }
        else
            return { start: i, end: i + 1, reason: 'invalid start byte' }; // 80..C1、F5..FF：不能作起始字节
        for (let k = 1; k <= need; k++) {
            const x = b[i + k];
            if (x === undefined)
                return { start: i, end: n, reason: 'unexpected end of data' }; // 被截断
            const l = k === 1 ? lo : 0x80, h = k === 1 ? hi : 0xbf;
            if (x < l || x > h)
                return { start: i, end: i + k, reason: 'invalid continuation byte' }; // 后继字节不合规：已读到的合规字节算进序列
        }
        i += need + 1;
    }
    return null;
}
/**
 * Python 的 `data.decode("utf-8", "ignore")`：把每个**无效序列**整个丢掉，其余原样解码。
 * 不能用 Node 的宽松 `TextDecoder`：①它把无效字节换成 U+FFFD，而原文自带的 U+FFFD 必须保留，事后「去掉 U+FFFD」会误伤；②它默认吞掉开头的 BOM，Python 的 `utf-8` 编解码器保留（U+FEFF）。
 * 无效序列的边界直接用 `diagnoseUtf8` 给的 [start, end)（已与 Python 逐字节核对，见设计 §12.11），下一轮从 end 起继续——与 CPython 的 ignore 处理同一规则。
 */
export function decodeUtf8Ignore(b) {
    const parts = [];
    const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let from = 0;
    while (from <= b.length) {
        const rest = b.subarray(from);
        const p = diagnoseUtf8(rest);
        if (p === null) {
            parts.push(dec.decode(rest));
            break;
        }
        parts.push(dec.decode(rest.subarray(0, p.start)));
        from += p.end;
    }
    return parts.join('');
}
/** 首个无效序列的起点；整段合法返回 -1。 */
export function firstInvalidUtf8(b) {
    return diagnoseUtf8(b)?.start ?? -1;
}
/**
 * Python 的 `str(UnicodeDecodeError)`：`'utf-8' codec can't decode byte 0xe9 in position 2: invalid continuation byte`
 * 或（序列占多字节时）`can't decode bytes in position 0-1: ...`。位置是 `start` 到 `end - 1`。
 * 注意：Python 的 `decode('utf-8-sig')` 先去掉开头的 BOM 再解码，所以报告的位置**相对 BOM 之后**；调用方负责传去掉 BOM 的数据。
 */
export function pyUtf8ErrorMessage(b, p) {
    if (p.end - p.start === 1) {
        const hex = b[p.start].toString(16).padStart(2, '0');
        return `'utf-8' codec can't decode byte 0x${hex} in position ${p.start}: ${p.reason}`;
    }
    return `'utf-8' codec can't decode bytes in position ${p.start}-${p.end - 1}: ${p.reason}`;
}
