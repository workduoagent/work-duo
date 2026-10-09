# 文档图片

本目录存放 README 引用的图片资源。

## 需要的图片

| 文件名 | 用途 | 建议尺寸 | 对应位置 |
|---|---|---|---|
| `screenshot.png` | 主界面截图 | 宽约 1200px | README.md / README.en.md 顶部 |

## 使用方式

图片在两个 README 中均以 HTML 注释形式预留，**截图就位后取消注释即可**：

```markdown
<!-- TODO: 主界面截图待补 —— 把截图存到 docs/images/screenshot.png（约 1200px 宽）后取消注释 -->
<!-- ![主界面](docs/images/screenshot.png) -->
```

英文版对应：

```markdown
<!-- TODO: Main interface screenshot — save to docs/images/screenshot.png (~1200px wide), then uncomment -->
<!-- ![Main Interface](docs/images/screenshot.png) -->
```

## 建议补充的图片（按对开源说服力的影响排序）

1. **智能体会话页** —— 展示 DAG 执行图与工具轨迹，这是本项目最有辨识度的界面
2. **小分队协作界面** —— 像素舞台 + 多角色气泡
3. **多格式查看器** —— PDF / Word / 表格 / 音视频预览
4. **GIF 动效** —— 智能体执行一轮任务的完整过程（比静态图更直观）

## 注意事项

- 请勿在截图中暴露敏感信息（API Key、服务器地址、内网 IP、真实路径）
- 图片统一用 PNG（截图）或 GIF（动效），不用 WebP（部分 Markdown 渲染器兼容性不佳）
- 单张控制在 500 KB 以内，避免仓库体积膨胀
