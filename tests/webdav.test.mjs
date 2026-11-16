import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDav,listFiles,inspectSize,parseSize} from '../webdav.mjs';
const name = 'luker-2025-01-02T03-04-05-006Z-00000000-0000-4000-8000-000000000001.zip';
const target = new URL('https://dav.example/dav/LukerBackup/'+name);
const response = (href=target.pathname,size='4096',code=200) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 ${code} Result</d:status></d:propstat></d:response>`;
const xml = body => `<d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`;
test('standard DAV property overrides misleading HEAD zero without needing HEAD',async()=>{
 const methods=[];
 const r=await inspectSize(async(c,m)=>{methods.push(m);return {text:xml(response()),headers:{'content-length':'0'}}},{},target,4096);
 assert.equal(r.sizeVerification,'matched');assert.equal(r.remoteBytes,4096);assert.deepEqual(methods,['PROPFIND']);
});
test('authoritative zero stays a mismatch; unknown HEAD zero is not called corruption',async()=>{
 const real=await inspectSize(async()=>({text:xml(response(target.pathname,'0'))}),{},target,4096);
 assert.equal(real.sizeVerification,'mismatch');assert.equal(real.remoteBytes,0);
 const unknown=await inspectSize(async(c,m)=>m==='HEAD'?{headers:{'content-length':'0'}}:{text:'broken'},{},target,4096);
 assert.equal(unknown.sizeVerification,'unknown');assert.equal(unknown.remoteBytes,null);
});
test('failed property status never masquerades as valid size',async()=>{
 assert.equal(parseDav(xml(response(target.pathname,'0',404))).length,0);
 const r=await inspectSize(async(c,m)=>m==='HEAD'?{headers:{'content-length':'4096'}}:{text:xml(response(target.pathname,'0',404))},{},target,4096);
 assert.equal(r.sizeVerification,'matched');assert.equal(r.verificationSource,'HEAD');
});
test('list restricts origin, directory, completed names and ignores folder entries',()=>{
 const entries=parseDav(xml(response()+response('https://evil.example/'+name)+response('/dav/other/'+name)+response(target.pathname+'.partial')+response('/dav/LukerBackup/nested/'+name)));
 assert.deepEqual(listFiles(entries,new URL('./',target)),[{name,bytes:4096,modified:null}]);
});
test('namespaces, split success properties and entity-encoded href work',()=>{
 const s='<multistatus xmlns="DAV:"><response><href>/dav/A&#38;B/a.zip</href><propstat><prop><getcontentlength>20</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><getcontentlength>0</getcontentlength></prop><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>';
 assert.equal(parseDav(s)[0].bytes,20);assert.equal(parseDav(s)[0].href,'/dav/A&B/a.zip');
});
test('malformed, DTD, truncated and oversized XML rejected',()=>{
 for(const s of ['<d:multistatus xmlns:d="DAV:">','<!DOCTYPE x SYSTEM "file:///etc/passwd"><x/>',xml(response()).slice(0,-3),'x'.repeat(2097153)]) assert.throws(()=>parseDav(s));
});
test('negative, empty, nonnumeric and unsafe sizes are unknown',()=>{
 for(const s of ['',undefined,'-1','12x','9007199254740992']) assert.equal(parseSize(s),null);
 assert.equal(parseSize('0'),0);
});
test('unrelated resource is not accepted; historical files have no invented baseline',async()=>{
 const unknown=await inspectSize(async(c,m)=>m==='HEAD'?{headers:{}}:{text:xml(response('/dav/other/'+name))},{},target,4096);
 assert.equal(unknown.sizeVerification,'unknown');
 const observed=await inspectSize(async()=>({text:xml(response())}),{},target,null);
 assert.equal(observed.sizeVerification,'observed');assert.equal(observed.expectedBytes,null);
});
