// Explicit, read-only verification of pinned upstream selection/path functions.
// Not a ZIP extraction test or a complete Luker restore test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

const SHA = 'edae4ef84adde5a78c443883c224ef5753f81975';
const sourceRoot = process.argv[2];
async function source(file) {
  const response = await fetch(`https://raw.githubusercontent.com/funnycups/Luker/${SHA}/${file}`, {signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw Error(`${file}: HTTP ${response.status}`);
  return response.text();
}
const readSource = file => sourceRoot ? fs.readFileSync(path.join(sourceRoot,file),'utf8') : source(file);
const users = await readSource('src/users.js');
const restore = await readSource('src/endpoints/users-private.js');
const ui = await readSource('public/scripts/user.js');
const hashes = [users,restore,ui].map(s=>createHash('sha256').update(s).digest('hex'));
assert.deepEqual(hashes,[
  'ae8c1b1f954751e2a43096fc41f88bb96c50668006f60bd5bc5cdf144d407528',
  '774fac81fcb4fd8754bb294db50d7fe270a1e0510bae4a17624d98b2ad3d5830',
  'ee4b8cbf2061ebce94301bd621ca272c46a1146c9d07f6658bfbbfcaf9a711f5',
], 'Source content differs from the reviewed pinned commit');
function declaration(text,name) {
  const start=text.indexOf(`function ${name}(`);
  assert.ok(start>=0,`Upstream function missing: ${name}`);
  const end=text.indexOf('\n}',start);
  assert.ok(end>start,`Upstream function boundary missing: ${name}`);
  return text.slice(start,end+2);
}
const defaults = users.match(/export const USER_BACKUP_SELECTION_DEFAULTS = Object\.freeze\(\{[\s\S]*?\}\);/)?.[0];
assert.ok(defaults,'Upstream defaults missing');
assert.match(ui,/globalExtensions: false/);
const root='/synthetic-luker/data/default-user';
const globalPath='/synthetic-luker/public/scripts/extensions/third-party';
const sandbox={path,process:{cwd:()=>'/synthetic-luker'},PUBLIC_DIRECTORIES:{globalExtensions:globalPath},SETTINGS_FILE:'settings.json',SECRETS_FILE:'secrets.json'};
vm.createContext(sandbox);
const code=[defaults.replace('export ',''),
  ...['normalizeUserBackupSelection','getUserBackupTargets','getBackupArchivePath'].map(n=>declaration(users,n)),
  ...['sanitizeBackupSelectionForUser','toPosixRelativePath','buildRestoreDirectoryAliases','resolveAllowedRestorePath'].map(n=>declaration(restore,n)),
  'globalThis.rules={normalizeUserBackupSelection,getUserBackupTargets,getBackupArchivePath,sanitizeBackupSelectionForUser,buildRestoreDirectoryAliases,resolveAllowedRestorePath};'].join('\n');
vm.runInContext(code,sandbox,{timeout:1000});
const rules=sandbox.rules;
const names=['.editorconfig','.git/HEAD','.git/config','.git/index',
  ...['2f89db201d5b1c1d4c22446b1df48e18de4431c2','3087409b759c4ca7e947fab13854ec9a5330e3ed','379bfbb326612833a15a9b4a7df24fd5e09761f9','39eb4ff9b618195024e2f781b83f9b786142d383'].flatMap(h=>['idx','pack'].map(ext=>`.git/objects/pack/pack-${h}.${ext}`))];
const selection={...Object.fromEntries(Object.keys(rules.normalizeUserBackupSelection({})).map(k=>[k,false])),extensions:true};
const dirs={root,extensions:path.join(root,'extensions')};
function targets(globalSelected,admin) {
  const selected=rules.sanitizeBackupSelectionForUser({...selection,globalExtensions:globalSelected},admin);
  const targets=rules.getUserBackupTargets(dirs,selected,{includeGlobalExtensions:admin});
  return targets.directories;
}
for (const [selected,admin,expected] of [[false,true,false],[true,true,true],[true,false,false]]) {
  const allowed=targets(selected,admin);
  const aliases=rules.buildRestoreDirectoryAliases(root,allowed);
  for (const name of names) {
    const result=rules.resolveAllowedRestorePath('third-party/JS-Slash-Runner/'+name,root,new Set(),allowed,aliases);
    assert.equal(Boolean(result),expected,`globalExtensions=${selected}, admin=${admin}, ${name}`);
    if(expected) assert.equal(result,path.join(globalPath,'JS-Slash-Runner',name));
  }
  console.log(`PASS ${names.length} paths: globalExtensions=${selected}, admin=${admin}, ${expected?'allowed':'skipped'}`);
}
// Test aliases with only the global category: extensions/third-party overlaps
// the user extensions category when both are selected; do not assume precedence.
const allowed=[globalPath],aliases=rules.buildRestoreDirectoryAliases(root,allowed);
for(const prefix of ['third-party','extensions/third-party','scripts/extensions/third-party','public/scripts/extensions/third-party']) {
  assert.equal(rules.resolveAllowedRestorePath(prefix+'/JS-Slash-Runner/.git/HEAD',root,new Set(),allowed,aliases),path.join(globalPath,'JS-Slash-Runner/.git/HEAD'));
}
// Both native export and plugin delegate archive naming to this same host function.
const exported=rules.getBackupArchivePath(root,globalPath);
assert.equal(rules.resolveAllowedRestorePath(exported+'/JS-Slash-Runner/.editorconfig',root,new Set(),allowed,aliases),path.join(globalPath,'JS-Slash-Runner/.editorconfig'));
console.log('PASS all four global-extension aliases and host-generated archive path');
console.log('Pinned reference:',SHA,sourceRoot?'(local source supplied; hashes below)':'(fetched fixed commit)');
console.log('Source hashes:',[users,restore,ui].map(s=>createHash('sha256').update(s).digest('hex')).join(' '));
console.log('Scope: upstream category/path rules only; no user archive opened, no files restored, no end-to-end restore claim.');
