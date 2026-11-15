// WebDAV backup for Luker. No local ZIP; host backup stream -> HTTPS PUT.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
export const info = { id: 'webdav-backup', name: 'WebDAV Backup', description: 'Manual streaming backups with a mobile settings page' };
const base = '/api/plugins/webdav-backup';
let host;
let busy = false;
let status = { phase: 'idle' };
const configPath = () => path.join(globalThis.DATA_ROOT, '_webdav-backup.json');
function config() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('Cannot read WebDAV configuration'); }
}
function validate(c) {
  const u = new URL(c.url);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('Use an HTTPS directory URL without embedded credentials, query or fragment');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  if (String(c.username || '').includes(':')) throw new Error('Username cannot contain a colon');
  return u;
}
function request(c, method, target, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(target, { method, headers: { Authorization: 'Basic ' + Buffer.from((c.username || '') + ':' + (c.password || '')).toString('base64'), ...extra } }, response => {
      response.resume();
      response.on('error', reject);
      response.on('end', () => response.statusCode >= 200 && response.statusCode < 300 ? resolve(response.statusCode) : reject(new Error('WebDAV HTTP ' + response.statusCode)));
    });
    req.on('error', () => reject(new Error('WebDAV connection failed')));
    req.setTimeout(120000, () => req.destroy(new Error('Timeout')));
    const timer = setTimeout(() => req.destroy(new Error('Time limit')), 1800000);
    req.on('close', () => clearTimeout(timer));
    if (body) pipeline(body, req).catch(reject); else req.end();
  });
}
async function backup(user, includeSecrets) {
  const c = config();
  const folder = validate(c);
  const name = 'luker-' + new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + randomUUID() + '.zip';
  const pending = new URL(name + '.partial', folder);
  const final = new URL(name, folder);
  status = { phase: 'uploading', name, bytes: 0, started: new Date().toISOString() };
  const source = new PassThrough();
  // Adapt the Express response contract used by createBackupArchive.
  source.attachment = () => source;
  source.status = () => source;
  source.send = value => source.destroy(new Error(value.error || 'Archive failed'));
  const meter = new Transform({ transform(chunk, enc, done) { status.bytes += chunk.length; done(null, chunk); } });
  source.on('error', e => meter.destroy(e));
  source.pipe(meter);
  try {
    const uploading = request(c, 'PUT', pending, meter, { 'Content-Type': 'application/zip', 'If-None-Match': '*' });
    uploading.catch(e => source.destroy(e));
    await Promise.all([uploading, host.createBackupArchive(user.profile.handle, source, { secrets: includeSecrets, globalExtensions: false, vectors: false })]);
    await request(c, 'MOVE', pending, null, { Destination: final.href, Overwrite: 'F' });
    status = { ...status, phase: 'uploaded', finished: new Date().toISOString() };
  } catch (e) {
    source.destroy(); meter.destroy();
    status = { ...status, phase: 'failed', error: e.message + '; remote .partial may remain' };
  } finally { busy = false; }
}
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebDAV 备份</title><style>body{font:16px system-ui;max-width:620px;margin:24px auto;padding:16px;background:#f4f6fa;color:#182234}input,button{box-sizing:border-box;padding:12px;margin:8px 0;width:100%;font:inherit}button{background:#245bd6;color:white;border:0;border-radius:8px}input[type=checkbox]{width:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{line-height:1.7;display:block}</style><h2>WebDAV 流式备份</h2><small>适配 Luker 2.8.0 的备份格式。读取已保存的数据，不创建本地 ZIP。请先结束生成和编辑。第一版手动上传，不提供自动清理或覆盖恢复。远端目录必须已存在，服务需支持流式 PUT 和 MOVE。</small><label>HTTPS WebDAV 完整目录地址<input id="url" placeholder="https://dav.example.com/Luker/"></label><label>用户名<input id="username" autocomplete="off"></label><label>密码<input id="password" type="password" placeholder="留空保留已保存密码" autocomplete="new-password"></label><small>凭据保存在本机服务端配置文件，不上传 GitHub。备份 ZIP 未加密，请使用私有目录。</small><button id="save">保存配置</button><button id="test">测试目录访问</button><label><input id="secrets" type="checkbox">包含 API 密钥文件（数据库导出范围由 Luker 决定）</label><button id="backup">确认目标并上传备份</button><button id="refresh">刷新任务状态</button><pre id="out">加载中</pre><small>上传成功只表示 WebDAV 接受文件，尚未验证恢复。到网盘下载 ZIP 后，用 Luker 的账户→备份与恢复导入；跨数据库恢复遵循 Luker 的要求。失败的 .partial 文件不是有效备份。</small><a href="/">返回 Luker</a><script>
const root='/api/plugins/webdav-backup';const el=id=>document.getElementById(id);let token='';
async function api(p,data){const r=await fetch(root+p,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-csrf-token':token},body:data===undefined?undefined:JSON.stringify(data)});const j=await r.json();if(!r.ok)throw Error(j.error||r.status);return j}
async function run(fn){try{el('out').textContent=JSON.stringify(await fn(),null,2)}catch(e){el('out').textContent=e.message}}
el('save').onclick=()=>run(()=>api('/config',{url:el('url').value,username:el('username').value,password:el('password').value}).then(j=>{el('password').value='';return j}));
el('test').onclick=()=>run(()=>api('/test',{}));el('refresh').onclick=()=>run(()=>api('/status'));
el('backup').onclick=()=>run(async()=>{const c=await api('/config');if(!confirm('上传当前用户的备份到已保存目录：'+c.url+'？请先保存页面中的修改。'))return {cancelled:true};return api('/backup',{secrets:el('secrets').checked})});
run(async()=>{token=(await(await fetch('/csrf-token')).json()).token;const c=await api('/config');el('url').value=c.url||'';el('username').value=c.username||'';return api('/status')});
</script></html>`;
export async function init(router) {
  host = await import(pathToFileURL(path.join(process.cwd(), 'src/users.js')).href);
  router.use((req,res,next) => { res.set('Cache-Control','no-store'); if(!req.user || !host.isRequestAdmin(req))return res.status(403).json({error:'Administrator access required'});next(); });
  const wrap = fn => async(req,res)=>{try{await fn(req,res)}catch(e){res.status(400).json({error:e.message})}};
  router.get('/', (_req,res)=>res.type('html').send(page));
  router.get('/config', wrap((_req,res)=>{const c=config();res.json({url:c.url||'',username:c.username||'',passwordSet:!!c.password})}));
  router.get('/status', (_req,res)=>res.json({version:'0.1.0',busy,...status}));
  router.post('/config', wrap((req,res)=>{if(busy)throw Error('Backup in progress');const b=req.body||{};const old=config();const c={url:String(b.url||'').trim(),username:String(b.username||''),password:String(b.password||old.password||'')};c.url=validate(c).href;const file=configPath();fs.writeFileSync(file+'.tmp',JSON.stringify(c),{mode:0o600});fs.renameSync(file+'.tmp',file);res.json({ok:true})}));
  router.post('/test', wrap(async(_req,res)=>{const c=config();const code=await request(c,'PROPFIND',validate(c),null,{Depth:'0'});res.json({ok:true,status:code,note:'Directory access only; streaming PUT and MOVE require an upload test'})}));
  router.post('/backup', wrap((req,res)=>{if(busy)return res.status(409).json({error:'Backup already running'});validate(config());busy=true;backup(req.user,req.body?.secrets===true).catch(()=>{busy=false;status={phase:'failed',error:'Backup initialization failed'}});res.status(202).json({started:true,note:'Refresh status to check completion'})}));
}
