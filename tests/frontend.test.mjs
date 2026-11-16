import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

// Execute the browser module in an isolated DOM. Only import.meta.url is replaced;
// all event handlers, configuration handling, requests and notifications are real.
const source = readFileSync(new URL('../frontend.js', import.meta.url), 'utf8').replace(
  "new URL('./style.css', import.meta.url)",
  "new URL('./style.css', 'https://luker.test/scripts/extensions/webdav/frontend.js')",
);
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const selection = {settings:true,secrets:false,characters:true,chats:true,lorebooks:true,presets:true,assets:true,extensions:true,globalExtensions:false,vectors:false};
function harness(t, {toasts = true, popups = true, oldBackend = false} = {}) {
  const dom = new JSDOM('<div id="extensions_settings"></div>', {runScripts:'outside-only',pretendToBeVisual:true,url:'https://luker.test'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const config = {version:oldBackend ? '0.4.0' : '0.5.0',url:'https://dav.jianguoyun.com/dav/',username:'test',passwordSet:true,storageEngine:'fs',selection:{...selection},categories:Object.fromEntries(Object.keys(selection).map(key => [key,key]))};
  if (!oldBackend) Object.assign(config, {supportedUploadModes:['stream','staged'],uploadMode:'stream',stagingMaxMiB:1024});
  const h = {dom,w,config,calls:[],notices:[],popups:[],alerts:[],confirmations:[],allow:false,fail:{},tasks:new Map(),nextTimer:100000,backupCount:0};
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
    if (route === '/csrf-token') result = {token:'test'};
    else if (route === '/status') result = {...h.status};
    else if (route === '/config') {
      if (options.method === 'POST') {
        const saved = JSON.parse(options.body);
        if (oldBackend) { delete saved.uploadMode; delete saved.stagingMaxMiB; }
        Object.assign(config,saved);
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

test('mode defaults, dirty protection, persisted save/reload and one staged upload confirmation', async t => {
  const h = harness(t);
  await h.open(true);
  assert.equal(h.notices.length,0,'historical terminal status is silent');
  assert.equal(h.$('#luker-webdav-panel-style').href,'https://luker.test/scripts/extensions/webdav/style.css?v=0.5.0');
  assert.equal(h.field('uploadMode').value,'stream');
  assert.equal(h.field('stagingMaxMiB').value,'1024');
  assert.equal(h.view('stagingLimit').hidden,true);
  assert.equal(h.view('modeWarning').hidden,true);
  assert.match(h.view('modeHint').textContent,/不在本地保存/);
  h.change('uploadMode','staged');
  h.change('stagingMaxMiB','2048');
  assert.equal(h.view('stagingLimit').hidden,false);
  assert.match(h.view('modeHint').textContent,/完整 ZIP/);
  await h.click('backup');
  assert.equal(h.backupCount,0);
  assert.match(h.notices.at(-1).text,/未保存/);
  await h.click('save');
  const saved = JSON.parse(h.posted('/config').at(-1).options.body);
  assert.equal(saved.uploadMode,'staged');
  assert.equal(saved.stagingMaxMiB,2048);
  assert.equal(h.field('url').value,'https://dav.jianguoyun.com/dav/LukerBackup/');
  assert.equal(h.notices.at(-1).title,'保存成功');
  await h.click('reload');
  assert.equal(h.field('uploadMode').value,'staged');
  assert.equal(h.field('stagingMaxMiB').value,'2048');
  h.change('uploadMode','stream');
  await h.click('reload');
  assert.equal(h.field('uploadMode').value,'stream','cancel discard retains dirty mode');
  h.allow = true;
  await h.click('reload');
  assert.equal(h.field('uploadMode').value,'staged');
  const confirmsBefore = h.confirmations.length;
  await h.click('backup');
  assert.equal(h.confirmations.length,confirmsBefore + 1,'no additional upload confirmation');
  assert.match(h.confirmations.at(-1),/兼容上传.*2048 MiB/);
  assert.equal(h.backupCount,1);
  assert.match(h.notices.find(n => n.title === '备份已启动').text,/兼容上传.*先生成本地 ZIP/);
  h.status = {...h.status,phase:'uploaded',busy:false,sizeVerification:'matched'};
  await h.tick();
  assert.match(h.notices.find(n => n.title === '备份完成').text,/兼容上传/);
  await h.click('status');
  assert.equal(h.notices.filter(n => n.title === '备份完成').length,1);
});

test('old backend keeps stream usable and cannot silently accept staged; capability loss blocks writes', async t => {
  const h = harness(t,{oldBackend:true});
  await h.open(true);
  assert.equal(h.field('uploadMode').value,'stream');
  assert.equal(h.field('stagingMaxMiB').value,'1024');
  assert.equal(h.field('uploadMode').querySelector('[value="staged"]').disabled,true);
  assert.equal(h.view('modeWarning').hidden,false);
  assert.match(h.view('modeWarning').textContent,/0\.5\.0/);
  await h.click('save');
  h.allow = true;
  await h.click('backup');
  assert.equal(h.backupCount,1,'old backend still supports existing stream path');
  assert.match(h.confirmations.at(-1),/流式上传/);
  assert.match(h.notices.find(n => n.title === '备份已启动').text,/流式上传/);
  h.change('uploadMode','staged'); // Programmatic tampering must also fail closed.
  const writes = h.posted('/config').length;
  await h.click('save');
  assert.equal(h.posted('/config').length,writes);
  assert.match(h.notices.at(-1).text,/0\.5\.0/);
  const fresh = harness(t);
  await fresh.open(true);
  fresh.change('uploadMode','staged');
  delete fresh.config.supportedUploadModes;
  await fresh.click('save');
  assert.equal(fresh.posted('/config').length,0,'capability is rechecked before staged save');
  assert.match(fresh.notices.at(-1).text,/0\.5\.0/);
});

test('staging availability failure blocks only staged and cleanup warnings are once-only warnings', async t => {
  const h = harness(t);
  Object.assign(h.config,{uploadMode:'staged',stagingAvailable:false,stagingWarning:'暂存目录清理失败，请检查权限'});
  await h.open(true);
  assert.equal(h.field('uploadMode').value,'staged','do not silently replace the saved mode');
  assert.equal(h.field('uploadMode').querySelector('[value="staged"]').disabled,true);
  assert.match(h.view('modeWarning').textContent,/清理失败/);
  h.allow = true;
  await h.click('backup');
  assert.equal(h.backupCount,0);
  assert.match(h.notices.at(-1).text,/暂不可用/);
  await h.click('save');
  assert.equal(h.posted('/config').length,0);
  h.change('uploadMode','stream');
  await h.click('save');
  await h.click('backup');
  assert.equal(h.backupCount,1,'stream remains usable when staging unavailable');
  // Terminal data can become visible while backend cleanup is still running.
  h.status = {...h.status,uploadMode:'staged',phase:'uploaded',busy:true,sizeVerification:'matched'};
  await h.tick();
  assert.equal(h.notices.filter(n => n.title.startsWith('备份完成')).length,0);
  h.status = {...h.status,busy:false,cleanupWarning:'本地临时 ZIP 清理失败'};
  await h.tick();
  const notice = h.notices.at(-1);
  assert.equal(notice.title,'备份完成 · 本地清理警告');
  assert.equal(notice.tone,'warning');
  assert.match(notice.text,/兼容上传.*远端大小一致/);
  assert.match(notice.text,/清理失败/);
  assert.match(h.view('verification').textContent,/清理失败/);
  assert.match(h.view('phase').textContent,/本地清理警告/);
  await h.click('status');
  assert.equal(h.notices.filter(n => n.title === notice.title).length,1);
});

test('staging bounds are validated and external saved-mode changes require reload', async t => {
  const h = harness(t);
  await h.open(true);
  h.change('uploadMode','staged');
  for (const value of ['','63','65537','64.5']) {
    h.change('stagingMaxMiB',value);
    const count = h.posted('/config').length;
    await h.click('save');
    assert.equal(h.posted('/config').length,count);
    assert.match(h.notices.at(-1).text,/64–65536/);
  }
  for (const value of ['64','65536']) {
    h.change('stagingMaxMiB',value);
    await h.click('save');
    assert.equal(h.config.stagingMaxMiB,Number(value));
  }
  h.config.uploadMode = 'stream';
  h.allow = true;
  await h.click('backup');
  assert.equal(h.backupCount,0);
  assert.match(h.notices.at(-1).text,/配置已变化/);
});

test('packing remains active with no percent; staged upload has known progress and stream never does', async t => {
  const h = harness(t);
  h.status = {...h.status,uploadMode:'staged',phase:'packing',busy:false,archiveBytes:1048576,totalBytes:null,bytes:0};
  await h.open(true);
  assert.match(h.view('phase').textContent,/生成本地 ZIP/);
  assert.match(h.view('bytes').textContent,/已生成 1\.00 MiB/);
  assert.match(h.view('bytes').textContent,/尚未上传/);
  assert.ok(!h.view('bytes').textContent.includes('%'));
  assert.equal(h.tasks.size,1,'packing is active even without busy flag');
  h.status = {...h.status,phase:'uploading',archiveBytes:4194304,totalBytes:4194304,bytes:1048576};
  await h.tick();
  assert.match(h.view('phase').textContent,/已生成的 ZIP/);
  assert.match(h.view('bytes').textContent,/1\.00 MiB \/ 4\.00 MiB/);
  assert.match(h.view('bytes').textContent,/25\.0%/);
  h.status.totalBytes = null;
  await h.tick();
  assert.ok(!h.view('bytes').textContent.includes('%'));
  h.status = {...h.status,uploadMode:'stream',totalBytes:4194304};
  await h.tick();
  assert.equal(h.view('bytes').textContent,'已发送 1.00 MiB');
  assert.match(h.view('phase').textContent,/打包并上传/);
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
