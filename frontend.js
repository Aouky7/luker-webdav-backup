// In-app companion for the WebDAV Backup server plugin (loaded as an ES module).
const ROOT = '/api/plugins/webdav-backup';
const ID = 'luker-webdav-panel';
const VERSION = '0.5.2';
const LONG_ROUTES = new Set(['/test', '/backups', '/verify']);
const ctx = () => (globalThis.Luker || globalThis.SillyTavern).getContext();
let popupQueue = Promise.resolve();
function notify(text, tone = 'info', title = 'WebDAV 备份') {
  const safeText = String(text ?? '').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[凭据已隐藏]@');
  const method = ['success', 'warning', 'error', 'info'].includes(tone) ? tone : 'info';
  try {
    if (typeof globalThis.toastr?.[method] === 'function') {
      globalThis.toastr[method](safeText, title, {escapeHtml:true, closeButton:true, timeOut:method === 'error' || method === 'warning' ? 9000 : 4000});
      return;
    }
  } catch { /* Fall back to the host's text popup. */ }
  popupQueue = popupQueue.catch(() => {}).then(async () => {
    try {
      const c = ctx();
      if (c.callGenericPopup && c.POPUP_TYPE?.TEXT !== undefined) {
        const content = document.createElement('div'); content.style.whiteSpace = 'pre-wrap'; content.textContent = title + '\n\n' + safeText;
        await c.callGenericPopup(content, c.POPUP_TYPE.TEXT, '');
        return;
      }
    } catch { /* Older hosts may not expose popups. */ }
    try { globalThis.alert(title + '\n\n' + safeText); } catch {}
  });
}
const styleUrl = new URL('./style.css', import.meta.url);
styleUrl.searchParams.set('v', VERSION);
function loadScopedStyle() {
  let link = document.getElementById(ID + '-style');
  if (link && link.dataset.state !== 'failed') return;
  link?.remove();
  link = document.createElement('link');
  link.id = ID + '-style';
  link.rel = 'stylesheet';
  link.href = styleUrl.href;
  link.dataset.state = 'loading';
  const showError = failed => {
    const notice = document.querySelector('#' + ID + ' [data-view="styleWarning"]');
    if (notice) notice.hidden = !failed;
  };
  link.addEventListener('load', () => { link.dataset.state = 'loaded'; showError(false); }, {once:true});
  link.addEventListener('error', () => { link.dataset.state = 'failed'; showError(true); }, {once:true});
  document.head.append(link);
}
async function api(route, data) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LONG_ROUTES.has(route) ? 70000 : 20000);
  try {
    const tokenResponse = await fetch('/csrf-token', {cache:'no-store',signal:controller.signal});
    if (!tokenResponse.ok) throw new Error('无法取得登录令牌，请重新打开 Luker 或登录');
    const token = (await tokenResponse.json()).token;
    const response = await fetch(ROOT + route, {
      method:data === undefined ? 'GET' : 'POST', cache:'no-store', signal:controller.signal,
      headers:{'Content-Type':'application/json','x-csrf-token':token},
      body:data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await response.text();
    let result; try { result = JSON.parse(text); } catch { result = {}; }
    if (!response.ok) {
      if (['/backups', '/verify'].includes(route) && [404, 405, 501].includes(response.status)) {
        throw new Error('云端列表与大小检查需要 0.3.0 后端，请更新服务端插件并重启 Luker');
      }
      throw new Error(result.error || (response.status === 404 ? '未找到后端插件，请在服务端插件管理安装/更新后重启 Luker' : response.status === 403 ? '当前会话需要管理员权限，请先登录 Luker' : '请求失败：HTTP ' + response.status));
    }
    return result;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时，请确认 Luker 后端仍在运行后重试');
    if (e instanceof TypeError) throw new Error('无法连接 Luker 后端，请返回应用并等待启动完成');
    throw e;
  } finally { clearTimeout(timer); }
}
function mount() {
  if (document.getElementById(ID)) return;
  const target = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
  if (!target) return;
  const panel = document.createElement('div');
  panel.id = ID;
  panel.innerHTML = `<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header" role="button" tabindex="0" aria-expanded="false" aria-controls="luker-webdav-content">
<b>WebDAV 备份</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></div>
</div>
<div class="inline-drawer-content" id="luker-webdav-content"><div class="wd-body">
<p data-view="styleWarning" role="status" hidden>样式加载失败，请检查扩展是否包含 style.css 并重新加载页面；重新展开面板会重试。</p>
<section class="wd-section" aria-label="连接配置">
<div class="wd-heading"><h4>连接配置</h4><span class="wd-caption">WebDAV 云端备份</span></div>
<div class="wd-fields">
<label class="wd-field wd-wide">HTTPS 目录地址<input class="text_pole" data-field="url" type="url" spellcheck="false" autocapitalize="off" placeholder="https://dav.jianguoyun.com/dav/LukerBackup/"></label>
<label class="wd-field">用户名<input class="text_pole" data-field="username" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
<label class="wd-field">应用密码<input class="text_pole" data-field="password" type="password" autocomplete="new-password" placeholder="留空保留已保存的密码"></label>
</div>
<small class="wd-hint">边生成 ZIP 边上传，不保存本地完整 ZIP；服务须支持未知长度的流式上传。</small>
<small class="wd-hint wd-directory-hint">测试连接或开始备份时，会自动创建缺失的目标及中间目录；需要可用的 WebDAV 根目录和创建权限。坚果云 /dav/ 根地址保存后会改为 /dav/LukerBackup/。</small>
<small class="wd-hint" data-view="configState">展开后读取已保存的配置</small>
<div class="wd-buttons"><button type="button" class="menu_button" data-action="save">保存配置</button><button type="button" class="menu_button" data-action="test">测试连接</button><button type="button" class="menu_button" data-action="reload">重新读取</button></div>
</section>
<section class="wd-section" aria-label="备份内容">
<div class="wd-heading"><h4>备份内容</h4><span class="wd-caption" data-view="selectionCount">等待读取</span></div>
<div class="wd-categories"></div>
<div class="wd-buttons wd-select-tools"><button type="button" class="menu_button" data-action="defaults">默认分类</button><button type="button" class="menu_button" data-action="all">全选（含密钥）</button></div>
<small class="wd-hint" data-view="databaseWarning" hidden>数据库模式：导出可能包含未勾选分类的数据及 API 密钥。</small>
<details class="wd-notes"><summary>备份范围说明</summary><small class="wd-hint">全选仅覆盖 Luker 原生支持的分类，不包含服务端插件、APK 或整套运行环境；独立 Skills/CardApp 等是否覆盖取决于宿主版本。数据库导出可能包含分类之外的数据及机密，即使未勾选 API 密钥。恢复时需以管理员身份在 Luker 备份恢复中勾选“全局前端扩展”；服务端插件需单独安装。</small></details>
</section>
<div><button type="button" class="menu_button wd-primary" data-action="backup"><i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i>备份到 WebDAV</button>
<small class="wd-hint">先结束生成和编辑。上传前会确认目标及分类；ZIP 未加密，请使用私有目录。</small></div>
<p class="wd-message" data-view="message" role="status">准备就绪</p>
<section class="wd-section" aria-label="最近任务">
<div class="wd-heading"><h4>最近任务</h4><div class="wd-task-actions"><button type="button" class="menu_button" data-action="verify-latest" hidden>重新检查大小</button><button type="button" class="menu_button" data-action="status" aria-label="刷新任务状态">刷新状态</button></div></div>
<div class="wd-status-line" role="status"><span class="wd-badge" data-view="phase">尚未查询</span><span class="wd-caption" data-view="bytes"></span></div>
<p class="wd-verification" data-view="verification" role="status" hidden></p>
<p class="wd-verification" data-view="latestCheck" role="status" hidden></p>
<details class="wd-notes"><summary>任务详情</summary><dl class="wd-metadata" data-view="metadata"></dl></details>
<small class="wd-hint">运行时自动刷新。关闭面板不影响任务，请保持 Luker 后端运行。</small>
</section>
<section class="wd-section" aria-label="云端备份">
<div class="wd-heading"><h4>云端备份</h4><button type="button" class="menu_button" data-action="list">刷新云端列表</button></div>
<small class="wd-hint">读取已保存的 WebDAV 目录，仅手动刷新。大小检查不验证 ZIP 内容完整性，也不验证能否恢复。</small>
<p class="wd-message" data-view="cloudMessage" role="status">尚未读取云端列表</p>
<div class="wd-cloud-list" data-view="cloudList" role="list" aria-label="云端备份文件"></div>
</section>
<details class="wd-notes"><summary>关于此扩展 · 0.5.2</summary><small class="wd-hint">仅使用流式上传，边生成边上传，不创建本地 ZIP。自动创建目录需要 0.4.0 后端。本扩展不提供恢复、删除或下载备份操作；大小一致不代表内容完整或可恢复。</small></details>
</div></div></div>`;
  target.append(panel);
  loadScopedStyle();
  const $ = selector => panel.querySelector(selector);
  const field = name => $('[data-field="' + name + '"]');
  const message = (value, tone = 'info') => {
    const el = $('[data-view="message"]'); el.textContent = value; el.dataset.tone = tone;
  };
  const header = $('.inline-drawer-header');
  const isOpen = () => $('.inline-drawer-icon').classList.contains('up');
  let loaded = false, loading = false, dirty = false, running = false, checking = null, timer;
  let starting = false, pollingFailed = false;
  const observedTasks = new Set(), announcedTasks = new Set(), pendingResults = new Map();
  const activePhases = new Set(['preparing','uploading','renaming','verifying']);
  const taskKey = s => s.name ? JSON.stringify([s.name, s.destination || '', s.started || '']) : '';
  function observeStatus(s, startedHere = false) {
    const key = taskKey(s);
    running = !!s.busy || activePhases.has(s.phase);
    if (key && (running || startedHere)) observedTasks.add(key);
    formatStatus(s);
    if (running || !key || !observedTasks.has(key) || announcedTasks.has(key) || !['uploaded','failed','interrupted'].includes(s.phase)) return;
    if (document.hidden) { pendingResults.set(key, s); return; }
    announceResult(key, s);
  }
  function announceResult(key, s) {
    pendingResults.delete(key);
    announcedTasks.add(key); observedTasks.delete(key);
    if (s.phase !== 'uploaded') {
      notify(s.error || s.note || '任务已中断，请检查最近任务详情', 'error', s.phase === 'failed' ? '备份失败' : '备份已中断');
    } else if (s.sizeVerification === 'matched') {
      notify('备份上传完成，远端大小一致。' + (s.directoryCreated ? '已自动创建备份目录。' : '') + '尚未验证 ZIP 内容或恢复。', 'success', '备份完成');
    } else {
      notify(s.verification || '上传已完成，但尚未确认远端大小，请检查任务详情。', 'warning', s.sizeVerification === 'mismatch' ? '备份上传完成 · 大小异常' : '备份上传完成 · 大小待确认');
    }
  }
  function pollingError(error) {
    message('状态读取失败，备份结果尚未确认：' + error.message, 'error');
    if (!pollingFailed) notify('暂时无法读取任务状态，不能据此判断备份失败。恢复连接后会继续检查。', 'warning', '状态连接中断');
    pollingFailed = true;
  }
  let listing = false, verifying = false, configRevision = 0, latestName = '';
  const sizeText = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString() + ' 字节（' + (value / 1048576).toFixed(2) + ' MiB）' : '未知';
  const checkLabels = {matched:'大小一致（未验证内容）', mismatch:'大小不一致，请勿依赖此备份', unknown:'大小未知，无法确认', observed:'已读取大小，无发送基准，未验证'};
  const cloudMessage = (text, tone = 'info') => {
    const el = $('[data-view="cloudMessage"]'); el.textContent = text; el.dataset.tone = tone;
  };
  function invalidateCloud() {
    configRevision++;
    $('[data-view="cloudList"]').replaceChildren();
    cloudMessage('配置已读取或保存，请手动刷新云端列表');
  }
  function verificationText(result) {
    return [checkLabels[result.sizeVerification] || checkLabels.unknown,
      '远端大小：' + sizeText(result.remoteBytes),
      '发送基准：' + sizeText(result.expectedBytes),
      result.verificationSource ? '大小来源：' + result.verificationSource : '',
      result.verification || '大小检查已完成。'].filter(Boolean).join('\n');
  }
  async function refreshCloud() {
    if (listing || verifying) throw new Error('云端请求正在进行，请稍后再试');
    listing = true;
    const revision = configRevision;
    cloudMessage('正在读取云端列表…');
    $('[data-view="cloudList"]').replaceChildren();
    try {
      const result = await api('/backups');
      if (revision !== configRevision) return;
      if (!Array.isArray(result.files)) throw new Error('后端未返回云端文件列表，请更新到 0.3.0 后端并重启 Luker');
      const rows = result.files.filter(file => file && typeof file.name === 'string').map(file => {
        const row = document.createElement('article'); row.className = 'wd-cloud-file'; row.setAttribute('role', 'listitem');
        const title = document.createElement('div'); title.className = 'wd-file-name'; title.textContent = file.name;
        const metadata = document.createElement('div'); metadata.className = 'wd-caption';
        const date = file.modified ? new Date(file.modified) : null;
        metadata.textContent = '大小：' + sizeText(file.bytes) + ' · 修改时间：' + (date && Number.isFinite(date.getTime()) ? date.toLocaleString() : '未知');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button'; button.dataset.action = 'verify'; button.dataset.name = file.name; button.textContent = '检查大小'; button.setAttribute('aria-label', '检查大小：' + file.name);
        const details = document.createElement('p'); details.className = 'wd-verification'; details.dataset.fileVerification = ''; details.setAttribute('role', 'status'); details.hidden = true;
        row.append(title, metadata, button, details); return row;
      });
      $('[data-view="cloudList"]').replaceChildren(...rows);
      cloudMessage((rows.length ? '已读取 ' + rows.length + ' 个备份文件。' : '当前目录未找到备份文件。') + (result.limited ? '列表已截断，仅显示部分文件。' : ''));
    } catch (e) {
      if (revision === configRevision) cloudMessage(e.message, 'error');
      throw e;
    } finally { listing = false; }
  }
  async function verifyFile(name, output) {
    if (listing || verifying) throw new Error('云端请求正在进行，请稍后再试');
    verifying = true;
    const revision = configRevision;
    output.hidden = false; output.dataset.tone = 'info'; output.textContent = '正在检查远端大小…';
    try {
      const result = await api('/verify', {name});
      if (revision !== configRevision) return;
      if (result.name !== name || !Object.hasOwn(checkLabels, result.sizeVerification)) throw new Error('后端返回的大小检查结果无效，请更新到 0.3.0 后端并重启 Luker');
      output.textContent = verificationText(result);
      output.dataset.tone = result.sizeVerification === 'mismatch' ? 'warning' : 'info';
      notify(checkLabels[result.sizeVerification], result.sizeVerification === 'matched' ? 'success' : 'warning', '大小检查完成');
      // Status refresh is optional; a failure must not erase the successful per-file result.
      if (name === latestName) await refreshStatus().catch(e => message('大小检查已返回，但任务状态刷新失败：' + e.message, 'error'));
    } catch (e) {
      if (revision === configRevision) { output.textContent = e.message; output.dataset.tone = 'error'; }
      throw e;
    } finally { verifying = false; }
  }
  function updateSelectionCount() {
    const inputs = [...panel.querySelectorAll('[data-category]')];
    $('[data-view="selectionCount"]').textContent = '已选 ' + inputs.filter(el => el.checked).length + ' / ' + inputs.length;
  }
  const defaults = {settings:true,secrets:false,characters:true,chats:true,lorebooks:true,presets:true,assets:true,extensions:true,globalExtensions:false,vectors:false};
  const getSelection = () => Object.fromEntries([...panel.querySelectorAll('[data-category]')].map(el => [el.dataset.category,el.checked]));
  const setSelection = values => panel.querySelectorAll('[data-category]').forEach(el => { el.checked = !!values[el.dataset.category]; });
  function formatStatus(s) {
    const names = {idle:'空闲',preparing:'检查并准备备份目录',uploading:'打包并上传中',renaming:'远端改名中',verifying:'检查远端文件',uploaded:'上传完成',failed:'失败',interrupted:'已中断'};
    const tone = activePhases.has(s.phase) ? 'active' : ['failed','interrupted'].includes(s.phase) ? 'error' : s.sizeVerification === 'mismatch' || s.verification?.includes('警告') ? 'warning' : 'info';
    latestName = s.name || '';
    const latestButton = $('[data-action="verify-latest"]');
    latestButton.hidden = s.phase !== 'uploaded' || !latestName;
    const phase = $('[data-view="phase"]'); phase.textContent = names[s.phase] || s.phase || '尚未查询'; phase.dataset.tone = tone;
    const validBytes = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    $('[data-view="bytes"]').textContent = validBytes(s.bytes) ? '已发送 ' + (s.bytes / 1048576).toFixed(2) + ' MiB' : '';
    if (s.phase === 'uploaded' && tone === 'warning') phase.textContent = '上传完成 · 校验异常';
    const verification = $('[data-view="verification"]'); verification.textContent = [s.sizeVerification ? checkLabels[s.sizeVerification] : '', s.verification, s.error, s.note, s.warning, s.phase === 'uploaded' ? '仅检查大小，未验证 ZIP 内容完整性或能否恢复。' : ''].filter(Boolean).join('\n'); verification.hidden = !verification.textContent; verification.dataset.tone = tone;
    const values = [['后端版本', s.version], ['已发送', validBytes(s.bytes) ? s.bytes + ' 字节（交给上传流，不代表远端已校验）' : null], ['远端大小', s.remoteBytes != null ? s.remoteBytes + ' 字节' : null], ['文件', s.name], ['目标', s.destination], ['开始', s.started && new Date(s.started).toLocaleString()], ['结束', s.finished && new Date(s.finished).toLocaleString()]];
    $('[data-view="metadata"]').replaceChildren(...values.filter(([,value]) => value).flatMap(([key,value]) => { const dt = document.createElement('dt'); dt.textContent = key; const dd = document.createElement('dd'); dd.textContent = value; return [dt,dd]; }));
  }
  function schedule() {
    clearTimeout(timer);
    // Keep watching an observed task when its panel is collapsed, but not in a hidden tab.
    if (running && !starting && !document.hidden) timer = setTimeout(() => refreshStatus().catch(pollingError), 2500);
  }
  function refreshStatus() {
    if (checking) return checking;
    if (starting) return Promise.resolve(null);
    checking = (async () => {
      try {
        const s = await api('/status');
        pollingFailed = false;
        observeStatus(s);
        return s;
      } finally { checking = null; schedule(); }
    })();
    return checking;
  }
  async function load() {
    if (loading) return;
    loading = true;
    try {
    const c = await api('/config');
    if (!c.categories) throw new Error('后端仍为旧版，请更新服务端插件并重启 Luker，再点重新读取配置');
    field('url').value = c.url || ''; field('username').value = c.username || ''; field('password').value = '';
    invalidateCloud();
    $('[data-view="latestCheck"]').hidden = true;
    const box = $('.wd-categories'); box.replaceChildren();
    for (const [key,name] of Object.entries(c.categories)) {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.dataset.category = key; input.checked = !!c.selection[key];
      label.append(input,document.createTextNode(name)); box.append(label);
    }
    $('[data-view="configState"]').textContent = '后端 ' + c.version + ' · 存储 ' + c.storageEngine + ' · ' + (c.passwordSet ? '密码已保存，留空不变' : '尚未保存密码');
    $('[data-view="databaseWarning"]').hidden = c.storageEngine === 'fs';
    updateSelectionCount();
    loaded = true; dirty = false; message('配置已读取'); await refreshStatus();
    } finally { loading = false; }
  }
  panel.addEventListener('input', () => { dirty = true; message('配置已修改，请保存后再备份'); });
  panel.addEventListener('change', () => { dirty = true; updateSelectionCount(); message('配置已修改，请保存后再备份'); });
  async function confirmUpload(text) {
    let context; try { context = ctx(); } catch { context = {}; }
    if (context.callGenericPopup && context.POPUP_TYPE?.CONFIRM !== undefined) {
      const content = document.createElement('div'); content.style.whiteSpace = 'pre-wrap'; content.textContent = text;
      return !!(await context.callGenericPopup(content, context.POPUP_TYPE.CONFIRM, ''));
    }
    return globalThis.confirm(text);
  }
  panel.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const action = button.dataset.action;
    button.disabled = true;
    try {
      if (starting && action !== 'status') throw new Error('正在启动备份，请稍后再试');
      if (['save', 'reload'].includes(action) && (listing || verifying)) throw new Error('云端请求正在进行，请完成后再修改或读取配置');
      if (action === 'reload') {
        if (dirty && !await confirmUpload('放弃未保存的表单修改，重新读取后端配置？')) return;
        await load(); notify('已重新读取保存的配置与最近任务。', 'success', '配置已读取'); return;
      }
      if (action === 'status') { const s = await refreshStatus(); if (s) notify('已获取最新任务状态：' + (s.phase === 'uploaded' ? '上传完成，请查看校验结果' : s.phase === 'failed' ? '失败，请查看详情' : s.phase === 'idle' ? '空闲' : '请查看最近任务'), 'info', '状态已刷新'); return; }
      if (action === 'list' || action === 'verify' || action === 'verify-latest') {
        if (!loaded) throw new Error('请先点击重新读取配置，确认后端连接成功');
        if (dirty) throw new Error('表单有未保存修改，请先保存配置');
        if (action === 'list') { await refreshCloud(); notify($('[data-view="cloudMessage"]').textContent, 'success', '云端列表已刷新'); return; }
        const name = action === 'verify-latest' ? latestName : button.dataset.name;
        if (!name) throw new Error('没有可检查的备份文件');
        const output = action === 'verify-latest' ? $('[data-view="latestCheck"]') : button.closest('.wd-cloud-file')?.querySelector('[data-file-verification]');
        if (!output) throw new Error('找不到大小检查结果区域');
        await verifyFile(name, output); return;
      }
      if (!loaded) throw new Error('请先点击重新读取配置，确认后端连接成功');
      if (action === 'all' || action === 'defaults') {
        setSelection(action === 'all' ? Object.fromEntries(Object.keys(getSelection()).map(k => [k,true])) : defaults); updateSelectionCount(); dirty = true; message('分类已修改，请保存配置'); return;
      }
      if (action === 'save') {
        const r = await api('/config',{url:field('url').value,username:field('username').value,password:field('password').value,selection:getSelection()});
        if (typeof r.url === 'string') field('url').value = r.url;
        field('password').value = ''; dirty = false; invalidateCloud(); $('[data-view="latestCheck"]').hidden = true;
        message(r.note || '已保存'); notify(r.note || '配置已保存', 'success', '保存成功'); return;
      }
      if (dirty) throw new Error('表单有未保存修改，请先保存配置');
      if (action === 'test') {
        message('正在检查目录，缺失时将自动创建…');
        const r = await api('/test',{});
        message(r.note || '目录访问成功'); notify(r.note || '目录访问成功', 'success', r.created ? '连接成功 · 目录已创建' : '连接成功'); return;
      }
      if (action === 'backup') {
        const c = await api('/config'), chosen = c.selection;
        if (c.uploadMode === 'staged') throw new Error('当前后端仍启用旧版暂存上传，请更新服务端插件到 0.5.2 并重启 Luker');
        const names = Object.keys(chosen).filter(k => chosen[k]).map(k => c.categories[k]);
        const modeText = '流式上传：边生成 ZIP 边上传，不保存本地 ZIP。';
        const restoreHint = chosen.globalExtensions ? '恢复时需以管理员身份在 Luker 备份恢复中勾选“全局前端扩展”；服务端插件需单独安装。\n' : '';
        const text = '确认将当前用户数据上传到：\n' + c.url + '\n\n上传方式：' + modeText + '\n\n分类：' + names.join('、') + '\n\n' + (c.storageEngine !== 'fs' ? '数据库模式：导出可能含其他分类与机密。\n' : '') + restoreHint + '请确认已结束生成与编辑。目标目录不存在时将自动创建。此操作仅新增远端备份，不恢复或覆盖当前聊天。';
        if (!await confirmUpload(text)) return;
        // Drain an older status query before accepting a new task snapshot.
        if (checking) await checking.catch(() => {});
        starting = true; clearTimeout(timer);
        let accepted = false;
        try {
          const result = await api('/backup',{selection:chosen});
          accepted = true;
          message('备份任务已启动'); notify('准备目录后边生成 ZIP 边上传。完成或异常时会提示，请保持 Luker 后端运行。', 'info', '备份已启动');
          observeStatus(result, true);
        } catch (e) {
          if (accepted) pollingError(e); else throw e;
        } finally { starting = false; schedule(); }
        await refreshStatus().catch(pollingError);
      }
    } catch (e) {
      message(e.message, 'error');
      const titles = {save:'保存配置失败',test:'连接测试失败',reload:'重新读取失败',backup:'备份请求未确认',status:'状态读取失败',list:'云端列表读取失败',verify:'大小检查失败','verify-latest':'大小检查失败'};
      notify(e.message, 'error', titles[action] || '操作未完成');
    }
    finally { button.disabled = false; }
  });
  // Luker owns drawer clicks/animation. Observe its icon instead of toggling twice.
  new MutationObserver(() => {
    header.setAttribute('aria-expanded', String(isOpen()));
    if (!isOpen()) { schedule(); return; }
    loadScopedStyle();
    (loaded ? refreshStatus() : load()).catch(pollingError);
  }).observe($('.inline-drawer-icon'), {attributes:true, attributeFilter:['class']});
  header.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); header.click(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else {
      for (const [key, result] of pendingResults) announceResult(key, result);
      if (isOpen() || running) {
        loadScopedStyle();
        (loaded ? refreshStatus() : load()).catch(pollingError);
      }
    }
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
else mount();
try { const c = ctx(); c.eventSource.on(c.eventTypes.APP_READY, mount); } catch {}
