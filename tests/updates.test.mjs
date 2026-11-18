import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

// Browser ESM helper in an isolated DOM. Source has no import-side initialization.
const source=readFileSync(new URL('../updates.js',import.meta.url),'utf8').replace('export function mountUpdates','function mountUpdates');
const repo='https://github.com/Aouky7/webdav_luker';
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
function setup(t,options={}) {
  const dom=new JSDOM('<div id="panel"><div class="wd-body"></div></div>',{runScripts:'outside-only',url:'https://luker.test'});
  t.after(()=>dom.window.close()); const w=dom.window;
  Object.assign(w,{AbortController,TextDecoder,TextEncoder,Uint8Array});
  w.eval(source+'\nglobalThis.mountUpdates=mountUpdates;');
  const h={calls:[],fetches:[],notices:[],available:[],locks:[],confirmations:[],allow:true,busy:false,dirty:false};
  h.discovery=[{name:'third-party/client-folder',type:'global'}];
  h.plugins=[{directory:'backend-folder',remoteUrl:repo,version:'0.5.4'}];
  h.version={remoteUrl:repo,currentBranchName:'main',currentCommitHash:'abc1234',isUpToDate:true};
  h.fail={};h.backendResult={ok:true,plugin:{directory:'backend-folder',remoteUrl:repo},restartRecommended:true};
  h.frontendResult={shortCommitHash:'1234567',remoteUrl:repo,isUpToDate:false};
  h.config={version:'0.5.4',updateIdentity:{directory:'backend-folder',repository:repo}};
  h.api=async(route,data)=>{
    h.calls.push({route,data});
    if(h.fail[route])throw h.fail[route];
    if(route==='/api/extensions/discover')return h.discovery;
    if(route==='/api/users/plugins/list')return {ok:true,plugins:h.plugins};
    if(route==='/api/extensions/version')return h.version;
    if(route==='/api/users/plugins/update')return h.backendResult;
    if(route==='/api/extensions/update')return h.frontendResult;
    throw Error('unexpected route '+route);
  };
  const fetchImpl=async(url,init)=>{
    h.fetches.push({url,init});
    if(options.fetchError)throw Error('offline');
    return new Response(options.manifest || JSON.stringify({version:options.latest || '0.5.5'}),{status:200});
  };
  h.controller=w.mountUpdates({panel:w.document.querySelector('#panel'),version:'0.5.4',moduleUrl:options.moduleUrl || 'https://luker.test/scripts/extensions/third-party/client-folder/frontend.js',api:h.api,fetchImpl,
    notify:(...args)=>h.notices.push(args),onUpdateAvailable:info=>h.available.push(info),confirm:async text=>{h.confirmations.push(text);return h.allow;},getBusy:()=>h.busy,getDirty:()=>h.dirty,onLock:value=>h.locks.push(value)});
  h.view=name=>w.document.querySelector('[data-update="'+name+'"]');
  h.load=async()=>{h.controller.setConfig(h.config);await tick();};
  h.mutations=()=>h.calls.filter(c=>c.route.endsWith('/update'));
  return h;
}

test('mismatch is local; auto check is read-only once and distinguishes latest from running versions',async t=>{
  const h=setup(t);h.config.version='0.5.3';await h.load();
  assert.equal(h.view('mismatch').hidden,false);assert.match(h.view('versions').textContent,/前端 0.5.4.*后端 0.5.3/);
  assert.match(h.view('result').textContent,/0.5.5.*新版本/);
  assert.equal(h.fetches.length,1);assert.equal(h.fetches[0].init.credentials,'omit');assert.equal(h.fetches[0].init.redirect,'error');
  assert.equal(h.mutations().length,0);assert.equal(h.view('install').disabled,false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.available)),[{latestVersion:'0.5.5',upgrade:true,codeUpdate:false,canUpdate:true}]);assert.equal(h.notices.length,0);
  h.controller.setBackendVersion('0.5.4');assert.equal(h.view('mismatch').hidden,true);
  h.controller.setConfig(h.config);await tick();assert.equal(h.fetches.length,1);
});

