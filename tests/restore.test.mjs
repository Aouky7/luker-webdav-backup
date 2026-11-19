import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {JSDOM} from 'jsdom';

const CATEGORY_KEYS = [
  'settings','secrets','characters','chats','lorebooks','presets','assets',
  'extensions','globalExtensions','vectors',
];
const UPLOAD_ID = '0123456789abcdef0123456789abcdef';
const TOKEN = 'restore-token-000001';
const ZIP_SIGNATURE = Uint8Array.of(0x50,0x4b,0x03,0x04);

// restore.js is shipped as a plain script in the plugin. Compile only the
// requested named export away so this test exercises that source directly.
const restoreSource = (await readFile(new URL('../restore.js', import.meta.url), 'utf8'))
  .replace('export function mountRestore(', 'function mountRestore(') +
  '\nglobalThis.__mountRestore = mountRestore;';
const moduleUrl = `data:text/javascript;base64,${Buffer.from(restoreSource).toString('base64')}`;
await import(moduleUrl);
const mountRestore = globalThis.__mountRestore;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json'}});
}
function makeStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}
function defer() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
async function settle(rounds = 16) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

function harness(options = {}) {
  const dom = new JSDOM('<!doctype html><main id="panel"><div id="container"></div></main>');
  const {document} = dom.window;
  const panel = document.querySelector('#panel');
  const container = document.querySelector('#container');
  const fetchCalls = [], apiCalls = [], confirms = [], notices = [], locks = [], timeline = [];
  let dirty = !!options.dirty, busy = !!options.busy;
  let currentUserCall = 0;
  const sourceChunks = options.sourceChunks ?? [[...ZIP_SIGNATURE]];
  const sessionBytes = options.sessionBytes ?? 4;
  const api = async (route, body) => {
    apiCalls.push({route, body});
    timeline.push(`api:${route}`);
    if (route === '/restore/prepare') {
      return {token:TOKEN, name:body.name, bytes:sessionBytes};
    }
    if (route === '/restore/commit' || route === '/restore/release') return {ok:true};
    throw new Error(`Unexpected plugin API route ${route}`);
  };
  const fetchImpl = async (url, init = {}) => {
    const route = String(url);
    const method = init.method ?? 'GET';
    fetchCalls.push({route, method, init});
    if (route.startsWith('/api/users/') && method !== 'GET') timeline.push(`fetch:${route}`);
    if (route === '/csrf-token') return jsonResponse({token:'csrf-test'});
    if (route === '/api/plugins/webdav-backup/restore/source') {
      return new Response(makeStream(sourceChunks), {status:options.sourceStatus ?? 200});
    }
    if (route === '/api/users/me') {
      currentUserCall++;
      const identity = options.identityAt?.(currentUserCall) ?? options.identity ?? {handle:'alice',admin:true};
      return jsonResponse(identity, options.meStatus ?? 200);
    }
    if (route === '/api/users/restore-backup/uploads' && method === 'POST') {
      return jsonResponse({uploadId:options.uploadId ?? UPLOAD_ID}, options.uploadStatus ?? 200);
    }
    if (route.startsWith('/api/users/restore-backup/uploads/') && route.includes('/chunks/')) {
      const offset = Number(route.slice(route.lastIndexOf('/') + 1));
      const bytes = init.body?.byteLength ?? -1;
      const ack = options.chunkAck?.({offset,bytes}) ?? {ok:true,offset,bytes};
      return jsonResponse(ack, options.chunkStatus ?? 200);
    }
    if (route.startsWith('/api/users/restore-backup/uploads/') && route.endsWith('/finalize')) {
      return jsonResponse({size:options.finalizedSize ?? sessionBytes}, options.finalizeStatus ?? 200);
    }
    if (route === '/api/users/restore-backup/probe') {
      return jsonResponse(options.probe ?? {engineKind:'fs',crossModeRequired:false,scratchCredsNeeded:false}, options.probeStatus ?? 200);
    }
    if (route === '/api/users/restore-backup' && method === 'POST') {
      if (options.restoreHttpStatus && options.restoreHttpStatus !== 200)
        return jsonResponse({error:'synthetic host failure'}, options.restoreHttpStatus);
      return jsonResponse(options.restoreResult ?? {
        mode:JSON.parse(init.body).mode,restoredCount:2,failedCount:0,skippedCount:0,rejectedCount:0,
      });
    }
    if (route.startsWith('/api/users/restore-backup/uploads/') && method === 'DELETE') {
      return new Response(null, {status:204});
    }
    throw new Error(`Unexpected fetch ${method} ${route}`);
  };
  const defaultConfirm = options.confirm ?? (async () => true);
  const instance = mountRestore({
    panel, container, api, fetchImpl,
    confirm:async message => { confirms.push(message); return defaultConfirm(message, confirms.length); },
    notify:(...args) => notices.push(args),
    getBusy:() => busy,
    getDirty:() => dirty,
    onLock:value => locks.push(value),
  });
  instance.setConfig({
    capabilities:{cloudRestore:true}, storageEngine:'fs',
    categories:Object.fromEntries(CATEGORY_KEYS.map(key => [key,`label:${key}`])),
  });
  const button = action => panel.querySelector(`[data-restore-action="${action}"]`);
  const state = () => instance.getState();
  const open = (name = 'snapshot.zip') => instance.open({name});
  const click = async action => { button(action).click(); await settle(); };
  const matchingFetches = (route, method) => fetchCalls.filter(c => c.route === route && (!method || c.method === method));
  const restoreRequests = () => matchingFetches('/api/users/restore-backup','POST');
  const nativeMutations = () => fetchCalls.filter(c => c.route.startsWith('/api/users/') && c.method !== 'GET');
  return {
    dom,panel,container,instance,button,state,open,click,apiCalls,fetchCalls,confirms,notices,locks,
    matchingFetches,restoreRequests,nativeMutations,timeline,
    setDirty:value => { dirty = value; }, setBusy:value => { busy = value; },
  };
}

