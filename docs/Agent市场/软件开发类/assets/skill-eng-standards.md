# skill-eng-standards · 工程规范守卫

> 适用：全员（开发/测试/评审/集成）。用途：目录、命名、依赖、禁止项检查清单；新代码与文档落盘前自检。

---

## 何时使用

- 新增页面/模块/接口/脚本前后
- 评审或自测前的规范扫描
- 交付包组装前最后一道规范确认

## 核心清单（按栈）

### 通用

| 项 | 规则 |
|---|---|
| 目录 | 功能代码放对应模块目录；禁止在 `components/` 写页面业务、禁止在入口文件堆业务 |
| 命名 | 文件/导出与团队约定一致；布尔用 `is/has`；禁止无意义缩写 |
| 依赖 | 只在清单文件增依赖；禁止隐式全局安装 |
| 密钥 | 禁止提交 `.env` 明文；配置走本地配置/平台密钥位 |
| 注释 | 只写非显而易见的 WHY；禁止叙述型注释 |
| 死代码 | 确认无用就删，不留兼容空壳 |

### React / WorkDuo 前端

- UI 一律经 `@/components/ui`，禁裸 antd；图标只用 lucide-react。
- 样式 `.scss` 与 tsx 分离；颜色/尺寸只用 `var(--color-*)` 等设计令牌。
- 路由 HashRouter；新页面注册到 `src/core/router`。
- 数据访问走 mapper，组件禁止直写 SQL。
- 完成后 `npm run typecheck` 必须 0 error。

### Vue 3

- SFC 分层清晰；组合式 API 优先；逻辑抽 `composables`。
- 组件库统一封装；避免页面内全局污染样式。
- 状态：跨页面才上 Pinia；请求统一 request 封装。
- `vue-tsc --noEmit` 或项目 typecheck/build 0 error。

### Python

- 标准库优先；边界校验只在系统边界。
- 测试与源码目录分离；公共工具放 `utils`/`lib` 并有单测。
- 依赖写入项目清单；沙箱缺库走平台自愈声明 `dependencies`。

### Java / Spring

- Controller/Service/Repository 分层清晰；DTO 与实体不混用。
- 异常与错误码统一；事务边界在服务层。
- 接口与 OpenAPI 契约一致。

### Rust / Tauri

- 命令与事件契约变更必须同步文档/前端类型。
- 保持消息序列不变量（每条 tool_call.id 有结果）。
- 能力以 ToolRegistry 为准，禁止只在 prompt 里「宣称能做」。

## 禁止项（红线）

1. 绕过封装层直调底层（裸 UI 库 / 直写 SQL / 裸 IPC）。
2. 把密钥、真实凭证写进仓库或日志。
3. 无超时、无取消语义的长阻塞。
4. 评审员角色直接改业务代码。
5. 声称「已在沙箱安全执行」而实际调用宿主任意 shell。

## 输出模板（自检/评审用）

```markdown
## 规范自检
- [ ] 目录与命名
- [ ] 封装层（UI / DB / IPC）
- [ ] 样式令牌
- [ ] typecheck / build
- [ ] 无密钥与死代码
结论：通过 / 阻塞项列表
```
