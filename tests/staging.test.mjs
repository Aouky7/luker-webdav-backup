import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Writable} from 'node:stream';
import {createStagingManager,MiB} from '../staging.mjs';

function fixture(operations = {}) {
  const parent = fs.realpathSync(os.tmpdir());
  const base = fs.mkdtempSync(path.join(parent,'luker-staging-test-'));
  const data = path.join(base,'data'); fs.mkdirSync(data);
  const manager = createStagingManager(data,{tmpDir:base,operations});
  return {manager,base,data,close() {
    // Exact directory created by this test; validate boundary before removal.
    assert.equal(fs.realpathSync(base),base); assert.equal(path.dirname(base),parent);
    fs.rmSync(base,{recursive:true,force:true});
  }};
}

test('private archive waits for producer and writer; byte accounting and recovery cleanup',async()=>{
  const f = fixture();
  try {
    assert.equal((await f.manager.recover()).available,true);
    const task = f.manager.create();
    let release, finished=false;
    const result = f.manager.pack(task,async stream=>{
      stream.end(Buffer.from('archive'));
      await new Promise(resolve=>{release=resolve;});
    },{maxBytes:1024,onProgress:n=>assert.equal(n,7)}).then(v=>{finished=true;return v;});
    while(!release)await new Promise(r=>setImmediate(r));
    await new Promise(r=>setImmediate(r));
    assert.equal(finished,false,'ending output alone is not producer success');
    release();
    assert.deepEqual(await result,{archiveBytes:7,totalBytes:7});
    assert.equal(fs.statSync(task.directory).mode & 0o777,0o700);
    assert.equal(fs.statSync(task.archive).mode & 0o777,0o600);
    assert.equal(fs.readFileSync(task.archive,'utf8'),'archive');
    const restarted=createStagingManager(f.data,{tmpDir:f.base});
    assert.equal((await restarted.recover()).available,true);
    assert.equal(fs.existsSync(task.directory),false);
    assert.deepEqual(fs.readdirSync(restarted.root),['.owner']);
  } finally {f.close();}
});

test('limits reject oversize and initial or periodic low disk space',async()=>{
  let low=false,checks=0;
  const f=fixture({statfsSync(){checks++;return {bavail:BigInt(low?63:256),bsize:BigInt(MiB)};}});
  try {
    await f.manager.recover(); low=true;
    assert.throws(()=>f.manager.create(),/64 MiB/);
    assert.deepEqual(fs.readdirSync(f.manager.root),['.owner']);
    low=false;let task=f.manager.create();
    await assert.rejects(f.manager.pack(task,s=>s.end(Buffer.alloc(11)),{maxBytes:10}),/上限/);
    f.manager.cleanup(task);
    task=f.manager.create();
    await assert.rejects(f.manager.pack(task,s=>{low=true;s.end(Buffer.alloc(16*MiB));},{maxBytes:32*MiB}),/64 MiB/);
    f.manager.cleanup(task);assert.ok(checks>=4);
  } finally {f.close();}
});

test('producer rejection after end, output failure and stalled producer stop packing',async()=>{
  const f=fixture();
  try {
    await f.manager.recover();
    let task=f.manager.create();
    await assert.rejects(f.manager.pack(task,async s=>{s.end('data');throw Error('producer failed');},{maxBytes:100}),/producer failed/);
    f.manager.cleanup(task);
    task=f.manager.create();
    await assert.rejects(f.manager.pack(task,()=>new Promise(()=>{}),{maxBytes:100,timeoutMs:15}),/时限/);
    f.manager.cleanup(task);
    task=f.manager.create();
    // Existing archive proves exclusive creation; no overwrite is allowed.
    fs.writeFileSync(task.archive,'keep');
    await assert.rejects(f.manager.pack(task,s=>s.end('replace'),{maxBytes:100}),/EEXIST/);
    assert.equal(fs.readFileSync(task.archive,'utf8'),'keep');
    f.manager.cleanup(task);
  } finally {f.close();}
});

test('statfs failure blocks packing and ENOSPC from file writer rejects without leaking a task',async()=>{
  let statError=false;
  const f=fixture({
    statfsSync(...args){if(statError)throw Object.assign(Error('statfs unavailable'),{code:'EIO'});return fs.statfsSync(...args);},
    createWriteStream(){return new Writable({write(chunk,encoding,done){done(Object.assign(Error('disk full ENOSPC'),{code:'ENOSPC'}));}});}
  });
  try {
    await f.manager.recover();
    statError=true;assert.throws(()=>f.manager.create(),/statfs unavailable/);
    assert.deepEqual(fs.readdirSync(f.manager.root),['.owner']);
    statError=false;const task=f.manager.create();
    await assert.rejects(f.manager.pack(task,s=>s.end('data'),{maxBytes:100}),/ENOSPC/);
    f.manager.cleanup(task);
    assert.deepEqual(fs.readdirSync(f.manager.root),['.owner']);
  } finally {f.close();}
});

test('recovery refuses unowned markers, symlinks and unknown children without deleting data',async()=>{
  const f=fixture();
  try {
    await f.manager.recover();
    const task=f.manager.create();
    const outside=path.join(f.base,'outside');fs.writeFileSync(outside,'keep');
    fs.symlinkSync(outside,task.archive);
    assert.equal((await f.manager.recover()).available,false);
    assert.equal(fs.readFileSync(outside,'utf8'),'keep');
    assert.throws(()=>f.manager.create(),/不可用/);
    // Remove exactly the test-created symlink after verifying its type and target.
    assert.equal(fs.lstatSync(task.archive).isSymbolicLink(),true);
    assert.equal(fs.readlinkSync(task.archive),outside);fs.unlinkSync(task.archive);
    fs.writeFileSync(path.join(task.directory,'foreign'),'keep');
    assert.equal((await f.manager.recover()).available,false);
    assert.equal(fs.readFileSync(path.join(task.directory,'foreign'),'utf8'),'keep');
    assert.throws(()=>f.manager.cleanup({directory:f.base}),/非本插件/);
  } finally {f.close();}
});

test('marker mismatch blocks recovery and cleanup errors block subsequent staged work',async()=>{
  let denied=false;
  const f=fixture({unlinkSync(p){if(denied)throw Error('injected unlink failure');return fs.unlinkSync(p);}});
  try {
    await f.manager.recover();
    const task=f.manager.create();
    await f.manager.pack(task,s=>s.end('data'),{maxBytes:100});
    denied=true;assert.throws(()=>f.manager.cleanup(task),/清理失败/);
    assert.throws(()=>f.manager.create(),/暂停/);
    denied=false;assert.equal((await f.manager.recover()).available,true);
    const second=f.manager.create();
    fs.writeFileSync(path.join(second.directory,'.owner'),'wrong');
    assert.equal((await f.manager.recover()).available,false);
    assert.equal(fs.existsSync(second.directory),true);
  } finally {f.close();}
});
