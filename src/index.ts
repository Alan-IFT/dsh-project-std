// dsh-project-std 包入口：显式 opt-in 的项目结构化 write/edit 路径询问。
// 独立 ./skills 入口提供标准技能；std-check CLI 与技能算法不依赖守卫启用。
export { name, inject, Config, apply } from './guard/index.js'
