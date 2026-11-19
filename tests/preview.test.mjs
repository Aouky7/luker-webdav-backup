import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {JSDOM,VirtualConsole} from 'jsdom';

// Exercise the generated single-file demo, not a second hand-written UI.
test('offline preview has only snapshots and demonstrates both notification update stages',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const parent=fs.realpathSync(os.tmpdir());
 const directory=fs.mkdtempSync(path.join(parent,'webdav-progress-preview-'));
 const real=fs.realpathSync(directory);
 assert.equal(real,directory);assert.equal(path.dirname(real),parent);
 const output=path.join(real,'preview.html');
 const errors=[], log=new VirtualConsole();
 log.on('jsdomError',error=>{if(!error.message.includes('Could not parse CSS stylesheet'))errors.push(error.message);});
 let dom;
 try{
  execFileSync(process.execPath,['tests/create-layout-preview.mjs',output],{cwd:root,timeout:10000});
  const html=fs.readFileSync(output,'utf8');assert(html.includes("connect-src 'none'"));
  dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:log,beforeParse(w){Object.assign(w,{Response,AbortController,TextDecoder,TextEncoder,Uint8Array});w.confirm=()=>true;}});
  const w=dom.window,$=selector=>w.document.querySelector(selector);
  const waitFor=async(predicate)=>{
   const deadline=Date.now()+6000;
   while(!predicate()){
    assert(Date.now()<deadline,'preview transition timed out: '+$('[data-update-notice="stage"]')?.textContent);
    await new Promise(resolve=>setTimeout(resolve,20));
   }
  };
  await waitFor(()=>$('[data-update-notice-action="install"]')&&!$('[data-update-notice-action="install"]').disabled);
  assert.equal($('.wd-restore'),null);assert.equal($('[data-restore-action]'),null);
  $('[data-tab="cloud"]').click();$('[data-action="list"]').click();
  await waitFor(()=>$('[data-view="cloudList"]').children.length===5);
  assert.equal($('.wd-snapshot-details').open,false);
  assert.deepEqual([...$('.wd-snapshot-details').querySelectorAll('button')].map(button=>button.dataset.action),['verify']);
  $('[data-update-notice-action="install"]').click();
  await waitFor(()=>$('[data-update-notice="counter"]')?.textContent.includes('1 / 3')&&/服务端|后端/.test($('[data-update-notice="stage"]').textContent));
  assert.equal($('[data-update-notice="bar"]').hasAttribute('value'),false);
  await waitFor(()=>$('[data-update-notice="counter"]')?.textContent.includes('2 / 3'));
  assert.equal($('[data-update-notice="bar"]').hasAttribute('value'),false);
  await waitFor(()=>$('[data-update-notice="bar"]')?.value===3);
  assert.equal($('[data-update-notice="bar"]').max,3);
  assert.match($('[data-update-notice="stage"]').textContent,/重启/);
  assert.equal(w.__WD_PREVIEW__.requests.filter(route=>route==='/api/users/plugins/update').length,1);
  assert.equal(w.__WD_PREVIEW__.requests.filter(route=>route==='/api/extensions/update').length,1);
  assert.equal(w.__WD_PREVIEW__.requests.some(route=>/restore|uploads/.test(route)),false);
  assert.deepEqual(errors,[]);
 }finally{
  dom?.window.close();
  assert.equal(fs.realpathSync(directory),real);assert.equal(path.dirname(real),parent);
  fs.rmSync(real,{recursive:true,force:true});
 }
});
