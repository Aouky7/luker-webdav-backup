// In-app companion for the WebDAV Backup server plugin.
const ROOT = '/api/plugins/webdav-backup';
const ID = 'luker-webdav-panel';
const ctx = () => (globalThis.Luker || globalThis.SillyTavern).getContext();
async function api(route, data) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), route === '/test' ? 70000 : 20000);
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
    if (!response.ok) throw new Error(result.error || (response.status === 404 ? '未找到后端插件，请在服务端插件管理安装/更新后重启 Luker' : response.status === 403 ? '当前会话需要管理员权限，请先登录 Luker' : '请求失败：HTTP ' + response.status));
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
<section class="wd-section" aria-label="连接配置">
<div class="wd-heading"><h4>连接配置</h4><span class="wd-caption">WebDAV 云端备份</span></div>
<div class="wd-fields">
<label class="wd-field wd-wide">HTTPS 目录地址<input class="text_pole" data-field="url" type="url" spellcheck="false" autocapitalize="off" placeholder="https://dav.jianguoyun.com/dav/LukerBackup/"></label>
<label class="wd-field">用户名<input class="text_pole" data-field="username" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
<label class="wd-field">应用密码<input class="text_pole" data-field="password" type="password" autocomplete="new-password" placeholder="留空保留已保存的密码"></label>
</div>
<small class="wd-hint" data-view="configState">展开后读取已保存的配置</small>
<div class="wd-buttons"><button type="button" class="menu_button" data-action="save">保存配置</button><button type="button" class="menu_button" data-action="test">测试连接</button><button type="button" class="menu_button" data-action="reload">重新读取</button></div>
</section>
<section class="wd-section" aria-label="备份内容">
<div class="wd-heading"><h4>备份内容</h4><span class="wd-caption" data-view="selectionCount">等待读取</span></div>
<div class="wd-categories"></div>
<div class="wd-buttons wd-select-tools"><button type="button" class="menu_button" data-action="defaults">默认分类</button><button type="button" class="menu_button" data-action="all">全选（含密钥）</button></div>
<small class="wd-hint" data-view="databaseWarning" hidden>数据库模式：导出可能包含未勾选分类的数据及 API 密钥。</small>
<details class="wd-notes"><summary>备份范围说明</summary><small class="wd-hint">全选仅覆盖 Luker 原生支持的分类，不包含服务端插件、APK 或整套运行环境；独立 Skills/CardApp 等是否覆盖取决于宿主版本。数据库导出可能包含分类之外的数据及机密，即使未勾选 API 密钥。</small></details>
</section>
<div><button type="button" class="menu_button wd-primary" data-action="backup"><i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i>备份到 WebDAV</button>
<small class="wd-hint">先结束生成和编辑。上传前会确认目标及分类；ZIP 未加密，请使用私有目录。</small></div>
<p class="wd-message" data-view="message" role="status">准备就绪</p>
<section class="wd-section" aria-label="最近任务">
<div class="wd-heading"><h4>最近任务</h4><button type="button" class="menu_button" data-action="status" aria-label="刷新任务状态">刷新状态</button></div>
<div class="wd-status-line" role="status"><span class="wd-badge" data-view="phase">尚未查询</span><span class="wd-caption" data-view="bytes"></span></div>
<p class="wd-verification" data-view="verification" role="status" hidden></p>
<details class="wd-notes"><summary>任务详情</summary><dl class="wd-metadata" data-view="metadata"></dl></details>
<small class="wd-hint">运行时自动刷新。关闭面板不影响任务，请保持 Luker 后端运行。</small>
</section>
<details class="wd-notes"><summary>关于此扩展 · 0.2.1</summary><small class="wd-hint">直接在后端生成备份流并上传，不创建本地 ZIP。兼容 0.2.0 后端。本扩展不提供恢复或删除备份操作；上传完成不代表内容与恢复已验证。</small></details>
</div></div></div>`;
  target.append(panel);
  const $ = selector => panel.querySelector(selector);
  const field = name => $('[data-field="' + name + '"]');
  const message = (value, tone = 'info') => {
    const el = $('[data-view="message"]'); el.textContent = value; el.dataset.tone = tone;
  };
  const header = $('.inline-drawer-header');
  const isOpen = () => $('.inline-drawer-icon').classList.contains('up');
  let loaded = false, loading = false, dirty = false, running = false, checking = false, timer;
  function updateSelectionCount() {
    const inputs = [...panel.querySelectorAll('[data-category]')];
    $('[data-view="selectionCount"]').textContent = '已选 ' + inputs.filter(el => el.checked).length + ' / ' + inputs.length;
  }
  const defaults = {settings:true,secrets:false,characters:true,chats:true,lorebooks:true,presets:true,assets:true,extensions:true,globalExtensions:false,vectors:false};
  const getSelection = () => Object.fromEntries([...panel.querySelectorAll('[data-category]')].map(el => [el.dataset.category,el.checked]));
  const setSelection = values => panel.querySelectorAll('[data-category]').forEach(el => { el.checked = !!values[el.dataset.category]; });
  function formatStatus(s) {
    const names = {idle:'空闲',uploading:'打包并上传中',renaming:'远端改名中',verifying:'检查远端文件',uploaded:'上传完成',failed:'失败',interrupted:'已中断'};
    const tone = ['uploading','renaming','verifying'].includes(s.phase) ? 'active' : ['failed','interrupted'].includes(s.phase) ? 'error' : s.verification?.includes('警告') ? 'warning' : 'info';
    const phase = $('[data-view="phase"]'); phase.textContent = names[s.phase] || s.phase || '尚未查询'; phase.dataset.tone = tone;
    $('[data-view="bytes"]').textContent = s.bytes != null ? '已发送 ' + (s.bytes / 1048576).toFixed(2) + ' MiB' : '';
    if (s.phase === 'uploaded' && tone === 'warning') phase.textContent = '上传完成 · 校验异常';
    const verification = $('[data-view="verification"]'); verification.textContent = [s.verification, s.error, s.note, s.warning].filter(Boolean).join('\n'); verification.hidden = !verification.textContent; verification.dataset.tone = s.verification?.includes('警告') ? 'warning' : tone;
    const values = [['后端版本', s.version], ['已发送', s.bytes != null ? s.bytes + ' 字节（不是总进度）' : null], ['远端大小', s.remoteBytes != null ? s.remoteBytes + ' 字节' : null], ['文件', s.name], ['目标', s.destination], ['开始', s.started && new Date(s.started).toLocaleString()], ['结束', s.finished && new Date(s.finished).toLocaleString()]];
    $('[data-view="metadata"]').replaceChildren(...values.filter(([,value]) => value).flatMap(([key,value]) => { const dt = document.createElement('dt'); dt.textContent = key; const dd = document.createElement('dd'); dd.textContent = value; return [dt,dd]; }));
  }
  function schedule() {
    clearTimeout(timer);
    if (running && isOpen() && !document.hidden) timer = setTimeout(() => refreshStatus().catch(e => message(e.message, 'error')), 2500);
  }
  async function refreshStatus() {
    if (checking) return;
    checking = true;
    try { const s = await api('/status'); running = !!s.busy; formatStatus(s); }
    finally { checking = false; schedule(); }
  }
  async function load() {
    if (loading) return;
    loading = true;
    try {
    const c = await api('/config');
    if (!c.categories) throw new Error('后端仍为旧版，请更新服务端插件并重启 Luker，再点重新读取配置');
    field('url').value = c.url || ''; field('username').value = c.username || ''; field('password').value = '';
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
  panel.addEventListener('change', () => { dirty = true; updateSelectionCount(); });
  async function confirmUpload(text) {
    const context = ctx();
    if (context.callGenericPopup && context.POPUP_TYPE) {
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
      if (action === 'reload') {
        if (dirty && !globalThis.confirm('放弃未保存的表单修改，重新读取后端配置？')) return;
        await load(); return;
      }
      if (action === 'status') { await refreshStatus(); return; }
      if (!loaded) throw new Error('请先点击重新读取配置，确认后端连接成功');
      if (action === 'all' || action === 'defaults') {
        setSelection(action === 'all' ? Object.fromEntries(Object.keys(getSelection()).map(k => [k,true])) : defaults); updateSelectionCount(); dirty = true; message('分类已修改，请保存配置'); return;
      }
      if (action === 'save') {
        const r = await api('/config',{url:field('url').value,username:field('username').value,password:field('password').value,selection:getSelection()});
        field('password').value = ''; dirty = false; message(r.note || '已保存'); return;
      }
      if (dirty) throw new Error('表单有未保存修改，请先保存配置');
      if (action === 'test') { message('正在测试目录访问…'); const r = await api('/test',{}); message(r.note); return; }
      if (action === 'backup') {
        const c = await api('/config'), chosen = c.selection;
        const names = Object.keys(chosen).filter(k => chosen[k]).map(k => c.categories[k]);
        const text = '确认将当前用户数据上传到：\n' + c.url + '\n\n分类：' + names.join('、') + '\n\n' + (c.storageEngine !== 'fs' ? '数据库模式：导出可能含其他分类与机密。\n' : '') + '请确认已结束生成与编辑。此操作仅新增远端备份，不恢复或覆盖当前聊天。';
        if (!await confirmUpload(text)) return;
        await api('/backup',{selection:chosen}); message('备份任务已启动'); await refreshStatus();
      }
    } catch (e) { message(e.message, 'error'); }
    finally { button.disabled = false; }
  });
  // Luker owns drawer clicks/animation. Observe its icon instead of toggling twice.
  new MutationObserver(() => {
    header.setAttribute('aria-expanded', String(isOpen()));
    if (!isOpen()) { clearTimeout(timer); return; }
    (loaded ? refreshStatus() : load()).catch(e => message(e.message, 'error'));
  }).observe($('.inline-drawer-icon'), {attributes:true, attributeFilter:['class']});
  header.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); header.click(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else if (isOpen()) (loaded ? refreshStatus() : load()).catch(e => message(e.message, 'error'));
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
else mount();
try { const c = ctx(); c.eventSource.on(c.eventTypes.APP_READY, mount); } catch {}
