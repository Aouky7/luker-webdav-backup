import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {Writable,PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {init,request} from '../index.mjs';

test('stream uploads ignore legacy staged settings, preserve failure boundaries and interrupted stages',async()=>{
  const cwd=process.cwd(),previousRoot=Object.getOwnPropertyDescriptor(globalThis,'DATA_ROOT'),original=https.request;
  const parent=fs.realpathSync(os.tmpdir()),temp=fs.mkdtempSync(path.join(parent,'luker-upload-test-'));
  const routes=new Map(),calls=[];let producer='success',putCode=201,moveCode=201,denyDirectory=false,remoteSize=16,release;
  const bytes=Buffer.from('ZIP sample bytes');
  try {
    fs.mkdirSync(path.join(temp,'src/storage'),{recursive:true});
    fs.writeFileSync(path.join(temp,'package.json'),'{"type":"module"}');
    fs.writeFileSync(path.join(temp,'src/users.js'),'export const createBackupArchive=(h,res)=>globalThis.__uploadProduce(res);export const isRequestAdmin=r=>r.user?.profile?.admin===true;');
    fs.writeFileSync(path.join(temp,'src/storage/index.js'),'export const getStorageEngine=()=>({kind:"fs"});');
    const configPath=path.join(temp,'_webdav-backup.json'),statePath=path.join(temp,'_webdav-backup-status.json');
    fs.writeFileSync(configPath,JSON.stringify({url:'https://example.test/dav/backups/',username:'fake',uploadMode:'staged',stagingMaxMiB:'invalid old value'}));
    const marker=path.join(temp,'.webdav-backup-staging-tmp');fs.mkdirSync(marker);fs.writeFileSync(path.join(marker,'keep'),'untouched');
    process.chdir(temp);globalThis.DATA_ROOT=temp;
    globalThis.__uploadProduce=async stream=>{
      if(producer==='fail')throw Error('archive producer failed');
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
          body=`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${url.pathname}</d:href><d:propstat><d:prop><d:resourcetype>${isFile?'':'<d:collection/>'}</d:resourcetype>${isFile&&remoteSize!==null?`<d:getcontentlength>${remoteSize}</d:getcontentlength>`:''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
        }else res.statusCode=opts.method==='PUT'?putCode:opts.method==='MOVE'?moveCode:200;
        callback(res);res.end(body);
      });
      return req;
    };
    const router={use(){},get(p,f){routes.set('GET '+p,f);},post(p,f){routes.set('POST '+p,f);}};
    await init(router);
    async function invoke(route,body){let payload,code=200;const res={headersSent:false,status(c){code=c;return this;},json(v){payload=v;}};await routes.get(route)({body,user:{profile:{admin:true,handle:'default-user'}}},res);return {code,payload};}
    async function finish(){for(let i=0;i<500;i++){await new Promise(r=>setTimeout(r,2));const s=(await invoke('GET /status')).payload;if(!s.busy)return s;}assert.fail('backup did not finish');}
    const save=changes=>invoke('POST /config',{url:'https://example.test/dav/backups/',username:'fake',...changes});
    const c=(await invoke('GET /config')).payload;
    assert.equal(c.uploadMode,'stream');assert.deepEqual(c.supportedUploadModes,['stream']);assert.equal('stagingWarning' in c,false);
    producer='hold';await invoke('POST /backup',{});
    for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,2));
    assert.ok(release);let s=(await invoke('GET /status')).payload;
    assert.equal(s.phase,'uploading');assert.equal((await save({})).code,409);
    producer='success';release();s=await finish();
    assert.equal(s.phase,'uploaded');assert.equal(s.bytes,bytes.length);assert.equal(s.sizeVerification,'matched');
    const put=calls.find(c=>c.method==='PUT');assert.deepEqual(put.bytes,bytes);assert.equal(put.headers['Content-Length'],undefined);assert.equal(put.headers['If-None-Match'],'*');
    assert.equal(calls.find(c=>c.method==='MOVE').headers.Overwrite,'F');assert.equal(s.totalBytes,undefined);
    assert.equal(fs.readFileSync(path.join(marker,'keep'),'utf8'),'untouched');
    await save({uploadMode:'staged',stagingMaxMiB:0});
    const persisted=JSON.parse(fs.readFileSync(configPath));assert.equal('uploadMode' in persisted,false);assert.equal('stagingMaxMiB' in persisted,false);
    for(const url of ['http://example.test/dav/','https://example.test/dav/%2f/'])assert.equal((await save({url})).code,400);
    calls.length=0;producer='fail';await invoke('POST /backup',{});s=await finish();assert.equal(s.failureStage,'uploading');assert.equal(calls.some(c=>c.method==='MOVE'),false);
    producer='success';denyDirectory=true;calls.length=0;await invoke('POST /backup',{});s=await finish();assert.equal(s.failureStage,'preparing');assert.match(s.note,/未上传/);assert.equal(calls.some(c=>c.method==='PUT'),false);denyDirectory=false;
    for(const code of [411,413,507,307]){
      calls.length=0;putCode=code;await invoke('POST /backup',{});s=await finish();
      assert.equal(s.phase,'failed');assert.equal(s.failureStage,'uploading');assert.match(s.error,new RegExp(String(code)));assert.equal(calls.filter(c=>c.method==='PUT').length,1);assert.equal(calls.some(c=>c.method==='MOVE'),false);assert.doesNotMatch(s.error,/改用兼容/);
    }
    putCode=201;moveCode=405;calls.length=0;await invoke('POST /backup',{});s=await finish();assert.equal(s.failureStage,'renaming');assert.match(s.note,/最终 .zip/);assert.equal(calls.filter(c=>c.method==='MOVE').length,1);moveCode=201;
    remoteSize=1;await invoke('POST /backup',{});assert.equal((await finish()).sizeVerification,'mismatch');
    remoteSize=null;await invoke('POST /backup',{});assert.equal((await finish()).sizeVerification,'unknown');
    for(const phase of ['preparing','packing','uploading','renaming','verifying']){
      fs.writeFileSync(statePath,JSON.stringify({phase,name:'legacy.zip'}));await init(router);
      s=(await invoke('GET /status')).payload;assert.equal(s.phase,'interrupted');assert.equal(s.failureStage,phase);
      assert.match(s.error,['preparing','packing'].includes(phase)?/未上传/:phase==='renaming'?/改名结果未确认/:phase==='verifying'?/核验未完成/:/partial/);
    }
    assert.equal(fs.readFileSync(path.join(marker,'keep'),'utf8'),'untouched');assert.equal(typeof request,'function');
  } finally {
    https.request=original;process.chdir(cwd);delete globalThis.__uploadProduce;
    if(previousRoot)Object.defineProperty(globalThis,'DATA_ROOT',previousRoot);else delete globalThis.DATA_ROOT;
    assert.equal(fs.realpathSync(temp),temp);assert.equal(path.dirname(temp),parent);assert.ok(path.basename(temp).startsWith('luker-upload-test-'));fs.rmSync(temp,{recursive:true,force:true});
  }
});