test('updates exact active backend and local frontend in order without force or automatic reload',async t=>{
  const h=setup(t);h.discovery[0].type='local';
  h.plugins.push({directory:'another-copy',remoteUrl:repo});await h.load();
  await h.controller.install();
  const calls=h.mutations();assert.equal(calls.length,2);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{route:'/api/users/plugins/update',data:{directory:'backend-folder'}});
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])),{route:'/api/extensions/update',data:{extensionName:'client-folder',global:false,force:false}});
  assert.equal(h.confirmations.length,1);assert.deepEqual(h.locks,[true]);
  assert.equal(h.controller.getState().locked,true);assert.match(h.view('result').textContent,/重启.*重新加载/);
  assert.match(h.view('versions').textContent,/0.5.4/);assert.doesNotMatch(h.view('versions').textContent,/0.5.5/);
  await h.controller.install();assert.equal(h.mutations().length,2);
});

test('wrong repositories, missing identities and ambiguous discovered copies refuse mutations',async t=>{
  for(const invalid of ['backend','frontend','identity','duplicate-backend','duplicate-frontend','path']) {
    const h=setup(t,invalid==='path'?{moduleUrl:'https://luker.test/scripts/extensions/third-party/%2E%2E/frontend.js'}:{});
    if(invalid==='backend')h.plugins[0].remoteUrl='https://github.com/Aouky7/luker-webdav-backup';
    if(invalid==='frontend')h.version.remoteUrl='https://github.com/evil/webdav_luker';
    if(invalid==='identity')delete h.config.updateIdentity;
    if(invalid==='duplicate-backend')h.plugins.push({...h.plugins[0]});
    if(invalid==='duplicate-frontend')h.discovery.push({...h.discovery[0],type:'local'});
    await h.load();assert.equal(h.view('install').disabled,true,invalid);
    await h.controller.install();assert.equal(h.mutations().length,0,invalid);
  }
});

test('preflight rechecks repository, dirty/busy states, and confirmation cancellation',async t=>{
  const h=setup(t);await h.load();
  h.dirty=true;await h.controller.install();assert.equal(h.mutations().length,0);h.dirty=false;
  h.busy=true;await h.controller.install();assert.equal(h.mutations().length,0);h.busy=false;
  h.allow=false;await h.controller.install();assert.equal(h.mutations().length,0);assert.deepEqual(h.locks,[]);h.allow=true;
  h.plugins[0].remoteUrl='https://github.com/other/project';await h.controller.install();assert.equal(h.mutations().length,0);
});

test('backend failure stops frontend; partial failure locks against replay with truthful results',async t=>{
  const h=setup(t);await h.load();h.fail['/api/users/plugins/update']=Error('HTTP 409 local changes');
  await h.controller.install();assert.equal(h.mutations().length,1);assert.equal(h.controller.getState().locked,false);
  assert.deepEqual(h.locks,[true,false]);assert.match(h.view('result').textContent,/服务端：更新失败；前端：未执行/);
  const p=setup(t);await p.load();p.fail['/api/extensions/update']=Error('HTTP 409 conflict');
  await p.controller.install();assert.equal(p.mutations().length,2);assert.equal(p.controller.getState().locked,true);
  assert.match(p.view('result').textContent,/已下载.*前端：更新失败/);await p.controller.install();assert.equal(p.mutations().length,2);
});

test('uncertain backend timeout stays locked and cannot replay mutations',async t=>{
  const h=setup(t);await h.load();h.fail['/api/users/plugins/update']=Object.assign(Error('request timeout'),{uncertain:true});
  await h.controller.install();assert.equal(h.controller.getState().locked,true);assert.deepEqual(h.locks,[true]);
  assert.match(h.view('result').textContent,/结果未确认/);await h.controller.install();assert.equal(h.mutations().length,1);
});

test('offline or invalid/oversized version source preserves local mismatch and never evaluates data',async t=>{
  for(const options of [{fetchError:true},{manifest:'{"version":"<img src=x>"}'},{manifest:'x'.repeat(65537)}]) {
    const h=setup(t,options);h.config.version='0.5.3';await h.load();
    assert.equal(h.view('mismatch').hidden,false);assert.match(h.view('result').textContent,/在线版本检查失败/);
    assert.equal(h.view('result').querySelector('img'),null);assert.equal(h.mutations().length,0);
  }
});
