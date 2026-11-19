import assert from 'node:assert/strict';
import test from 'node:test';
import {flush, harness} from './frontend-harness.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await flush(); };
const activeTab = h => h.$('[data-tab][aria-selected="true"]')?.dataset.tab;
const dispatchKey = (h, selector, key) => h.$(selector).dispatchEvent(new h.w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));

test('four tabs expose the tabpanel contract and support manual keyboard activation', async t => {
  const h = harness(t);
  await h.open(true); await settle();

  const tabs = [...h.w.document.querySelectorAll('[data-tab]')];
  const pages = [...h.w.document.querySelectorAll('[data-page]')];
  assert.deepEqual(tabs.map(tab => tab.dataset.tab), ['backup','task','cloud','settings']);
  assert.ok(tabs.every(tab => tab.getAttribute('role') === 'tab'));
  assert.deepEqual(pages.map(page => page.dataset.page), ['backup','task','cloud','settings']);
  assert.ok(pages.every(page => page.getAttribute('role') === 'tabpanel'));
  assert.equal(activeTab(h),'backup');
  assert.deepEqual(h.pageNames(),['backup']);

  h.$('[data-tab="backup"]').focus();
  dispatchKey(h,'[data-tab="backup"]','ArrowRight');
  assert.equal(h.w.document.activeElement.dataset.tab,'task');
  assert.equal(activeTab(h),'backup','arrow navigation moves focus without activating');
  assert.deepEqual(h.pageNames(),['backup']);
  dispatchKey(h,'[data-tab="task"]','Enter');
  assert.equal(activeTab(h),'task');
  assert.deepEqual(h.pageNames(),['task']);

  dispatchKey(h,'[data-tab="task"]','Home');
  assert.equal(h.w.document.activeElement.dataset.tab,'backup');
  assert.equal(activeTab(h),'task','Home moves focus only');
  dispatchKey(h,'[data-tab="backup"]',' ');
  assert.equal(activeTab(h),'backup','Space activates the focused tab');
  dispatchKey(h,'[data-tab="backup"]','End');
  assert.equal(h.w.document.activeElement.dataset.tab,'settings');
  assert.equal(activeTab(h),'backup','End moves focus only');
});

test('manual navigation wins when configuration finishes loading later', async t => {
  const h = harness(t,{holdLoadConfig:true});
  await settle();
  await h.open(true); await settle();
  assert.equal(typeof h.releaseConfig,'function','the config load is deferred');
  assert.equal(h.$('[data-page="backup"]').hidden,false,'backup remains the pre-load page');

  await h.tab('cloud');
  h.releaseConfig(); await settle();
  assert.equal(activeTab(h),'cloud');
  assert.deepEqual(h.pageNames(),['cloud']);
});

test('incomplete credentials select settings; closed scope warnings remain visible outside details', async t => {
  const h = harness(t,{config:{url:'',passwordSet:false,storageEngine:'database',selection:{settings:true,secrets:true,characters:false,chats:false,lorebooks:false,presets:false,assets:false,extensions:false,globalExtensions:false,vectors:false}}});
  await h.open(true); await settle();

  assert.equal(activeTab(h),'settings');
  const scope = h.view('scope');
  assert.equal(scope.open,false,'scope details are closed by default');
  assert.equal(h.view('secretsWarning').hidden,false);
  assert.equal(h.view('databaseWarning').hidden,false);
  assert.equal(scope.contains(h.view('databaseWarning')),false,'database warning is outside the collapsible scope');
});

test('switching tabs preserves dirty settings and categories without requests or saves', async t => {
  const h = harness(t);
  await h.open(true); await settle();
  const configGets = () => h.calls.filter(call => call.route === '/config' && call.options.method !== 'POST').length;
  const backupsGets = () => h.calls.filter(call => call.route === '/backups').length;
  const configPosts = () => h.posted('/config').length;
  const before = {configGets:configGets(),backupsGets:backupsGets(),configPosts:configPosts()};

  h.change('username','unsaved-user');
  await h.tab('settings');
  h.change('url','https://dav.example.test/backup/');
  const settingsValue = h.field('url').value;
  await h.tab('backup');
  const secrets = h.$('[data-category="secrets"]');
  secrets.checked = true;
  secrets.dispatchEvent(new h.w.Event('change',{bubbles:true}));
  const categoryState = h.$('[data-category="secrets"]').checked;
  await h.tab('cloud');
  await h.tab('settings');

  assert.equal(h.field('username').value,'unsaved-user');
  assert.equal(h.field('url').value,settingsValue);
  assert.equal(h.$('[data-category="secrets"]').checked,categoryState);
  assert.equal(h.view('dirty').hidden,false);
  assert.equal(configGets(),before.configGets,'navigation does not reread config');
  assert.equal(backupsGets(),before.backupsGets,'navigation does not fetch cloud files');
  assert.equal(configPosts(),before.configPosts,'navigation never saves');
});

