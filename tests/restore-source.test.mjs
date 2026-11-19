import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRestoreSource, MAX_RESTORE_BYTES } from '../restore-source.mjs';

const name = 'luker-2025-01-02T03-04-05-006Z-00000000-0000-4000-8000-000000000001.zip';
const folder = 'https://dav.example/dav/LukerBackup/';
const zip = Buffer.from([0x50,0x4b,0x03,0x04,0x61,0x62,0x63,0x64]);

function makeXml(bytes, fileName = name) {
  return `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/LukerBackup/${fileName}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${bytes}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
}
function metadataRequest(bytes = zip.length, {gate} = {}) {
  return async (_config, method) => {
    if (gate) await gate;
    if (method === 'PROPFIND') return {text:makeXml(bytes)};
    throw new Error('unexpected method');
  };
}
function mockResponse() {
  const res = new PassThrough();
  res.headers = {};
  res.payload = undefined;
  res.headersSent = false;
  res.status = status => { res.statusCode = status; return res; };
  res.set = (key, value) => { res.headers[key.toLowerCase()] = value; return res; };
  res.json = value => { res.payload = value; res.headersSent = true; res.end(); return res; };
  const write = res.write.bind(res);
  res.write = (...args) => { res.headersSent = true; return write(...args); };
  return res;
}
function makeHarness({bytes = zip.length, request = metadataRequest(bytes), canStart = () => true, httpsImpl, onLock} = {}) {
  const routes = new Map();
  const controller = createRestoreSource({
    getConfig:() => ({url:folder,username:'test-user',password:'fake-secret'}),
    validate:() => new URL(folder), request, canStart, onLock, httpsImpl,
  });
  controller.register({post:(path, handler) => routes.set(path, handler)});
  const invoke = async (path, body = {}, handle = 'alice', res = mockResponse()) => {
    await routes.get(path)({body,user:handle ? {profile:{handle}} : null},res);
    return res;
  };
  return {controller,routes,invoke};
}
async function prepare(harness, handle = 'alice') {
  const res = await harness.invoke('/restore/prepare',{name},handle);
  assert.equal(res.statusCode,200,JSON.stringify(res.payload));
  return res.payload;
}

class FakeRequest extends EventEmitter {
  constructor(onEnd) { super(); this.onEnd = onEnd; this.destroyed = false; }
  setTimeout(_ms, callback) { this.timeoutCallback = callback; return this; }
  end() { this.onEnd(); }
  destroy(error) {
    this.destroyed = true;
    if (error) this.emit('error',error);
    return this;
  }
}
function fakeHttps({status = 200, headers = {'content-length':String(zip.length)}, chunks = [zip], delay = 0, hold = false} = {}) {
  const observed = {options:null,request:null,response:null};
  return {
    observed,
    request(target, options, callback) {
      observed.options = {target:String(target),...options};
      const req = new FakeRequest(() => setImmediate(() => {
        const remote = new PassThrough();
        remote.statusCode = status;
        remote.headers = headers;
        observed.response = remote;
        callback(remote);
        if (hold) { for (const chunk of chunks) remote.write(chunk); return; }
        setTimeout(() => { for (const chunk of chunks) remote.write(chunk); remote.end(); },delay);
      }));
      observed.request = req;
      return req;
    },
  };
}

 test('exports the 2 GiB cap and rejects invalid names and non-HTTPS configuration', async () => {
  assert.equal(MAX_RESTORE_BYTES,2 * 1024 * 1024 * 1024);
  const h = makeHarness();
  for (const invalid of ['../secret.zip','https://evil.example/file.zip','backup.zip',name + '.partial']) {
    const res = await h.invoke('/restore/prepare',{name:invalid});
    assert.equal(res.statusCode,400);
  }
  assert.equal(h.controller.isLocked(),false);
  const bad = createRestoreSource({getConfig:() => ({url:'http://dav.example/folder/'}),validate:() => new URL('http://dav.example/folder/'),request:metadataRequest(),canStart:() => true});
  const routes = new Map(); bad.register({post:(path,handler) => routes.set(path,handler)});
  const res = mockResponse(); await routes.get('/restore/prepare')({body:{name},user:{profile:{handle:'alice'}}},res);
  assert.equal(res.statusCode,400); assert.equal(bad.isLocked(),false);
 });

test('prepare requires a safe positive remote size and enforces the cap', async () => {
  for (const bytes of [0,-1,Number.MAX_SAFE_INTEGER + 1,MAX_RESTORE_BYTES + 1]) {
    const h = makeHarness({bytes});
    const res = await h.invoke('/restore/prepare',{name});
    assert.ok([502,413].includes(res.statusCode));
    assert.equal(h.controller.isLocked(),false);
    assert.doesNotMatch(JSON.stringify(res.payload),/fake-secret|test-user/);
  }
  const h = makeHarness({bytes:MAX_RESTORE_BYTES});
  const res = await h.invoke('/restore/prepare',{name});
  assert.equal(res.statusCode,200);
  assert.equal(res.payload.bytes,MAX_RESTORE_BYTES);
  assert.equal(res.payload.maxBytes,MAX_RESTORE_BYTES);
});

test('prepare reserves the lock before metadata awaits and clears it on metadata failure', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const h = makeHarness({request:metadataRequest(zip.length,{gate})});
  const first = h.invoke('/restore/prepare',{name});
  assert.equal(h.controller.isLocked(),true);
  assert.equal(h.controller.getState().phase,'prepared');
  assert.equal((await h.invoke('/restore/prepare',{name})).statusCode,409);
  finish();
  assert.equal((await first).statusCode,200);

  const failed = makeHarness({request:async () => { throw new Error('secret remote details'); }});
  const failure = await failed.invoke('/restore/prepare',{name});
  assert.equal(failure.statusCode,502);
  assert.deepEqual(failed.controller.getState(),{pending:false,phase:'idle',name:null,bytes:0,maxBytes:MAX_RESTORE_BYTES});
  assert.doesNotMatch(JSON.stringify(failure.payload),/secret remote details/);
});

test('sessions are owner-bound, token-bound, and expose no token or credentials in state', async () => {
  const h = makeHarness();
  const session = await prepare(h);
  assert.deepEqual(h.controller.getState(),{pending:true,phase:'prepared',name,bytes:zip.length,maxBytes:MAX_RESTORE_BYTES});
  for (const path of ['/restore/source','/restore/commit','/restore/release']) {
    assert.equal((await h.invoke(path,{token:session.token},'bob')).statusCode,403);
    assert.equal((await h.invoke(path,{token:'wrong'},'alice')).statusCode,409);
    assert.equal((await h.invoke(path,{},'alice')).statusCode,409);
  }
  assert.doesNotMatch(JSON.stringify(h.controller.getState()),/token|fake-secret|test-user/);
});

test('source GET streams validated ZIP bytes, forbids redirects, and checks response lengths', async () => {
  const upstream = fakeHttps();
  const h = makeHarness({httpsImpl:upstream});
  const session = await prepare(h);
  const res = mockResponse();
  const chunks = [];
  res.on('data',chunk => chunks.push(chunk));
  await h.invoke('/restore/source',{token:session.token},'alice',res);
  assert.equal(res.statusCode,200);
  assert.deepEqual(Buffer.concat(chunks),zip);
  assert.equal(res.headers['content-type'],'application/zip');
  assert.equal(res.headers['cache-control'],'no-store');
  assert.equal(res.headers['content-length'],String(zip.length));
  assert.equal(upstream.observed.options.method,'GET');
  assert.equal(new URL(upstream.observed.options.target).href,folder + name);
  assert.equal(upstream.observed.options.headers['Accept-Encoding'],'identity');
  assert.equal(h.controller.getState().phase,'downloaded');
  assert.equal((await h.invoke('/restore/source',{token:session.token})).statusCode,409);

  const redirected = fakeHttps({status:302,headers:{location:'https://other.invalid/private'},chunks:[Buffer.from('remote body')]});
  const redirectHarness = makeHarness({httpsImpl:redirected});
  const redirectSession = await prepare(redirectHarness);
  const redirectRes = await redirectHarness.invoke('/restore/source',{token:redirectSession.token});
  assert.equal(redirectRes.statusCode,502);
  assert.doesNotMatch(JSON.stringify(redirectRes.payload),/remote body|other.invalid/);
  assert.equal(redirectHarness.controller.getState().phase,'failed');

  const badLength = fakeHttps({headers:{'content-length':String(zip.length - 1)}});
  const lengthHarness = makeHarness({httpsImpl:badLength});
  const lengthSession = await prepare(lengthHarness);
  const lengthRes = await lengthHarness.invoke('/restore/source',{token:lengthSession.token});
  assert.equal(lengthRes.statusCode,502);
  assert.equal(lengthHarness.controller.getState().phase,'failed');
});

test('source rejects short, long, and non-ZIP streams without marking them downloaded', async () => {
  for (const chunks of [[zip.subarray(0,zip.length - 1)],[Buffer.concat([zip,Buffer.from('x')])],[Buffer.from('not a zip')]]) {
    const upstream = fakeHttps({headers:{},chunks});
    const h = makeHarness({httpsImpl:upstream});
    const session = await prepare(h);
    const res = mockResponse();
    await h.invoke('/restore/source',{token:session.token},'alice',res);
    assert.equal(h.controller.getState().phase,'failed');
    assert.notEqual(h.controller.getState().phase,'downloaded');
    assert.ok(res.destroyed || res.payload?.error);
  }
});

test('client close aborts the remote GET and leaves a cancellable failed session', async () => {
  const upstream = fakeHttps({headers:{},chunks:[zip.subarray(0,4)],hold:true});
  const h = makeHarness({httpsImpl:upstream});
  const session = await prepare(h);
  const res = mockResponse();
  const download = h.invoke('/restore/source',{token:session.token},'alice',res);
  await new Promise(resolve => setImmediate(resolve));
  res.destroy();
  await download;
  assert.equal(upstream.observed.request.destroyed,true);
  assert.equal(h.controller.getState().phase,'failed');
  assert.equal((await h.invoke('/restore/release',{token:session.token})).statusCode,200);
  assert.equal(h.controller.isLocked(),false);
});

test('commit requires a completed download; release after commit needs explicit confirmation', async () => {
  const notices = [];
  const upstream = fakeHttps();
  const h = makeHarness({httpsImpl:upstream,onLock:value => notices.push(value)});
  const session = await prepare(h);
  assert.equal((await h.invoke('/restore/commit',{token:session.token})).statusCode,409);
  const res = mockResponse(); await h.invoke('/restore/source',{token:session.token},'alice',res);
  assert.equal(h.controller.getState().phase,'downloaded');
  assert.equal((await h.invoke('/restore/commit',{token:session.token})).statusCode,200);
  assert.equal(h.controller.getState().phase,'restoring');
  assert.equal((await h.invoke('/restore/release',{token:session.token})).statusCode,409);
  assert.equal(h.controller.isLocked(),true);
  const confirmed = await h.invoke('/restore/release',{token:session.token,confirmed:true});
  assert.equal(confirmed.statusCode,200);
  assert.equal(confirmed.payload.ok,true);
  assert.equal(h.controller.isLocked(),false);
  assert.deepEqual(notices,[true,false]);
});

test('cancel before commit releases the lock without requiring confirmation', async () => {
  const h = makeHarness();
  const session = await prepare(h);
  const res = await h.invoke('/restore/release',{token:session.token,confirmed:false});
  assert.equal(res.statusCode,200);
  assert.equal(h.controller.isLocked(),false);
});
