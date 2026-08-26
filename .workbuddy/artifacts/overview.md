# LLM 模型接入页 — 开发总览

## 功能
顶栏「LLM」菜单落地为第一个完整路由页面（`/model-settings`），提供线上模型接入能力：

- **6 大分类**：文本模型 / 多模态模型 / 语音转文字 / 文字转语音 / 向量模型 / 重排序，带数量徽章的分类 tab。
- **分类差异化参数**：按分类动态渲染参数表单（如文本模型的 Temperature、Top P、Top K、频率/存在惩罚、上下文大小、深度推理开关等；参数依据 OpenAI / Cohere 官方 API 整理）。
- **增删改查**：接入（新增）、编辑、删除（二次确认）、启用/停用，实时持久化。
- **顶栏路由已接通**：点击 LLM/智能体/小分队 真正跳转页面并同步高亮滑块。

## 新增 / 改动文件
| 文件 | 职责 |
|---|---|
| `src/types/core.d.ts` | 公共编译期类型（ModelCategory、ModelProvider），中文注释 |
| `src/core/file/model-file.ts` | 数据层：6 类参数接口 + ModelConfig + models.json 读写接口 |
| `src/pages/model-settings/index.tsx` / `index.scss` | 页面入口：加载、分类切换、增删改编排 |
| `src/pages/model-settings/components/CategoryTabs.*` | 分类 tab（图标 + 文字 + 数量徽章） |
| `src/pages/model-settings/components/ModelList.*` | 模型卡片列表 + 空态 + 删除确认 |
| `src/pages/model-settings/components/ModelFormModal.*` | 接入/编辑表单弹窗（基础信息 + 动态分类参数） |
| `src/pages/model-settings/components/paramFields.ts` | 分类参数字段描述（表单的单一数据源） |
| `src/components/ui/controls.tsx` | 透传 antd Select/Slider/Switch/InputNumber |
| `src/components/ui/Modal.tsx` | 加 width；destroyOnClose → destroyOnHidden |
| `src/components/layout/TopBar.tsx` | 菜单接通 react-router |

## 数据结构（models.json，存于 $APPDATA/）
```json
{
  "version": 1,
  "models": [
    {
      "id": "uuid", "name": "GPT-4o", "category": "text",
      "provider": "openai", "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-…", "modelName": "gpt-4o", "enabled": true,
      "text": { "temperature": 0.7, "topP": 1, "topK": 40, "frequencyPenalty": 0,
                "presencePenalty": 0, "contextLength": 128000, "maxTokens": 4096,
                "reasoning": false, "stream": true, "stop": "", "systemPrompt": "" },
      "createdAt": "…", "updatedAt": "…"
    }
  ]
}
```
- 非 Tauri 环境（浏览器 dev）自动回退 localStorage，`npm run dev` 可直接调试。

## 扩展方式
新增模型分类只需两步：`paramFields.ts` 加字段描述 + `model-file.ts` 加参数接口与默认值，弹窗自动渲染。

## 验证
- `tsc --noEmit`：通过（EXIT 0）
- `vite build`：通过（3341 模块，无 Sass 告警；用临时 outDir 绕开被残留进程锁定的 dist/）