async function stage(h, filename = 'snapshot.zip') {
  h.open(filename);
  await h.click('prepare');
  assert.equal(h.state().stage, 'staged');
}
function select(h, keys = ['settings']) {
  for (const key of keys) {
    const input = h.panel.querySelector(`[data-restore-category="${key}"]`);
    input.checked = true;
    input.dispatchEvent(new h.dom.window.Event('change', {bubbles:true}));
  }
  const ack = h.panel.querySelector('[data-restore="ack"]');
  ack.checked = true;
  ack.dispatchEvent(new h.dom.window.Event('change', {bubbles:true}));
}

// The fixture response and request streams are the platform's native web APIs;
// no files, real account, network service, or ZIP extraction is involved.
test('mount and open are inert; a selected filename is rendered as text', async t => {
  const h = harness(); t.after(() => h.dom.window.close());
  const filename = '<img src=x onerror=alert(1)>.zip';
  h.open(filename);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.apiCalls.length, 0);
  assert.equal(h.panel.querySelector('[data-restore="file"]').textContent, filename);
  assert.equal(h.panel.querySelector('[data-restore="file"] img'), null);
  assert.ok([...h.panel.querySelectorAll('[data-restore-category]')].every(input => !input.checked), 'all restore categories start unselected');
  assert.equal(h.state().stage, 'idle');
});

test('cancelling the first confirmation has no network or plugin effects', async t => {
  const h = harness({confirm:async () => false}); t.after(() => h.dom.window.close());
  h.open(); await h.click('prepare');
  assert.equal(h.confirms.length, 1);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.apiCalls.length, 0);
  assert.equal(h.state().stage, 'idle');
});

test('prepare stages and probes the archive but never dispatches a restore', async t => {
  const h = harness(); t.after(() => h.dom.window.close());
  await stage(h);
  assert.equal(h.state().stage, 'staged');
  assert.equal(h.restoreRequests().length, 0);
  assert.deepEqual(h.apiCalls.map(call => call.route), ['/restore/prepare']);
  assert.equal(h.matchingFetches('/api/users/restore-backup/probe','POST').length, 1);
  assert.equal(h.button('apply').disabled, true);
});

test('apply stays disabled until an explicit category and acknowledgement are selected', async t => {
  const h = harness(); t.after(() => h.dom.window.close());
  await stage(h);
  const ack = h.panel.querySelector('[data-restore="ack"]');
  ack.checked = true; ack.dispatchEvent(new h.dom.window.Event('change', {bubbles:true}));
  assert.equal(h.button('apply').disabled, true);
  const category = h.panel.querySelector('[data-restore-category="settings"]');
  category.checked = true; category.dispatchEvent(new h.dom.window.Event('change', {bubbles:true}));
  ack.checked = false; ack.dispatchEvent(new h.dom.window.Event('change', {bubbles:true}));
  assert.equal(h.button('apply').disabled, true);
});

