// 显式项目路径要求：纯词法比较，不解析命令、不证明 realpath 或沙箱隔离。
import path from 'node:path'

export type Verdict = { kind: 'allow' } | { kind: 'ask'; reason: string }
export interface ProjectPolicy { readonly root: string; readonly protect: readonly string[] }
export interface GuardConfig { readonly enabled: boolean; readonly policyVersion: 2; readonly projects: readonly ProjectPolicy[] }
export interface ToolCall {
  name?: unknown
  arguments?: unknown
  agent?: { session?: { header?: { cwd?: unknown } } }
}

const ALLOW: Verdict = Object.freeze({ kind: 'allow' })
const ask = (reason: string): Verdict => ({ kind: 'ask', reason })
const paths = (platform: NodeJS.Platform) => platform === 'win32' ? path.win32 : path.posix

function withoutNamespace(value: string): string {
  return value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
}

/** Windows 的大小写、长前缀、ADS、段尾点空格别名；不访问文件系统。 */
function windowsAlias(value: string): string {
  const plain = withoutNamespace(value).replace(/\//g, '\\')
  return plain.split('\\').map((segment, index) => {
    if (index === 0 && /^[A-Za-z]:$/.test(segment)) return segment
    if (segment === '.' || segment === '..') return segment
    return segment.split(':', 1)[0].replace(/[. ]+$/, '')
  }).join('\\')
}

export function normalizeForCompare(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.win32.normalize(windowsAlias(value)).toLowerCase() : path.posix.normalize(value)
}

function fullyQualified(value: unknown, platform: NodeJS.Platform): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) return false
  if (platform !== 'win32') return value.startsWith('/')
  const plain = withoutNamespace(value).replace(/\//g, '\\')
  if (/^[A-Za-z]:\\/.test(plain)) return true
  const unc = /^\\\\([^\\/:?]+)\\([^\\/:?]+)(?:\\|$)/.exec(plain)
  return !!unc && unc.slice(1).every((segment) => segment !== '.' && segment !== '..' && !/^[. ]+$/.test(segment))
}