test('cloud pager renders five rows locally and retains verification across pages', async t => {
  const files = Array.from({length:12},(_,index)=>({name:`backup-${index + 1}.zip`,bytes:100 + index,modified:null}));
  const h = harness(t,{cloudFiles:files});
  await h.open(true); await settle();
  await h.tab('cloud');
  await h.click('list');

  const list = h.view('cloudList');
  const getCount = () => h.calls.filter(call => call.route === '/backups').length;
  assert.equal(getCount(),1);
  assert.equal(list.querySelectorAll('.wd-cloud-file').length,5);
  assert.equal(h.view('cloudPager').hidden,false);
  assert.equal(h.view('cloudPage').textContent,'1 / 3');
  assert.equal(h.$('[data-action="cloud-prev"]').disabled,true);

  const first = list.querySelector('.wd-cloud-file');
  first.querySelector('[data-action="verify"]').click(); await settle();
  const verification = first.querySelector('[data-file-verification]');
  assert.equal(verification.hidden,false);
  assert.match(verification.textContent,/已读取大小/);

  await h.click('cloud-next');
  assert.equal(h.view('cloudPage').textContent,'2 / 3');
  assert.equal(list.querySelectorAll('.wd-cloud-file').length,5);
  assert.equal(getCount(),1,'paging is local and does not refetch');
  await h.click('cloud-prev');
  assert.equal(list.querySelector('.wd-cloud-file'),first,'the original row is retained');
  assert.equal(verification.hidden,false);
  assert.match(verification.textContent,/已读取大小/);
});

test('saving configuration clears the cached cloud rows and page index', async t => {
  const files = Array.from({length:11},(_,index)=>({name:`backup-${index}.zip`,bytes:100,modified:null}));
  const h = harness(t,{cloudFiles:files});
  await h.open(true); await settle();
  await h.tab('cloud'); await h.click('list'); await h.click('cloud-next');
  assert.equal(h.view('cloudPage').textContent,'2 / 3');

  await h.tab('settings');
  h.change('username','saved-user');
  assert.equal(h.view('dirty').hidden,false);
  const configGets = h.calls.filter(call => call.route === '/config' && call.options.method !== 'POST').length;
  const listGets = h.calls.filter(call => call.route === '/backups').length;
  h.view('dirty').querySelector('[data-action="save"]').click(); await settle();

  assert.equal(h.posted('/config').length,1);
  assert.equal(h.view('cloudList').children.length,0);
  assert.equal(h.view('cloudPager').hidden,true);
  assert.equal(h.view('cloudPage').textContent,'1 / 1');
  assert.equal(h.calls.filter(call => call.route === '/config' && call.options.method !== 'POST').length,configGets);
  assert.equal(h.calls.filter(call => call.route === '/backups').length,listGets,'save does not automatically fetch the cloud list');
});

test('reloading configuration clears the cloud cache and resets its page without fetching again', async t => {
  const files = Array.from({length:11},(_,index)=>({name:`reload-${index}.zip`,bytes:100,modified:null}));
  const h = harness(t,{cloudFiles:files});
  await h.open(true); await settle();
  await h.tab('cloud'); await h.click('list'); await h.click('cloud-next');
  assert.equal(h.view('cloudPage').textContent,'2 / 3');
  await h.tab('settings');
  const configGets = h.calls.filter(call => call.route === '/config' && call.options.method !== 'POST').length;
  const listGets = h.calls.filter(call => call.route === '/backups').length;
  h.allow = true;

  await h.click('reload');
  assert.equal(h.calls.filter(call => call.route === '/config' && call.options.method !== 'POST').length,configGets + 1);
  assert.equal(h.view('cloudList').children.length,0);
  assert.equal(h.view('cloudPager').hidden,true);
  assert.equal(h.view('cloudPage').textContent,'1 / 1');
  assert.equal(h.calls.filter(call => call.route === '/backups').length,listGets,'reload does not automatically fetch the cloud list');
});

