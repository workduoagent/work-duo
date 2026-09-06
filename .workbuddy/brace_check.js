const fs = require('fs');
const path = 'E:/Codes/ABC/work-duo/src/pages/agent-studio/chat.scss';
const src = fs.readFileSync(path, 'utf8');
let clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
let depth = 0;
let firstErr = -1;
for (let i = 0; i < clean.length; i++) {
  if (clean[i] === '{') depth++;
  else if (clean[i] === '}') {
    depth--;
    if (depth < 0 && firstErr < 0) firstErr = i;
  }
}
const result = `depth=${depth} firstErr=${firstErr} totalLen=${src.length}`;
fs.writeFileSync('E:/Codes/ABC/work-duo/.workbuddy/brace_check.txt', result);
