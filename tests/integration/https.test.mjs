import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {init} from '../../index.mjs';

const ZIP = Buffer.from('UEsDBBQAAAAIAAAAIVqJJZ6IRAAAAIAKAAANAAAAc3ludGhldGljLnR4dAuuzCvJSC3JTFZISkzOLi1QKEktLlHIz8up1FPwy1coLU4tUkhJLEnU4woeVTmqclTlqMpRlaMqR1WOqhxVOaqSYpUAUEsBAhQDFAAAAAgAAAAhWoklnohEAAAAgAoAAA0AAAAAAAAAAAAAAIABAAAAAHN5bnRoZXRpYy50eHRQSwUGAAAAAAEAAQA7AAAAbwAAAAAA', 'base64');
const digest = b => createHash('sha256').update(b).digest('hex');
const credentials = {username:'test-user',password:'test-password'};
const auth = 'Basic ' + Buffer.from('test-user:test-password').toString('base64');
const escape = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;');
const resource = (name, data) => `<d:response><d:href>${escape(name)}</d:href><d:propstat><d:prop><d:resourcetype>${data === null ? '<d:collection/>' : ''}</d:resourcetype>${data === null ? '' : `<d:getcontentlength>${data.length}</d:getcontentlength>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

function fixture() {
  const files = new Map([['/dav/',null]]), puts = [];
  const server = https.createServer({cert:fs.readFileSync(process.env.TEST_CERT),key:fs.readFileSync(process.env.TEST_KEY)}, async (req,res) => {
    try {
      if (req.headers.authorization !== auth) { res.writeHead(401).end(); return; }
      const target = new URL(req.url,'https://localhost').pathname;
      if (req.method === 'PUT' && !req.headers['content-length']) {
        puts.push({accepted:false,headers:req.headers}); req.resume(); res.writeHead(411).end(); return;
      }
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      if (req.method === 'PROPFIND') {
        if (!files.has(target)) { res.writeHead(404).end(); return; }
        const entries = [[target,files.get(target)]];
        if (req.headers.depth === '1') for (const [name,value] of files) {
          if (name !== target && name.startsWith(target) && !name.slice(target.length).replace(/\/$/,'').includes('/')) entries.push([name,value]);
        }
        // Deliberately reverse order: clients must match href, not discard the first item.
        res.writeHead(207,{'Content-Type':'application/xml'}).end('<d:multistatus xmlns:d="DAV:">' + entries.reverse().map(([n,v])=>resource(n,v)).join('') + '</d:multistatus>');
      } else if (req.method === 'MKCOL') {
        const parent = new URL('../','https://localhost'+target).pathname;
        if (!files.has(parent)) { res.writeHead(409).end(); return; }
        if (files.has(target)) { res.writeHead(405).end(); return; }
        files.set(target,null); res.writeHead(201).end();
      } else if (req.method === 'PUT') {
        const data=Buffer.concat(chunks);
        puts.push({accepted:true,headers:req.headers,bytes:data.length});
        assert.equal(Number(req.headers['content-length']), data.length);
        assert.equal(req.headers['transfer-encoding'],undefined);
        assert.equal(req.headers['if-none-match'],'*');
        files.set(target,data); res.writeHead(201).end();
      } else if (req.method === 'MOVE') {
        assert.equal(req.headers.overwrite,'F');
        const destination=new URL(req.headers.destination).pathname;
        if (!files.has(target)) { res.writeHead(404).end(); return; }
        files.set(destination,files.get(target)); files.delete(target); res.writeHead(201).end();
      } else if (req.method === 'GET') {
        if (!files.has(target) || files.get(target)===null) { res.writeHead(404).end(); return; }
        res.writeHead(200,{'Content-Length':files.get(target).length}).end(files.get(target));
      } else res.writeHead(405).end();
    } catch (e) { server.testFailure=e; res.destroy(e); }
  });
  return {server,puts};
}

function get(url) {
  return new Promise((resolve,reject)=> {
    const req=https.get(url,{headers:{Authorization:auth}},res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('error',reject);
      res.on('end',()=>res.statusCode===200 ? resolve(Buffer.concat(chunks)) : reject(new Error('GET HTTP '+res.statusCode)));
    }); req.on('error',reject);
  });
}

