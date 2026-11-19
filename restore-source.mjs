import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';
import { BACKUP_NAME, inspectSize } from './webdav.mjs';

export const MAX_RESTORE_BYTES = 2 * 1024 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
const EMPTY_STATE = Object.freeze({pending:false,phase:'idle',name:null,bytes:0,maxBytes:MAX_RESTORE_BYTES});

class RestoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function responseStatus(res, status) {
  if (typeof res.status === 'function') res.status(status);
  else res.statusCode = status;
}
function responseJson(res, status, value) {
  if (res.headersSent || res.destroyed) return;
  responseStatus(res, status);
  if (typeof res.json === 'function') res.json(value);
  else {
    res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
    res.end?.(JSON.stringify(value));
  }
}
function responseHeader(res, key, value) {
  if (typeof res.set === 'function') res.set(key, value);
  else res.setHeader?.(key, value);
}
function ownerOf(req) {
  const owner = req?.user?.profile?.handle;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}
function isHttpsFolder(folder) {
  return folder && folder.protocol === 'https:' && !folder.username && !folder.password && !folder.search && !folder.hash;
}
function zipSignature(bytes) {
  return bytes.equals(Buffer.from([0x50,0x4b,0x03,0x04])) ||
    bytes.equals(Buffer.from([0x50,0x4b,0x05,0x06])) ||
    bytes.equals(Buffer.from([0x50,0x4b,0x07,0x08]));
}

/**
 * A short-lived, owner-bound streaming source for restoring one plugin backup.
 * This module only provides bytes; the host remains responsible for restoring data.
 */
