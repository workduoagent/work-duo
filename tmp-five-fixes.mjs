// 一次性：工作台五修（用完删）
import fs from 'node:fs'

const p = 'src/pages/squads-workspace/SquadDetailPage.tsx'
let s = fs.readFileSync(p, 'utf8')
let n = 0
const sub = (label, from, to) => {
  if (!s.includes(from)) { console.error('锚点未命中: ' + label); process.exit(1) }
  s = s.split(from).join(to)
  n++
}

// 2. 删编辑编制按钮（顶栏）
sub('编辑编制',
  `                <Button variant="ghost" size="sm" onClick={() => nav('/squads-workspace')} title="编辑编制（回列表）"><Pencil size={14}/> 编辑编制</Button>\n`,
  '')

// 3. 草稿态运行按钮内嵌输入框
sub('内嵌运行钮',
  `<button className="sw-send" disabled={!prompt.trim() || starting} onClick={() => void handleStart()}>`,
  `<button className="sw-send sw-send--in" disabled={!prompt.trim() || starting} onClick={() => void handleStart()}>`)

// 4. chatcard 仅运行中可弹（舞台小人点击加守卫）
sub('chatcard 守卫',
  `onClick={(e) => { e.stopPropagation(); setInjectTarget(m.agentId); setInjectMode('soft'); setChatCard(m.agentId) }}`,
  `onClick={(e) => { e.stopPropagation(); if (!canInject) return; setInjectTarget(m.agentId); setInjectMode('soft'); setChatCard(m.agentId) }}`)

// 5. modebar 删「协作模式」label + mode-tab + 「中间区」label
sub('modebar 精简',
  `                    <div className="sw-modebar">
                        <span className="sw-modebar__label">协作模式</span>
                        <div className="sw-mode-tab is-on" data-mode={mode}>
                            <span className="sw-mode-tab__ico">{MODE_META[mode]?.ico}</span>{MODE_META[mode]?.label ?? mode}
                            <span className="sw-mode-tab__desc">{MODE_META[mode]?.desc}</span>
                        </div>
                        <div className="sw-modebar__spacer"/>
                        <span className="sw-modebar__label">中间区</span>
                        <div className="sw-viewseg">`,
  `                    <div className="sw-modebar">
                        <div className="sw-modebar__spacer"/>
                        <div className="sw-viewseg">`)

fs.writeFileSync(p, s)

// ---- SCSS ----
const cp = 'src/pages/squads-workspace/index.scss'
let c = fs.readFileSync(cp, 'utf8')

sub.call(null, 'aside 收起隐藏',
  `  transform: translateX(calc(100% + 20px));
  transition: transform .28s cubic-bezier(.2, .8, .3, 1);`,
  `  transform: translateX(calc(100% + 20px));
  visibility: hidden;
  transition: transform .28s cubic-bezier(.2, .8, .3, 1), visibility .28s;`)
c = c.replace('.sw-aside-float.is-open { transform: translateX(0); }',
  '.sw-aside-float.is-open { transform: translateX(0); visibility: visible; }')
c = c.replace('.sw-send:disabled { opacity: .45; cursor: not-allowed; }',
  `.sw-send:disabled { opacity: .45; cursor: not-allowed; }
.sw-input-row { position: relative; }
.sw-input-row textarea { padding-right: 96px; }
.sw-send--in { position: absolute; right: 8px; bottom: 8px; height: 30px; padding: 0 14px; }`)
c = c.replace(`.sw-chatcard {
  position: absolute; z-index: 20; width: 240px; padding: 12px;`,
  `.sw-chatcard {
  position: absolute; z-index: 20; width: 240px; padding: 12px;
  right: 16px; bottom: 16px;`)
fs.writeFileSync(cp, c)
console.log('patched x' + n)