async function createHost(t) {
  const previous = process.cwd(), oldRoot = Object.getOwnPropertyDescriptor(globalThis,'DATA_ROOT');
  const parent=fs.realpathSync(os.tmpdir()), root=fs.mkdtempSync(path.join(parent,'luker-real-host-')), resolved=fs.realpathSync(root);
  fs.mkdirSync(path.join(root,'src/storage'),{recursive:true});
  fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(root,'src/users.js'),`export async function createBackupArchive(handle,source){source.end(Buffer.from('${ZIP.toString('base64')}','base64'));} export const isRequestAdmin=req=>req.user?.profile?.admin===true;`);
  fs.writeFileSync(path.join(root,'src/storage/index.js'),'export const getStorageEngine=()=>({kind:"fs"});');
  process.chdir(root); globalThis.DATA_ROOT=root;
  const routes=new Map();
  await init({use(){},get(p,f){routes.set('GET '+p,f);},post(p,f){routes.set('POST '+p,f);}});
  t.after(()=>{
    process.chdir(previous);
    if (oldRoot) Object.defineProperty(globalThis,'DATA_ROOT',oldRoot); else delete globalThis.DATA_ROOT;
    assert.equal(fs.realpathSync(root),resolved); assert.equal(path.dirname(resolved),parent);
    assert.ok(path.basename(resolved).startsWith('luker-real-host-')); fs.rmSync(resolved,{recursive:true,force:true});
  });
  async function call(route,body) {
    let code=200,payload;
    await routes.get(route)({body,user:{profile:{admin:true,handle:'synthetic'}}},{headersSent:false,status(c){code=c;return this;},json(p){payload=p;},set(){}});
    return {code,payload};
  }
  async function backup(url,mode) {
    const saved=await call('POST /config',{...credentials,url,uploadMode:mode,stagingMaxMiB:64});
    assert.equal(saved.code,200,JSON.stringify(saved.payload));
    const started=await call('POST /backup',{selection:{settings:true}}); assert.equal(started.code,202);
    const deadline=Date.now()+15000;
    for (;;) {
      const {payload}=await call('GET /status');
      if (!payload.busy && ['uploaded','failed','interrupted'].includes(payload.phase)) return payload;
      assert.ok(Date.now()<deadline,'backup did not complete within 15 seconds'); await delay(20);
    }
  }
  return {call,backup};
}

test('real HTTPS: strict length server rejects stream and accepts staged ZIP with exact content', {timeout:30000}, async t=>{
  const {server,puts}=fixture();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const host=await createHost(t);
  const folder=`https://127.0.0.1:${server.address().port}/dav/${encodeURIComponent('测试 空间')}/nested/`;
  const streamed=await host.backup(folder,'stream');
  assert.equal(streamed.phase,'failed'); assert.match(streamed.error,/411/);
  assert.equal(puts.filter(p=>!p.accepted).length,1,'uncertain writes must not be replayed');
  const staged=await host.backup(folder,'staged');
  assert.equal(staged.phase,'uploaded',staged.error); assert.equal(staged.sizeVerification,'matched');
  assert.equal(staged.totalBytes,ZIP.length); assert.equal(staged.bytes,ZIP.length);
  assert.equal(puts.filter(p=>p.accepted).length,1);
  const list=await host.call('GET /backups'); assert.equal(list.code,200); assert.equal(list.payload.files.length,1);
  const received=await get(new URL(staged.name,folder)); assert.equal(digest(received),digest(ZIP));
  assert.equal(server.testFailure,undefined);
});

test('independent WsgiDAV: both upload modes, nested encoded folders, MOVE, list and download hash', {skip:!process.env.TEST_DAV_URL,timeout:30000}, async t=>{
  const host=await createHost(t);
  const folder=new URL(encodeURIComponent('独立 服务')+'/nested/',process.env.TEST_DAV_URL).href;
  for (const mode of ['stream','staged']) {
    const result=await host.backup(folder,mode);
    assert.equal(result.phase,'uploaded',`${mode}: ${result.error}`);
    assert.equal(result.sizeVerification,'matched');
    const received=await get(new URL(result.name,folder));
    assert.equal(digest(received),digest(ZIP),mode+' archive digest');
  }
  const list=await host.call('GET /backups'); assert.equal(list.code,200); assert.equal(list.payload.files.length,2);
  assert.ok(list.payload.files.every(f=>f.bytes===ZIP.length));
});
