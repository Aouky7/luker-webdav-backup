import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough, Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {request,init} from '../index.mjs';

const config={username:'PRIVATE_USER',password:'PRIVATE_PASSWORD'};
const url=new URL('https://private.example/secret-path/');
const expectedKeys=['method','kind','errorCode','elapsedMs','bodyBytes','uploadFinishedMs','responseStartedMs','responseStatus','reusedSocket','idleTimeoutMs','totalTimeoutMs'].sort();
function evidence(error,kind) {
  const d=error.networkDiagnostic;
  assert.equal(d.kind,kind);
  assert.deepEqual(Object.keys(d).sort(),expectedKeys);
  assert.equal(d.idleTimeoutMs,120000);
  assert.ok(Number.isSafeInteger(d.elapsedMs) && d.elapsedMs>=0);
  assert.ok(Number.isSafeInteger(d.bodyBytes) && d.bodyBytes>=0);
  for(const key of ['uploadFinishedMs','responseStartedMs']) assert.ok(d[key]===null || Number.isSafeInteger(d[key]) && d[key]>=0 && d[key]<=d.elapsedMs);
  assert.doesNotMatch(JSON.stringify(d),/PRIVATE|private\.example|secret-path|127\.0\.0\.1|Authorization|cookie|Bearer/);
  return d;
}
async function mocked(t,make,run) {
  const original=https.request;let count=0;
  https.request=(target,opts,respond)=>{count++;return make(opts,respond);};
  try {await run(()=>count);} finally {https.request=original;}
}
function reqStub(write=(_chunk,_encoding,done)=>done()) {
  const req=new Writable({write});
  req.setTimeout=(ms,cb)=>{req.idleMs=ms;req.idle=cb;return req;};
  return req;
}
async function rejected(p) {try {await p;assert.fail('expected request failure');}catch(e){return e;}}

test('reset retains original code, partial body count, reuse flag and sanitized monotonic evidence without retry',async t=>{
  await mocked(t,()=>{
    const req=reqStub((chunk,encoding,done)=>{
      done();process.nextTick(()=>req.destroy(Object.assign(Error('PRIVATE_PASSWORD https://private.example/secret-path/ 127.0.0.1'),{code:'ECONNRESET'})));
    });req.reusedSocket=true;return req;
  },async count=>{
    const body=new PassThrough();const pending=request(config,'PUT',url,body);
    body.write(Buffer.alloc(1024));
    const error=await rejected(pending);const d=evidence(error,'network');
    assert.equal(error.code,'ECONNRESET');assert.match(error.message,/ECONNRESET/);
    assert.doesNotMatch(error.message,/PRIVATE|private\.example|127\.0/);
    assert.equal(d.errorCode,'ECONNRESET');assert.equal(d.bodyBytes,1024);
    assert.equal(d.reusedSocket,true);assert.equal(d.uploadFinishedMs,null);assert.equal(d.responseStatus,null);assert.equal(d.totalTimeoutMs,1800000);
    await delay(10);assert.equal(count(),1);assert.ok(body.destroyed);
  });
});

test('idle timeout is distinguished from total timeout and defaults stay unchanged',async t=>{
  let req;
  await mocked(t,()=>{req=reqStub();return req;},async count=>{
    const pending=request(config,'PUT',url,new PassThrough());
    assert.equal(req.idleMs,120000);req.idle();
    const d=evidence(await rejected(pending),'idle-timeout');assert.equal(d.totalTimeoutMs,1800000);assert.equal(d.errorCode,null);assert.equal(count(),1);
  });
  await mocked(t,()=>reqStub(),async count=>{
    const error=await rejected(request(config,'PUT',url,new PassThrough(),{},10));
    const d=evidence(error,'total-timeout');assert.equal(d.totalTimeoutMs,10);assert.equal(d.errorCode,null);assert.equal(count(),1);
  });
});

test('HTTP rejection wins over destruction fallout and captures response timing',async t=>{
  await mocked(t,(_opts,respond)=>{
    const req=reqStub();
    process.nextTick(()=>{const res=new PassThrough();res.statusCode=413;res.headers={'set-cookie':'PRIVATE_PASSWORD'};respond(res);res.end();});
    return req;
  },async count=>{
    const error=await rejected(request(config,'PUT',url,new PassThrough()));
    const d=evidence(error,'http');assert.equal(error.statusCode,413);assert.equal(d.responseStatus,413);assert.notEqual(d.responseStartedMs,null);assert.equal(d.errorCode,null);
    await delay(10);assert.equal(count(),1);
  });
});

