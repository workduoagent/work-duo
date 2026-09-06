const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('E:/Codes/ABC/work-duo/node_modules/sass/package.json', 'utf8'));
const result = JSON.stringify({ name: pkg.name, version: pkg.version, type: pkg.type, main: pkg.main, exports: pkg.exports }, null, 2);
fs.writeFileSync('E:/Codes/ABC/work-duo/.workbuddy/sass_pkg.txt', result);
