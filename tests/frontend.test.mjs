import assert from 'node:assert/strict';
import test from 'node:test';
import {flush, harness} from './frontend-harness.mjs';


test('startup silently checks once and pins a dismissible update banner above the drawer',async t=>{
  const h=harness(t);h.latestVersion='0.5.8';
  for(let i=0;i<10;i++)await flush();
  const banner=h.$('.wd-update-notice');
  assert.ok(banner);assert.equal(h.$('#luker-webdav-panel').firstElementChild,banner);
  assert.match(banner.textContent,/0\.5\.8/);assert.equal(h.notices.length,0);
  assert.equal(banner.querySelector('[data-update-notice-action="install"]').disabled,false);
  banner.querySelector('[data-update-notice-action="install"]').click();
  for(let i=0;i<8;i++)await flush();
  assert.equal(h.mutations?.().length ?? h.calls.filter(c=>c.route.endsWith('/update')).length,0);
  assert.equal(h.confirmations.length,1,'the banner update action still requires normal confirmation');
  banner.querySelector('[data-update-notice-action="dismiss"]').click();
  assert.equal(h.$('.wd-update-notice'),null);
  await h.open(true);h.$('[data-update="check"]').click();for(let i=0;i<10;i++)await flush();
  assert.equal(h.$('.wd-update-notice'),null,'dismissal lasts until page refresh');
});

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
  assert.equal(h.$('#luker-webdav-panel-style').href,'https://luker.test/scripts/extensions/third-party/webdav/style.css?v=0.5.7');
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
