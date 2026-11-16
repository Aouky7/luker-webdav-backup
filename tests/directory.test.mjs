import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureDirectory,inspectDirectory} from '../webdav.mjs';
const target = new URL('https://dav.example/dav/backups/');
const fail = code => Object.assign(new Error('HTTP '+code),{statusCode:code});
const xml = (url,kind='directory',status=200) => `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${url.pathname}</d:href>${status !== 200 ? `<d:status>HTTP/1.1 ${status} Error</d:status>` : `<d:propstat><d:prop>${kind==='unknown'?'':`<d:resourcetype>${kind==='directory'?'<d:collection/>':''}</d:resourcetype>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`}</d:response></d:multistatus>`;
function server(initial) {
 const dirs=new Set(initial),calls=[];
 return {dirs,calls,request:async(c,method,url,body,headers,timeout)=>{
  calls.push({method,path:url.pathname,body,headers,timeout});
  if(method==='PROPFIND') {
   if(!dirs.has(url.pathname)) throw fail(404);
   return {text:xml(url)};
  }
  assert.equal(method,'MKCOL');assert.ok(dirs.has(new URL('../',url).pathname),'parent must already exist');
  dirs.add(url.pathname);return {code:201};
 }};
}
test('existing collection is read-only; missing nested directories are created parent first and rechecked',async()=>{
 const s=server(['/dav/']);
 const nested=new URL('https://dav.example/dav/2025/backups/');
 const r=await ensureDirectory(s.request,{},nested);
 assert.equal(r.created,true);assert.equal(r.destination,nested.href);
 assert.deepEqual(s.calls.filter(x=>x.method==='MKCOL').map(x=>x.path),['/dav/2025/','/dav/2025/backups/']);
 assert.ok(s.calls.every(x=>x.timeout>0&&x.timeout<=15000));
 s.calls.length=0;assert.equal((await ensureDirectory(s.request,{},nested)).created,false);
 assert.deepEqual(s.calls.map(x=>x.method),['PROPFIND']);
});
test('resource-level 404 in 207 allows creation; property-level missing type does not',async()=>{
 let created=false;
 const request=async(c,m,u)=>{
  if(m==='MKCOL'){created=true;return {code:201};}
  return {text:xml(u,'directory',u.pathname===target.pathname&&!created?404:200)};
 };
 assert.equal((await ensureDirectory(request,{},target)).created,true);
 let mutations=0;
 await assert.rejects(ensureDirectory(async(c,m,u)=>{if(m==='MKCOL')mutations++;return {text:xml(u,'unknown')};},{},target),e=>e.code==='DIRECTORY_UNKNOWN');
 assert.equal(mutations,0);
});
test('authentication errors, noncollections, malformed and unrelated responses never trigger MKCOL',async()=>{
 for(const scenario of ['401','403','file','malformed','unrelated']) {
  let writes=0;
  await assert.rejects(ensureDirectory(async(c,m,u)=>{
   if(m==='MKCOL')writes++;
   if(/^\d/.test(scenario))throw fail(Number(scenario));
   return {text:scenario==='malformed'?'not XML':xml(scenario==='unrelated'?new URL('../else/',u):u,'file')};
  },{},target));
  assert.equal(writes,0,scenario);
 }
});
test('Jianguoyun never creates or traverses above /dav service root',async()=>{
 const s=server(['/']);
 await assert.rejects(ensureDirectory(s.request,{},new URL('https://dav.jianguoyun.com/dav/LukerBackup/')),e=>e.code==='DIRECTORY_PARENT_MISSING');
 assert.deepEqual(s.calls.map(x=>x.path),['/dav/LukerBackup/','/dav/']);
});
test('MKCOL race 405 accepts only a verified existing collection',async()=>{
 let raced=false;
 const r=await ensureDirectory(async(c,m,u)=>{
  if(m==='MKCOL'){raced=true;throw fail(405);}
  if(u.pathname===target.pathname&&!raced)throw fail(404);
  return {text:xml(u)};
 },{},target);
 assert.equal(r.created,false);
 let writes=0;
 await assert.rejects(ensureDirectory(async(c,m,u)=>{
  if(m==='MKCOL'){writes++;throw fail(405);}
  if(u.pathname===target.pathname)throw fail(404);
  return {text:xml(u)};
 },{},target),e=>e.code==='DIRECTORY_CREATE_UNSUPPORTED');
 assert.equal(writes,1);
});
test('creation denial and uncertain failure are not retried; accepted write must be verified',async()=>{
 for(const [code,expected] of [[403,'DIRECTORY_CREATE_FORBIDDEN'],[507,'DIRECTORY_NO_SPACE'],[501,'DIRECTORY_CREATE_UNSUPPORTED'],[0,'DIRECTORY_CREATE_UNCERTAIN'],[201,'DIRECTORY_CREATE_UNCONFIRMED']]) {
  let writes=0;
  await assert.rejects(ensureDirectory(async(c,m,u)=>{
   if(m==='MKCOL'){writes++;if(code===201)return {code};throw code?fail(code):new Error('timeout');}
   if(u.pathname===target.pathname)throw fail(404);
   return {text:xml(u)};
  },{},target),e=>e.code===expected);
  assert.equal(writes,1);
 }
});
test('directory probe checks type and matches href with optional trailing slash and Unicode',async()=>{
 const u=new URL('https://dav.example/dav/%E5%A4%87%E4%BB%BD/');
 const noSlash=new URL(u.href);noSlash.pathname=noSlash.pathname.slice(0,-1);
 assert.equal((await inspectDirectory(async()=>({text:xml(noSlash)}),{},u)).exists,true);
});
test('depth and deadline are bounded without creating service root',async()=>{
 const deep=new URL('https://dav.example/'+Array.from({length:14},(_,i)=>'x'+i).join('/')+'/');
 let writes=0;
 await assert.rejects(ensureDirectory(async(c,m)=>{if(m==='MKCOL')writes++;throw fail(404);},{},deep),e=>e.code==='DIRECTORY_PARENT_MISSING');
 assert.equal(writes,0);
 await assert.rejects(inspectDirectory(async()=>assert.fail('must not request after deadline'),{},target,Date.now()-1),e=>e.code==='DIRECTORY_TIMEOUT');
});
