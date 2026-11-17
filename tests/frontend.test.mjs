import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

// Execute the browser module in an isolated DOM. Only import.meta.url is replaced;
// all event handlers, configuration handling, requests and notifications are real.
const updateSource = readFileSync(new URL('../updates.js',import.meta.url),'utf8').replace('export function mountUpdates','function mountUpdates');
const source = updateSource + '\n' + readFileSync(new URL('../frontend.js', import.meta.url), 'utf8')
  .replace("import {mountUpdates} from './updates.js';",'')
  .replaceAll('import.meta.url', "'https://luker.test/scripts/extensions/third-party/webdav/frontend.js'");
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const selection = {settings:true,secrets:false,characters:true,chats:true,lorebooks:true,presets:true,assets:true,extensions:true,globalExtensions:false,vectors:false};
function harness(t, {toasts = true, popups = true, oldBackend = false} = {}) {
  const dom = new JSDOM('<div id="extensions_settings"></div>', {runScripts:'outside-only',pretendToBeVisual:true,url:'https://luker.test'});
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w,{AbortController,TextDecoder,TextEncoder});
  const config = {version:oldBackend ? '0.4.0' : '0.5.4',url:'https://dav.jianguoyun.com/dav/',username:'test',passwordSet:true,storageEngine:'fs',selection:{...selection},categories:Object.fromEntries(Object.keys(selection).map(key => [key,key]))};
  if (!oldBackend) Object.assign(config, {supportedUploadModes:['stream'],uploadMode:'stream',capabilities:{passwordReveal:true}});
  const h = {secret:'synthetic-application-password',dom,w,config,calls:[],notices:[],popups:[],alerts:[],confirmations:[],allow:false,fail:{},tasks:new Map(),nextTimer:100000,backupCount:0};
  h.status = {version:config.version,phase:'uploaded',busy:false,name:'old.zip',started:'2025-01-01',destination:config.url,bytes:100,remoteBytes:100,sizeVerification:'matched'};
  h.$ = selector => w.document.querySelector(selector);
  h.field = name => h.$(`[data-field="${name}"]`);
  h.view = name => h.$(`[data-view="${name}"]`);
  h.change = (name, value) => { h.field(name).value = value; h.field(name).dispatchEvent(new w.Event('change',{bubbles:true})); };
  h.click = async action => { h.$(`[data-action="${action}"]`).click(); await flush(); };
  h.open = async value => { h.$('.inline-drawer-icon').classList.replace(value ? 'down' : 'up', value ? 'up' : 'down'); await flush(); };
  h.tick = async () => { const jobs = [...h.tasks.values()]; h.tasks.clear(); for (const fn of jobs) fn(); await flush(); };
  h.hide = async value => { Object.defineProperty(w.document,'hidden',{configurable:true,value}); w.document.dispatchEvent(new w.Event('visibilitychange')); await flush(); };
  h.posted = route => h.calls.filter(call => call.route === route && call.options.method === 'POST');
  const set = w.setTimeout.bind(w), clear = w.clearTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => { if (ms === 2500) { const id = ++h.nextTimer; h.tasks.set(id, () => fn(...args)); return id; } return set(fn,ms,...args); };
  w.clearTimeout = id => { h.tasks.delete(id); clear(id); };
  w.alert = text => h.alerts.push(text);
  w.confirm = text => { h.confirmations.push(text); return h.allow; };
  const context = {eventSource:{on(){}},eventTypes:{APP_READY:'ready'}};
  if (popups) {
    context.POPUP_TYPE = {CONFIRM:1,TEXT:0};
    context.callGenericPopup = async (element, type) => {
      if (type === 1) { h.confirmations.push(element.textContent); return h.allow; }
      h.popups.push(element); return true;
    };
  }
  w.Luker = {getContext:() => context};
  if (toasts) w.toastr = Object.fromEntries(['success','error','warning','info'].map(tone => [tone,(text,title,options) => h.notices.push({tone,text,title,options})]));
  w.fetch = async (url, options = {}) => {
    const route = url.startsWith('/api/plugins/webdav-backup') ? url.slice('/api/plugins/webdav-backup'.length) : url;
    h.calls.push({route,options});
    if (h.holdStatus && route === '/status') return new Promise(resolve => {
      h.releaseStatus = () => resolve({ok:true,status:200,text:async () => JSON.stringify(h.status)});
    });
    const failure = h.fail[`${options.method || 'GET'} ${route}`];
    if (failure) return {ok:false,status:400,text:async () => JSON.stringify({error:failure})};
    let result;
    if (route.startsWith('https://raw.githubusercontent.com/')) return new Response(JSON.stringify({version:'0.5.4'}));
    if (route === '/password/reveal' && h.holdReveal) return new Promise(resolve=>{h.releaseReveal=()=>resolve({ok:true,status:200,text:async()=>JSON.stringify({password:h.secret})});});
    if (route === '/csrf-token') result = {token:'test'};
    else if (route === '/password/reveal') result={password:h.secret};
    else if (route === '/api/extensions/discover') result=[{name:'third-party/webdav',type:'global'}];
    else if (route === '/api/users/plugins/list') result={ok:true,plugins:[{directory:'backend-folder',remoteUrl:'https://github.com/Aouky7/webdav_luker'}]};
    else if (route === '/api/extensions/version') result={remoteUrl:'https://github.com/Aouky7/webdav_luker',currentBranchName:'main',currentCommitHash:'abc123',isUpToDate:true};
    else if (route === '/updates/lock') { h.config.updatePending=true; result={ok:true,token:'test-lock'}; }
    else if (route === '/updates/unlock') { h.config.updatePending=false; result={ok:true}; }
    else if (route === '/api/users/plugins/update') result={ok:true,plugin:{directory:'backend-folder',remoteUrl:'https://github.com/Aouky7/webdav_luker'},restartRecommended:true};
    else if (route === '/api/extensions/update') result={shortCommitHash:'def456',remoteUrl:'https://github.com/Aouky7/webdav_luker'};
    else if (route === '/status') result = {...h.status};
    else if (route === '/config') {
      if (options.method === 'POST') {
        const saved = JSON.parse(options.body);
        if (oldBackend) { delete saved.uploadMode; delete saved.stagingMaxMiB; }
        if (saved.password) h.secret=saved.password;
        delete saved.password; Object.assign(config,saved);
        if (config.url === 'https://dav.jianguoyun.com/dav/') config.url += 'LukerBackup/';
        result = {ok:true,url:config.url,uploadMode:config.uploadMode,stagingMaxMiB:config.stagingMaxMiB,note:'配置已保存，根目录已改为 /dav/LukerBackup/'};
      } else result = {...config};
    } else if (route === '/test') result = {ok:true,created:true,destination:config.url,note:'已自动创建目录；目录访问成功，不证明上传权限'};
    else if (route === '/backup') {
      h.backupCount++;
      h.status = {version:config.version,phase:h.instant ? 'uploaded' : 'preparing',busy:!h.instant,name:`task-${h.backupCount}.zip`,started:`2025-01-0${h.backupCount}`,destination:config.url,uploadMode:config.uploadMode,bytes:100,remoteBytes:100,sizeVerification:h.instant ? 'matched' : undefined,directoryCreated:true};
      result = {started:true,...h.status};
    } else if (route === '/backups') result = {files:[{name:'<img src=x onerror=alert(1)>.zip',bytes:100,modified:null}],limited:false};
    else if (route === '/verify') result = {name:JSON.parse(options.body).name,remoteBytes:100,expectedBytes:null,sizeVerification:'observed',verificationSource:'PROPFIND',verification:'缺少基准'};
    else throw new Error('Unexpected route ' + route);
    return {ok:true,status:200,json:async () => result,text:async () => JSON.stringify(result)};
  };
  w.eval(source);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return h;
}

