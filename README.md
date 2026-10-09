<div align="center">

# WorkDuo

**本地优先的 AI 智能体工作台 —— 把模型接入、智能体编排、多智能体协作与沙箱执行装进一个桌面客户端**

[English](README.en.md) | 简体中文

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://tauri.app)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-orange.svg)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-2021-orange.svg)](https://www.rust-lang.org)

</div>

> **数据与产物留在本机，推理走云端API。** 无需自建后端，克隆即可运行。

<!-- TODO: 主界面截图待补 —— 把截图存到 docs/images/screenshot.png（约 1200px 宽）后取消注释 -->
<!-- ![主界面](docs/images/screenshot.png) -->

## 特性

- **可视化智能体编排** —— 7步向导创建智能体，运行期实时呈现意图分类、规划 DAG、工具轨迹与产物；DAG 节点可拖拽缩放，支持从任意步骤分支重跑
- **多智能体协作** —— 三种执行模式（群聊 / 流水线 / 主管制），成员间产物经交接箱单向传递，内置 3 套官方编队模板开箱即用
- **自带 MCP Server** —— 内建 98 个 MCP 工具，可被 Claude Code、Cursor 等外部客户端接入，**以真实 UI 权限驱动全模块**（外部 Agent 的每次操作都与你手动点击产生相同副作用）
- **技能与插件生态** —— 技能把「模型临场发挥」收敛为可复用工作流，支持随包脚本工具；本地插件可作为原子工具接入
- **双沙箱运行时** —— 内置 Micromamba（Python）与 Bun（JS），默认断网 + 文件系统有界，用户脚本开箱即跑无需配置环境
- **长期记忆沉淀** —— 记忆宫殿可视化管理，自动召回与锚定，能力层可控（关闭 / 主动 / 强制三档），非仅提示词约束

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | [Tauri 2](https://tauri.app)（Rust 2021 + tokio） |
| 前端 | [React 19](https://react.dev) + TypeScript 5.8 + Vite 7 + React Router 7 |
| UI | [Ant Design 5](https://ant.design)（经统一封装层） + Sass 设计令牌 + lucide-react |
| 数据 | SQLite（`workduo.db`，40 张表） + LanceDB（向量检索） |
| 运行时 | [Bun](https://bun.sh) 1.4（JS）+ [Micromamba](https://mamba.readthedocs.io)（Python） |
| 服务器 | russh / russh-sftp（SSH、SFTP，跨平台远程纳管） |
| 凭证 | OS 凭据管理器（keyring）+ AES-256-GCM + HMAC-SHA256 |

## 快速开始

### 环境要求

| 依赖 | 版本 |
|---|---|
| Node.js | ≥ 20 |
| Rust | ≥ 1.77（Edition 2021） |
| pnpm | ≥ 8（推荐） |

**系统依赖**

- **Windows**：需 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（WebView2 运行时通常已预装）
- **macOS**：Xcode Command Line Tools — `xcode-select --install`
- **Linux**：

  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
  ```

### 安装与运行

```bash
git clone https://github.com/workduoagent/work-duo.git
cd work-duo
pnpm install          # 或 npm install
pnpm tauri dev        # 启动开发模式（前端 + Rust 联调）
```

首次启动会自动创建数据库、初始化 40 张表，并准备所需运行时。

> **克隆慢？** 仓库含约 **370 MB** 的预编译运行时二进制（10 个 sidecar，覆盖三大平台）。建议浅克隆：
>
> ```bash
> git clone --depth 1 https://github.com/workduoagent/work-duo.git
> ```

### 其他常用命令

| 命令 | 说明 |
|---|---|
| `pnpm tauri dev` | 开发模式（前端 + 后端联调，**这是唯一能真正调用引擎的方式**） |
| `pnpm dev` | 仅前端 Vite（无 Tauri 时降级运行，SQLite 走浏览器存储） |
| `pnpm typecheck` | 前端类型检查 |
| `pnpm test` | 前端单元测试 |
| `pnpm lint` | ESLint 检查 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 后端测试 |

## 构建

```bash
pnpm tauri build
```

产物位置：

| 平台 | 路径 |
|---|---|
| Windows | `src-tauri/target/release/bundle/msi/`、`nsis/` |
| macOS | `src-tauri/target/release/bundle/dmg/`、`app/` |
| Linux | `src-tauri/target/release/bundle/deb/`、`rpm/`、`AppImage/` |

> 跨平台打包需在对应系统上执行：macOS 的 `.app` / `.dmg` 只能在 macOS 构建。

## 项目结构

```text
work-duo/
├── src/                      # 前端源码（React + TS）
│   ├── pages/                # 业务页面（智能体 / 小分队 / 模型 / 知识库 / MCP / 技能 …）
│   ├── components/ui/        # 统一组件层（Ant Design 封装，禁裸用）
│   ├── core/                 # 核心层（路由 / 数据访问 / 领域类型 / IPC 桥）
│   └── assets/sql/           # 数据库 DDL 单一事实源
├── src-tauri/
│   ├── src/
│   │   ├── agent/            # 智能体引擎（意图 → 规划 → 执行流水线）
│   │   ├── host/             # 服务器托管（SSH / SFTP）
│   │   ├── mcp_server.rs     # 内建 MCP Server
│   │   └── fs_helper.rs      # 路径边界校验原语
│   ├── binaries/             # 预编译 sidecar（Bun / Micromamba，约 370 MB）
│   └── tauri.conf.json       # Tauri 配置与 CSP
├── docs/                     # 架构文档
├── public/                   # 静态资源
└── package.json
```

完整架构说明见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

## 配置

无需 `.env`。应用配置存放于 SQLite 的 `app_config` 表，可在应用内「设置」页可视化管理。

常用配置项：

| 配置项 | 说明 | 默认 |
|---|---|---|
| `workspace_path` | 智能体工作空间目录（沙箱可写目录之一） | `$HOME/work-duo-workspace` |
| `skill_path` | 技能包根目录 | `$APPDATA/.skills` |
| `knowledge_base_path` | 知识库文件树根目录 | `$APPDATA/knowledge` |
| `mcp_bind_addr` | 内建 MCP Server 监听地址（`0.0.0.0` 供内网访问，`127.0.0.1` 仅本机） | `0.0.0.0` |
| `mcp_local_trust` | 是否允许本机无凭证访问 MCP Server | `true` |

### 环境变量

| 变量 | 说明 |
|---|---|
| `WD_LLM_RPM` | LLM 请求速率限制 |
| `WD_RUN_MAX_SECS` | 单次任务墙钟上限（秒） |
| `WD_SUBTASK_MAX_ITERATIONS` | 子任务工具轮上限 |
| `WD_SANDBOX_NET` | 设为 `on` 放开沙箱网络（默认断网） |
| `WD_SANDBOX_FS` | 设为 `off` 关闭文件系统边界（默认有界） |

> ⚠️ 后两项是调试逃生阀，启动时**必定写入审计日志**。

## 常见问题

**Q：克隆很慢 / 仓库体积大？**
A：仓库含约 370 MB 预编译运行时（10 个 sidecar）。用 `git clone --depth 1` 浅克隆。

**Q：Linux 构建报错找不到 `webkit2gtk`？**
A：安装上述系统依赖；Ubuntu 24.04+ 需用 `libwebkit2gtk-4.1-dev`（不是 `4.0`）。

**Q：MCP Server 端口 18755 被占用？**
A：在设置页修改 `mcp_bind_addr` 端口，或关闭占用进程。

**Q：MCP 客户端接入报 401？**
A：需先在「设置 → 安全中心」发起设备配对，用配对码完成绑定。带凭证但不匹配会被直接拒绝，不会回退本机信任。

**Q：沙箱脚本无法联网 / 访问文件？**
A：这是**默认行为**——沙箱强制断网 + 文件系统有界（仅工作空间与临时目录）。调试时可用 `WD_SANDBOX_NET=on` / `WD_SANDBOX_FS=off`，但会留审计痕迹。

**Q：Rust 改动不生效？**
A：Rust 代码必须重启应用；开发模式下等待 `tauri dev` 重新编译完成。

**Q：Windows 下 Bun 报 `JSError` 加载失败？**
A：Windows 资源路径带 `\\?\` 前缀，需归一化后再传给 Bun 子进程。项目已处理，手动调用时需注意。

**Q：想了解某个功能的实现细节？**
A：架构与设计决策见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与代码注释。

## 路线图

- [x] 单智能体完整链路（意图 → 规划 → 执行 → 校验 → 交付）
- [x] 多智能体协作（小分队：三种模式 + 交接箱 + 角色包）
- [x] 内建 MCP Server（98 工具，UI 级权限）
- [x] 双沙箱运行时与安全守卫
- [ ] 应用内国际化（i18n）
- [ ] 更多生态集成

## 贡献

欢迎提 Issue 和 PR。开始前请阅读：

- [CONTRIBUTING.md](CONTRIBUTING.md) —— 提交规范与协作方式
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构说明，改动前请先理解模块边界

## 许可证

[MIT](LICENSE) © WorkDuoAgent

## 致谢

- [Tauri](https://tauri.app) —— 跨平台桌面壳
- [React](https://react.dev) · [Vite](https://vitejs.dev) —— 前端框架与构建
- [Ant Design](https://ant.design) —— UI 组件库
- [Bun](https://bun.sh) —— JS 运行时
- [Micromamba](https://mamba.readthedocs.io) —— Python 环境管理
- [LanceDB](https://lancedb.com) —— 向量存储
- [russh](https://github.com/Eugeny/russh) —— 纯 Rust SSH 实现

## 联系

- 仓库：[github.com/workduoagent/work-duo](https://github.com/workduoagent/work-duo)
- Issue：[GitHub Issues](https://github.com/workduoagent/work-duo/issues)
