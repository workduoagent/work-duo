const sass = require('E:/Codes/ABC/work-duo/node_modules/sass');
const fs = require('fs');
const out = 'E:/Codes/ABC/work-duo/.workbuddy/sass_out.txt';
try {
  const r = sass.compile('E:/Codes/ABC/work-duo/src/pages/agent-studio/chat.scss');
  fs.writeFileSync(out, 'SASS_OK bytes=' + r.css.length);
} catch (e) {
  fs.writeFileSync(out, 'SASS_ERR ' + e.message);
}
