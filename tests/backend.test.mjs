import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {Writable,PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {init} from '../index.mjs';
const name='luker-2025-01-02T03-04-05-006Z-00000000-0000-4000-8000-000000000001.zip';
const folder='https://dav.example/dav/LukerBackup/';
const xml=`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/LukerBackup/${name}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>4096</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
test('router uses bounded XML requests, persists recheck, rejects unsafe names and requires admin',async()=>{
 const cwd=process.cwd(), oldRoot=Object.getOwnPropertyDescriptor(globalThis,'DATA_ROOT'), originalRequest=https.request;
 const tempParent=fs.realpathSync(os.tmpdir());
 const temp=fs.mkdtempSync(path.join(tempParent,'luker-dav-test-'));
 const resolvedTemp=fs.realpathSync(temp);
 assert.equal(path.dirname(resolvedTemp),tempParent);
 assert.ok(path.basename(resolvedTemp).startsWith('luker-dav-test-'));
 assert.equal(resolvedTemp,path.resolve(temp));
 const calls=[],routes=new Map();let middleware,oversized=false;
 try {
 fs.mkdirSync(path.join(temp,'src/storage'),{recursive:true});
 fs.writeFileSync(path.join(temp,'package.json'),'{"type":"module"}');
 fs.writeFileSync(path.join(temp,'src/users.js'),'export const createBackupArchive=()=>{};export const isRequestAdmin=req=>req.user?.profile?.admin===true;');
 fs.writeFileSync(path.join(temp,'src/storage/index.js'),'export const getStorageEngine=()=>({kind:"fs"});');
 fs.writeFileSync(path.join(temp,'_webdav-backup.json'),JSON.stringify({url:folder,username:'fake-user',password:'fake-password'}));
 fs.writeFileSync(path.join(temp,'_webdav-backup-status.json'),JSON.stringify({name,destination:folder,phase:'uploaded',bytes:4096,remoteBytes:0,verification:'old warning'}));
  process.chdir(temp);globalThis.DATA_ROOT=temp;
  https.request=(url,opts,callback)=>{
   const chunks=[];
   const req=new Writable({write(chunk,encoding,done){chunks.push(chunk);done();}});
   req.setTimeout=()=>req;
   req.on('finish',()=>{
    calls.push({url:String(url),opts,body:Buffer.concat(chunks).toString()});
    const response=new PassThrough();response.statusCode=207;response.headers={};
    callback(response);response.end(oversized?'x'.repeat(2097153):xml);
   });
   return req;
  };
  await init({use(fn){middleware=fn;},get(p,fn){routes.set('GET '+p,fn);},post(p,fn){routes.set('POST '+p,fn);}});
  async function invoke(key,body){let payload,code=200;const res={headersSent:false,status(c){code=c;return this;},json(x){payload=x;},set(){}};await routes.get(key)({body,user:{profile:{admin:true,handle:'test-user'}}},res);return {payload,code};}
  let denied;middleware({user:{profile:{admin:false}}},{set(){},status(c){denied=c;return this;},json(){}},()=>assert.fail('nonadmin admitted'));assert.equal(denied,403);
  let cache;middleware({user:{profile:{admin:true}}},{set(k,v){if(k==='Cache-Control')cache=v;}},()=>{});assert.equal(cache,'no-store');
   const cfg=(await invoke('GET /config')).payload;assert.equal(cfg.password,undefined);assert.equal(cfg.passwordSet,true);assert.equal(cfg.capabilities.passwordReveal,true);
   assert.equal((await invoke('POST /password/reveal',{})).payload.password,'fake-password');
   const lock=await invoke('POST /updates/lock',{});assert.equal(lock.code,200);assert.equal((await invoke('GET /config')).payload.updatePending,true);
   for(const route of ['POST /backup','POST /config','POST /test','POST /updates/lock'])assert.equal((await invoke(route,{})).code,409);
   assert.equal((await invoke('POST /updates/unlock',{token:'wrong'})).code,409);
   assert.equal((await invoke('POST /updates/unlock',{token:lock.payload.token})).code,200);
   assert.equal((await invoke('GET /config')).payload.updatePending,false);
   const list=await invoke('GET /backups');assert.equal(list.payload.files[0].name,name);assert.equal(list.payload.files[0].bytes,4096);
  assert.equal(calls[0].opts.headers.Depth,'1');assert.equal(calls[0].opts.headers['Content-Length'],Buffer.byteLength(calls[0].body));assert.ok(calls[0].body.includes('getcontentlength'));
  const verify=await invoke('POST /verify',{name});assert.equal(verify.payload.sizeVerification,'matched');
  const state=await invoke('GET /status');assert.equal(state.payload.remoteBytes,4096);assert.equal(state.payload.sizeVerification,'matched');
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp,'_webdav-backup-status.json'),'utf8')).remoteBytes,4096);
  const count=calls.length;
  for(const invalid of ['../secret.zip','https://evil.example/test.zip','bad.zip',name+'.partial']) assert.equal((await invoke('POST /verify',{name:invalid})).code,400);
  assert.equal(calls.length,count);
  for(const suffix of ['prepare','source','commit','release'])assert.equal(routes.has('POST /restore/'+suffix),false);
   const readOnly=(await invoke('GET /config')).payload;assert.equal(readOnly.capabilities.cloudRestore,undefined);assert.equal(readOnly.restorePending,undefined);
   oversized=true;const tooLarge=await invoke('GET /backups');assert.equal(tooLarge.code,400);assert.ok(tooLarge.payload.error.includes('2 MiB'));
 } finally {
  https.request=originalRequest;
  process.chdir(cwd);
  if (oldRoot) Object.defineProperty(globalThis,'DATA_ROOT',oldRoot);
  else delete globalThis.DATA_ROOT;
  // Only remove the exact directory created and checked by this test.
  assert.equal(fs.realpathSync(temp),resolvedTemp);
  assert.equal(path.dirname(resolvedTemp),tempParent);
  fs.rmSync(resolvedTemp,{recursive:true,force:true});
 }
 assert.equal(process.cwd(),cwd);
 assert.equal(https.request,originalRequest);
 assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,'DATA_ROOT'),oldRoot);
 assert.equal(fs.existsSync(temp),false);
});
