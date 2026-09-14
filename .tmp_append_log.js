const fs = require('fs');
const p = '.workbuddy/memory/2026-09-14.md';
let c = fs.readFileSync(p, 'utf8');
c = c.replace(/\n+$/, '');
c += '\n\n## 通知弹窗改写：字符截断 + 复制图标（20260914 收尾）\n';
c += '- 用户最终立规矩：通知弹窗（recovery/approval/choice/plan）整卡绝不能有 Y 滚动条、底部按钮必须第一眼可见；此前 description 用 overflow-y:auto 仍出滚动条。改为：description 改 overflow:hidden（不滚动），超长文本体用 CopyableMarkdown（默认 600 字截断 + 省略号），右上角复制图标复制完整原文（Clipboard API 失败回退 execCommand）。覆盖 reason/summary/description/question/goalSummary 五处。\n';
c += '- 验证：node node_modules/typescript/bin/tsc --noEmit EXIT=0。纯前端 HMR 生效。已同步到 MEMORY.md 前端坑②硬规矩。\n';
fs.writeFileSync(p, c);
console.log('appended ok');
