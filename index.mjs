// Luker WebDAV backup backend. User data is streamed, never staged as a local ZIP.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BACKUP_NAME, PROPERTIES, parseDav, listFiles, inspectSize } from './webdav.mjs';

export const info = { id: 'webdav-backup', name: 'WebDAV Backup', description: 'Streaming WebDAV backups with an in-app companion extension' };
const VERSION = '0.3.0';
const DEFAULTS = { settings:true, secrets:false, characters:true, chats:true, lorebooks:true, presets:true, assets:true, extensions:true, globalExtensions:false, vectors:false };
const CATEGORIES = { settings:'设置', secrets:'API 密钥 / 机密', characters:'角色 / 头像 / 背景', chats:'聊天 / 群组', lorebooks:'世界书', presets:'预设 / 界面布局', assets:'素材 / 文件', extensions:'用户扩展', globalExtensions:'全局前端扩展（管理员）', vectors:'向量索引' };
let host, storageModule;
let busy = false;
let status = { phase:'idle' };
const file = name => path.join(globalThis.DATA_ROOT, name);
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('无法读取插件配置或状态文件：' + name); }
}
function writeJson(name, value) {
  const target = file(name), temp = target + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), {mode:0o600}); fs.renameSync(temp, target); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
const config = () => readJson('_webdav-backup.json', {});
function selection(input) {
  const result = {...DEFAULTS};
  if (input && typeof input === 'object') for (const key of Object.keys(result)) if (typeof input[key] === 'boolean') result[key] = input[key];
  return result;
}
function validate(c) {
  let u;
  try { u = new URL(c.url); } catch { throw new Error('请填写完整的 HTTPS WebDAV 目录地址'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('地址必须使用 HTTPS，且不能内嵌密码、查询参数或片段');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  if (u.hostname.toLowerCase() === 'dav.jianguoyun.com' && /^\/dav\/*$/i.test(u.pathname)) throw new Error('坚果云根目录不能直接上传文件。请先创建专用文件夹，并使用 /dav/文件夹名/ 地址');
  if (String(c.username || '').includes(':')) throw new Error('用户名不能包含冒号');
  return u;
}
function request(c, method, target, body = null, headers = {}, timeout = 1800000) {
  return new Promise((resolve, reject) => {
    let settled = false, sent = !body, received = false, result, req, timer;
    const fail = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (body && typeof body.destroy === 'function') body.destroy(); req?.destroy(); reject(error);
    };
    const complete = () => {
      if (!settled && sent && received) { settled = true; clearTimeout(timer); resolve(result); }
    };
    req = https.request(target, {
      method,
      headers: { Authorization:'Basic ' + Buffer.from((c.username || '') + ':' + (c.password || '')).toString('base64'), ...(typeof body === 'string' ? {'Content-Length':Buffer.byteLength(body)} : {}), ...headers },
    }, response => {
      const code = response.statusCode || 0;
      if (code < 200 || code >= 300) {
        response.resume();
        const hint = code === 404 ? '（检查目录是否存在；坚果云须使用子目录）' : code === 401 || code === 403 ? '（检查应用密码和目录权限）' : code === 411 ? '（服务不接受未知长度的流式上传）' : '';
        fail(new Error(method + ' HTTP ' + code + hint)); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2097152) { response.destroy(); fail(new Error(method + ' 响应超过 2 MiB，无法完整读取目录')); return; }
        chunks.push(chunk);
      });
      response.on('error', () => fail(new Error(method + ' 响应读取失败')));
      response.on('aborted', () => fail(new Error(method + ' 响应中断')));
      response.on('end', () => { result = {code, headers:response.headers, text:Buffer.concat(chunks).toString('utf8')}; received = true; complete(); });
    });
    req.on('error', e => fail(new Error(method + ' 网络请求失败：' + (e.code || '连接中断'))));
    req.setTimeout(120000, () => fail(new Error(method + ' 连接空闲超时')));
    timer = setTimeout(() => fail(new Error(method + ' 超过任务时限')), timeout);
    if (body && typeof body.pipe === 'function') {
      pipeline(body, req).then(() => { sent = true; complete(); }, () => fail(new Error(method + ' 上传数据流中断')));
    } else if (body) {
      req.end(body, () => { sent = true; complete(); });
    } else req.end();
  });
}
function persistStatus() {
  try { writeJson('_webdav-backup-status.json', status); }
  catch { console.error('[webdav-backup] Could not persist task status'); }
}
function snapshot() { return {version:VERSION, busy, ...status}; }
async function backup(user, chosen, c, folder) {
  const name = 'luker-' + new Date().toISOString().replaceAll(':','-').replaceAll('.','-') + '-' + randomUUID() + '.zip';
  const pending = new URL(name + '.partial', folder), final = new URL(name, folder);
  status = { phase:'uploading', name, destination:folder.href, selection:chosen, bytes:0, started:new Date().toISOString() };
  persistStatus();
  const source = new PassThrough();
  // Host createBackupArchive expects an Express-like writable response.
  source.attachment = () => source;
  source.status = () => source;
  source.send = () => source.destroy(new Error('Luker 归档失败，请查看服务端日志'));
  const meter = new Transform({ transform(chunk, encoding, done) { status.bytes += chunk.length; done(null, chunk); } });
  const forwarding = pipeline(source, meter);
  forwarding.catch(() => {});
  try {
    const uploading = request(c, 'PUT', pending, meter, {'Content-Type':'application/zip','If-None-Match':'*'});
    uploading.catch(() => source.destroy());
    await Promise.all([
      uploading,
      forwarding,
      host.createBackupArchive(user.profile.handle, source, chosen, {includeGlobalExtensions:user.profile.admin === true || host.isRequestAdmin({user})}),
    ]);
    status.phase = 'renaming'; persistStatus();
    await request(c, 'MOVE', pending, null, {Destination:final.href, Overwrite:'F'}, 60000);
    status.phase = 'verifying'; persistStatus();
    const verification = await inspectSize(request, c, final, status.bytes);
    status = {...status, phase:'uploaded', ...verification, finished:new Date().toISOString()};
  } catch (e) {
    source.destroy(); meter.destroy();
    status = {...status, phase:'failed', error:String(e.message || e), note:'失败时远端可能留有 .partial 文件，请勿将其作为有效备份', finished:new Date().toISOString()};
  } finally { busy = false; persistStatus(); }
}

export async function init(router) {
  host = await import(pathToFileURL(path.join(process.cwd(), 'src/users.js')).href);
  storageModule = await import(pathToFileURL(path.join(process.cwd(), 'src/storage/index.js')).href);
  if (typeof host.createBackupArchive !== 'function') throw new Error('Unsupported Luker backup API');
  try {
    status = readJson('_webdav-backup-status.json', {phase:'idle'});
    if (['uploading','renaming','verifying'].includes(status.phase)) {
      status = {...status, phase:'interrupted', error:'上次任务因后端重启中断；远端可能存在未完成文件'}; persistStatus();
    }
  } catch { status = {phase:'idle', warning:'无法读取上次任务记录'}; }
  router.use((req,res,next) => {
    res.set('Cache-Control','no-store');
    if (!req.user || !host.isRequestAdmin(req)) return res.status(403).json({error:'需要在当前 Luker 中登录管理员账号'});
    next();
  });
  const wrap = fn => async(req,res) => { try { await fn(req,res); } catch (e) { if (!res.headersSent) res.status(400).json({error:String(e.message || e)}); } };
  router.get('/', (_req,res) => res.type('html').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebDAV 备份</title><body style="font:18px system-ui;padding:24px"><h2>WebDAV 后端已运行</h2><p>0.3.0 使用 Luker 内置扩展面板。请将同一 GitHub 仓库安装为前端扩展，然后在扩展列表中打开 WebDAV 备份。</p><a href="/">返回 Luker</a></body></html>'));
  router.get('/config', wrap((_req,res) => {
    const c = config();
    res.json({version:VERSION,url:c.url || '',username:c.username || '',passwordSet:!!c.password,selection:selection(c.selection),categories:CATEGORIES,storageEngine:storageModule.getStorageEngine().kind});
  }));
  router.get('/status', (_req,res) => res.json(snapshot()));
  router.get('/backups', wrap(async(_req,res) => {
    const c = config(), folder = validate(c);
    const remote = await request(c,'PROPFIND',folder,PROPERTIES,{Depth:'1','Content-Type':'application/xml; charset=utf-8'},60000);
    const files = listFiles(parseDav(remote.text),folder);
    res.json({files:files.slice(0,200),limited:files.length > 200});
  }));
  router.post('/verify', wrap(async(req,res) => {
    if (busy) return res.status(409).json({error:'备份进行中，请完成后再复核'});
    const name = req.body?.name;
    if (typeof name !== 'string' || !BACKUP_NAME.test(name)) throw new Error('只能复核本插件命名的 ZIP 文件');
    const c = config(), folder = validate(c);
    const task = status;
    const known = task.name === name && task.destination === folder.href && task.phase === 'uploaded';
    const result = await inspectSize(request,c,new URL(name,folder),known ? task.bytes : null);
    // A concurrent backup must never have its state replaced by this older query.
    if (known && status === task && !busy) { status = {...task,...result}; persistStatus(); }
    res.json({name,...result});
  }));
  router.post('/config', wrap((req,res) => {
    if (busy) return res.status(409).json({error:'备份进行中，请完成后再修改配置'});
    const b = req.body || {}, old = config();
    const c = {...old,url:String(b.url || '').trim(),username:String(b.username || ''),password:String(b.password || old.password || ''),selection:selection(b.selection || old.selection)};
    c.url = validate(c).href;
    writeJson('_webdav-backup.json', c);
    res.json({ok:true,note:'配置已保存；密码不会返回前端'});
  }));
  router.post('/test', wrap(async(_req,res) => {
    const c = config(), target = validate(c);
    const result = await request(c,'PROPFIND',target,null,{Depth:'0'},60000);
    if (result.code === 207 && !/HTTP\/\d(?:\.\d)?\s+2\d\d\b/i.test(result.text)) throw new Error('PROPFIND 返回 207，但未确认目录属性成功，请检查路径与权限');
    res.json({ok:true,note:'目录读取成功。此测试不会上传用户数据，也不证明 PUT/MOVE 写入权限；需真实备份验证。'});
  }));
  router.post('/backup', wrap((req,res) => {
    if (busy) return res.status(409).json({error:'已有备份任务运行中'});
    const c = config(), folder = validate(c), chosen = selection(req.body?.selection || c.selection);
    if (!Object.values(chosen).some(Boolean)) throw new Error('请至少选择一个备份分类');
    busy = true;
    backup(req.user, chosen, c, folder).catch(() => { busy = false; status = {phase:'failed',error:'备份初始化失败'}; persistStatus(); });
    res.status(202).json({started:true,...snapshot()});
  }));
}
