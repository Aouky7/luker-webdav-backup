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

test('selecting a snapshot opens its restore module without staging or restoring anything',async t=>{
 const h=await ready(t);await h.click('list');
 const before=h.calls.length;await h.click('restore-snapshot');
 assert.equal(h.$('.wd-restore').open,true);
 assert.match(h.$('[data-restore="file"]').textContent,/<img/);
 assert.equal(h.calls.length,before);
 assert.equal(h.$('[data-restore-action="prepare"]').disabled,false);
 assert.equal(h.$('[data-restore-action="apply"]').disabled,true);
 assert.ok([...h.w.document.querySelectorAll('[data-restore-category]')].every(input=>!input.checked));
});

test('restore controls do not dirty backup settings or alter backup category choices',async t=>{
 const h=await ready(t);await h.click('list');await h.click('restore-snapshot');
 const backup=h.$('[data-category="settings"]').checked;
 const input=h.$('[data-restore-category="settings"]');input.checked=true;
 input.dispatchEvent(new h.w.Event('change',{bubbles:true}));
 assert.equal(h.view('dirty').hidden,true);assert.equal(h.$('[data-category="settings"]').checked,backup);
 assert.equal(h.posted('/config').length,0);
});

test('pending restore is visible and blocks new backup or updates',async t=>{
 const h=await ready(t,{config:{restorePending:true}});
 assert.equal(h.$('.wd-restore').open,true);
 await h.tab('backup');assert.equal(h.view('globalRestore').hidden,false);
 h.allow=true;await h.click('backup');assert.equal(h.backupCount,0);
 assert.match(h.view('message').textContent,/恢复/);
 const before=h.calls.filter(call=>call.route.endsWith('/update')).length;
 h.$('[data-update="install"]').click();await settle();
 assert.equal(h.calls.filter(call=>call.route.endsWith('/update')).length,before);
});

test('older backend still lists snapshots while unsupported restore stays disabled',async t=>{
 const h=await ready(t,{oldBackend:true});await h.click('list');await h.click('restore-snapshot');
 assert.equal(h.$('[data-restore-action="prepare"]').disabled,true);
 assert.match(h.$('[data-restore="status"]').textContent,/新版/);
 assert.equal(h.calls.some(call=>call.route.startsWith('/restore/')),false);
});
