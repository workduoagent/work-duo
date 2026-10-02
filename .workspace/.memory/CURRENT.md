# CURRENT —— 当前进行中（跨工具接续入口）

> 每次收工刷新本文件；详细脉络见 `.memory/` 按日文件。

## 正在进行

- F001（MCP 信任协议）已实施并实测：设备配对/令牌鉴权/吊销/本机信任/Origin 拦截全链路落地，待用户真机跨设备补测 0.0.0.0 场景。

- 工作区已定名并落地为 `.workspace/`（初名 .workbranchs，2026-10-02 用户定名更正）：docs/ 资产全部迁入 + `.norms/` 规范目录；**需求/设计文档统一归口 `.future/`**（.design 已并入，MD+HTML 同需求子目录规整，见 `.future/README.md`），**docs/ 目录已清空移除**（4 份历史评估/台账删除，git 历史可找回；被活代码引用的文档全部迁入 .future 并修复引用），60+ 文件路径引用已同步，`npm run squad:eval env` 已验证可用。
- 窗口尺寸适配已实现（lib.rs setup 按显示器工作区收敛初始/最小尺寸，cargo check 过），待用户实机重启观察。
- 多模态渲染已提交（6387438 图片内联渲染+预览器 / ee4122a echarts+latex+mermaid 修复），待真实使用观察：
  - echarts 的 json 围栏结构识别误判率（普通 JSON 被误渲染为图的概率）
  - mermaid 流式场景下气泡内瞬时错误条的观感

## 下一步候选

1. `.future/` 补第一个版本方案稿（建议：聊天多模态输出 v1 复盘 + v2 规划）。
2. 观察首次 CI 运行（`.github/workflows/ci.yml` 已随路径迁移更新）。
3. 图片生成师 Agent 接入小分队（如全栈迭代组出图位）。
4. 用户侧遗留未提交：pnpm-workspace.yaml / Cargo.lock / 根目录旧 eval-results 删除（staged）。

## 环境事实（跨设备必读）

- WorkDuo 实例：本机运行时 MCP 端点 `127.0.0.1:18755/mcp`；驱动脚本在 `.workspace/.sys_tool/workduo-mcp/scripts/`。
- `npm run squad:eval` / `squad:gate` / `release:gate` 均已指向新路径。
- pnpm-lock.yaml 被 gitignore；eval 产物目录不进 git。