test('integrated updater obtains CSRF and backend lock before changing exact host installs',async t=>{
  const h=harness(t);h.config.updateIdentity={directory:'backend-folder',repository:'https://github.com/Aouky7/webdav_luker'};
  await h.open(true);for(let i=0;i<8;i++)await flush();
  const install=h.$('[data-update="install"]');assert.equal(install.disabled,false);
  h.allow=true;install.click();for(let i=0;i<12;i++)await flush();
  const relevant=h.calls.filter(c=>['/updates/lock','/api/users/plugins/update','/api/extensions/update'].includes(c.route));
  assert.deepEqual(relevant.map(c=>c.route),['/updates/lock','/api/users/plugins/update','/api/extensions/update']);
  assert.ok(relevant.every(c=>c.options.headers['x-csrf-token']==='test'));
  assert.match(h.$('[data-update="result"]').textContent,/成功.*当前运行版本尚未改变/s);
  await h.click('backup');assert.equal(h.backupCount,0);assert.match(h.view('message').textContent,/更新待应用/);
});

test('saved password is fetched on eye click only; mask is never saved and typed stars remain a real password',async t=>{
  const h=harness(t);await h.open(true);
  assert.equal(h.field('password').value,'********');assert.equal(h.field('password').type,'password');
  assert.equal(h.posted('/password/reveal').length,0);
  await h.click('password-eye');assert.equal(h.field('password').value,h.secret);assert.equal(h.field('password').type,'text');
  await h.click('save');assert.equal(JSON.parse(h.posted('/config').at(-1).options.body).password,'');
  assert.equal(h.field('password').value,'********');
  h.change('password','********');await h.click('save');assert.equal(JSON.parse(h.posted('/config').at(-1).options.body).password,'********');
  assert.equal(h.secret,'********');
  assert.ok(h.notices.every(n=>!n.text.includes('synthetic-application-password')));
});