test('cancelling the final confirmation performs no commit or native restore', async t => {
  const h = harness({confirm:async (_message, count) => count === 1}); t.after(() => h.dom.window.close());
  await stage(h); select(h); await h.click('apply');
  assert.equal(h.confirms.length, 2);
  assert.equal(h.apiCalls.some(call => call.route === '/restore/commit'), false);
  assert.equal(h.restoreRequests().length, 0);
  assert.equal(h.state().stage, 'staged');
});

test('successful restore rechecks identity and sends every selection as an explicit boolean', async t => {
  const h = harness(); t.after(() => h.dom.window.close());
  await stage(h); select(h, ['settings','chats']);
  const mode = h.panel.querySelector('[data-restore="mode"]');
  mode.value = 'overwrite'; mode.dispatchEvent(new h.dom.window.Event('change', {bubbles:true}));
  await h.click('apply');
  const restore = h.restoreRequests();
  assert.equal(restore.length, 1);
  const payload = JSON.parse(restore[0].init.body);
  assert.equal(payload.mode, 'overwrite');
  assert.deepEqual(Object.keys(payload.selection).sort(), [...CATEGORY_KEYS].sort());
  for (const key of CATEGORY_KEYS) assert.equal(typeof payload.selection[key], 'boolean', `${key} must be explicit`);
  assert.equal(payload.selection.settings, true);
  assert.equal(payload.selection.chats, true);
  assert.equal(payload.selection.globalExtensions, false, 'unselected global extensions stay false');
  assert.equal(h.matchingFetches('/api/users/me','GET').length, 2, 'identity is checked before preparation and again before restore');
  assert.equal(h.apiCalls.filter(call => call.route === '/restore/commit').length, 1);
  assert.ok(h.timeline.indexOf('api:/restore/commit') < h.timeline.indexOf('fetch:/api/users/restore-backup'), 'plugin lock commit precedes native restore');
  assert.equal(h.state().stage, 'completed');
  assert.equal(h.notices.length, 1);
});

test('identity change between preparation and final restore blocks dispatch and cleans staging', async t => {
  const h = harness({identityAt:n => n === 1 ? {handle:'alice',admin:true} : {handle:'mallory',admin:true}});
  t.after(() => h.dom.window.close());
  await stage(h); select(h); await h.click('apply');
  assert.equal(h.restoreRequests().length, 0);
  assert.equal(h.state().stage, 'failed');
  assert.equal(h.matchingFetches('/api/users/restore-backup/uploads/'+UPLOAD_ID,'DELETE').length, 1);
});

test('oversized prepare metadata is rejected before upload creation', async t => {
  const h = harness({sessionBytes:2 * 1024 * 1024 * 1024 + 1}); t.after(() => h.dom.window.close());
  h.open(); await h.click('prepare');
  assert.equal(h.state().stage, 'failed');
  assert.equal(h.matchingFetches('/api/users/restore-backup/uploads','POST').length, 0);
  assert.equal(h.restoreRequests().length, 0);
});

test('short source stream is rejected and staged upload is cleaned', async t => {
  const h = harness({sessionBytes:8}); t.after(() => h.dom.window.close());
  h.open(); await h.click('prepare');
  assert.equal(h.state().stage, 'failed');
  assert.equal(h.matchingFetches('/api/users/restore-backup/uploads/'+UPLOAD_ID,'DELETE').length, 1);
  assert.equal(h.restoreRequests().length, 0);
});

test('overlong source stream is rejected before finalize or restore', async t => {
  const h = harness({sessionBytes:3}); t.after(() => h.dom.window.close());
  h.open(); await h.click('prepare');
  assert.equal(h.state().stage, 'failed');
  assert.equal(h.matchingFetches('/api/users/restore-backup/uploads/'+UPLOAD_ID+'/finalize','POST').length, 0);
  assert.equal(h.restoreRequests().length, 0);
});

test('a chunk acknowledgement mismatch never advances into restore', async t => {
  const h = harness({chunkAck:({offset,bytes}) => ({ok:true,offset:offset+1,bytes})});
  t.after(() => h.dom.window.close());
  h.open(); await h.click('prepare');
  assert.equal(h.state().stage, 'failed');
  assert.equal(h.restoreRequests().length, 0);
  assert.equal(h.matchingFetches('/api/users/restore-backup/uploads/'+UPLOAD_ID,'DELETE').length, 1);
});

test('invalid ZIP signature prevents finalize and restore', async t => {
  const h = harness({sourceChunks:[[0x3c,0x68,0x74,0x6d]]}); t.after(() => h.dom.window.close());
  h.open(); await h.click('prepare');
  assert.equal(h.state().stage, 'failed');
  assert.equal(h.matchingFetches('/api/users/restore-backup/uploads/'+UPLOAD_ID+'/finalize','POST').length, 0);
  assert.equal(h.restoreRequests().length, 0);
});