test('leaving settings conceals a revealed password and cancels a pending reveal', async t => {
  const h = harness(t);
  await h.open(true); await settle(); await h.tab('settings');
  h.holdReveal = true;
  await h.click('password-eye');
  assert.equal(typeof h.releaseReveal,'function');
  await h.tab('cloud');
  h.releaseReveal(); await settle();
  assert.equal(h.field('password').type,'password');
  assert.equal(h.field('password').value,'********');
  assert.equal(h.posted('/password/reveal').length,1);

  h.holdReveal = false;
  await h.tab('settings'); await h.click('password-eye');
  assert.equal(h.field('password').value,h.secret);
  await h.tab('backup');
  assert.equal(h.field('password').type,'password');
  assert.equal(h.field('password').value,'********');

  await h.tab('settings');
  h.change('password','typed-not-saved');
  await h.tab('cloud');
  assert.equal(h.field('password').type,'password');
  assert.equal(h.field('password').value,'typed-not-saved','leaving settings conceals but preserves a typed replacement');
});

test('running tasks default to task, report globally elsewhere, and never steal navigation', async t => {
  const h = harness(t,{status:{version:'0.5.5',phase:'uploading',busy:true,name:'running.zip',started:'2025-01-01',destination:'https://dav.test/',bytes:50}});
  await h.open(true); await settle();
  assert.equal(activeTab(h),'task');
  assert.equal(h.view('globalTask').hidden,true);

  await h.tab('cloud');
  h.status = {version:'0.5.5',phase:'uploaded',busy:false,name:'running.zip',sizeVerification:'mismatch',bytes:100,verification:'大小不一致'};
  await h.click('status');
  assert.equal(activeTab(h),'cloud','a background status update does not change the selected tab');
  assert.equal(h.view('globalTask').hidden,false);
  assert.match(h.view('globalTaskText').textContent,/校验异常/);
  assert.match(h.view('taskSummary').textContent,/大小不一致/);

  h.status = {version:'0.5.5',phase:'failed',busy:false,name:'running.zip',error:'failed'};
  await h.click('status');
  assert.equal(activeTab(h),'cloud','a later background failure also leaves navigation alone');
  assert.equal(h.view('globalTask').hidden,false);
  assert.match(h.view('globalTaskText').textContent,/失败/);
  assert.match(h.view('taskSummary').textContent,/失败/);

  await h.tab('settings');
  h.status = {version:'0.5.5',phase:'uploading',busy:true,name:'next.zip',started:'2025-01-02',bytes:10};
  await h.click('status');
  assert.equal(activeTab(h),'settings');
  assert.equal(h.view('globalTask').hidden,false);
});

test('a successfully started backup selects the task tab', async t => {
  const h = harness(t);
  await h.open(true); await settle();
  assert.equal(activeTab(h),'backup');
  h.allow = true;
  await h.click('backup');
  assert.equal(h.backupCount,1);
  assert.equal(activeTab(h),'task');
  assert.deepEqual(h.pageNames(),['task']);
});

test('updater details auto-open for mismatch, failed checks, and pending restart', async t => {
  const mismatch = harness(t,{config:{version:'0.5.4'}});
  await mismatch.open(true); await settle();
  assert.ok(mismatch.view('updatesMount').closest('[data-page="settings"]'));
  assert.ok(mismatch.view('updatesMount').querySelector('[data-update="check"]'));
  assert.equal(mismatch.view('updatesDetails').open,true,'version mismatch opens updater details');

  const failedCheck = harness(t,{config:{updateIdentity:null}});
  await failedCheck.open(true); await settle();
  assert.equal(failedCheck.view('updatesDetails').open,true,'an updater warning/failure opens updater details');
  assert.match(failedCheck.view('updatesMount').textContent,/未提供可核实的安装身份/);

  const pending = harness(t,{config:{updatePending:true}});
  await pending.open(true); await settle();
  assert.equal(pending.view('updatesDetails').open,true,'pending restart state opens updater details');
});
