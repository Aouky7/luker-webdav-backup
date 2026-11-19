// Build a self-contained offline preview from the actual production UI sources.
// All API calls are replaced by synthetic fixtures; no credentials are collected.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('style.css', root), 'utf8');
const updates = readFileSync(new URL('updates.js', root), 'utf8').replace('export function mountUpdates', 'function mountUpdates');
const frontend = readFileSync(new URL('frontend.js', root), 'utf8')
  .replace("import {mountUpdates} from './updates.js';", '')
  .replaceAll('import.meta.url', JSON.stringify('https://preview.invalid/scripts/extensions/third-party/webdav/frontend.js'));
const fixtures = `
const categoryNames = {settings:'设置',secrets:'API 密钥 / 机密',characters:'角色 / 头像 / 背景',chats:'聊天 / 群组',lorebooks:'世界书',presets:'预设 / 界面布局',assets:'素材 / 文件',extensions:'用户扩展',globalExtensions:'全局前端扩展（管理员）',vectors:'向量索引'};
const config = {version:'0.5.6',url:'https://dav.example.com/LukerBackup/',username:'demo-user',passwordSet:true,storageEngine:'fs',selection:Object.fromEntries(Object.keys(categoryNames).map(k=>[k,!['secrets','globalExtensions'].includes(k)])),categories:categoryNames,capabilities:{passwordReveal:true},updateIdentity:{directory:'webdav-backup',repository:'https://github.com/Aouky7/webdav_luker'},uploadMode:'stream'};
let task = {version:'0.5.6',phase:'uploaded',busy:false,name:'Luker-demo.zip',started:'2026-01-01T08:00:00Z',finished:'2026-01-01T08:02:00Z',destination:config.url,bytes:172727804,remoteBytes:172727804,sizeVerification:'matched'};
let backupTick = 0;
window.__WD_PREVIEW__ = {requests:[],uploadCount:0};
window.fetch = async (url, options={}) => {
  const route = String(url).replace('/api/plugins/webdav-backup','');
  window.__WD_PREVIEW__.requests.push(route);
  const posted = options.body ? JSON.parse(options.body) : {};
  let data;
  if (route === '/csrf-token') data={token:'preview-only'};
  else if (route === '/config') {
    if (options.method==='POST') {
      config.url=posted.url; config.username=posted.username; config.selection=posted.selection;
      config.passwordSet=!!posted.password || config.passwordSet;
      data={ok:true,url:config.url,note:'示例配置已在本页保存，刷新后重置。'};
    } else data={...config};
  } else if (route === '/status') {
    if (task.busy && ++backupTick >= 3) task={...task,phase:'uploaded',busy:false,sizeVerification:'matched',remoteBytes:task.bytes,finished:'2026-01-01T08:02:00Z'};
    data={...task};
  } else if (route === '/backup') {
    window.__WD_PREVIEW__.uploadCount++; backupTick=0;
    task={version:'0.5.6',phase:'uploading',busy:true,name:'Luker-preview.zip',started:'2026-01-01T08:00:00Z',bytes:172727804,destination:config.url}; data={started:true,...task};
  } else if (route === '/backups') data={files:Array.from({length:12},(_,i)=>({name:'Luker-demo-'+String(i+1).padStart(2,'0')+'.zip',bytes:172727804-i*1024,modified:'2026-01-01T08:02:00Z'})),limited:false};
  else if (route === '/verify') data={name:posted.name,remoteBytes:172727804,expectedBytes:null,sizeVerification:'observed',verificationSource:'PROPFIND',verification:'示例结果：历史文件缺少发送基准。'};
  else if (route === '/test') data={ok:true,note:'示例目录测试通过；此预览没有访问真实服务。'};
  else if (route === '/password/reveal') data={password:'preview-example-password'};
  else if (route.startsWith('https://raw.githubusercontent.com/')) data={version:'0.5.6'};
  else if (route === '/api/extensions/discover') data=[{name:'third-party/webdav',type:'global'}];
  else if (route === '/api/users/plugins/list') data={ok:true,plugins:[{directory:'webdav-backup',remoteUrl:'https://github.com/Aouky7/webdav_luker'}]};
  else if (route === '/api/extensions/version') data={remoteUrl:'https://github.com/Aouky7/webdav_luker',currentBranchName:'main',currentCommitHash:'preview-only',isUpToDate:true};
  else if (route === '/updates/lock') {config.updatePending=true;data={ok:true,token:'preview-only'};}
  else if (route === '/updates/unlock') {config.updatePending=false;data={ok:true};}
  else if (route === '/api/users/plugins/update') data={ok:true,plugin:{directory:'webdav-backup',remoteUrl:'https://github.com/Aouky7/webdav_luker'}};
  else if (route === '/api/extensions/update') data={shortCommitHash:'preview',remoteUrl:'https://github.com/Aouky7/webdav_luker'};
  else throw Error('预览未实现此操作');
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
};
window.Luker = {getContext:()=>({eventSource:{on(){}},eventTypes:{APP_READY:'ready'}})};
const notice = (message,title) => {
  const element = document.getElementById('preview-notice');
  element.textContent=title+'：'+message; element.hidden=false;
};
window.toastr=Object.fromEntries(['info','success','warning','error'].map(type=>[type,notice]));
`;
const controls = `
document.addEventListener('DOMContentLoaded',()=>{
 const icon=document.querySelector('.inline-drawer-icon');
 if(icon) icon.classList.replace('down','up');
});
document.addEventListener('click',event=>{
 const header=event.target.closest('.inline-drawer-header');
 if(header){
  const icon=header.querySelector('.inline-drawer-icon');
  icon.classList.toggle('up'); icon.classList.toggle('down');
 }
 if(event.target.id==='preview-theme') document.documentElement.classList.toggle('light');
 if(event.target.id==='preview-font') document.documentElement.classList.toggle('large');
});
`;
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'"><title>WebDAV 四页签布局预览</title>
<style>
:root{color-scheme:dark;--SmartThemeBodyColor:#e6e6ea;--SmartThemeBorderColor:#ffffff24;--SmartThemeQuoteColor:#89baf5;--SmartThemeBlurTintColor:#1b1c20;font:16px system-ui,sans-serif;background:#1b1c20;color:var(--SmartThemeBodyColor)}
:root.light{color-scheme:light;--SmartThemeBodyColor:#232a35;--SmartThemeBorderColor:#172b4d24;--SmartThemeQuoteColor:#2467ba;--SmartThemeBlurTintColor:#fff;background:#f5f7fa}
:root.large{font-size:24px}body{margin:0;padding:16px;box-sizing:border-box}main{max-width:760px;margin:auto}button,input{font:inherit;color:inherit}button{cursor:pointer}button:disabled{cursor:default}.preview-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}.preview-tools span{margin-inline-end:auto}.preview-tools button,.menu_button{border:1px solid var(--SmartThemeBorderColor);background:transparent;border-radius:6px;padding:8px}.preview-note{font-size:.8rem;line-height:1.6;opacity:.75;margin:4px 0 16px}.text_pole{border:1px solid var(--SmartThemeBorderColor);background:color-mix(in srgb,var(--SmartThemeBodyColor) 3%,transparent)}.inline-drawer-header{display:flex;justify-content:space-between;align-items:center;min-height:44px;border-bottom:1px solid var(--SmartThemeBorderColor);cursor:pointer}.inline-drawer-icon::before{content:'⌄'}.inline-drawer-icon.up::before{content:'⌃'}.inline-drawer:has(.inline-drawer-icon.down)>.inline-drawer-content{display:none}.fa-eye::before{content:'◉'}.fa-eye-slash::before{content:'◌'}[hidden]{display:none!important}#preview-notice{padding:10px;border:1px solid var(--SmartThemeBorderColor);border-radius:6px;font-size:.85rem;line-height:1.5}input[type=checkbox]{accent-color:var(--SmartThemeQuoteColor)}
</style><style id="luker-webdav-panel-style" data-state="loaded">${css}</style></head>
<body><main><div class="preview-tools"><span>交互布局预览</span><button type="button" id="preview-theme">深浅主题</button><button type="button" id="preview-font">放大字体</button></div><p class="preview-note">示例数据 · 操作只在本页模拟，不连接真实 WebDAV，也不会备份、更新或保存到你的客户端。正式效果继承 Luker 主题。</p><div id="extensions_settings"></div><p id="preview-notice" role="status" hidden></p></main>
<script>${fixtures}\n${updates}\n${frontend}\n${controls}</script></body></html>`;
const output = resolve(process.argv[2] || 'webdav-layout-preview.html');
mkdirSync(dirname(output), {recursive:true});
writeFileSync(output, html);
console.log(output);
