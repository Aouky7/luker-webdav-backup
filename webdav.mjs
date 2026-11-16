// Bounded DAV XML reader: rejects DTDs and never resolves external entities.
export const BACKUP_NAME = /^luker-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$/i;
export const PROPERTIES = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';
function decode(text) {
  return text.replace(/&([^;]*);/g, (_, e) => {
    const names = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
    if (Object.hasOwn(names,e)) return names[e];
    const n = /^#x[0-9a-f]+$/i.test(e) ? parseInt(e.slice(2),16) : /^#\d+$/.test(e) ? Number(e.slice(1)) : NaN;
    if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || n >= 0xd800 && n <= 0xdfff) throw new Error('无效 XML 实体');
    return String.fromCodePoint(n);
  });
}
export function parseDav(xml, {includeFailures = false} = {}) {
  if (Buffer.byteLength(xml) > 2097152 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('WebDAV XML 超限或包含不支持的声明');
  const root = {children:[],ns:{},text:''}, stack = [root];
  let pos = 0, count = 0;
  for (const token of xml.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g)) {
    if (token.index !== pos) throw new Error('WebDAV XML 不完整');
    const s = token[0]; pos += s.length;
    const parent = stack.at(-1);
    if (s.startsWith('<!--') || s.startsWith('<?')) continue;
    if (s.startsWith('<![CDATA[')) { parent.text += s.slice(9,-3); continue; }
    if (s.startsWith('</')) {
      if (stack.length === 1 || s.slice(2,-1).trim() !== parent.qname) throw new Error('WebDAV XML 标签不匹配');
      stack.pop(); continue;
    }
    if (s.startsWith('<')) {
      const m = /^<([\w:.-]+)((?:\s+[\s\S]*?)?)\s*(\/?)>$/.exec(s);
      if (!m || ++count > 50000 || stack.length > 32) throw new Error('WebDAV XML 结构不支持或超限');
      const ns = {...parent.ns}; let attrs = m[2].trim();
      while (attrs) {
        const a = /^([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/.exec(attrs);
        if (!a) throw new Error('WebDAV XML 属性无效');
        if (a[1] === 'xmlns') ns[''] = decode(a[2] ?? a[3]);
        else if (a[1].startsWith('xmlns:')) ns[a[1].slice(6)] = decode(a[2] ?? a[3]);
        attrs = attrs.slice(a[0].length);
      }
      const parts = m[1].split(':');
      const node = {qname:m[1],name:parts.at(-1),uri:ns[parts.length === 2 ? parts[0] : ''],ns,children:[],text:''};
      parent.children.push(node); if (!m[3]) stack.push(node);
    } else parent.text += decode(s);
  }
  if (pos !== xml.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim()) throw new Error('WebDAV XML 不完整');
  const children = (n,name) => n.children.filter(c => c.uri === 'DAV:' && c.name === name);
  const first = (n,name) => children(n,name)[0];
  const multi = root.children[0];
  if (multi.uri !== 'DAV:' || multi.name !== 'multistatus') throw new Error('WebDAV 未返回文件属性列表');
  return children(multi,'response').flatMap(r => {
    const href = first(r,'href')?.text.trim(), direct = first(r,'status')?.text;
    if (!href) return [];
    const responseStatus = Number(/\s(\d{3})(?:\s|$)/.exec(direct || '')?.[1]);
    if (direct && !(responseStatus >= 200 && responseStatus < 300)) {
      return includeFailures ? [{href,status:responseStatus,bytes:null,modified:null,collection:false,typeKnown:false}] : [];
    }
    let valid = false, collection = false, typeKnown = false, bytes = null, modified = null;
    for (const ps of children(r,'propstat')) {
      if (!/\s2\d\d(?:\s|$)/.test(first(ps,'status')?.text || '')) continue;
      const prop = first(ps,'prop'); if (!prop) continue;
      valid = true;
      const resource = first(prop,'resourcetype');
      typeKnown ||= !!resource;
      collection ||= !!resource && children(resource,'collection').length > 0;
      const length = first(prop,'getcontentlength'); if (length) bytes = parseSize(length.text.trim());
      const date = Date.parse(first(prop,'getlastmodified')?.text || '');
      if (Number.isFinite(date)) modified = new Date(date).toISOString();
    }
    return valid ? [{href,bytes,modified,collection,typeKnown}] : [];
  });
}
export function parseSize(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value); return Number.isSafeInteger(n) ? n : null;
}
function safeUrl(href,base) {
  try { const u = new URL(href,base); return u.origin !== base.origin || u.username || u.password || u.search || u.hash ? null : u; } catch { return null; }
}
export function listFiles(entries,folder) {
  const files = new Map(), prefix = decodeURIComponent(folder.pathname);
  for (const e of entries) {
    const u = safeUrl(e.href,folder); if (!u || e.collection) continue;
    let p; try { p = decodeURIComponent(u.pathname); } catch { continue; }
    if (!p.startsWith(prefix)) continue;
    const name = p.slice(prefix.length);
    if (BACKUP_NAME.test(name)) files.set(name,{name,bytes:e.bytes,modified:e.modified});
  }
  return [...files.values()].sort((a,b) => b.name.localeCompare(a.name));
}
export function targetEntry(entries,target) {
  return entries.find(e => {
    const u = safeUrl(e.href,target); if (!u || e.collection) return false;
    try { return decodeURIComponent(u.pathname) === decodeURIComponent(target.pathname); } catch { return false; }
  });
}
export function sizeResult(remoteBytes,expectedBytes,verificationSource) {
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  remoteBytes = valid(remoteBytes) ? remoteBytes : null; expectedBytes = valid(expectedBytes) ? expectedBytes : null;
  const sizeVerification = remoteBytes === null ? 'unknown' : expectedBytes === null ? 'observed' : remoteBytes === expectedBytes ? 'matched' : 'mismatch';
  const messages = {
    unknown:'无法可靠确认远端大小；上传结果尚未通过大小校验，未验证 ZIP 内容或恢复',
    observed:'已读取远端大小；缺少该文件的本地发送记录，不能判断是否一致，未验证内容或恢复',
    matched:'远端文件大小与发送字节数一致；未验证 ZIP 内容或恢复',
    mismatch:'警告：远端文件大小与发送字节数不同，请勿依赖此备份',
  };
  return {remoteBytes,expectedBytes,verificationSource,sizeVerification,verification:messages[sizeVerification],verifiedAt:new Date().toISOString()};
}
function directoryError(code, message) {
  return Object.assign(new Error(message), {code});
}
function remaining(deadline) {
  const ms = deadline - Date.now();
  if (ms <= 0) throw directoryError('DIRECTORY_TIMEOUT','目录检查或创建超时；可能已创建部分目录，请重新测试连接确认');
  return Math.min(ms, 15000);
}
export async function inspectDirectory(request, c, target, deadline = Date.now() + 60000) {
  let result;
  try {
    result = await request(c,'PROPFIND',target,PROPERTIES,{Depth:'0','Content-Type':'application/xml; charset=utf-8'},remaining(deadline));
  } catch (e) {
    if (e.statusCode === 404) return {exists:false};
    throw e;
  }
  const entries = parseDav(result.text,{includeFailures:true});
  const normalize = p => decodeURIComponent(p).replace(/\/+$/, '') || '/';
  const entry = entries.find(e => {
    const url = safeUrl(e.href,target);
    try { return url && normalize(url.pathname) === normalize(target.pathname); } catch { return false; }
  });
  if (entry?.status === 404) return {exists:false};
  if (entry?.status === 401 || entry?.status === 403) throw directoryError('DIRECTORY_FORBIDDEN','目录读取被拒绝，请检查应用密码和权限');
  if (!entry || !entry.typeKnown) throw directoryError('DIRECTORY_UNKNOWN','服务未返回目标目录的有效类型，不能确认目录状态，未尝试创建');
  if (!entry.collection) throw directoryError('DIRECTORY_NOT_COLLECTION','目标路径是文件而不是文件夹，请更换备份目录地址');
  return {exists:true};
}
export async function ensureDirectory(request, c, target) {
  const deadline = Date.now() + 60000;
  const missing = [];
  let cursor = new URL(target.href);
  // Never create the service root. On Jianguoyun, /dav/ is the hard boundary.
  const boundary = target.hostname.toLowerCase() === 'dav.jianguoyun.com' ? '/dav/' : '/';
  if (boundary !== '/' && !target.pathname.startsWith(boundary)) throw directoryError('DIRECTORY_PATH','坚果云目录地址应位于 /dav/ 下');
  for (;;) {
    const state = await inspectDirectory(request,c,cursor,deadline);
    if (state.exists) break;
    if (cursor.pathname === boundary || cursor.pathname === '/' || missing.length >= 12) {
      throw directoryError('DIRECTORY_PARENT_MISSING','无法找到可用的 WebDAV 父目录或缺失层级过多，请检查服务器地址');
    }
    missing.push(cursor);
    cursor = new URL('../',cursor);
  }
  let created = false;
  for (const folder of missing.reverse()) {
    try {
      await request(c,'MKCOL',folder,null,{'Content-Length':'0'},remaining(deadline));
      created = true;
    } catch (e) {
      // Another client may have just created it; only a positive read proves that.
      if (e.statusCode === 405 || e.statusCode === 409) {
        const state = await inspectDirectory(request,c,folder,deadline);
        if (state.exists) continue;
        throw directoryError('DIRECTORY_CREATE_UNSUPPORTED',e.statusCode === 405 ? '服务拒绝创建目录（HTTP 405）；请确认服务支持 MKCOL，或在网盘中手动建立目录' : '无法创建目录（HTTP 409）；父目录可能已变化，请重新测试连接');
      }
      if (e.statusCode === 401 || e.statusCode === 403) throw directoryError('DIRECTORY_CREATE_FORBIDDEN','自动创建目录被拒绝，请检查应用密码和创建权限；部分服务需要先在网盘中创建顶层文件夹');
      if (e.statusCode === 507) throw directoryError('DIRECTORY_NO_SPACE','云端空间不足，无法创建备份目录');
      if (e.statusCode === 501) throw directoryError('DIRECTORY_CREATE_UNSUPPORTED','此服务不支持 MKCOL 自动建目录，请手动创建或换用支持该功能的服务');
      throw directoryError('DIRECTORY_CREATE_UNCERTAIN','创建目录未确认完成：' + String(e.message || e) + '；不会自动重试写入，请重新测试连接确认状态');
    }
    const verified = await inspectDirectory(request,c,folder,deadline);
    if (!verified.exists) throw directoryError('DIRECTORY_CREATE_UNCONFIRMED','服务已接受创建请求，但复查仍找不到目录；请稍后测试连接，不要依赖此次创建结果');
  }
  return {created,destination:target.href};
}
export async function inspectSize(request,c,target,expectedBytes) {
  let propBytes = null, headBytes = null;
  try {
    const r = await request(c,'PROPFIND',target,PROPERTIES,{Depth:'0','Content-Type':'application/xml; charset=utf-8'},30000);
    propBytes = targetEntry(parseDav(r.text),target)?.bytes ?? null;
  } catch { /* Fall back when DAV properties are unavailable. */ }
  if (propBytes !== null) return sizeResult(propBytes,expectedBytes,'PROPFIND');
  try { const r = await request(c,'HEAD',target,null,{},20000); headBytes = parseSize(r.headers['content-length']); } catch {}
  // HEAD zero may describe an empty response rather than the actual resource.
  return sizeResult(headBytes > 0 ? headBytes : null,expectedBytes,headBytes > 0 ? 'HEAD' : 'unavailable');
}
