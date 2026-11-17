// Frontend-only updater. Host APIs own Git changes; no code evaluation or auto mutation.
const REPOSITORY = 'https://github.com/Aouky7/webdav_luker';
const LATEST = 'https://raw.githubusercontent.com/Aouky7/webdav_luker/main/manifest.json';
const validDirectory = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..';
function sameRepository(value) {
  if (typeof value !== 'string') return false;
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)aouky7\/webdav_luker(?:\.git)?\/?$/i.test(value.trim());
}
function versionParts(value) {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) return null;
  return value.split('.').map(Number);
}
function newer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function folderFromModule(moduleUrl) {
  try {
    const pathname = new URL(moduleUrl).pathname;
    const match = /^\/scripts\/extensions\/third-party\/([^/]+)\/frontend\.js$/.exec(pathname);
    const folder = match && decodeURIComponent(match[1]);
    return validDirectory(folder) ? folder : null;
  } catch { return null; }
}
async function latestVersion(fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(LATEST, {signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error'});
    if (!response.ok) throw Error('版本源 HTTP ' + response.status);
    if (Number(response.headers?.get?.('content-length')) > 65536) throw Error('版本清单超过大小限制');
    if (!response.body?.getReader) throw Error('无法安全读取版本清单');
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    try {
      for (;;) {
        const {done,value} = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 65536) throw Error('版本清单超过大小限制');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    const manifest = JSON.parse(new TextDecoder().decode(bytes));
    if (!versionParts(manifest.version)) throw Error('版本清单格式不支持');
    return manifest.version;
  } finally { clearTimeout(timer); }
}

export function mountUpdates({panel,version,moduleUrl,api,notify,confirm,getBusy = () => false,getDirty = () => false,onLock = () => {},fetchImpl = globalThis.fetch}) {
  const body = panel.querySelector('.wd-body');
  if (!body) throw Error('更新面板缺少挂载位置');
  const section = panel.ownerDocument.createElement('section');
  section.className = 'wd-section'; section.dataset.updates = '';
  section.innerHTML = '<div class="wd-heading"><h4>版本与更新</h4></div><p class="wd-hint" data-update="versions"></p><p class="wd-message" data-update="mismatch" role="status" hidden></p><p class="wd-message" data-update="result" role="status">读取配置后检查更新</p><div class="wd-buttons"><button type="button" class="menu_button" data-update="check">检查更新</button><button type="button" class="menu_button" data-update="install" disabled>更新前后端</button></div><small class="wd-hint">依次更新服务端插件和前端扩展，不是原子更新。完成后需重启 Luker 后端并重新加载页面；不会自动重启或强制覆盖本地修改。</small>';
  body.append(section);
  const $ = name => section.querySelector('[data-update="' + name + '"]');
  let backendVersion = '', identity = null, checked = null, automaticChecked = false;
  let checking = false, updating = false, locked = false, lastCheck = 0;
  const state = {backend:'未执行',frontend:'未执行'};
  const text = (message,tone = 'info') => { $('result').textContent = message; $('result').dataset.tone = tone; };
  function versions() {
    $('versions').textContent = `当前运行：前端 ${version} · 后端 ${backendVersion || '未知'}`;
    const mismatch = !!backendVersion && backendVersion !== version;
    $('mismatch').hidden = !mismatch;
    $('mismatch').textContent = mismatch ? '前后端版本不匹配，请更新两端后重启后端并重新加载页面。' : '';
    $('mismatch').dataset.tone = 'warning';
  }
  function buttons() {
    $('check').disabled = checking || updating || locked;
    $('install').disabled = checking || updating || locked || !checked;
  }
  function guard() {
    if (locked) throw Error('更新结果待应用或核实，请重启后端并重新加载页面后操作');
    if (getBusy()) throw Error('备份或其他操作正在进行，请完成后再更新');
    if (getDirty()) throw Error('配置有未保存修改，请先保存或重新读取');
  }
  async function identify() {
    const folder = folderFromModule(moduleUrl);
    if (!folder) throw Error('无法确定当前前端安装目录，请在宿主扩展管理中手动更新');
    if (!identity || !validDirectory(identity.directory) || !sameRepository(identity.repository)) throw Error('后端未提供可核实的安装身份，请在宿主插件管理中手动更新');
    const directory = identity.directory;
    const [discovered,listed] = await Promise.all([api('/api/extensions/discover'),api('/api/users/plugins/list',{})]);
    if (!Array.isArray(discovered) || !listed?.ok || !Array.isArray(listed.plugins)) throw Error('宿主未提供完整更新能力，请分别在扩展管理和服务端插件管理中更新');
    const front = discovered.filter(item => item.name === 'third-party/' + folder && ['local','global'].includes(item.type));
    const back = listed.plugins.filter(item => item.directory === directory);
    if (front.length !== 1 || back.length !== 1) throw Error('安装目录缺失或存在歧义，请在宿主管理界面核对后更新');
    if (!sameRepository(back[0].remoteUrl)) throw Error('当前后端来源不是新仓库 Aouky7/webdav_luker；请先手动迁移，不能自动修改来源');
    const frontend = {extensionName:folder,global:front[0].type === 'global'};
    const status = await api('/api/extensions/version',frontend);
    if (!sameRepository(status?.remoteUrl)) throw Error('当前前端来源不是新仓库 Aouky7/webdav_luker；请先手动迁移，不能自动修改来源');
    if (!status.currentBranchName || !status.currentCommitHash) throw Error('前端没有可确认的 Git 分支，请在宿主管理中手动更新');
    return {directory:identity.directory,frontend,status};
  }
  async function check({automatic = false} = {}) {
    if (checking || updating || locked) return;
    if (automatic && automaticChecked) return;
    if (automatic) automaticChecked = true;
    if (lastCheck && Date.now() - lastCheck < 15000) return;
    if (getBusy() || getDirty()) { if (!automatic) text('请在当前操作结束并保存配置后检查更新','warning'); return; }
    checking = true; checked = null; lastCheck = Date.now(); buttons(); text('正在检查版本与安装来源…');
    try {
      const [remote,target] = await Promise.allSettled([latestVersion(fetchImpl),identify()]);
      checked = target.status === 'fulfilled' ? target.value : null;
      const latest = remote.status === 'fulfilled' ? remote.value : null;
      const upgrade = latest && (newer(latest,version) || newer(latest,backendVersion));
      const codeUpdate = checked?.status?.isUpToDate === false;
      const parts = [latest ? '仓库版本：' + latest + (upgrade ? '，有新版本。' : '。') : '在线版本检查失败，可稍后重试。'];
      if (codeUpdate) parts.push('前端仓库有新提交。');
      if (target.status === 'rejected') parts.push(target.reason?.message || '无法确认更新能力，请手动更新。');
      else parts.push('已核实前后端安装来源，可依次更新；后端是否有新提交由更新接口确认。');
      text(parts.join('\n'),upgrade || codeUpdate || !checked ? 'warning' : 'info');
      if (upgrade || codeUpdate) notify('发现更新，请在“版本与更新”中查看。','info','WebDAV 更新提示');
      return {latest,canUpdate:!!checked};
    } finally { checking = false; buttons(); }
  }
  async function install() {
    if (checking || updating || locked) return;
    updating = true; buttons(); let touched = false;
    try {
      guard();
      const target = await identify(); // Revalidate exact directories and remotes for every mutation.
      guard();
      if (!await confirm('将依次更新当前 WebDAV 服务端插件与前端扩展。\n仓库：' + REPOSITORY + '\n服务端目录：' + target.directory + '\n前端目录：' + target.frontend.extensionName + '\n\n任一步骤失败会停止；完成后请手动重启后端并重新加载页面。是否继续？')) return;
      state.backend = '未执行'; state.frontend = '未执行';
      guard(); touched = true; await onLock(true);
      state.backend = '正在更新'; text('正在更新服务端插件…');
      const backend = await api('/api/users/plugins/update',{directory:target.directory});
      if (backend?.ok !== true || backend.plugin?.directory !== target.directory || !sameRepository(backend.plugin?.remoteUrl)) {
        throw Object.assign(Error('服务端更新响应无法核实，结果未确认'),{uncertain:true});
      }
      state.backend = '已下载，待重启'; state.frontend = '正在更新';
      text('服务端更新已下载，正在更新前端扩展…');
      const frontend = await api('/api/extensions/update',{...target.frontend,force:false});
      if (!frontend || typeof frontend.shortCommitHash !== 'string' || !sameRepository(frontend.remoteUrl)) {
        const error = Error('前端更新响应无法核实，结果未确认'); error.uncertain = true; throw error;
      }
      state.frontend = '已下载，待重新加载'; locked = true;
      text('前后端更新请求均已成功。当前运行版本尚未改变；请重启 Luker 后端，再重新加载页面。','info');
      notify('更新已下载，请重启后端并重新加载页面。','success','更新完成 · 待应用');
    } catch (error) {
      const uncertain = error?.uncertain || error?.name === 'AbortError' || error instanceof TypeError;
      if (state.backend === '正在更新') state.backend = uncertain ? '结果未确认' : '更新失败';
      if (state.frontend === '正在更新') state.frontend = uncertain ? '结果未确认' : '更新失败';
      // A partial update must not replay the first write on the next button click.
      locked = touched && (uncertain || state.backend === '已下载，待重启');
      const result = `服务端：${state.backend}；前端：${state.frontend}。`;
      text(result + '\n' + String(error?.message || error) + (locked ? '\n请在宿主管理中核实结果，重启后端并重新加载页面；不会自动重试。' : ''),'warning');
      notify(result + ' ' + String(error?.message || error),'warning','更新未全部完成');
    } finally {
      updating = false;
      if (touched && !locked) await onLock(false);
      buttons();
    }
  }
  $('check').addEventListener('click',() => { void check(); });
  $('install').addEventListener('click',() => { void install(); });
  versions(); buttons();
  return {
    setBackendVersion(value) { backendVersion = typeof value === 'string' ? value : ''; versions(); },
    setConfig(config) {
      backendVersion = typeof config?.version === 'string' ? config.version : '';
      identity = config?.updateIdentity ? {...config.updateIdentity} : null;
      checked = null; versions(); buttons();
      if (!automaticChecked && !checking && !updating) void check({automatic:true});
    },
    check,install,
    getState:() => ({...state,locked,checking,updating}),
  };
}