export function createRestoreSource({getConfig, validate, request, canStart, onLock, httpsImpl = https} = {}) {
  if (typeof getConfig !== 'function' || typeof validate !== 'function' ||
      typeof request !== 'function' || typeof canStart !== 'function') {
    throw new TypeError('Restore source dependencies are required');
  }

  let current = null;

  const notifyLock = locked => { try { onLock?.(locked); } catch { /* Lock notification must not expose config or interrupt cleanup. */ } };

  function clearSession(session) {
    if (!session || current !== session) return;
    clearTimeout(session.expiryTimer);
    session.config = null;
    session.folder = null;
    session.target = null;
    session.metadataReady = false;
    const abort = session.abortDownload;
    session.abortDownload = null;
    current = null;
    notifyLock(false);
    try { abort?.(); } catch { /* Best-effort cancellation. */ }
  }

  function expireIfDue(session = current) {
    if (!session || current !== session || session.phase === 'restoring') return;
    if (Date.now() < session.expiresAt) return;
    if (session.downloadActive) {
      session.expiryElapsed = true;
      return;
    }
    clearSession(session);
  }

  function scheduleExpiry(session) {
    clearTimeout(session.expiryTimer);
    const delay = Math.max(0, session.expiresAt - Date.now());
    session.expiryTimer = setTimeout(() => {
      if (current !== session || session.phase === 'restoring') return;
      if (session.downloadActive) { session.expiryElapsed = true; return; }
      clearSession(session);
    }, delay);
    session.expiryTimer.unref?.();
  }

  function authorize(req, body) {
    const owner = ownerOf(req);
    if (!owner) throw new RestoreError(403, '需要登录管理员账号');
    expireIfDue();
    const session = current;
    if (!session || typeof body?.token !== 'string' || body.token !== session.token) {
      throw new RestoreError(409, '恢复会话不存在或令牌无效');
    }
    if (session.owner !== owner) throw new RestoreError(403, '无权访问此恢复会话');
    return session;
  }

  async function prepare(req, res) {
    const owner = ownerOf(req);
    if (!owner) throw new RestoreError(403, '需要登录管理员账号');
    if (typeof req.body?.name !== 'string' || !BACKUP_NAME.test(req.body.name)) {
      throw new RestoreError(400, '只能恢复本插件命名的 ZIP 文件');
    }
    expireIfDue();
    if (current) throw new RestoreError(409, '已有恢复会话正在进行');
    let allowed = false;
    try { allowed = canStart() === true; } catch { allowed = false; }
    if (!allowed) throw new RestoreError(409, '备份、目录检查、更新或恢复操作正在进行');

    let config, folder;
    try {
      const configured = getConfig();
      if (!configured || typeof configured !== 'object') throw new Error();
      folder = validate(configured);
      if (!isHttpsFolder(folder)) throw new Error();
      // request() only needs these captured connection fields. Do not retain mutable config objects.
      config = {
        url:folder.href,
        username:String(configured.username || ''),
        password:String(configured.password || ''),
      };
    } catch {
      throw new RestoreError(400, 'WebDAV 配置无效；恢复源必须使用已配置的 HTTPS 目录');
    }

    let target;
    try {
      target = new URL(req.body.name, folder);
      if (target.protocol !== 'https:' || target.origin !== folder.origin || !target.pathname.startsWith(folder.pathname)) throw new Error();
    } catch {
      throw new RestoreError(400, '恢复文件路径无效');
    }

    // Reserve synchronously before the first metadata await, preventing competing prepares.
    const session = {
      token:randomUUID(), owner, name:req.body.name, bytes:0, maxBytes:MAX_RESTORE_BYTES,
      phase:'prepared', config, folder, target, metadataReady:false,
      createdAt:Date.now(), expiresAt:Date.now() + SESSION_TTL_MS,
      expiryTimer:null, downloadActive:false, expiryElapsed:false, abortDownload:null,
    };
    current = session;
    notifyLock(true);
    scheduleExpiry(session);

    try {
      const metadata = await inspectSize(request, config, target, null);
      const bytes = metadata?.remoteBytes;
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RestoreError(502, '无法确认远端备份大小');
      if (bytes > MAX_RESTORE_BYTES) throw new RestoreError(413, '远端备份超过 2 GiB 恢复上限');
      if (current !== session) throw new RestoreError(409, '恢复会话已过期');
      session.bytes = bytes;
      session.metadataReady = true;
      responseJson(res, 200, {token:session.token,name:session.name,bytes:session.bytes,maxBytes:MAX_RESTORE_BYTES});
    } catch (error) {
      clearSession(session);
      if (error instanceof RestoreError) throw error;
      throw new RestoreError(502, '无法读取远端备份元数据');
    }
  }

  async function streamSource(req, res) {
    const session = authorize(req, req.body);
    if (session.phase !== 'prepared' || !session.metadataReady) throw new RestoreError(409, '恢复源不可用或已被使用');
    session.phase = 'downloading';
    session.downloadActive = true;

    let upstreamRequest = null, upstreamResponse = null, totalTimer = null, clientClosed = false;
    let resolveHeaders, rejectHeaders, headersSettled = false;
    const headersPromise = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
    const failHeaders = error => {
      if (headersSettled) return;
      headersSettled = true;
      rejectHeaders(error);
    };
    const abort = () => {
      try { upstreamRequest?.destroy(); } catch {}
      try { upstreamResponse?.destroy(); } catch {}
      failHeaders(new Error('cancelled'));
    };
    session.abortDownload = abort;
    const onClientClose = () => {
      if (res.writableEnded) return;
      clientClosed = true;
      abort();
    };
    res.once?.('close', onClientClose);

    try {
      const auth = 'Basic ' + Buffer.from(session.config.username + ':' + session.config.password).toString('base64');
      upstreamRequest = httpsImpl.request(session.target, {
        method:'GET',
        headers:{Authorization:auth,'Accept-Encoding':'identity'},
      }, response => {
        upstreamResponse = response;
        response.on?.('error', () => {});
        response.once?.('aborted', () => response.destroy?.(new Error('remote response aborted')));
        if ((response.statusCode || 0) !== 200) {
          response.resume?.();
          failHeaders(new RestoreError(502, '无法读取远端 ZIP 文件'));
          return;
        }
        const lengthHeader = response.headers?.['content-length'];
        if (lengthHeader !== undefined) {
          const text = Array.isArray(lengthHeader) ? lengthHeader.join(',') : String(lengthHeader);
          if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) !== session.bytes) {
            response.on?.('error', () => {});
            response.destroy?.();
            failHeaders(new RestoreError(502, '远端文件长度与已确认大小不一致'));
            return;
          }
        }
        if (response.headers?.['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.on?.('error', () => {});
          response.destroy?.();
          failHeaders(new RestoreError(502, '远端响应编码不受支持'));
          return;
        }
        headersSettled = true;
        resolveHeaders(response);
      });
      upstreamRequest.on?.('error', error => {
        if (!headersSettled) failHeaders(error);
        else upstreamResponse?.destroy?.(error);
      });
      upstreamRequest.setTimeout?.(IDLE_TIMEOUT_MS, () => {
        const error = new Error('idle timeout');
        failHeaders(error);
        upstreamRequest?.destroy?.(error);
        upstreamResponse?.destroy?.(error);
      });
      totalTimer = setTimeout(() => {
        const error = new Error('total timeout');
        failHeaders(error);
        upstreamRequest?.destroy?.(error);
        upstreamResponse?.destroy?.(error);
      }, TOTAL_TIMEOUT_MS);
      totalTimer.unref?.();
      upstreamRequest.end();

      const remote = await headersPromise;
      if (clientClosed || current !== session) throw new Error('client closed');
      responseStatus(res, 200);
      responseHeader(res, 'Content-Type', 'application/zip');
      responseHeader(res, 'Cache-Control', 'no-store');
      responseHeader(res, 'Content-Length', String(session.bytes));
      responseHeader(res, 'Content-Disposition', `attachment; filename="${session.name}"`);

      let received = 0;
      let prefix = Buffer.alloc(0);
      let signatureChecked = false;
      const gate = new Transform({
        transform(chunk, _encoding, callback) {
          if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
          received += chunk.length;
          if (received > session.bytes) return callback(new Error('remote file exceeds confirmed size'));
          if (!signatureChecked) {
            const need = 4 - prefix.length;
            const used = Math.min(need, chunk.length);
            if (used) prefix = Buffer.concat([prefix, chunk.subarray(0, used)], prefix.length + used);
            if (prefix.length < 4) return callback();
            if (!zipSignature(prefix)) return callback(new Error('remote file is not a ZIP archive'));
            signatureChecked = true;
            this.push(prefix);
            if (chunk.length > used) this.push(chunk.subarray(used));
            return callback();
          }
          callback(null, chunk);
        },
        flush(callback) {
          if (!signatureChecked || received !== session.bytes) return callback(new Error('remote file length is invalid'));
          callback();
        },
      });
      await pipeline(remote, gate, res);
      if (current === session) session.phase = 'downloaded';
    } catch (error) {
      if (current === session) session.phase = 'failed';
      if (!res.headersSent && !res.destroyed && !clientClosed) {
        const status = error instanceof RestoreError ? error.status : 502;
        const message = error instanceof RestoreError ? error.message : '远端 ZIP 下载或校验失败';
        responseJson(res, status, {error:message});
      } else if (!res.destroyed && !res.writableEnded) {
        res.destroy?.();
      }
    } finally {
      clearTimeout(totalTimer);
      res.removeListener?.('close', onClientClose);
      session.downloadActive = false;
      session.abortDownload = null;
      if (current === session && session.expiryElapsed) clearSession(session);
      else expireIfDue(session);
    }
  }

  function commit(req, res) {
    const session = authorize(req, req.body);
    if (session.phase !== 'downloaded') throw new RestoreError(409, '必须先完整下载并校验恢复源');
    session.phase = 'restoring';
    clearTimeout(session.expiryTimer);
    responseJson(res, 200, {ok:true});
  }

  function release(req, res) {
    const session = authorize(req, req.body);
    if (session.phase === 'restoring' && req.body?.confirmed !== true) {
      throw new RestoreError(409, '原生恢复结果未确认，必须保留恢复锁');
    }
    clearSession(session);
    responseJson(res, 200, {ok:true});
  }

  const route = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      if (error instanceof RestoreError) responseJson(res, error.status, {error:error.message});
      else responseJson(res, 500, {error:'恢复请求失败'});
    }
  };

  return {
    register(router) {
      router.post('/restore/prepare', route(prepare));
      router.post('/restore/source', route(streamSource));
      router.post('/restore/commit', route(commit));
      router.post('/restore/release', route(release));
    },
    isLocked() {
      expireIfDue();
      return current !== null;
    },
    getState() {
      expireIfDue();
      if (!current) return {...EMPTY_STATE};
      return {pending:true,phase:current.phase,name:current.name,bytes:current.bytes,maxBytes:MAX_RESTORE_BYTES};
    },
  };
}
