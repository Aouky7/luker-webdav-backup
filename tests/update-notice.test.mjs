import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,flush} from './frontend-harness.mjs';
const settle=async()=>{for(let i=0;i<20;i++)await flush();};
async function setup(t){
 const h=harness(t);h.latestVersion='0.5.9';h.allow=true;await settle();
 assert.ok(h.$('.wd-update-notice'));
 return h;
}
const view=(h,name)=>h.$('[data-update-notice="'+name+'"]');

test('notification shows update stages while the outer plugin drawer remains closed',async t=>{
 const h=await setup(t),original=h.w.fetch;
 let backend,frontend,backendCalls=0;
 h.w.fetch=async(url,options={})=>{
  if(url==='/api/users/plugins/update') {backendCalls++;return new Promise(resolve=>{backend=()=>resolve(original(url,options));});}
  if(url==='/api/extensions/update')return new Promise(resolve=>{frontend=()=>resolve(original(url,options));});
  return original(url,options);
 };
 h.$('[data-update-notice-action="install"]').click();await settle();
 assert.ok(backend);assert.equal(h.$('.inline-drawer-icon').classList.contains('down'),true);
 assert.equal(view(h,'progress').hidden,false);
 assert.equal(view(h,'bar').hasAttribute('value'),false);
 assert.match(view(h,'stage').textContent,/后端|服务端/);
 assert.match(view(h,'counter').textContent,/1 \/ 3/);
 assert.equal(h.$('[data-update-notice-action="install"]').disabled,true);
 assert.equal(h.$('[data-update-notice-action="dismiss"]').disabled,true);
 h.$('[data-update-notice-action="install"]').click();await settle();assert.equal(backendCalls,1);
 backend();await settle();assert.ok(frontend);
 assert.match(view(h,'stage').textContent,/前端/);assert.match(view(h,'counter').textContent,/2 \/ 3/);
 assert.equal(view(h,'bar').hasAttribute('value'),false);
 frontend();await settle();
 assert.equal(view(h,'bar').value,3);assert.equal(view(h,'bar').max,3);
 assert.match(view(h,'stage').textContent,/重启|重新加载/);
 assert.match(h.$('[data-update="versions"]').textContent,/0\.5\.8/);
 assert.equal(h.$('[data-update-notice-action="install"]').disabled,true);
 assert.equal(h.$('[data-update-notice-action="dismiss"]').disabled,false);
 assert.equal(h.$('.wd-update-notice').dataset.status,'success');
 h.$('[data-update-notice-action="dismiss"]').click();await h.open(true);await settle();
 assert.equal(h.$('.wd-update-notice'),null,'status refresh must not resurrect dismissed terminal progress');
});

test('partial update stops the notification animation and retains confirmed stage count',async t=>{
 const h=await setup(t);h.fail['POST /api/extensions/update']='conflict';
 h.$('[data-update-notice-action="install"]').click();await settle();
 assert.equal(view(h,'progress').hidden,false);
 assert.equal(view(h,'bar').hasAttribute('value'),true);
 assert.equal(view(h,'bar').value,2);assert.equal(view(h,'bar').max,3);
 assert.notEqual(h.$('.wd-update-notice').dataset.status,'success');
 assert.match(view(h,'stage').textContent,/失败|未确认|未全部|核实/);
 assert.equal(h.$('[data-update-notice-action="install"]').disabled,true);
 assert.equal(h.calls.filter(call=>call.route==='/api/users/plugins/update').length,1);
 assert.equal(h.calls.filter(call=>call.route==='/api/extensions/update').length,1);
});

test('cancelling update confirmation hides progress and leaves notification dismissible',async t=>{
 const h=await setup(t);h.allow=false;
 h.$('[data-update-notice-action="install"]').click();await settle();
 assert.equal(view(h,'progress').hidden,true);
 assert.equal(h.calls.filter(call=>call.route.endsWith('/update')).length,0);
 assert.equal(h.posted('/updates/lock').length,0);
 assert.equal(h.$('[data-update-notice-action="dismiss"]').disabled,false);
 assert.equal(h.$('[data-update-notice-action="install"]').disabled,false);
});

test('manual settings update recreates a dismissed notice for its progress',async t=>{
 const h=await setup(t);h.$('[data-update-notice-action="dismiss"]').click();assert.equal(h.$('.wd-update-notice'),null);
 await h.open(true);await h.tab('settings');
 const original=h.w.fetch;let release;
 h.w.fetch=async(url,options={})=>url==='/api/users/plugins/update'?new Promise(resolve=>{release=()=>resolve(original(url,options));}):original(url,options);
 h.$('[data-update="install"]').click();await settle();assert.ok(release);
 assert.ok(h.$('.wd-update-notice'));assert.equal(view(h,'progress').hidden,false);
 release();await settle();assert.equal(h.$('.wd-update-notice').dataset.status,'success');
});