test('reveal response cannot overwrite edits or expose secret after hide, reload or failed fetch',async t=>{
  const h=harness(t);await h.open(true);h.holdReveal=true;
  await h.click('password-eye');assert.ok(h.releaseReveal);h.change('password','new-secret');h.releaseReveal();await flush();
  assert.equal(h.field('password').value,'new-secret');assert.equal(h.field('password').type,'password');
  h.allow=true;await h.click('reload');await h.click('password-eye');await h.hide(true);h.releaseReveal();await flush();
  assert.equal(h.field('password').type,'password');assert.equal(h.field('password').value,'********');
  await h.hide(false);h.holdReveal=false;h.fail['POST /password/reveal']='sensitive-remote-error';await h.click('password-eye');
  assert.ok(h.notices.every(n=>!n.text.includes('sensitive-remote-error')));
});

test('old backend allows toggling typed passwords but never invents the saved secret',async t=>{
  const h=harness(t,{oldBackend:true});await h.open(true);await h.click('password-eye');
  assert.equal(h.posted('/password/reveal').length,0);assert.match(h.view('message').textContent,/新版后端/);
  h.change('password','typed');await h.click('password-eye');assert.equal(h.field('password').type,'text');
  await h.hide(true);assert.equal(h.field('password').type,'password');assert.equal(h.field('password').value,'typed');
});

test('network failure details distinguish incomplete body from response wait and render as text', async t => {
  const h=harness(t);
  h.status={...h.status,phase:'failed',sizeVerification:undefined,error:'PUT 网络请求失败：ECONNRESET',networkDiagnostic:{method:'PUT',kind:'network',errorCode:'ECONNRESET',elapsedMs:115000,bodyBytes:141377967,uploadFinishedMs:null,responseStatus:null,reusedSocket:false}};
  await h.open(true);
  let text=h.view('metadata').textContent;
  assert.match(text,/115\.0 秒/);assert.match(text,/141377967 字节/);assert.match(text,/请求体发送完成未确认/);assert.match(text,/未收到响应头/);assert.match(text,/复用连接否/);
  h.status.networkDiagnostic={...h.status.networkDiagnostic,uploadFinishedMs:110000,responseStatus:503,errorCode:'<img src=x>'};
  await h.click('status');text=h.view('metadata').textContent;
  assert.match(text,/110\.0 秒/);assert.match(text,/HTTP 503/);assert.equal(h.view('metadata').querySelector('img'),null);
});

