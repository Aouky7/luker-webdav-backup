import assert from 'node:assert/strict';
import test from 'node:test';
import {flush,harness} from './frontend-harness.mjs';
const settle=async()=>{for(let i=0;i<8;i++)await flush();};
const ready=async(t,options)=>{const h=harness(t,options);await h.open(true);await settle();return h;};

test('connection fields remain read-only while initial config is pending; navigation remains usable',async t=>{
  const h=harness(t,{holdLoadConfig:true});await h.open(true);await settle();
  assert.equal(typeof h.releaseConfig,'function');assert.equal(h.field('url').readOnly,true);
  await h.tab('cloud');h.releaseConfig();await settle();
  assert.deepEqual(h.pageNames(),['cloud']);assert.equal(h.field('url').readOnly,false);
});

test('pending update stays locked and visible from any other panel',async t=>{
  const h=await ready(t,{config:{version:'0.5.4',updatePending:true}});
  assert.equal(h.view('updatesDetails').open,true);
  assert.equal(h.$('[data-update="install"]').disabled,true);
  assert.equal(h.view('globalUpdate').hidden,false);
  await h.tab('settings');assert.equal(h.view('globalUpdate').hidden,true);
  await h.tab('cloud');assert.equal(h.view('globalUpdate').hidden,false);
  assert.equal(h.calls.some(call=>call.route.endsWith('/update')),false);
});

test('destination summaries omit URL credentials, query values, and fragments',async t=>{
  const h=await ready(t,{config:{url:'https://username:password@dav.example.test/private/folder/?token=sensitive#secret'}});
  assert.equal(h.view('destinationFull').textContent,'https://dav.example.test/private/folder/');
  assert.doesNotMatch(h.view('destination').textContent+h.view('cloudDestination').textContent,/username|password|token|sensitive|secret/);
});

test('cloud distinguishes unrequested, empty and failed results and recovers on manual refresh',async t=>{
  const h=await ready(t,{cloudFiles:[]});await h.tab('cloud');
  assert.match(h.view('cloudMessage').textContent,/尚未读取/);
  await h.click('list');assert.match(h.view('cloudMessage').textContent,/未找到备份/);
  h.fail['GET /backups']='list-unavailable';await h.click('list');
  assert.equal(h.view('cloudMessage').dataset.tone,'error');
  assert.match(h.view('cloudMessage').textContent,/list-unavailable/);
  delete h.fail['GET /backups'];h.cloudFiles=[{name:'new.zip',bytes:1}];
  await h.click('list');assert.equal(h.view('cloudList').children.length,1);
});

test('save response preserves edits made after submission and duplicate save stays blocked',async t=>{
  const h=await ready(t);await h.tab('settings');h.change('username','submitted');
  const original=h.w.fetch;let release;
  h.w.fetch=async(url,options={})=>{
    if(url==='/api/plugins/webdav-backup/config'&&options.method==='POST')await new Promise(resolve=>{release=resolve;});
    return original(url,options);
  };
  await h.click('save');assert.ok(release);
  h.change('username','later-draft');h.change('password','later-password');
  h.view('dirty').querySelector('button').click();await flush();release();await settle();
  assert.equal(h.posted('/config').length,1);
  assert.equal(JSON.parse(h.posted('/config')[0].options.body).username,'submitted');
  assert.equal(h.field('username').value,'later-draft');assert.equal(h.field('password').value,'later-password');
  assert.equal(h.view('dirty').hidden,false);
});

test('a stale connection-test response cannot mark a newly saved target as tested',async t=>{
  const h=await ready(t);await h.tab('settings');
  const original=h.w.fetch;let release;
  h.w.fetch=async(url,options={})=>{
    if(url==='/api/plugins/webdav-backup/test')await new Promise(resolve=>{release=resolve;});
    return original(url,options);
  };
  await h.click('test');assert.ok(release);
  h.change('url','https://dav.example.test/new/');await h.click('save');
  release();await settle();
  assert.match(h.view('connectionState').textContent,/未测试连接/);
});
