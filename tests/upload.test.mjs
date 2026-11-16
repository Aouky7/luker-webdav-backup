import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {Writable,PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {init,request} from '../index.mjs';
import {createStagingManager} from '../staging.mjs';

test('routes preserve upload settings; modes upload exact bytes; staging and HTTP failures preserve boundaries',async()=>{
  const cwd=process.cwd(),previousRoot=Object.getOwnPropertyDescriptor(globalThis,'DATA_ROOT'),original=https.request;
  const parent=fs.realpathSync(os.tmpdir()),temp=fs.mkdtempSync(path.join(parent,'luker-upload-test-'));
  const routes=new Map(),calls=[];let producer='success',putCode=201,moveCode=201,denyDirectory=false,release;
  const bytes=Buffer.from('ZIP sample bytes');
  let stagingRoot,owner;
  try {
    fs.mkdirSync(path.join(temp,'src/storage'),{recursive:true});
    fs.writeFileSync(path.join(temp,'package.json'),'{"type":"module"}');
    fs.writeFileSync(path.join(temp,'src/users.js'),'export const createBackupArchive=(h,res)=>globalThis.__uploadProduce(res);export const isRequestAdmin=r=>r.user?.profile?.admin===true;');
    fs.writeFileSync(path.join(temp,'src/storage/index.js'),'export const getStorageEngine=()=>({kind:"fs"});');
    process.chdir(temp);globalThis.DATA_ROOT=temp;
    globalThis.__uploadProduce=async stream=>{
      if(producer==='fail')throw Error('packing producer failed');
      if(producer==='hold')await new Promise(r=>{release=r;});
      stream.end(bytes);
    };
    https.request=(url,opts,callback)=>{
      const chunks=[];
      const req=new Writable({write(chunk,encoding,done){chunks.push(chunk);done();}});req.setTimeout=()=>req;
      req.on('finish',()=>{
        calls.push({method:opts.method,headers:opts.headers,bytes:Buffer.concat(chunks),path:url.pathname});
        const res=new PassThrough();res.headers={};let body='';
        if(opts.method==='PROPFIND'){
          res.statusCode=denyDirectory?403:207;
          const isFile=url.pathname.endsWith('.zip');
          body=`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${url.pathname}</d:href><d:propstat><d:prop><d:resourcetype>${isFile?'':'<d:collection/>'}</d:resourcetype>${isFile?`<d:getcontentlength>${bytes.length}</d:getcontentlength>`:''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
        }else res.statusCode=opts.method==='PUT'?putCode:opts.method==='MOVE'?moveCode:200;
        callback(res);res.end(body);
      });
      return req;
    };
    await init({use(){},get(p,f){routes.set('GET '+p,f);},post(p,f){routes.set('POST '+p,f);}});
    stagingRoot=createStagingManager(temp).root;owner=fs.readFileSync(path.join(stagingRoot,'.owner'),'utf8');
    async function invoke(route,body){let payload,code=200;const res={headersSent:false,status(c){code=c;return this;},json(v){payload=v;}};await routes.get(route)({body,user:{profile:{admin:true,handle:'default-user'}}},res);return {code,payload};}
    async function finish(){for(let i=0;i<500;i++){await new Promise(r=>setTimeout(r,2));const s=(await invoke('GET /status')).payload;if(!s.busy)return s;}assert.fail('backup did not finish');}
    const save=changes=>invoke('POST /config',{url:'https://example.test/dav/backups/',username:'fake',...changes});
    let c=(await invoke('GET /config')).payload;
    assert.equal(c.uploadMode,'stream');assert.equal(c.stagingMaxMiB,1024);assert.deepEqual(c.supportedUploadModes,['stream','staged']);
    await save({uploadMode:'staged',stagingMaxMiB:64});await save({});
    c=(await invoke('GET /config')).payload;assert.equal(c.uploadMode,'staged');assert.equal(c.stagingMaxMiB,64);
    for(const invalid of [{uploadMode:'auto'},{stagingMaxMiB:63},{stagingMaxMiB:65537},{stagingMaxMiB:64.5},{stagingMaxMiB:'64'}])assert.equal((await save(invalid)).code,400);
    producer='hold';await invoke('POST /backup',{});
    for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,2));
    assert.ok(release);let s=(await invoke('GET /status')).payload;
    assert.equal(s.phase,'packing');assert.equal(s.totalBytes,null);assert.equal(calls.some(c=>c.method==='PUT'),false);
    assert.equal((await save({})).code,409);
    producer='success';release();s=await finish();
    assert.equal(s.phase,'uploaded');assert.equal(s.uploadMode,'staged');assert.equal(s.archiveBytes,bytes.length);assert.equal(s.totalBytes,bytes.length);assert.equal(s.bytes,bytes.length);assert.equal(s.sizeVerification,'matched');
    let put=calls.find(c=>c.method==='PUT');assert.deepEqual(put.bytes,bytes);assert.equal(put.headers['Content-Length'],bytes.length);
    assert.equal(calls.find(c=>c.method==='MOVE').headers.Overwrite,'F');
    assert.deepEqual(fs.readdirSync(stagingRoot),['.owner']);
    calls.length=0;await save({uploadMode:'stream'});await invoke('POST /backup',{});s=await finish();
    assert.equal(s.phase,'uploaded');assert.equal(s.totalBytes,null);assert.equal(s.archiveBytes,null);
    put=calls.find(c=>c.method==='PUT');assert.deepEqual(put.bytes,bytes);assert.equal(put.headers['Content-Length'],undefined);
    await save({uploadMode:'staged'});calls.length=0;producer='fail';await invoke('POST /backup',{});s=await finish();
    assert.equal(s.failureStage,'packing');assert.match(s.note,/未上传/);assert.equal(calls.some(c=>['PUT','MOVE'].includes(c.method)),false);assert.deepEqual(fs.readdirSync(stagingRoot),['.owner']);
    producer='success';denyDirectory=true;calls.length=0;await invoke('POST /backup',{});s=await finish();assert.equal(s.failureStage,'preparing');assert.equal(calls.some(c=>c.method==='PUT'),false);denyDirectory=false;
    for(const code of [411,413,507,307]){
      calls.length=0;putCode=code;await invoke('POST /backup',{});s=await finish();
      assert.equal(s.phase,'failed');assert.equal(s.failureStage,'uploading');assert.match(s.error,new RegExp(String(code)));assert.equal(calls.filter(c=>c.method==='PUT').length,1);assert.equal(calls.some(c=>c.method==='MOVE'),false);assert.deepEqual(fs.readdirSync(stagingRoot),['.owner']);
    }
    putCode=201;moveCode=405;calls.length=0;await invoke('POST /backup',{});s=await finish();assert.equal(s.failureStage,'renaming');assert.match(s.error,/MOVE/);assert.equal(calls.filter(c=>c.method==='MOVE').length,1);moveCode=201;
    // An unknown local file makes cleanup fail safely, without reversing remote success.
    globalThis.__uploadProduce=async stream=>{
      const dir=fs.readdirSync(stagingRoot).find(n=>n.startsWith('task-'));
      fs.writeFileSync(path.join(stagingRoot,dir,'unexpected'),'keep');stream.end(bytes);
    };
    await invoke('POST /backup',{});s=await finish();assert.equal(s.phase,'uploaded');assert.match(s.cleanupWarning,/清理失败/);
    assert.equal((await invoke('POST /backup',{})).code,409);
    globalThis.__uploadProduce=async stream=>stream.end(bytes);
    await save({uploadMode:'stream'});await invoke('POST /backup',{});assert.equal((await finish()).phase,'uploaded');
    assert.equal((await invoke('GET /config')).payload.stagingAvailable,false);
    assert.equal(typeof request,'function');
  } finally {
    https.request=original;process.chdir(cwd);delete globalThis.__uploadProduce;
    if(previousRoot)Object.defineProperty(globalThis,'DATA_ROOT',previousRoot);else delete globalThis.DATA_ROOT;
    if(stagingRoot){
      assert.equal(fs.realpathSync(stagingRoot),stagingRoot);assert.equal(path.dirname(stagingRoot),parent);assert.equal(fs.readFileSync(path.join(stagingRoot,'.owner'),'utf8'),owner);
      // This is the exact hash-keyed root created for this test's unique DATA_ROOT.
      fs.rmSync(stagingRoot,{recursive:true,force:true});
    }
    assert.equal(fs.realpathSync(temp),temp);assert.equal(path.dirname(temp),parent);fs.rmSync(temp,{recursive:true,force:true});
  }
});
