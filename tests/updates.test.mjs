import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './run-network.mjs';

test('mismatch is local; auto check is read-only once and distinguishes latest from running versions',async t=>{
  const h=harness(t);
  h.config.version='0.5.4';
  h.api.on('/config',()=>h.config);
  h.api.on('/api/extensions/discover',()=>[{name:'third-party/test-plugin',type:'local'}]);
  h.api.on('/api/users/plugins/list',()=>({ok:true,plugins:[{directory:'test-folder',remoteUrl:'https://github.com/Aouky7/webdav_luker'}]}));
  h.api.on('/api/extensions/version',()=>({remoteUrl:'https://github.com/Aouky7/webdav_luker',currentBranchName:'main',currentCommitHash:'abc',isUpToDate:true}));
  
  const {updater}=h.mount();
  // Simulate fetch returning newer version
  h.fetch.override('https://raw.githubusercontent.com/Aouky7/webdav_luker/main/manifest.json',()=>({version:'0.5.5'}));
  
  await updater.check({automatic:true});
  
  assert.deepEqual(JSON.parse(JSON.stringify(h.available)),[{latestVersion:'0.5.5',upgrade:true,codeUpdate:false,canUpdate:true}]);assert.equal(h.notices.length,0);
});
