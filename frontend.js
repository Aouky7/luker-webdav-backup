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
  panel.innerHTML = `<style>
#luker-webdav-panel{margin:10px 0;color:var(--SmartThemeBodyColor,inherit)}
#luker-webdav-panel summary{cursor:pointer;font-weight:bold;padding:12px 4px}
#luker-webdav-panel .wd-body{padding:8px;display:flex;flex-direction:column;gap:10px}
#luker-webdav-panel label.wd-field{display:flex;flex-direction:column;gap:5px}
#luker-webdav-panel input.text_pole{width:100%;box-sizing:border-box}
#luker-webdav-panel .wd-buttons{display:flex;flex-wrap:wrap;gap:8px}
#luker-webdav-panel button{min-height:40px;margin:0;white-space:normal}
#luker-webdav-panel .wd-categories{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px}
#luker-webdav-panel .wd-categories label{display:flex;align-items:center;gap:6px}
#luker-webdav-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:.9em;padding:10px;border:1px solid var(--SmartThemeBorderColor,#888);border-radius:8px;max-height:350px;overflow:auto}
#luker-webdav-panel small{line-height:1.6;opacity:.85}
</style><details><summary>☁ WebDAV 备份</summary><div class="wd-body">
<small>直接在手机后端生成备份流并上传，不创建本地 ZIP。前端 0.2.0，需要同版本服务端插件。</small>
<label class="wd-field">HTTPS WebDAV 目录<input class="text_pole" data-field="url" type="url" placeholder="https://dav.jianguoyun.com/dav/LukerBackup/"></label>
<label class="wd-field">用户名<input class="text_pole" data-field="username" autocomplete="off"></label>
<label class="wd-field">应用密码<input class="text_pole" data-field="password" type="password" autocomplete="new-password" placeholder="留空保留已保存的密码"></label>
<small data-view="configState">等待连接后端…</small>
<div class="wd-categories"></div>
<small>全选仅覆盖 Luker 原生支持的分类，不包含服务端插件、APK 或整套运行环境；独立 Skills/CardApp 等是否覆盖仍取决于宿主版本。数据库导出可能包含分类之外的数据及机密，即使未勾选 API 密钥。</small>
<div class="wd-buttons"><button class="menu_button" data-action="all">全选分类（含密钥）</button><button class="menu_button" data-action="defaults">默认分类</button></div>
<div class="wd-buttons"><button class="menu_button" data-action="save">保存配置</button><button class="menu_button" data-action="test">测试目录访问</button><button class="menu_button" data-action="reload">重新读取配置</button></div>
<button class="menu_button" data-action="backup">备份到 WebDAV…</button>
<small>先结束生成和编辑；上传前会确认保存的目标及分类。ZIP 未加密，请使用私有目录。</small>
<pre data-view="message" role="status">准备就绪</pre>
<div class="wd-buttons"><button class="menu_button" data-action="status">刷新任务状态</button></div>
<pre data-view="status" aria-live="polite">尚未查询</pre>
<small>任务运行时自动刷新。关闭面板不会取消后端任务；安卓结束 Luker 后端会中断任务。本扩展不提供恢复或删除备份操作。</small>
</div></details>`;
  target.append(panel);
  const $ = selector => panel.querySelector(selector);
  const field = name => $('[data-field="' + name + '"]');
  const message = value => { $('[data-view="message"]').textContent = value; };
  let loaded = false, dirty = false, running = false, checking = false, timer;
  const defaults = {settings:true,secrets:false,characters:true,chats:true,lorebooks:true,presets:true,assets:true,extensions:true,globalExtensions:false,vectors:false};
  const getSelection = () => Object.fromEntries([...panel.querySelectorAll('[data-category]')].map(el => [el.dataset.category,el.checked]));
  const setSelection = values => panel.querySelectorAll('[data-category]').forEach(el => { el.checked = !!values[el.dataset.category]; });
  function formatStatus(s) {
    const names = {idle:'空闲',uploading:'打包并上传中',renaming:'远端改名中',verifying:'检查远端文件',uploaded:'上传成功',failed:'失败',interrupted:'已中断'};
    return ['后端版本：' + (s.version || '未知'), '状态：' + (names[s.phase] || s.phase), s.bytes != null ? '已发送：' + (s.bytes / 1048576).toFixed(2) + ' MiB（不是总进度）' : '', s.name ? '文件：' + s.name : '', s.destination ? '目标：' + s.destination : '', s.started ? '开始：' + new Date(s.started).toLocaleString() : '', s.finished ? '结束：' + new Date(s.finished).toLocaleString() : '', s.verification || '', s.error || '', s.note || '', s.warning || ''].filter(Boolean).join('\n');
  }
  function schedule() {
    clearTimeout(timer);
    if (running && $('details').open && !document.hidden) timer = setTimeout(() => refreshStatus().catch(e => message(e.message)), 2500);
  }
  async function refreshStatus() {
    if (checking) return;
    checking = true;
    try { const s = await api('/status'); running = !!s.busy; $('[data-view="status"]').textContent = formatStatus(s); }
    finally { checking = false; schedule(); }
  }
  async function load() {
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
    loaded = true; dirty = false; message('配置已读取'); await refreshStatus();
  }
  panel.addEventListener('input', () => { dirty = true; });
  panel.addEventListener('change', () => { dirty = true; });
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
        setSelection(action === 'all' ? Object.fromEntries(Object.keys(getSelection()).map(k => [k,true])) : defaults); dirty = true; message('分类已修改，请保存配置'); return;
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
    } catch (e) { message(e.message); }
    finally { button.disabled = false; }
  });
  $('details').addEventListener('toggle', () => {
    if (!$('details').open) { clearTimeout(timer); return; }
    (loaded ? refreshStatus() : load()).catch(e => message(e.message));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else if ($('details').open) refreshStatus().catch(e => message(e.message));
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
else mount();
try { const c = ctx(); c.eventSource.on(c.eventTypes.APP_READY, mount); } catch {}