test('malformed, database-engine, and cross-mode probes are refused with cleanup', async t => {
  for (const probe of [
    {},
    {engineKind:'db',crossModeRequired:false,scratchCredsNeeded:false},
    {engineKind:'fs',crossModeRequired:true,scratchCredsNeeded:false},
  ]) {
    const h = harness({probe}); t.after(() => h.dom.window.close());
    h.open(); await h.click('prepare');
    assert.equal(h.state().stage, 'failed', JSON.stringify(probe));
    assert.equal(h.restoreRequests().length, 0, JSON.stringify(probe));
    assert.equal(h.matchingFetches('/api/users/restore-backup/uploads/'+UPLOAD_ID,'DELETE').length, 1, JSON.stringify(probe));
    assert.ok(h.apiCalls.some(call => call.route === '/restore/release'), JSON.stringify(probe));
  }
});

test('dirty state after preparation blocks final restore without committing', async t => {
  const h = harness(); t.after(() => h.dom.window.close());
  await stage(h); select(h); h.setDirty(true); await h.click('apply');
  assert.equal(h.confirms.length, 1, 'the second confirmation is not offered');
  assert.equal(h.apiCalls.some(call => call.route === '/restore/commit'), false);
  assert.equal(h.restoreRequests().length, 0);
  assert.equal(h.state().stage, 'staged');
});

test('selection changes while final confirmation is open invalidate that confirmation', async t => {
  const pending = defer();
  const h = harness({confirm:(_message,count) => count === 1 ? true : pending.promise});
  t.after(() => h.dom.window.close());
  await stage(h); select(h, ['settings']);
  h.button('apply').click(); await settle();
  assert.equal(h.confirms.length, 2, 'the final confirmation is pending');
  const original = h.panel.querySelector('[data-restore-category="settings"]');
  const changed = h.panel.querySelector('[data-restore-category="chats"]');
  original.checked = false; changed.checked = true;
  original.dispatchEvent(new h.dom.window.Event('change', {bubbles:true}));
  pending.resolve(true); await settle();
  assert.equal(h.restoreRequests().length, 0, 'changed selection must not be sent under stale confirmation');
  assert.equal(h.apiCalls.some(call => call.route === '/restore/commit'), false);
});

test('double-clicking apply dispatches at most one native restore', async t => {
  const h = harness(); t.after(() => h.dom.window.close());
  await stage(h); select(h);
  h.button('apply').click(); h.button('apply').click();
  await settle(30);
  assert.equal(h.restoreRequests().length, 1);
  assert.equal(h.apiCalls.filter(call => call.route === '/restore/commit').length, 1);
});

test('an HTTP failure after restore dispatch is uncertain, locked, and never cleaned or retried', async t => {
  const h = harness({restoreHttpStatus:503}); t.after(() => h.dom.window.close());
  await stage(h); select(h); await h.click('apply');
  assert.equal(h.state().stage, 'uncertain');
  assert.equal(h.state().pending, true);
  assert.equal(h.restoreRequests().length, 1);
  assert.equal(h.matchingFetches('/api/users/restore-backup/uploads/'+UPLOAD_ID,'DELETE').length, 0);
  assert.equal(h.apiCalls.some(call => call.route === '/restore/release'), false);
  assert.equal(h.locks.at(-1), true);
});

test('invalid restore counts after dispatch are uncertain and never cleaned or retried', async t => {
  const h = harness({restoreResult:{mode:'merge',restoredCount:-1,failedCount:0,skippedCount:0,rejectedCount:0}});
  t.after(() => h.dom.window.close());
  await stage(h); select(h); await h.click('apply');
  assert.equal(h.state().stage, 'uncertain');
  assert.equal(h.restoreRequests().length, 1);
  assert.equal(h.matchingFetches('/api/users/restore-backup/uploads/'+UPLOAD_ID,'DELETE').length, 0);
  assert.equal(h.apiCalls.some(call => call.route === '/restore/release'), false);
  assert.equal(h.locks.at(-1), true);
});

test('busy and dirty configuration refuse preparation before side effects', async t => {
  for (const state of [{busy:true},{dirty:true}]) {
    const h = harness(state); t.after(() => h.dom.window.close());
    h.open(); await h.click('prepare');
    assert.equal(h.confirms.length, 0);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.apiCalls.length, 0);
    assert.equal(h.state().stage, 'idle');
  }
});