test('stream-only UI preserves dirty settings, reload, and a single upload confirmation', async t => {
  const h = harness(t);
  await h.open(true);
  assert.equal(h.notices.length,0,'historical terminal status is silent');
  assert.equal(h.$('#luker-webdav-panel-style').href,'https://luker.test/scripts/extensions/third-party/webdav/style.css?v=0.5.4');
  assert.equal(h.field('uploadMode'),null);
  assert.equal(h.field('stagingMaxMiB'),null);
  assert.equal(h.view('modeWarning'),null);
  h.change('username','changed');
  await h.click('backup');
  assert.equal(h.backupCount,0);assert.match(h.notices.at(-1).text,/未保存/);
  await h.click('save');
  const saved=JSON.parse(h.posted('/config').at(-1).options.body);
  assert.equal(saved.username,'changed');assert.equal('uploadMode' in saved,false);assert.equal('stagingMaxMiB' in saved,false);
  assert.equal(h.field('url').value,'https://dav.jianguoyun.com/dav/LukerBackup/');
  h.change('username','unsaved');await h.click('reload');assert.equal(h.field('username').value,'unsaved');
  h.allow=true;await h.click('reload');assert.equal(h.field('username').value,'changed');
  h.config.selection.globalExtensions=true;
  const count=h.confirmations.length;await h.click('backup');
  assert.equal(h.confirmations.length,count+1);assert.equal(h.backupCount,1);
  assert.match(h.confirmations.at(-1),/流式上传/);
  assert.match(h.confirmations.at(-1),/恢复时需以管理员身份/);
  assert.match(h.confirmations.at(-1),/服务端插件需单独安装/);
  assert.doesNotMatch(h.confirmations.at(-1),/兼容上传/);
});

test('old stream backend works; old staged backend requests update instead of starting hidden staging', async t => {
  const h=harness(t,{oldBackend:true});await h.open(true);h.allow=true;await h.click('backup');assert.equal(h.backupCount,1);
  const old=harness(t);Object.assign(old.config,{uploadMode:'staged',stagingAvailable:false,stagingWarning:'old failure'});
  await old.open(true);assert.equal(old.field('uploadMode'),null);assert.equal(old.view('modeWarning'),null);
  old.allow=true;await old.click('backup');assert.equal(old.backupCount,0);assert.match(old.notices.at(-1).text,/0\.5\.2/);
});

test('stream progress never claims total percent; terminal notification waits until not busy', async t => {
  const h=harness(t);
  h.status={...h.status,phase:'uploading',busy:true,bytes:1048576,totalBytes:4194304,archiveBytes:4194304};
  await h.open(true);assert.equal(h.view('bytes').textContent,'已发送 1.00 MiB');assert.doesNotMatch(h.view('bytes').textContent,/%/);
  assert.match(h.view('phase').textContent,/打包并上传/);
  assert.doesNotMatch(h.view('metadata').textContent,/本地 ZIP|ZIP 总大小/);
  h.status={...h.status,phase:'uploaded',sizeVerification:'matched'};await h.tick();assert.equal(h.notices.length,0);
  h.status.busy=false;await h.tick();assert.equal(h.notices.filter(n=>n.title==='备份完成').length,1);
});

