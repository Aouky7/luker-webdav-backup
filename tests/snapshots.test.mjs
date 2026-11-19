import assert from 'node:assert/strict';
import test from 'node:test';
import {harness,flush} from './frontend-harness.mjs';
const settle=async()=>{for(let i=0;i<8;i++)await flush();};
const ready=async(t,options)=>{const h=harness(t,options);await h.open(true);await settle();await h.tab('cloud');return h;};

test('snapshot collection and individual details collapse without fetching again',async t=>{
 const h=await ready(t);await h.click('list');
 assert.match(h.view('snapshotCount').textContent,/1 个快照/);
 const row=h.view('cloudList').firstElementChild;
 const details=row.querySelector('details');assert.equal(details.open,false);
 assert.doesNotMatch(details.querySelector('summary').textContent,/<img/);
 assert.match(row.querySelector('.wd-file-name').textContent,/<img/);assert.equal(row.querySelector('img'),null);
 const count=h.calls.length;
 details.open=true;h.view('snapshots').open=false;h.view('snapshots').open=true;
 assert.equal(h.calls.length,count);
});

test('snapshots expose only a read-only size check and no recovery or download controls',async t=>{
 const h=await ready(t);await h.click('list');
 const row=h.view('cloudList').firstElementChild;
 assert.deepEqual([...row.querySelectorAll('button')].map(button=>button.dataset.action),['verify']);
 assert.equal(h.$('.wd-restore'),null);assert.equal(h.$('[data-restore-action]'),null);
 assert.equal(h.view('restoreMount'),null);assert.equal(h.view('globalRestore'),null);
 await h.click('verify');
 assert.match(row.querySelector('[data-file-verification]').textContent,/已读取大小/);
 assert.equal(h.calls.some(call=>/restore|uploads|download/.test(call.route)),false);
});

test('opening and paging snapshot details never changes saved backup selection',async t=>{
 const files=Array.from({length:8},(_,i)=>({name:'snapshot-'+i+'.zip',bytes:100+i,modified:null}));
 const h=await ready(t,{cloudFiles:files});await h.click('list');
 const original=[...h.w.document.querySelectorAll('[data-category]')].map(input=>input.checked);
 for(const detail of h.view('cloudList').querySelectorAll('details'))detail.open=true;
 await h.click('cloud-next');await h.click('cloud-prev');
 assert.equal(h.view('dirty').hidden,true);
 assert.deepEqual([...h.w.document.querySelectorAll('[data-category]')].map(input=>input.checked),original);
 assert.equal(h.posted('/config').length,0);
});

test('legacy restore metadata is ignored and cannot recreate the removed recovery UI',async t=>{
 const h=await ready(t,{config:{restorePending:true,restoreState:{phase:'prepared'},capabilities:{passwordReveal:true,cloudRestore:true}}});
 assert.equal(h.$('.wd-restore'),null);assert.equal(h.view('globalRestore'),null);
 h.allow=true;await h.tab('backup');await h.click('backup');
 assert.equal(h.backupCount,1);
 assert.equal(h.calls.some(call=>call.route.startsWith('/restore/')),false);
});

test('older backend can still show snapshots without recovery dependencies',async t=>{
 const h=await ready(t,{oldBackend:true});await h.click('list');
 assert.equal(h.view('cloudList').children.length,1);
 assert.equal(h.$('[data-restore-action]'),null);
 assert.equal(h.calls.some(call=>call.route.startsWith('/restore/')),false);
});
