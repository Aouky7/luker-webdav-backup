// Luker WebDAV backup backend: stream ZIP output directly to WebDAV.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import { BACKUP_NAME, PROPERTIES, parseDav, listFiles, inspectSize, ensureDirectory } from './webdav.mjs';

export const info = { id: 'webdav-backup', name: 'WebDAV Backup', description: 'Streaming WebDAV backups with an in-app companion extension' };
const VERSION = '0.5.3';
const DEFAULTS = { settings:true, secrets:false, characters:true, chats:true, lorebooks:true, presets:true, assets:true, extensions:true, globalExtensions:false, vectors:false };
const CATEGORIES = { settings:'设置', secrets:'API 密钥 / 机密', characters:'角色 / 头像 / 背景', chats:'聊天 / 群组', lorebooks:'世界书', presets:'预设 / 界面布局', assets:'素材 / 文件', extensions:'用户扩展', globalExtensions:'全局前端扩展（管理员）', vectors:'向量索引' };
let host, storageModule;
let busy = false;
let directoryTesting = false;
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
  try {
    const segments = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments.some(s => /[\\/\\\\\u0000-\u001f\u007f]/.test(s) || s === '.' || s === '..')) throw new Error();
  } catch { throw new Error('目录路径包含无效编码、分隔符或控制字符'); }
  if (u.hostname.toLowerCase() === 'dav.jianguoyun.com') {
    if (/^\/dav\/*$/i.test(u.pathname)) u.pathname = '/dav/LukerBackup/';
    if (!u.pathname.startsWith('/dav/')) throw new Error('坚果云目录地址必须位于 /dav/ 下');
  }
  if (String(c.username || '').includes(':')) throw new Error('用户名不能包含冒号');
  return u;
}
export function request(c, method, target, body = null, headers = {}, timeout = 1800000) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));
    const knownCodes = new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','EPIPE','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ERR_STREAM_PREMATURE_CLOSE','ERR_STREAM_DESTROYED','ERR_STREAM_WRITE_AFTER_END','ABORT_ERR','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
    const codeOf = error => knownCodes.has(error?.code) ? error.code : null;
    let settled = false, sent = !body, received = false, result, req, timer, counter, responseEnded = false;
    let bodyBytes = 0, uploadFinishedMs = null, responseStartedMs = null, responseStatus = null, sourceError;
    const fail = (error, kind, original = error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const errorCode = codeOf(original);
      if (errorCode) error.code = errorCode;
      error.networkDiagnostic = {
        method:['PUT','MOVE','PROPFIND','HEAD','GET','MKCOL'].includes(method) ? method : 'OTHER',
        kind, errorCode, elapsedMs:elapsed(), bodyBytes,
        uploadFinishedMs, responseStartedMs, responseStatus,
        reusedSocket:typeof req?.reusedSocket === 'boolean' ? req.reusedSocket : null,
        idleTimeoutMs:120000, totalTimeoutMs:timeout,
      };
      reject(error);
      if (body && typeof body.destroy === 'function') body.destroy();
      counter?.destroy(); req?.destroy();
    };
    const complete = () => {
      if (!settled && sent && received) { settled = true; clearTimeout(timer); resolve(result); }
    };
    const streamFailure = error => {
      const code = codeOf(error);
      fail(new Error(method + ' 上传数据流中断' + (code ? '：' + code : '')), code === 'ERR_STREAM_PREMATURE_CLOSE' ? 'premature-close' : 'stream', error);
    };
    try {
      req = https.request(target, {
        method,
        headers: { Authorization:'Basic ' + Buffer.from((c.username || '') + ':' + (c.password || '')).toString('base64'), ...(typeof body === 'string' ? {'Content-Length':Buffer.byteLength(body)} : {}), ...headers },
      }, response => {
        responseStartedMs = elapsed();
        const code = response.statusCode || 0;
        responseStatus = Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
        // Install even on rejected HTTP responses: request destruction can emit
        // a later response error, which must not mask the explicit HTTP status.
        response.on('error', error => fail(new Error(method + ' 响应读取失败' + (codeOf(error) ? '：' + codeOf(error) : '')), 'response', error));
        if (code < 200 || code >= 300) {
          response.resume();
          const hint = code >= 300 && code < 400 ? '（不支持重定向，请填写最终 HTTPS WebDAV 地址）' : code === 404 ? '（目标不存在，请检查目录地址）' : code === 401 || code === 403 ? '（检查应用密码和目录权限）' : code === 411 ? '（服务要求明确文件长度，本插件仅支持未知长度的流式上传）' : code === 413 ? '（服务器或代理拒绝此大小的文件，请检查上传大小限制）' : code === 507 ? '（云端空间不足）' : method === 'MOVE' && [405,501].includes(code) ? '（服务不支持 MOVE 改名；.partial 不是有效完成备份）' : '';
          fail(Object.assign(new Error(method + ' HTTP ' + code + hint), {statusCode:code}), 'http'); return;
        }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 2097152) { fail(new Error(method + ' 响应超过 2 MiB，无法完整读取目录'), 'response-limit'); response.destroy(); return; }
          chunks.push(chunk);
        });
        // Node may emit aborted before error(ECONNRESET); let the original error win.
        response.on('aborted', () => setImmediate(() => fail(new Error(method + ' 响应中断'), 'premature-close')));
        response.on('close', () => { if (!responseEnded) setImmediate(() => fail(new Error(method + ' 响应提前关闭'), 'premature-close')); });
        response.on('end', () => { responseEnded = true; result = {code, headers:response.headers, text:Buffer.concat(chunks).toString('utf8')}; received = true; complete(); });
      });
      req.on('error', error => {
        if (error === sourceError) { streamFailure(error); return; }
        fail(new Error(method + ' 网络请求失败：' + (codeOf(error) || '连接中断')), 'network', error);
      });
      req.on('finish', () => { uploadFinishedMs = elapsed(); });
      req.on('close', () => { if (!received) setImmediate(() => fail(new Error(method + ' 请求提前关闭'), 'premature-close')); });
      req.setTimeout(120000, () => fail(new Error(method + ' 连接空闲超时'), 'idle-timeout'));
      timer = setTimeout(() => fail(new Error(method + ' 超过任务时限'), 'total-timeout'), timeout);
      if (body && typeof body.pipe === 'function') {
        // Observe source errors without putting it in flowing mode. The Transform
        // preserves backpressure; these are application bytes, not TCP acknowledgments.
        body.once('error', error => { sourceError = error; });
        counter = new Transform({transform(chunk,encoding,done) {
          bodyBytes = Math.min(Number.MAX_SAFE_INTEGER, bodyBytes + chunk.length);
          done(null,chunk);
        }});
        pipeline(body, counter, req).then(() => { sent = true; complete(); }, error => {
          // Request error/HTTP response callbacks retain the strongest evidence.
          setImmediate(() => streamFailure(error));
        });
      } else if (body) {
        bodyBytes = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength || 0;
        req.end(body, () => { sent = true; complete(); });
      } else req.end();
    } catch (error) {
      fail(new Error(method + ' 请求初始化失败' + (codeOf(error) ? '：' + codeOf(error) : '')), 'setup', error);
    }
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
  status = {phase:'preparing',name,destination:folder.href,selection:chosen,bytes:0,started:new Date().toISOString()};
  persistStatus();
  let source, meter, forwarding, uploading;
  const produce = stream => host.createBackupArchive(user.profile.handle,stream,chosen,{includeGlobalExtensions:user.profile.admin === true || host.isRequestAdmin({user})});
  try {
    const directory = await ensureDirectory(request,c,folder);
    status.directoryCreated = directory.created;
    source = new PassThrough();
    source.attachment = () => source; source.status = () => source;
    source.send = () => source.destroy(new Error('Luker 归档失败，请查看服务端日志'));
    meter = new Transform({transform(chunk,encoding,done) { status.bytes += chunk.length; done(null,chunk); }});
    forwarding = pipeline(source,meter); forwarding.catch(() => {});
    status.phase = 'uploading'; persistStatus();
    uploading = request(c,'PUT',pending,meter,{'Content-Type':'application/zip','If-None-Match':'*'});
    uploading.catch(() => source.destroy());
    await Promise.all([uploading,forwarding,Promise.resolve().then(() => produce(source))]);
    status.phase = 'renaming'; persistStatus();
    await request(c,'MOVE',pending,null,{Destination:final.href,Overwrite:'F'},60000);
    status.phase = 'verifying'; persistStatus();
    const verification = await inspectSize(request,c,final,status.bytes);
    status = {...status,phase:'uploaded',...verification,finished:new Date().toISOString()};
  } catch (e) {
    source?.destroy(); meter?.destroy();
    const outcomes = await Promise.allSettled([forwarding,uploading]);
    const transportError = outcomes[1].status === 'rejected' ? outcomes[1].reason : null;
    // Destroying the request also rejects the forwarding pipeline. Prefer the
    // recorded request failure over that secondary premature-close symptom.
    if (!e.networkDiagnostic && transportError?.networkDiagnostic &&
        (transportError.networkDiagnostic.kind === 'http' || transportError.networkDiagnostic.kind === 'network' ||
         ['ERR_STREAM_PREMATURE_CLOSE','ERR_STREAM_DESTROYED'].includes(e.code))) e = transportError;
    const networkDiagnostic = e.networkDiagnostic || transportError?.networkDiagnostic;
    const failureStage = status.phase;
    const note = ['preparing','packing'].includes(failureStage) ? '未上传备份数据；已创建的空目录会保留' : failureStage === 'renaming' ? '上传已完成，但改名结果未确认；请检查远端 .partial 和最终 .zip，未核验前请勿依赖此备份' : failureStage === 'verifying' ? '最终 .zip 已完成改名，但核验未完成；请检查云端文件后再使用' : '失败时远端可能留有 .partial 文件，请勿将其作为有效备份';
    status = {...status,phase:'failed',failureStage,error:String(e.message || e),...(networkDiagnostic ? {networkDiagnostic} : {}),note,finished:new Date().toISOString()};
  } finally {
    busy = false; persistStatus();
  }
}

export async function init(router) {
  host = await import(pathToFileURL(path.join(process.cwd(), 'src/users.js')).href);
  storageModule = await import(pathToFileURL(path.join(process.cwd(), 'src/storage/index.js')).href);
  if (typeof host.createBackupArchive !== 'function') throw new Error('Unsupported Luker backup API');
  try {
    status = readJson('_webdav-backup-status.json', {phase:'idle'});
    if (['preparing','packing','uploading','renaming','verifying'].includes(status.phase)) {
      const failureStage = status.phase;
      const error = ['preparing','packing'].includes(failureStage) ? '上次任务在上传前因后端重启中断，未上传备份数据' : failureStage === 'renaming' ? '上次任务在改名阶段中断；请检查远端 .partial 和最终 .zip，改名结果未确认' : failureStage === 'verifying' ? '上次任务在核验阶段中断；最终 .zip 已改名，但核验未完成' : '上次上传因后端重启中断；远端可能存在 .partial 文件';
      status = {...status,phase:'interrupted',failureStage,error}; persistStatus();
    }
  } catch { status = {phase:'idle', warning:'无法读取上次任务记录'}; }
  router.use((req,res,next) => {
    res.set('Cache-Control','no-store');
    if (!req.user || !host.isRequestAdmin(req)) return res.status(403).json({error:'需要在当前 Luker 中登录管理员账号'});
    next();
  });
  const wrap = fn => async(req,res) => { try { await fn(req,res); } catch (e) { if (!res.headersSent) res.status(400).json({error:String(e.message || e)}); } };
  router.get('/', (_req,res) => res.type('html').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebDAV 备份</title><body style="font:18px system-ui;padding:24px"><h2>WebDAV 后端已运行</h2><p>0.5.3 使用 Luker 内置扩展面板。请将同一 GitHub 仓库安装为前端扩展，然后在扩展列表中打开 WebDAV 备份。</p><a href="/">返回 Luker</a></body></html>'));
  router.get('/config', wrap((_req,res) => {
    const c = config();
    res.json({version:VERSION,uploadMode:'stream',supportedUploadModes:['stream'],url:c.url || '',username:c.username || '',passwordSet:!!c.password,selection:selection(c.selection),categories:CATEGORIES,storageEngine:storageModule.getStorageEngine().kind});
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
    if (busy || directoryTesting) return res.status(409).json({error:'备份或目录检查进行中，请完成后再修改配置'});
    const b = req.body || {}, old = config();
    const c = {...old,url:String(b.url || '').trim(),username:String(b.username || ''),password:String(b.password || old.password || ''),selection:selection(b.selection || old.selection)};
    delete c.uploadMode; delete c.stagingMaxMiB;
    const originalUrl = c.url;
    c.url = validate(c).href;
    writeJson('_webdav-backup.json', c);
    const adjusted = new URL(c.url).hostname === 'dav.jianguoyun.com' && /^https:\/\/dav\.jianguoyun\.com(?::443)?\/dav\/*$/i.test(originalUrl);
    res.json({ok:true,url:c.url,uploadMode:'stream',note:adjusted ? '配置已保存；坚果云根地址已设为 /dav/LukerBackup/，测试连接或备份时将自动创建目录' : '配置已保存；测试连接或备份时将自动创建缺失目录，密码不会返回前端'});
  }));
  router.post('/test', wrap(async(_req,res) => {
    if (busy || directoryTesting) return res.status(409).json({error:'备份或目录检查正在进行，请稍后再试'});
    directoryTesting = true;
    try {
      const c = config(), target = validate(c);
      const result = await ensureDirectory(request,c,target);
      res.json({ok:true,...result,note:(result.created ? '已自动创建备份目录，连接测试成功。' : '目录已存在，连接测试成功。') + '此测试未上传备份数据；上传与改名权限仍需真实备份验证。'});
    } finally { directoryTesting = false; }
  }));
  router.post('/backup', wrap((req,res) => {
    if (busy || directoryTesting) return res.status(409).json({error:'已有备份或目录检查运行中'});
    const c = config(), folder = validate(c), chosen = selection(req.body?.selection || c.selection);
    if (!Object.values(chosen).some(Boolean)) throw new Error('请至少选择一个备份分类');
    busy = true;
    backup(req.user, chosen, c, folder).catch(() => { busy = false; status = {phase:'failed',error:'备份初始化失败'}; persistStatus(); });
    res.status(202).json({started:true,...snapshot()});
  }));
}
