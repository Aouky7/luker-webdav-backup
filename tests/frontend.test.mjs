import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './run-network.mjs';

test('integrated updater obtains CSRF and backend lock before changing exact host installs',async t=>{
  const h=harness(t);h.config.updateIdentity={directory:'backend-folder',repository:'https://github.com/Aouky7/webdav_luker'};
  h.api.on('/api/extensions/discover',()=>[{name:'third-party/test-plugin',type:'local'}]);
  h.api.on('/api/users/plugins/list',()=>({ok:true,plugins:[{directory:'backend-folder',remoteUrl:'https://github.com/Aouky7/webdav_luker'}]}));
  h.api.on('/api/extensions/version',()=>({remoteUrl:'https://github.com/Aouky7/webdav_luker',currentBranchName:'main',currentCommitHash:'abc'}));
  h.api.on('/updates/lock',()=>({ok:true,token:'lock-token'}));
  h.api.on('/api/users/plugins/update',()=>({ok:true,plugin:{directory:'backend-folder',remoteUrl:'https://github.com/Aouky7/webdav_luker'}}));
  h.api.on('/api/extensions/update',()=>({shortCommitHash:'def',remoteUrl:'https://github.com/Aouky7/webdav_luker'}));
  
  const {updater}=h.mount();
  await updater.check();
  await updater.install();
  
  assert.equal(h.state.locked,true);
});