function inside(root: string, target: string, platform: NodeJS.Platform): boolean {
  const p = paths(platform)
  const rel = p.relative(root, target)
  return rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} 必须是配置对象`)
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error(`${label} 含未知配置键 ${String(key)}`)
  }
}

function relativeProtect(value: unknown, platform: NodeJS.Platform): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) return false
  const p = paths(platform)
  if (p.isAbsolute(value) || (platform === 'win32' && /^[A-Za-z]:/.test(value))) return false
  return value.split(platform === 'win32' ? /[\\/]/ : /\//).every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** schema 与 apply 共用完整输入；旧配置和错误规则明确报错，不自动升级或丢项。 */
export function validateConfig(raw: unknown, platform: NodeJS.Platform = process.platform): GuardConfig {
  const input = raw === undefined || raw === null ? {} : object(raw, '守卫配置')
  if (Object.hasOwn(input, 'root') || Object.hasOwn(input, 'protect')) throw new Error('旧 root/protect 配置已退出；请按 policyVersion: 2 的 projects 升级指南显式迁移')
  keys(input, ['enabled', 'policyVersion', 'projects'], '守卫配置')
  const enabled = Object.hasOwn(input, 'enabled') ? input.enabled : false
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
  if (Object.hasOwn(input, 'policyVersion') && input.policyVersion !== 2) throw new Error('policyVersion 必须是 2')
  if (enabled && input.policyVersion !== 2) throw new Error('启用守卫必须显式配置 policyVersion: 2')
  const given = Object.hasOwn(input, 'projects') ? input.projects : []
  if (!Array.isArray(given) || (enabled && given.length === 0)) throw new Error('projects 必须是数组；启用时不能为空')
  const projects = Array.from(given, (rawProject, index): ProjectPolicy => {
    const project = object(rawProject, `projects[${index}]`)
    keys(project, ['root', 'protect'], `projects[${index}]`)
    if (!fullyQualified(project.root, platform)) throw new Error('项目 root 必须是完全限定的绝对路径')
    const root = normalizeForCompare(project.root, platform)
    if (!fullyQualified(root, platform)) throw new Error('项目 root 规整后不是完全限定路径')
    if (!Array.isArray(project.protect) || project.protect.length === 0) throw new Error('项目 protect 必须是非空相对路径数组')
    const protect = Array.from(project.protect, (value: unknown) => {
      if (!relativeProtect(value, platform)) throw new Error('protect 原形必须是非空相对路径，不能含空段、. 或 ..')
      if (platform === 'win32' && !relativeProtect(windowsAlias(value), platform)) throw new Error('protect Windows 别名不得产生空段、. 或 ..')
      const normalized = normalizeForCompare(value, platform)
      if (!relativeProtect(normalized, platform)) throw new Error('protect 规整后必须是非空相对路径，不能变成根、. 或 ..')
      return normalized.split(paths(platform).sep).join('/')
    })
    return Object.freeze({ root, protect: Object.freeze(protect) })
  })
  for (let i = 0; i < projects.length; i++) for (let j = 0; j < i; j++) {
    if (inside(projects[i].root, projects[j].root, platform) || inside(projects[j].root, projects[i].root, platform)) throw new Error('projects roots 不得重复或父子重叠（包括 Windows 词法别名）')
  }
  return Object.freeze({ enabled, policyVersion: 2, projects: Object.freeze(projects) })
}

/** 只消费已校验配置和已知 native write/edit；相对目标严格按会话 cwd 解析。 */
export function decide(exec: ToolCall, config: GuardConfig, platform: NodeJS.Platform = process.platform): Verdict {
  if (!config.enabled) return ALLOW
  let name: unknown
  try { name = exec?.name } catch { return ALLOW }
  if (name !== 'write' && name !== 'edit') return ALLOW
  let cwd: unknown
  try { cwd = exec?.agent?.session?.header?.cwd } catch { return ask('会话 cwd 无法读取，无法确定项目路径范围，先问人') }
  if (!fullyQualified(cwd, platform)) return ask('缺少有效的完全限定会话 cwd，无法确定项目路径范围，先问人')
  const base = normalizeForCompare(cwd, platform)
  if (!fullyQualified(base, platform)) return ask('会话 cwd 规整后无效，无法确定项目路径范围，先问人')
  const project = config.projects.find(({ root }) => inside(root, base, platform))
  if (!project) return ALLOW
  let target: unknown
  try { target = (exec.arguments as { file_path?: unknown } | null)?.file_path } catch { return ask('受管 write/edit 的路径参数无法读取，先问人') }
  if (typeof target !== 'string' || target.trim() === '' || target.includes('\0')) return ask('受管 write/edit 的 file_path 缺失、空白或无效，先问人')
  if (platform === 'win32' && (/^[A-Za-z]:/.test(target) || /^[\\/]/.test(target)) && !fullyQualified(target, platform)) return ask('Windows 目标依赖盘符或缺少完整 UNC server/share，无法可靠解析，先问人')
  if (platform === 'win32' && windowsAlias(target).trim() === '') return ask('Windows 目标别名规整后为空，无法可靠解析，先问人')
  const normalized = normalizeForCompare(target, platform)
  if (platform === 'win32' && (/^[A-Za-z]:/.test(normalized) || /^[\\/]/.test(normalized)) && !fullyQualified(normalized, platform)) return ask('Windows 目标规整后不是完全限定路径，先问人')
  const p = paths(platform)
  const absolute = p.resolve(base, normalized)
  if (!inside(project.root, absolute, platform)) return ALLOW
  const rel = p.relative(project.root, absolute).split(p.sep).join('/')
  for (const protect of project.protect) {
    if (rel === protect || rel.startsWith(protect + '/')) return ask(`改显式项目 protect 路径（${protect}），先问人`)
  }
  return ALLOW
}