test('response abort preserves ECONNRESET rather than masking it with premature-close',async t=>{
  await mocked(t,(_opts,respond)=>{
    const req=reqStub();req.reusedSocket=false;
    req.on('finish',()=>{const res=new PassThrough();res.statusCode=200;res.headers={};respond(res);res.emit('aborted');res.destroy(Object.assign(Error('private details'),{code:'ECONNRESET'}));});
    return req;
  },async()=>{
    const error=await rejected(request(config,'PUT',url,'test'));
    const d=evidence(error,'response');assert.equal(d.errorCode,'ECONNRESET');assert.equal(d.bodyBytes,4);assert.equal(d.responseStatus,200);assert.notEqual(d.uploadFinishedMs,null);assert.equal(d.reusedSocket,false);
  });
});

test('premature request close and source errors are bounded, distinct and settle once',async t=>{
  await mocked(t,()=>{const req=reqStub();process.nextTick(()=>req.destroy());return req;},async()=>{
    const d=evidence(await rejected(request(config,'PUT',url,new PassThrough())),'premature-close');assert.equal(d.responseStatus,null);
  });
  await mocked(t,()=>reqStub(),async()=>{
    const body=new PassThrough();const pending=request(config,'PUT',url,body);
    body.destroy(Object.assign(Error('SECRET_SOURCE_PAYLOAD'),{code:'ERR_STREAM_WRITE_AFTER_END'}));
    const error=await rejected(pending);const d=evidence(error,'stream');assert.equal(d.errorCode,'ERR_STREAM_WRITE_AFTER_END');assert.doesNotMatch(error.message,/SECRET_SOURCE/);
  });
});

test('successful request waits for complete upload and response even with mocks without sockets',async t=>{
  let req;
  await mocked(t,(_opts,respond)=>{
    req=reqStub();req.on('finish',()=>{const res=new PassThrough();res.statusCode=201;res.headers={};respond(res);res.end('ok');});return req;
  },async count=>{
    const body=new PassThrough();let resolved=false;
    const pending=request(config,'PUT',url,body).then(r=>{resolved=true;return r;});
    body.write('ab');await delay(5);assert.equal(resolved,false);
    body.end('cd');assert.equal((await pending).text,'ok');assert.equal(count(),1);assert.ok(req.writableFinished);
  });
});

test('backup persists original reset evidence despite forwarding pipeline rejection race',async()=>{
  const previous=process.cwd(),original=https.request,oldRoot=Object.getOwnPropertyDescriptor(globalThis,'DATA_ROOT');
  const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'luker-diagnostic-test-')),resolved=fs.realpathSync(root);
  const routes=new Map();let puts=0;
  try {
    fs.mkdirSync(path.join(root,'src/storage'),{recursive:true});
    fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
    fs.writeFileSync(path.join(root,'src/users.js'),"export function createBackupArchive(h,s){s.write(Buffer.alloc(32768));} export const isRequestAdmin=r=>r.user?.profile?.admin===true;");
    fs.writeFileSync(path.join(root,'src/storage/index.js'),'export const getStorageEngine=()=>({kind:"fs"});');
    fs.writeFileSync(path.join(root,'_webdav-backup.json'),JSON.stringify({...config,url:url.href}));
    process.chdir(root);globalThis.DATA_ROOT=root;
    https.request=(target,opts,respond)=>{
      if(opts.method==='PUT') {
        puts++;const req=reqStub((chunk,enc,done)=>{done();process.nextTick(()=>req.destroy(Object.assign(Error('private upstream message'),{code:'ECONNRESET'})));});return req;
      }
      assert.equal(opts.method,'PROPFIND');const req=reqStub();
      req.on('finish',()=>{const res=new PassThrough();res.statusCode=207;res.headers={};respond(res);res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${target.pathname}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);});return req;
    };
    await init({use(){},get(p,f){routes.set('GET '+p,f);},post(p,f){routes.set('POST '+p,f);}});
    async function call(route,body){let value;await routes.get(route)({body,user:{profile:{admin:true,handle:'synthetic'}}},{headersSent:false,status(){return this;},json(v){value=v;}});return value;}
    await call('POST /backup',{});
    let state;
    for(let i=0;i<100;i++){state=await call('GET /status');if(!state.busy)break;await delay(5);}
    assert.equal(state.phase,'failed');assert.equal(state.failureStage,'uploading');assert.match(state.error,/ECONNRESET/);assert.equal(puts,1);
    evidence({networkDiagnostic:state.networkDiagnostic},'network');assert.equal(state.networkDiagnostic.errorCode,'ECONNRESET');
    const saved=JSON.parse(fs.readFileSync(path.join(root,'_webdav-backup-status.json'),'utf8'));
    assert.deepEqual(saved.networkDiagnostic,state.networkDiagnostic);
  } finally {
    https.request=original;process.chdir(previous);
    if(oldRoot)Object.defineProperty(globalThis,'DATA_ROOT',oldRoot);else delete globalThis.DATA_ROOT;
    assert.equal(fs.realpathSync(root),resolved);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('luker-diagnostic-test-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
