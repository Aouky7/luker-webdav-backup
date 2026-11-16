import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MiB = 1024 * 1024;
const MARKER = '.owner';
const TASK = /^task-[0-9a-f-]{36}$/;
const fail = message => new Error(message);

// One running host per DATA_ROOT. Only positively identified, flat task directories
// are removed; unknown files, markers or symlinks stop recovery instead.
export function createStagingManager(dataRoot, {tmpDir = os.tmpdir(), operations = {}} = {}) {
  const io = {...fs, ...operations};
  const dataPath = io.realpathSync(dataRoot);
  const identity = createHash('sha256').update(dataPath).digest('hex');
  const fallback = path.join(path.dirname(dataPath), '.luker-webdav-tmp-' + identity);
  function prepareParent(candidate, create = true) {
    try {
      const resolved = io.realpathSync(candidate);
      const stat = io.statSync(resolved);
      if (!stat.isDirectory()) throw fail('暂存父路径不是目录');
      if (resolved === dataPath || resolved.startsWith(dataPath + path.sep)) throw fail('暂存目录不能位于备份数据目录内');
      io.accessSync(resolved, fs.constants.W_OK | fs.constants.X_OK);
      return resolved;
    } catch (e) {
      if (!create || e.code !== 'ENOENT') throw e;
      io.mkdirSync(candidate, {recursive:true, mode:0o700});
      return prepareParent(candidate, false);
    }
  }
  let parent;
  try {
    parent = prepareParent(tmpDir);
  } catch (e) {
    if (tmpDir !== os.tmpdir()) throw e;
    // Use an app-writable sibling outside DATA_ROOT; never archive our own ZIP.
    try { io.mkdirSync(fallback, {mode:0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = io.lstatSync(fallback);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw fail('备用暂存目录权限或类型异常');
    parent = prepareParent(fallback, false);
  }
  const root = path.join(parent, 'luker-webdav-staging-' + identity);
  const owner = 'luker-webdav-staging-v1:' + identity;
  let blocked = null;
  function directory(target) {
    const st = io.lstatSync(target);
    if (!st.isDirectory() || st.isSymbolicLink() || io.realpathSync(target) !== target) throw fail('暂存目录边界或类型异常');
    if ((st.mode & 0o077) !== 0) throw fail('暂存目录权限不安全');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw fail('暂存目录所有者不符');
  }
  function marker(target, expected) {
    const p = path.join(target, MARKER), st = io.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 256 || (st.mode & 0o077) !== 0 || io.readFileSync(p, 'utf8') !== expected) throw fail('暂存目录标记不符');
  }
  function checkRoot() {
    if (path.dirname(root) !== parent || io.realpathSync(parent) !== parent) throw fail('暂存根目录边界异常');
    directory(root); marker(root, owner);
  }
  function validateTask(target) {
    checkRoot();
    if (path.dirname(target) !== root || !TASK.test(path.basename(target))) throw fail('拒绝清理非本插件暂存目录');
    directory(target); marker(target, owner + ':' + path.basename(target));
    const entries = io.readdirSync(target);
    for (const name of entries) {
      if (name !== MARKER && name !== 'archive.zip') throw fail('暂存目录含未知文件，停止清理');
      const st = io.lstatSync(path.join(target, name));
      if (!st.isFile() || st.isSymbolicLink()) throw fail('暂存目录含不安全文件，停止清理');
    }
    return entries;
  }
  function cleanup(task) {
    const target = typeof task === 'string' ? task : task.directory;
    try {
      const entries = validateTask(target);
      // All resolved targets have been checked before the first removal.
      for (const name of entries.filter(n => n !== MARKER)) io.unlinkSync(path.join(target, name));
      io.unlinkSync(path.join(target, MARKER));
      io.rmdirSync(target);
    } catch (e) { blocked = '暂存清理失败，兼容模式已暂停：' + e.message; throw fail(blocked); }
  }
  async function recover() {
    try {
      try { io.lstatSync(root); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        io.mkdirSync(root, {mode:0o700});
        io.writeFileSync(path.join(root, MARKER), owner, {flag:'wx',mode:0o600});
      }
      checkRoot();
      const tasks = io.readdirSync(root).filter(n => n !== MARKER);
      for (const name of tasks) {
        if (!TASK.test(name)) throw fail('暂存根目录含未知内容');
        validateTask(path.join(root,name));
      }
      for (const name of tasks) cleanup(path.join(root,name));
      blocked = null;
    } catch (e) { blocked = '暂存恢复清理失败，兼容模式不可用：' + e.message; }
    return {available:!blocked, warning:blocked};
  }
  function space(writeBudget = 0) {
    const stat = io.statfsSync(root, {bigint:true});
    if (BigInt(stat.bavail) * BigInt(stat.bsize) < 64n * BigInt(MiB) + BigInt(writeBudget)) throw fail('本地暂存空间不足，必须保留至少 64 MiB 可用空间');
  }
  function create() {
    if (blocked) throw fail(blocked);
    checkRoot(); space();
    const target = path.join(root,'task-' + randomUUID());
    io.mkdirSync(target,{mode:0o700});
    try { io.writeFileSync(path.join(target,MARKER),owner + ':' + path.basename(target),{flag:'wx',mode:0o600}); }
    catch (e) { blocked = '暂存标记创建失败，兼容模式已暂停：' + e.message; throw fail(blocked); }
    return {directory:target, archive:path.join(target,'archive.zip')};
  }
  async function pack(task, produce, {maxBytes, onProgress = () => {}, timeoutMs = 1800000} = {}) {
    validateTask(task.directory);
    if (task.archive !== path.join(task.directory,'archive.zip')) throw fail('暂存文件边界异常');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw fail('暂存大小限制无效');
    const source = new PassThrough();
    source.attachment = () => source; source.status = () => source;
    source.send = () => source.destroy(fail('Luker 归档失败，请查看服务端日志'));
    space(Math.min(maxBytes,16 * MiB));
    let bytes = 0, checked = 0, previousChunk = 0, timer;
    const meter = new Transform({transform(chunk, encoding, done) {
      try {
        const next = bytes + chunk.length;
        if (next > maxBytes) throw fail('备份 ZIP 超过本地暂存大小上限');
        if (next - checked >= 16 * MiB) {
          // Leave room for the current and preceding queued write plus the next
          // check interval. Other processes can still consume shared disk space.
          space(chunk.length + previousChunk + Math.min(maxBytes - next,16 * MiB));
          checked = next;
        }
        previousChunk = chunk.length;
        bytes = next; onProgress(bytes); done(null,chunk);
      } catch (e) { done(e); }
    }});
    const output = io.createWriteStream(task.archive,{flags:'wx',mode:0o600});
    const writing = pipeline(source,meter,output);
    const producing = Promise.resolve().then(() => produce(source));
    // Race the combined completion: a producer that never resolves must not hold
    // the backup lock forever. Its late rejection is consumed by Promise.all.
    const complete = Promise.all([writing,producing]);
    try {
      await Promise.race([complete,new Promise((_,reject) => { timer = setTimeout(() => reject(fail('本地打包超过 30 分钟时限')),timeoutMs); })]);
      const st = io.lstatSync(task.archive);
      if (!st.isFile() || st.isSymbolicLink() || st.size !== bytes) throw fail('本地暂存 ZIP 大小核对失败');
      return {archiveBytes:st.size,totalBytes:st.size};
    } catch (e) {
      source.destroy(e); meter.destroy(e); output.destroy(e);
      await Promise.allSettled([writing]);
      throw e;
    } finally { clearTimeout(timer); }
  }
  return {root, recover, create, pack, cleanup, get warning() { return blocked; }};
}
