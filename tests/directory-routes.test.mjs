import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {Writable,PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {init} from '../index.mjs';

test('test and backup automatically create folders; failed preparation never uploads; concurrent config is rejected',async()=>{
 const cwd=process.cwd(),previousRoot=Object.getOwnPropertyDescriptor(globalThis,'DATA_ROOT'),original=https.request;
 const parent=fs.realpathSync(os.tmpdir());
 const temp=fs.mkdtempSync(path.join(parent,'luker-auto-dir-test-'));
 const resolved=fs.realpathSync(temp);
 assert.equal(path.dirname(resolved),parent);assert.equal(resolved,path.resolve(temp));
 const routes=new Map(),calls=[],dirs=new Set(['/dav/']);
 let release=null,hold=false,deny=false;
 try {
  fs.mkdirSync(path.join(temp,'src/storage'),{recursive:true});
  fs.writeFileSync(path.join(temp,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(temp,'src/users.js'),'export const createBackupArchive=async(h,res)=>res.end(Buffer.from("sample"));export const isRequestAdmin=r=>r.user?.profile?.admin===true;');
  fs.writeFileSync(path.join(temp,'src/storage/index.js'),'export const getStorageEngine=()=>({kind:"fs"});');
  process.chdir(temp);globalThis.DATA_ROOT=temp;
  https.request=(url,opts,callback)=>{
   const chunks=[];
   const req=new Writable({write(c,e,done){chunks.push(c);done();}});req.setTimeout=()=>req;
   req.on('finish',()=>{
    calls.push({method:opts.method,path:url.pathname,bytes:Buffer.concat(chunks).length});
    const respond=()=>{
     const res=new PassThrough();res.headers={};let body='';
     if(opts.method==='PROPFIND') {
      const isFile=url.pathname.endsWith('.zip');
      res.statusCode=dirs.has(url.pathname)||isFile?207:404;
      body=`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${url.pathname}</d:href><d:propstat><d:prop><d:resourcetype>${isFile?'':'<d:collection/>'}</d:resourcetype>${isFile?'<d:getcontentlength>6</d:getcontentlength>':''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
     } else if(opts.method==='MKCOL') {
      res.statusCode=deny?403:201;if(!deny)dirs.add(url.pathname);
     } else res.statusCode=201;
     callback(res);res.end(body);
    };
    if(hold&&opts.method==='PROPFIND'){hold=false;release=respond;}else respond();
   });
   return req;
  };
  await init({use(){},get(p,f){routes.set('GET '+p,f);},post(p,f){routes.set('POST '+p,f);}});
  async function invoke(route,body){let payload,code=200;const res={headersSent:false,status(c){code=c;return this;},json(v){payload=v;}};await routes.get(route)({body,user:{profile:{admin:true,handle:'default-user'}}},res);return {code,payload};}
  const saved=await invoke('POST /config',{url:'https://dav.jianguoyun.com/dav/',username:'fake',password:'fake'});
  assert.equal(saved.payload.url,'https://dav.jianguoyun.com/dav/LukerBackup/');
  assert.ok(saved.payload.note.includes('自动创建'));
  assert.equal(calls.length,0,'saving configuration must not mutate the remote');
  hold=true;const testing=invoke('POST /test',{});
  for(let i=0;i<20&&!release;i++)await new Promise(r=>setImmediate(r));
  assert.ok(release);
  assert.equal((await invoke('POST /config',{url:'https://evil.example/'})).code,409);
  assert.equal((await invoke('POST /backup',{})).code,409);
  release();
  const tested=await testing;assert.equal(tested.code,200);assert.equal(tested.payload.created,true);
  assert.ok(dirs.has('/dav/LukerBackup/'));
  const writes=calls.filter(c=>c.method==='MKCOL').length;
  assert.equal((await invoke('POST /test',{})).payload.created,false);
  assert.equal(calls.filter(c=>c.method==='MKCOL').length,writes);
  await invoke('POST /config',{url:'https://dav.jianguoyun.com/dav/AutoBackup/'});
  const start=await invoke('POST /backup',{});assert.equal(start.code,202);assert.equal(start.payload.phase,'preparing');
  const finish=async()=>{
   for(let i=0;i<50;i++){
    await new Promise(r=>setImmediate(r));
    const s=(await invoke('GET /status')).payload;
    if(!s.busy)return s;
   }
   assert.fail('mock backup did not finish');
  };
  const done=await finish();assert.equal(done.phase,'uploaded');assert.equal(done.directoryCreated,true);assert.equal(done.sizeVerification,'matched');assert.equal(done.bytes,6);
  const createIndex=calls.findIndex(c=>c.method==='MKCOL'&&c.path==='/dav/AutoBackup/');
  const putIndex=calls.findIndex(c=>c.method==='PUT');assert.ok(createIndex>=0&&putIndex>createIndex);
  await invoke('POST /config',{url:'https://dav.jianguoyun.com/dav/Denied/'});
  deny=true;const oldPuts=calls.filter(c=>c.method==='PUT').length;
  await invoke('POST /backup',{});const failed=await finish();
  assert.equal(failed.phase,'failed');assert.ok(failed.error.includes('创建'));assert.ok(failed.note.includes('未上传'));
  assert.equal(calls.filter(c=>c.method==='PUT').length,oldPuts);
  // Failed automatic creation releases both task and test locks.
  assert.equal((await invoke('POST /test',{})).code,400);
  assert.equal((await invoke('POST /config',{url:'https://dav.jianguoyun.com/dav/AutoBackup/'})).code,200);
  for(const invalid of ['https://dav.example/dav/a%2fb/','https://dav.example/dav/a%5cb/','https://dav.example/dav/%00/']) assert.equal((await invoke('POST /config',{url:invalid})).code,400);
 } finally {
  https.request=original;process.chdir(cwd);
  if(previousRoot)Object.defineProperty(globalThis,'DATA_ROOT',previousRoot);else delete globalThis.DATA_ROOT;
  assert.equal(fs.realpathSync(temp),resolved);assert.equal(path.dirname(resolved),parent);
  fs.rmSync(resolved,{recursive:true,force:true});
 }
});
