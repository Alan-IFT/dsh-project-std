// 路径通配（对应 Python 的 `glob.glob(os.path.join(glob.escape(root), pattern))`，只供 layout 的存在性判据 `glob` 用）。
//
// **刻意只实现子集**：全仓只有一处用到 glob，且候选写死为三种形态（`tools/check_*.py`、`tools/*/check_*.py`、`tools/*/checks/check_*.py`）。
// 不引依赖、不做通用 glob。语义对着 Python 的 `glob`（`fnmatch` 翻译）逐条钉在 `test/cases/glob.mjs`：
//   - `*`、`?`、`[...]`、`[!...]` 只在**单个路径段内**生效，不跨 `/`；
//   - **不匹配以 `.` 开头的名字**，除非模式在该位置也以 `.` 开头；
//   - `**` 不递归（没带 `recursive=True`），等价于 `*`；
//   - 根按字面（先 `escape`），只有候选部分是通配（C14：扫描根路径里可能带 `[ ] * ?`）；
//   - 模式不含通配字符时，只判存在（`lexists`）；
//   - 模式以 `/` 结尾时，只匹配目录。
// 区分大小写：Python 的 `glob` 在 Windows 上按文件系统（不区分），POSIX 上区分。这里跟随 `readdirSync` 的真实名字，用**字面比较**，
// 所以 Windows 上 `Check_c.py` 与 `check_*.py` 不匹配——而 Python 在 Windows 上 `fnmatch` 会 `normcase`（小写）后比较，两者命中 `Check_c.py`。
// 这是一个平台差异，见设计 §12.17 D16；按平台处理。

import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isDir, lexists } from './fs.js'

const MAGIC = /[*?[]/

/** 把一个路径段的模式翻成正则（对应 Python `fnmatch.translate` 的子集：`*`、`?`、`[seq]`、`[!seq]`；其余按字面）。 */
function segmentRegex(seg: string, ignoreCase: boolean): RegExp {
  let re = ''
  for (let i = 0; i < seg.length; ) {
    const c = seg[i]!
    i++
    if (c === '*') {
      re += '.*'
    } else if (c === '?') {
      re += '.'
    } else if (c === '[') {
      let j = i
      if (seg[j] === '!') j++
      if (seg[j] === ']') j++
      while (j < seg.length && seg[j] !== ']') j++
      if (j >= seg.length) {
        re += '\\[' // 没有闭合：按字面的 `[`
      } else {
        let stuff = seg.slice(i, j)
        const neg = stuff.startsWith('!')
        if (neg) stuff = stuff.slice(1)
        stuff = stuff.replaceAll('\\', '\\\\').replaceAll(']', '\\]').replaceAll('^', '\\^')
        re += `[${neg ? '^' : ''}${stuff}]`
        i = j + 1
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
    }
  }
  return new RegExp(`^(?:${re})$`, 's' + (ignoreCase ? 'i' : ''))
}

const hasMagic = (s: string): boolean => MAGIC.test(s)

/**
 * 在 `root` 下展开 `pattern`（以 `/` 分段），返回命中的相对路径（`/` 分隔、未排序——调用方只关心「有没有命中」）。
 * `root` 按字面，不解释其中的通配字符。
 */
export function globIn(root: string, pattern: string): string[] {
  const dirOnly = pattern.endsWith('/') && pattern.length > 1
  const segs = pattern.split('/').filter((s, i, a) => s !== '' || (i === 0 && a.length === 1))
  if (segs.length === 0 || (segs.length === 1 && segs[0] === '')) return []
  const ignoreCase = process.platform === 'win32'
  let level: string[] = ['']
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]!
    const next: string[] = []
    for (const base of level) {
      const dir = base ? join(root, base) : root
      if (!hasMagic(seg)) {
        const rel = base ? `${base}/${seg}` : seg
        if (lexists(join(root, rel))) next.push(rel)
        continue
      }
      let names: string[]
      try { names = readdirSync(dir) } catch { continue }
      const re = segmentRegex(seg === '**' ? '*' : seg, ignoreCase)
      const dot = seg.startsWith('.')
      for (const n of names) {
        if (n.startsWith('.') && !dot) continue
        if (re.test(n)) next.push(base ? `${base}/${n}` : n)
      }
    }
    level = next
    if (level.length === 0) return []
  }
  // Python 返回拼接后的路径，样本记的是 `os.path.relpath`（已规范化）；这里同样规范化，`./`、`//`、`a/../b` 不留在结果里
  const hits = dirOnly ? level.filter((r) => isDir(join(root, r))) : level
  return hits.map((r) => relative(root, join(root, r)).split(sep).join('/'))
}

/** 命中任一即真：layout 的 `glob` 判据只问「有没有」。 */
export function globAny(root: string, pattern: string, accept: (rel: string) => boolean): boolean {
  return globIn(root, pattern).some(accept)
}
