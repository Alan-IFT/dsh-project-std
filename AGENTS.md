@CONTEXT_MANIFEST.md

提交闸门由 `.githooks/` 下的 git 钩子执行（合同见仓库工作须知 §7），每个克隆装一次：`git config core.hooksPath .githooks`。

受支持的宿主只有 DeepSeek Harness（D-135）。插件 `dsh-project-std` 提供标准技能与检查器；显式项目路径层是未发布候选，接入与保护范围只看 [tools/std/README「DSH 接法」](tools/std/README.md#dsh-接法)。沙箱与审批归宿主；此入口不授权改 profile、权限或自行安装钩子，工具已拒绝的动作不得换工具重试。
