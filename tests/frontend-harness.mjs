import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';

// Execute the browser module in an isolated DOM. Only import.meta.url is replaced;
// all event handlers, configuration handling, requests and notifications are real.
const updateSource = readFileSync(new URL('../updates.js', import.meta.url), 'utf8').replace('export function mountUpdates', 'function mountUpdates');
const restoreSource = readFileSync(new URL('../restore.js', import.meta.url), 'utf8').replace('export function mountRestore', 'function mountRestore');
const source = updateSource + '\n' + restoreSource + '\n' + readFileSync(new URL('../frontend.js', import.meta.url), 'utf8')
  .replace("import {mountUpdates} from './updates.js';", '')
  .replace("import {mountRestore} from './restore.js';", '')
  .replaceAll('import.meta.url', "'https://luker.test/scripts/extensions/third-party/webdav/frontend.js'");
export const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
export const selection = {settings:true,secrets:false,characters:true,chats:true,lorebooks:true,presets:true,assets:true,extensions:true,globalExtensions:false,vectors:false};

export function harness(t, {toasts = true, popups = true, oldBackend = false, config:configOverrides = {}, status:statusOverride = null, cloudFiles = null, holdLoadConfig = false} = {}) {
  const dom = new JSDOM('<div id="extensions_settings"></div>', {runScripts:'outside-only',pretendToBeVisual:true,url:'https://luker.test'});
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w,{AbortController,TextDecoder,TextEncoder,Uint8Array});
  const config = {version:oldBackend ? '0.4.0' : '0.5.7',url:'https://dav.jianguoyun.com/dav/',username:'test',passwordSet:true,storageEngine:'fs',selection:{...selection},categories:Object.fromEntries(Object.keys(selection).map(key => [key,key]))};
  if (!oldBackend) Object.assign(config, {supportedUploadModes:['stream'],uploadMode:'stream',capabilities:{passwordReveal:true,cloudRestore:true},updateIdentity:{directory:'backend-folder',repository:'https://github.com/Aouky7/webdav_luker'}});
  Object.assign(config,configOverrides);
  const h = {secret:'synthetic-application-password',dom,w,config,calls:[],notices:[],popups:[],alerts:[],confirmations:[],allow:false,fail:{},tasks:new Map(),nextTimer:100000,backupCount:0,latestVersion:'0.5.7',cloudFiles,holdLoadConfig,configGetCount:0};
  h.status = statusOverride || {version:config.version,phase:'uploaded',busy:false,name:'old.zip',started:'2025-01-01',destination:config.url,bytes:100,remoteBytes:100,sizeVerification:'matched'};
  h.$ = selector => w.document.querySelector(selector);
  h.field = name => h.$(`[data-field="${name}"]`);
  h.view = name => h.$(`[data-view="${name}"]`);
  h.change = (name, value) => { h.field(name).value = value; h.field(name).dispatchEvent(new w.Event('change',{bubbles:true})); };
  h.tab = async name => { h.$(`[data-tab="${name}"]`).click(); await flush(); };
  h.nav = async name => { h.$(`[data-nav="${name}"]`).click(); await flush(); };
  h.click = async action => {
    if (action === 'password-eye' && h.$('[data-page="settings"]')?.hidden) await h.tab('settings');
    const buttons = [...w.document.querySelectorAll(`[data-action="${action}"]`)];
    const button = action === 'save' ? buttons.at(-1) : buttons.find(item => !item.disabled) || buttons[0];
    button.click(); await flush();
  };
  h.open = async value => { h.$('.inline-drawer-icon').classList.replace(value ? 'down' : 'up', value ? 'up' : 'down'); await flush(); };
  h.tick = async () => { const jobs = [...h.tasks.values()]; h.tasks.clear(); for (const fn of jobs) fn(); await flush(); };
  h.hide = async value => { Object.defineProperty(w.document,'hidden',{configurable:true,value}); w.document.dispatchEvent(new w.Event('visibilitychange')); await flush(); };
  h.posted = route => h.calls.filter(call => call.route === route && call.options.method === 'POST');
  h.pageNames = () => [...w.document.querySelectorAll('[data-page]')].filter(page => !page.hidden).map(page => page.dataset.page);
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
    if (route.startsWith('https://raw.githubusercontent.com/')) return new Response(JSON.stringify({version:h.latestVersion}));
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
      } else {
        h.configGetCount++;
        if (h.holdLoadConfig && h.configGetCount > 1) return new Promise(resolve => { h.releaseConfig = () => resolve({ok:true,status:200,json:async()=>({...config}),text:async()=>JSON.stringify(config)}); });
        result = {...config};
      }
    } else if (route === '/test') result = {ok:true,created:true,destination:config.url,note:'已自动创建目录；目录访问成功，不证明上传权限'};
    else if (route === '/backup') {
      h.backupCount++;
      h.status = {version:config.version,phase:h.instant ? 'uploaded' : 'preparing',busy:!h.instant,name:`task-${h.backupCount}.zip`,started:`2025-01-0${h.backupCount}`,destination:config.url,uploadMode:config.uploadMode,bytes:100,remoteBytes:100,sizeVerification:h.instant ? 'matched' : undefined,directoryCreated:true};
      result = {started:true,...h.status};
    } else if (route === '/backups') result = {files:h.cloudFiles || [{name:'<img src=x onerror=alert(1)>.zip',bytes:100,modified:null}],limited:false};
    else if (route === '/verify') result = {name:JSON.parse(options.body).name,remoteBytes:100,expectedBytes:null,sizeVerification:'observed',verificationSource:'PROPFIND',verification:'缺少基准'};
    else throw new Error('Unexpected route ' + route);
    return {ok:true,status:200,json:async () => result,text:async () => JSON.stringify(result)};
  };
  w.eval(source);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return h;
}
