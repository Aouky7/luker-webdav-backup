// WebDAV snapshot staging + native Luker restore. Never extracts archives itself.
const USER_ROOT = '/api/users';
const PLUGIN_ROOT = '/api/plugins/webdav-backup';
const CATEGORY_KEYS = ['settings','secrets','characters','chats','lorebooks','presets','assets','extensions','globalExtensions','vectors'];
const CHUNK_BYTES = 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const bytesText = value => (value / 1048576).toFixed(2) + ' MiB';

export function mountRestore({panel,container,api,confirm,notify,getBusy = () => false,getDirty = () => false,onLock = () => {},openNative = async () => { const module = await import('/scripts/data-window.js'); await module.openDataWindow({tab:'restore'}); },fetchImpl = globalThis.fetch}) {
  if (!container || !panel.contains(container)) throw Error('恢复模块缺少挂载位置');
  const section = panel.ownerDocument.createElement('details');
  section.className = 'wd-restore wd-about';
  section.innerHTML = '<summary>恢复快照 <span class="wd-caption" data-restore="summary">选择一个云端快照</span></summary><div class="wd-restore-body"><p class="wd-hint" data-restore="file">在快照详情中选择“恢复此快照”。</p><p class="wd-message" role="status" data-restore="status">仅支持文件存储模式；恢复会修改当前用户的数据。</p><p class="wd-hint">准备时会把 ZIP 分片暂存到 Luker 后端，通常需要约两倍 ZIP 大小的可用磁盘空间。先停止聊天生成与编辑，建议先备份当前数据。只选择可信快照，恢复扩展可能安装可执行代码。</p><div class="wd-buttons"><button type="button" class="menu_button" data-restore-action="native">打开宿主恢复</button><button type="button" class="menu_button" data-restore-action="prepare" disabled>下载并检查快照</button><button type="button" class="menu_button" data-restore-action="cancel" disabled>取消准备</button></div><fieldset class="wd-restore-options" disabled><legend>选择恢复内容</legend><div class="wd-categories" data-restore="categories"></div><label class="wd-field">恢复方式<select data-restore="mode"><option value="merge">合并：保留其他内容，同名文件可能覆盖</option><option value="overwrite">覆盖：清空所选分类后恢复</option></select></label><p class="wd-risk" data-restore="modeWarning">合并也可能覆盖同名文件；恢复范围与可恢复性由 Luker 校验。</p><label class="wd-restore-ack"><input type="checkbox" data-restore="ack">我已停止生成和编辑，并理解所选数据可能被覆盖。</label><button type="button" class="menu_button wd-primary" data-restore-action="apply" disabled>确认恢复所选内容</button></fieldset></div>';
  container.append(section);
  const $ = name => section.querySelector('[data-restore="' + name + '"]');
  const button = name => section.querySelector('[data-restore-action="' + name + '"]');
  let config = null, file = null, session = null, uploadId = null, user = null;
  let stage = 'idle', busy = false, externalPending = false, controller = null, selectionRevision = 0;
  const say = (text,tone = 'info') => { $('status').textContent = text; $('status').dataset.tone = tone; };
  const lock = value => onLock(value);
  const ask = async text => { try { return await confirm(text) === true; } catch { say('无法取得确认，操作未执行。','warning'); return false; } };
  const supported = () => config?.capabilities?.cloudRestore === true && config?.storageEngine === 'fs';
  const selected = () => Object.fromEntries(CATEGORY_KEYS.map(key => [key,!!section.querySelector('[data-restore-category="' + key + '"]')?.checked && (key !== 'globalExtensions' || user?.admin === true)]));
  function paint() {
    const ready = stage === 'staged';
    section.querySelector('fieldset').disabled = !ready || busy;
    button('prepare').disabled = !file || !supported() || busy || !!session || externalPending || ['completed','uncertain'].includes(stage);
    button('cancel').disabled = (!busy && !session) || ['restoring','uncertain','completed'].includes(stage);
    button('apply').disabled = !ready || busy || !$('ack').checked || !Object.values(selected()).some(Boolean);
    $('summary').textContent = ({idle:file ? '待准备' : '选择一个云端快照',preparing:'准备中',downloading:'下载中',staged:'等待选择与确认',restoring:'恢复中',completed:'恢复已结束',failed:'准备未完成',uncertain:'结果待核实'})[stage];
  }
  async function csrf(signal) {
    const response = await fetchImpl('/csrf-token',{cache:'no-store',credentials:'same-origin',signal,redirect:'error'});
    if (!response.ok) throw Error('无法取得登录令牌，请重新登录后再操作。');
    const result = await response.json();
    if (typeof result.token !== 'string' || !result.token) throw Error('登录令牌无效。');
    return result.token;
  }
  async function native(route,data,{method = 'POST',binary = false,signal,timeout = 120000,onDispatch = () => {}} = {}) {
    const control = new AbortController(), timer = setTimeout(() => control.abort(),timeout);
    const abort = () => control.abort();
    if (signal?.aborted) control.abort();
    else signal?.addEventListener('abort',abort,{once:true});
    const combined = control.signal;
    try {
      const token = await csrf(combined);
      onDispatch();
      const response = await fetchImpl(USER_ROOT + route,{method,cache:'no-store',credentials:'same-origin',redirect:'error',signal:combined,headers:{'x-csrf-token':token,'Content-Type':binary ? 'application/octet-stream' : 'application/json','Accept':'application/json'},...(method === 'GET' || method === 'DELETE' ? {} : {body:binary ? data : JSON.stringify(data)})});
      if (method === 'DELETE' && response.status === 404) return null;
      if (!response.ok) throw Error(response.status === 404 || response.status === 405 ? '当前 Luker 不支持此恢复接口，请更新宿主或使用原生恢复入口。' : 'Luker 恢复接口 HTTP ' + response.status + '，请在宿主中核实。');
      if (response.status === 204) return null;
      const text = await response.text();
      if (text.length > 1048576) throw Error('宿主响应超过限制，结果需核实。');
      return JSON.parse(text);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
  }
  async function cleanup({confirmed = false} = {}) {
    let clean = true;
    if (uploadId && !confirmed) {
      try { await native('/restore-backup/uploads/' + encodeURIComponent(uploadId),undefined,{method:'DELETE'}); uploadId = null; }
      catch { clean = false; }
    }
    if (session) {
      try { await api('/restore/release',{token:session.token,confirmed:true}); session = null; }
      catch { clean = false; }
    }
    lock(!!session || !clean); return clean;
  }
  async function stageArchive() {
    if (busy || session || externalPending || !file || !supported()) return;
    if (getBusy() || getDirty()) { say('请先完成当前操作并保存配置。','warning'); return; }
    const chosenFile = file;
    if (!await ask('准备云端快照：\n' + chosenFile.name + '\n\n此步骤只下载并暂存到 Luker 后端，不恢复现有数据。需要临时磁盘空间；之后还需选择分类并确认恢复。是否开始准备？')) return;
    if (busy || session || file !== chosenFile || getBusy() || getDirty()) return;
    busy = true; stage = 'preparing'; lock(true); controller = new AbortController(); paint();
    try {
      user = await native('/me',undefined,{method:'GET',signal:controller.signal});
      if (typeof user?.handle !== 'string' || !user.handle || user.admin !== true) throw Error('恢复仅对当前已登录的管理员用户开放。');
      session = await api('/restore/prepare',{name:file.name});
      if (!validId(session?.token) || session.name !== file.name || !Number.isSafeInteger(session.bytes) || session.bytes <= 0 || session.bytes > MAX_BYTES) throw Error('快照准备响应无效，请核实后端状态。');
      controller.signal.throwIfAborted();
      const created = await native('/restore-backup/uploads',{handle:user.handle,fileName:file.name,size:session.bytes},{signal:controller.signal});
      if (typeof created?.uploadId !== 'string' || !/^[0-9a-f]{32}$/.test(created.uploadId)) throw Error('宿主未返回有效的临时上传身份。');
      uploadId = created.uploadId;
      const token = await csrf(controller.signal);
      const source = await fetchImpl(PLUGIN_ROOT + '/restore/source',{method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':token},body:JSON.stringify({token:session.token}),credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
      if (!source.ok || !source.body?.getReader) throw Error('无法下载所选快照；请确认文件仍存在且后端已更新。');
      stage = 'downloading'; paint();
      const reader = source.body.getReader();
      let offset = 0, used = 0, buffer = new Uint8Array(CHUNK_BYTES), signature = [];
      const flush = async () => {
        if (!used) return;
        const chunk = buffer.slice(0,used);
        const result = await native('/restore-backup/uploads/' + encodeURIComponent(uploadId) + '/chunks/' + offset,chunk,{method:'PUT',binary:true,signal:controller.signal});
        if (result?.ok !== true || result.offset !== offset || result.bytes !== used) throw Error('宿主未确认分片写入，已停止；不会自动重传。');
        offset += used; used = 0;
        say('已暂存 ' + bytesText(offset) + ' / ' + bytesText(session.bytes) + '；尚未恢复数据。');
      };
      try {
        for (;;) {
          const {done,value} = await reader.read(); if (done) break;
          if (!(value instanceof Uint8Array) || offset + used + value.byteLength > session.bytes) throw Error('下载大小与快照记录不符，已停止。');
          let consumed = 0;
          while (consumed < value.length) {
            if (signature.length < 4) {
              signature.push(...value.subarray(consumed,Math.min(value.length,consumed + 4 - signature.length)));
              if (signature.length === 4 && !(signature[0] === 80 && signature[1] === 75 && [[3,4],[5,6],[7,8]].some(pair => pair[0] === signature[2] && pair[1] === signature[3]))) throw Error('下载内容不是可识别的 ZIP 文件。');
            }
            const count = Math.min(value.length - consumed,buffer.length - used);
            buffer.set(value.subarray(consumed,consumed + count),used); used += count; consumed += count;
            if (used === buffer.length) await flush();
          }
        }
        if (offset + used !== session.bytes || signature.length < 4) throw Error('快照下载不完整，已停止。');
        await flush();
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const finalized = await native('/restore-backup/uploads/' + encodeURIComponent(uploadId) + '/finalize',{}, {signal:controller.signal,timeout:600000});
      if (finalized?.size !== session.bytes) throw Error('宿主组装后的大小不符。');
      const probe = await native('/restore-backup/probe',{uploadId},{signal:controller.signal});
      if (probe?.engineKind !== 'fs' || probe.crossModeRequired !== false || probe.scratchCredsNeeded) throw Error('此快照属于数据库或跨存储恢复，本模块不会执行。请从云盘取得 ZIP 后使用 Luker 原生恢复入口。');
      stage = 'staged';
      say('ZIP 已暂存并完成存储模式检查。请选择恢复分类；宿主将在执行时继续校验归档内容。');
    } catch (error) {
      const cancelled = controller?.signal.aborted;
      const clean = await cleanup();
      stage = clean ? 'failed' : 'uncertain';
      say((cancelled ? '已取消准备。' : String(error?.message || '快照准备失败。')) + (clean ? ' 未执行数据恢复。' : ' 清理或锁状态未确认，请在宿主中核实，勿重复操作。'),'warning');
    } finally { busy = false; controller = null; paint(); }
  }
  async function apply() {
    if (busy || stage !== 'staged' || !session || !uploadId || !$('ack').checked) return;
    const choice = selected(), names = CATEGORY_KEYS.filter(key => choice[key]).map(key => config.categories[key] || key);
    if (!names.length || getBusy() || getDirty()) { say('请至少选择一个分类，并先完成其他操作或保存配置。','warning'); return; }
    const revision = selectionRevision;
    const mode = $('mode').value === 'overwrite' ? 'overwrite' : 'merge';
    const warning = mode === 'overwrite' ? '覆盖模式会先清空所选分类，归档中没有的现有内容也可能被删除。' : '合并模式保留其他内容，但同名文件仍可能被覆盖。';
    if (!await ask('确认恢复到当前用户：' + user.handle + '\n快照：' + file.name + '\n分类：' + names.join('、') + '\n\n' + warning + '\n前端扩展可能包含可执行代码；仅恢复可信来源。恢复不是跨所有分类的原子事务，失败后需核实。请确认已停止生成和编辑。是否执行恢复？')) return;
    if (busy || stage !== 'staged' || getBusy() || getDirty()) return;
    if (revision !== selectionRevision) { say('恢复选项已变化，请按当前选择重新确认。','warning'); return; }
    busy = true; stage = 'restoring'; paint(); say('Luker 正在恢复数据，请保持页面和后端运行，不要重复提交。');
    let dispatched = false, result;
    try {
      const current = await native('/me',undefined,{method:'GET'});
      if (current?.handle !== user.handle || current?.admin !== true) throw Error('当前登录身份已变化，已停止。');
      await api('/restore/commit',{token:session.token});
      result = await native('/restore-backup',{uploadId,handle:user.handle,selection:choice,mode},{timeout:1800000,onDispatch:() => { dispatched = true; }});
      if (result?.mode !== mode || !['restoredCount','failedCount','skippedCount','rejectedCount'].every(key => Number.isSafeInteger(result?.[key]) && result[key] >= 0)) throw Error('宿主未返回可确认的恢复结果。');
      uploadId = null;
      const clean = await cleanup({confirmed:true});
      stage = 'completed';
      const warnings = result.failedCount || result.skippedCount || result.rejectedCount || result.restoredCount === 0;
      const text = '宿主已结束恢复：成功 ' + result.restoredCount + ' 项，失败 ' + result.failedCount + ' 项，跳过 ' + result.skippedCount + ' 项，拒绝 ' + result.rejectedCount + ' 项。请核对数据后重新加载页面。' + (clean ? '' : ' 插件锁释放未确认，请在宿主中核实。');
      say(text,warnings || !clean ? 'warning' : 'info'); notify(text,warnings || !clean ? 'warning' : 'success','快照恢复结果');
    } catch (error) {
      if (dispatched) {
        stage = 'uncertain'; lock(true);
        say('恢复请求已发送，但未取得可确认的完成结果。可能已有数据改变；请在 Luker 中核实。不会自动重试，也不会自动清理正在使用的归档。','warning');
      } else {
        const clean = await cleanup(); stage = clean ? 'failed' : 'uncertain';
        say(String(error?.message || '恢复未开始。') + (clean ? ' 未发送原生恢复请求。' : ' 锁状态需核实。'),'warning');
      }
    } finally { busy = false; paint(); }
  }
  section.addEventListener('change',() => {
    selectionRevision++;
    $('modeWarning').textContent = $('mode').value === 'overwrite' ? '覆盖会先清空所选分类；归档未包含的现有内容也可能被删除。' : '合并也可能覆盖同名文件；恢复范围与可恢复性由 Luker 校验。'; paint();
  });
  section.addEventListener('click',event => {
    const action = event.target.closest('[data-restore-action]')?.dataset.restoreAction;
    if (action === 'native') { void openNative().catch(() => say('当前宿主未提供原生恢复窗口，请从 Luker 备份恢复入口打开。','warning')); }
    else if (action === 'prepare') void stageArchive();
    else if (action === 'apply') void apply();
    else if (action === 'cancel') {
      if (busy && stage !== 'restoring') controller?.abort();
      else if (!busy && session && !['restoring','uncertain','completed'].includes(stage)) {
        busy = true; paint();
        void cleanup().then(clean => { stage = clean ? 'idle' : 'uncertain'; say(clean ? '已取消准备，临时归档清理请求已确认；未执行数据恢复。' : '清理未确认，请在宿主中核实。',clean ? 'info' : 'warning'); }).finally(() => { busy = false; paint(); });
      }
    }
  });
  return {
    setConfig(value) {
      config = value;
      externalPending = !!value?.restorePending && !session;
      if (externalPending) { section.open = true; lock(true); say('后端有恢复准备或执行状态待核实。请在原页面或 Luker 中核实，勿重复恢复。','warning'); }
      const categories = $('categories');
      if (!session && !busy) {
        categories.replaceChildren(...CATEGORY_KEYS.map(key => {
          const label = panel.ownerDocument.createElement('label'), input = panel.ownerDocument.createElement('input');
          input.type = 'checkbox'; input.dataset.restoreCategory = key;
          label.append(input,panel.ownerDocument.createTextNode(value?.categories?.[key] || key)); return label;
        }));
      }
      if (!supported() && !externalPending) say(value?.storageEngine && value.storageEngine !== 'fs' ? '当前使用数据库存储，请使用 Luker 原生恢复入口。' : '云端恢复需要新版前后端及支持分片恢复的 Luker。','warning');
      paint();
    },
    open(value) {
      section.open = true; section.scrollIntoView?.({block:'nearest',behavior:'auto'});
      if (session || busy || ['uncertain','completed'].includes(stage)) { say('请先完成或取消当前恢复准备；结果待核实时不能重试。','warning'); return; }
      file = value && typeof value.name === 'string' ? {name:value.name} : null;
      $('file').textContent = file ? file.name : '请选择云端快照。';
      if (supported() && !externalPending) say('准备只会下载并暂存 ZIP；完成后还需选择分类并确认恢复。');
      selectionRevision++; $('ack').checked = false; $('mode').value = 'merge';
      section.querySelectorAll('[data-restore-category]').forEach(input => { input.checked = false; });
      stage = 'idle'; paint();
    },
    getState:() => ({stage,busy,pending:!!session || externalPending}),
  };
}
