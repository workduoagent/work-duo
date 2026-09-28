# kb-adr · 架构决策记录（知识库种子）

> 用途：技术事实源——ADR、契约、时序、数据模型。  
> 挂载：架构、前后端、Rust、评审。

## 语料清单

| 文件 | 内容 |
|---|---|
| `01-adr-template.md` | ADR 模板 |
| `02-adr-sample-sandbox.md` | 样例：沙箱语义与宿主工具链 |
| `03-contract-layout.md` | 契约文件组织约定 |
| `04-data-model-notes.md` | 数据建模备忘 |

## 使用

- 重大技术选择开 ADR，编号递增，状态演进（提议→接受→废弃）。  
- 契约进 `docs/contracts/`，ADR 可引用其路径。  
- 记忆锚定 `architecture` 与本库同步，避免双源漂移时以 ADR 文件为准。