test('terminal notices are once-only, continue collapsed, defer hidden and distinguish polling errors', async t => {
  const h = harness(t);
  await h.open(true);
  await h.click('backup');
  assert.equal(h.backupCount,0,'cancel upload does not POST');
  h.allow = true; h.instant = true;
  await h.click('backup');
  assert.equal(h.notices.filter(n => n.title === '备份完成').length,1);
  await h.click('status'); await h.click('status');
  assert.equal(h.notices.filter(n => n.title === '备份完成').length,1);
  h.instant = false;
  await h.click('backup'); await h.open(false);
  assert.equal(h.tasks.size,1);
  h.fail['GET /status'] = 'offline';
  await h.tick(); await h.tick();
  assert.equal(h.notices.filter(n => n.title === '状态连接中断').length,1);
  assert.equal(h.notices.filter(n => n.title === '备份失败').length,0);
  delete h.fail['GET /status'];
  h.status = {...h.status,phase:'uploaded',busy:false,sizeVerification:'mismatch',verification:'警告：大小不同'};
  await h.tick();
  assert.equal(h.notices.at(-1).title,'备份上传完成 · 大小异常');
  assert.equal(h.notices.at(-1).tone,'warning');
  assert.equal(h.tasks.size,0);
  await h.open(true);
  assert.equal(h.notices.filter(n => n.title === '备份上传完成 · 大小异常').length,1);
  await h.click('backup');
  h.status = {...h.status,phase:'failed',busy:false,error:'没有创建权限'};
  await h.tick();
  assert.equal(h.notices.at(-1).title,'备份失败');
  await h.click('backup');
  h.status = {...h.status,phase:'uploaded',busy:false,sizeVerification:'unknown',verification:'无法确认'};
  await h.tick();
  assert.equal(h.notices.at(-1).title,'备份上传完成 · 大小待确认');
  await h.click('backup'); await h.open(false); await h.hide(true);
  assert.equal(h.tasks.size,0);
  h.status = {...h.status,phase:'uploaded',busy:false,sizeVerification:'matched'};
  const completed = h.notices.filter(n => n.title === '备份完成').length;
  await h.click('status');
  assert.equal(h.notices.filter(n => n.title === '备份完成').length,completed);
  await h.hide(false);
  assert.equal(h.notices.filter(n => n.title === '备份完成').length,completed + 1);
  await h.hide(false);
  assert.equal(h.notices.filter(n => n.title === '备份完成').length,completed + 1);
});

test('existing feedback escapes text, redacts URL credentials and preserves cloud/status behavior', async t => {
  const h = harness(t);
  await h.open(true);
  await h.click('test');
  assert.equal(h.notices.at(-1).title,'连接成功 · 目录已创建');
  await h.click('reload');
  assert.equal(h.notices.at(-1).title,'配置已读取');
  for (const [route,action,title] of [['POST /config','save','保存配置失败'],['POST /test','test','连接测试失败'],['GET /config','reload','重新读取失败']]) {
    h.fail[route] = '<img src=x onerror=alert(1)> https://user:secret@dav.test/';
    await h.click(action);
    assert.equal(h.notices.at(-1).title,title);
    assert.equal(h.notices.at(-1).options.escapeHtml,true);
    assert.ok(!h.notices.at(-1).text.includes('secret'));
    delete h.fail[route];
  }
  await h.click('list');
  assert.equal(h.$('.wd-file-name').textContent,'<img src=x onerror=alert(1)>.zip');
  assert.equal(h.$('.wd-file-name img'),null);
  await h.click('verify');
  assert.equal(h.notices.at(-1).tone,'warning');
  const statusCount = h.calls.filter(call => call.route === '/status').length;
  h.holdStatus = true;
  h.$('[data-action="status"]').click();
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  await flush();
  assert.equal(h.calls.filter(call => call.route === '/status').length,statusCount + 1);
  h.holdStatus = false; h.releaseStatus(); await flush();
  assert.ok(h.notices.every(notice => notice.options.escapeHtml === true));
});

test('host text popup and native alert fallbacks remain safe', async t => {
  const fallback = harness(t,{toasts:false});
  await fallback.open(true);
  fallback.fail['POST /test'] = '<b>unsafe</b>';
  await fallback.click('test');
  assert.equal(fallback.popups.at(-1).querySelector('b'),null);
  assert.match(fallback.popups.at(-1).textContent,/<b>unsafe<\/b>/);
  const native = harness(t,{toasts:false,popups:false});
  await native.open(true);
  await native.click('save');
  assert.match(native.alerts.at(-1),/保存成功/);
});
