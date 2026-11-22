/**
 * dsh-subagent-panel — 子智能体面板（DeepSeek Harness Web UI 插件）
 *
 * 形态：右侧栏标签页，入口是右侧栏「+」引导页里的「子智能体」卡片。
 *  - 标签类型：`ctx.sidebarRightTabs.register`（kind `subagentpanel`），
 *    既识别资源地址 `dsh-resource://subagentpanel/session/<rootId>`，
 *    也识别引导页的页面地址 `sidebar://subagentpanel`。
 *  - 标签本体：`sidebar.right.pane.tab`（keyed 座位，key = 实现 id）。
 *  - 资源协议 `subagentpanel`：地址 → 根会话 id；页面地址则由 body 的
 *    session 作用域（`sessionId`）兜底。
 *  - 不再占用会话标题栏（`conversation.session.header.actions`）。
 *
 * 功能
 *  - 子智能体树：运行状态、token、活跃耗时；运行中每秒推进时钟。
 *  - 状态四色区分：运行中（品牌色弧线动画）/ 正常完成（绿）/ 未正常结束（红）/ 未运行（空心灰）。
 *  - 详情抽屉：创建时间、用量、最近消息预览；运行中自动跟随最新消息（user 上滚则停跟，
 *    出现「跳到最新」）。
 *  - 清除：把子智能体从**本面板**隐藏（按会话持久化到 localStorage），可单个清除、
 *    一键清除已结束、全部恢复。会话日志与子会话本身不受影响。
 *  - 停止：运行中的子智能体可请求中断（`ctx.remote.subagents.interruptByUser`，
 *    通过 `ctx.get('remote.subagents')` 取得——命名空间是独立的服务键）。
 *
 * 约束
 *  - 静态 bundle 的客户端工厂只拿到 `require`，不 require 任何 @deepseek-ai 包。
 *  - `styles.insert` 属于动态插件通道，样式由本插件自建 <style> 注入。
 *  - 只用 --dsw-alias-* / --dsw-radius-* / --dsw-elevation-* 主题 token（带字面量兜底）。
 *  - 卸载时只关闭本 kind 的标签页。
 */

window.__ModuleLoader__.load({
  id: 'dsh-subagent-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'subagent-panel';
    const TAB_ID = 'dsh-subagent-panel';
    const TAB_KIND = 'subagentpanel';
    const PROTOCOL = 'subagentpanel';
    const ADDRESS_PREFIX = 'dsh-resource://' + PROTOCOL + '/session/';
    const PAGE_ADDRESS = 'sidebar://' + TAB_KIND;
    const RETAIN_SOURCE = 'subagentPanel';
    const TRANSCRIPT_LIMIT = 8;
    /** 清除（隐藏）集合的持久化键。 */
    const HIDDEN_KEY = 'dsh-subagent-panel.hidden.v1';

    let PLUGIN_CTX = null;

    /* ------------------------------------------------------------------ */
    /* 地址                                                                */
    /* ------------------------------------------------------------------ */

    /** 解析 `dsh-resource://subagentpanel/session/<rootId>`；不是本协议则返回 undefined。 */
    function parsePanelAddress(address) {
      if (typeof address !== 'string' || address.indexOf(ADDRESS_PREFIX) !== 0) return undefined;
      const rest = address.slice(ADDRESS_PREFIX.length).split('?')[0];
      if (rest === '') return undefined;
      try { return decodeURIComponent(rest) } catch (e) { return undefined; }
    }

    /* ------------------------------------------------------------------ */
    /* 清除（隐藏）集合：按会话持久化                                      */
    /* ------------------------------------------------------------------ */

    const hiddenCache = {};

    function readHiddenAll() {
      try {
        if (typeof localStorage === 'undefined') return {};
        const raw = localStorage.getItem(HIDDEN_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch (e) { return {}; }
    }

    function hiddenOf(sessionId) {
      if (Object.prototype.hasOwnProperty.call(hiddenCache, sessionId)) {
        return hiddenCache[sessionId];
      }
      const all = readHiddenAll();
      const list = Array.isArray(all[sessionId]) ? all[sessionId].filter(function (v) {
        return typeof v === 'string';
      }) : [];
      const set = new Set(list);
      hiddenCache[sessionId] = set;
      return set;
    }

    function persistHidden(sessionId, set) {
      hiddenCache[sessionId] = set;
      try {
        if (typeof localStorage === 'undefined') return;
        const all = readHiddenAll();
        const list = Array.from(set);
        if (list.length === 0) delete all[sessionId];
        else all[sessionId] = list;
        localStorage.setItem(HIDDEN_KEY, JSON.stringify(all));
      } catch (e) { /* 存储不可用时仅本次会话生效 */ }
    }

    /* ------------------------------------------------------------------ */
    /* 入口：自动放入 + 快捷键                                             */
    /* ------------------------------------------------------------------ */

    /** 用户明确关掉过面板的会话；这些会话不再自动放入。 */
    const DISMISSED_KEY = 'dsh-subagent-panel.dismissed.v1';
    /** 本页生命周期内已自动放入过的会话，用来把「我放进去的现在没了」判定为用户主动关闭。 */
    const provisioned = new Set();

    function readDismissed() {
      try {
        if (typeof localStorage === 'undefined') return [];
        const raw = localStorage.getItem(DISMISSED_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(function (v) { return typeof v === 'string'; }) : [];
      } catch (e) { return []; }
    }

    function writeDismissed(list) {
      try {
        if (typeof localStorage === 'undefined') return;
        const unique = Array.from(new Set(list));
        if (unique.length === 0) localStorage.removeItem(DISMISSED_KEY);
        else localStorage.setItem(DISMISSED_KEY, JSON.stringify(unique));
      } catch (e) { /* 降级：仅本次会话记住 */ }
    }

    function markDismissed(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      const list = readDismissed();
      if (list.indexOf(sessionId) >= 0) return;
      list.push(sessionId);
      writeDismissed(list);
    }

    function clearDismissed(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      const list = readDismissed();
      const next = list.filter(function (v) { return v !== sessionId; });
      if (next.length !== list.length) writeDismissed(next);
    }

    function openTabList(sb) {
      try {
        if (!sb || !sb.openTabs || typeof sb.openTabs.getSnapshot !== 'function') return [];
        const list = sb.openTabs.getSnapshot();
        return Array.isArray(list) ? list : [];
      } catch (e) { return []; }
    }

    function currentSessionOf(sb) {
      try {
        if (sb && sb.mounted && typeof sb.mounted.getSnapshot === 'function') {
          const id = sb.mounted.getSnapshot();
          return typeof id === 'string' ? id : undefined;
        }
      } catch (e) { /* 不可用 */ }
      return undefined;
    }

    /** 该会话的根目录里是否已有子智能体（决定值不值得自动放入）。 */
    function sessionHasSubagents(sessionId) {
      const sessions = getPluginService('sessions');
      if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return false;
      let snap;
      try { snap = sessions.list.getSnapshot(); } catch (e) { return false; }
      const proj = snap && snap.projectionsBySession ? snap.projectionsBySession[sessionId] : undefined;
      const entries = proj && proj.values ? proj.values.subagentCatalog : undefined;
      return Array.isArray(entries) && entries.length > 0;
    }

    /**
     * 侧栏为空、且当前会话确有子智能体时，静默把本面板放进侧栏。
     * 只在侧栏已展开、且该会话没有任何其它标签页时动手——不抢焦点、不替换用户在看的标签。
     * 用户关掉之后再也不会自动放入（按会话记在 localStorage）。
     */
    /** 「自动放入」的节流：会话流每来一个事件都会触发一次检查，没必要每次都算。 */
    let lastEnsureAt = 0;

    function ensurePanelTab() {
      const nowMs = Date.now();
      if (nowMs - lastEnsureAt < 1000) return;
      lastEnsureAt = nowMs;
      const sb = getPluginService('sidebarRight');
      if (sb === undefined || typeof sb.openTab !== 'function') return;
      const sessionId = currentSessionOf(sb);
      if (sessionId === undefined) return;
      const open = openTabList(sb);
      if (open.length === 0 && sb.openTabs === undefined) return;
      const forSession = open.filter(function (e) { return e && e.sessionId === sessionId; });
      if (forSession.some(function (e) { return e.kind === TAB_KIND; })) {
        provisioned.add(sessionId);
        return;
      }
      // 我放过、现在没了 => 用户主动关掉，记住别再放。
      if (provisioned.has(sessionId)) {
        provisioned.delete(sessionId);
        markDismissed(sessionId);
        return;
      }
      if (forSession.length > 0) return;
      if (readDismissed().indexOf(sessionId) >= 0) return;
      let expanded = true;
      try {
        if (typeof sb.isExpanded === 'function') expanded = sb.isExpanded();
      } catch (e) { expanded = true; }
      if (!expanded) return;
      if (!sessionHasSubagents(sessionId)) return;
      try {
        sb.openTab(TAB_KIND, {});
        provisioned.add(sessionId);
      } catch (e) {
        console.error('[subagent-panel] auto placement failed:', e);
      }
    }

    /** 手动入口（快捷键 / 引导页）：打开并解除该会话的「别再自动放」标记。 */
    function openPanelForCurrentSession() {
      const sb = getPluginService('sidebarRight');
      if (sb === undefined || typeof sb.openTab !== 'function') return;
      const sessionId = currentSessionOf(sb);
      if (sessionId !== undefined) {
        clearDismissed(sessionId);
        provisioned.add(sessionId);
      }
      try {
        sb.openTab(TAB_KIND, { revealIfOpened: true });
      } catch (e) {
        console.error('[subagent-panel] openTab failed:', e);
      }
    }

    /* ------------------------------------------------------------------ */
    /* 文案                                                                */
    /* ------------------------------------------------------------------ */

    const DICT_ZH = {
      'panel.title': '子智能体',
      'panel.guideDesc': '查看当前会话的子智能体：状态、用量与对话预览',
      'panel.close': '关闭面板',
      'panel.refresh': '刷新',
      'panel.empty': '暂无子智能体',
      'panel.idle': '尚未加载子智能体',
      'panel.loading': '正在加载…',
      'progress.completed': '{count} 已完成',
      'progress.active': '{count} 进行中',
      'progress.failed': '{count} 未正常结束',
      'progress.inactive': '{count} 未运行',
      'progress.external': '{count} 外部任务',
      'mode.external': '外部任务',
      'mode.oneShot': '一次性',
      'mode.continuable': '可继续',
      'mode.unknown': '模式未知',
      'state.running': '正在运行',
      'state.completed': '已完成',
      'state.failed': '未正常结束',
      'state.idle': '未运行',
      'catalog.failed': '无法加载子智能体',
      'action.clear': '清除',
      'action.dismiss': '知道了',
      'action.clearRow': '从面板清除「{label}」',
      'action.clearFinished': '清除已结束',
      'action.clearFailed': '清失败',
      'action.clearFailedHint': '一键清理未正常结束的子代理',
      'action.restoreAll': '全部恢复',
      'action.stop': '停止',
      'hidden.count': '已隐藏 {count}',
      'hidden.note': '清除只影响本面板显示，未删除任何会话',
      'detail.openMain': '在主面板打开',
      'detail.openAside': '在侧栏打开会话',
      'detail.transcript': '对话预览',
      'detail.loading': '正在读取对话…',
      'detail.failed': '无法读取对话内容',
      'detail.externalBody': '外部任务没有本地会话，无法预览对话内容。',
      'detail.more': '更早内容已省略，打开会话可查看完整记录',
      'detail.created': '创建时间',
      'detail.empty': '该子智能体暂无对话内容',
      'detail.streaming': '正在生成…',
      'meta.duration': '活跃 {value}',
      'transcript.jump': '跳到最新',
      'card.loading': '读取中…',
      'card.empty': '暂无内容',
      'card.failed': '对话不可读',
      'card.provider': '供应商',
      'card.model': '模型',
      'role.user': '用户',
      'role.assistant': '子智能体',
      'branch.expand': '展开子级',
      'branch.collapse': '收起子级',
      'tok.k': '{value}K tok',
      'tok.m': '{value}M tok',
      'tok.unit': '{value} tok',
      'dur.s': '{s}秒',
      'dur.min': '{m}分{s}秒',
      'dur.hour': '{h}小时{m}分',
      'dur.day': '{d}天{h}小时',
    };

    const DICT_EN = {
      'panel.title': 'Subagents',
      'panel.guideDesc': 'Inspect this session\'s subagents: state, usage, and a conversation preview',
      'panel.close': 'Close panel',
      'panel.refresh': 'Refresh',
      'panel.empty': 'No subagents',
      'panel.idle': 'Subagents not loaded',
      'panel.loading': 'Loading…',
      'progress.completed': '{count} completed',
      'progress.active': '{count} running',
      'progress.failed': '{count} ended abnormally',
      'progress.inactive': '{count} not running',
      'progress.external': '{count} external',
      'mode.external': 'external task',
      'mode.oneShot': 'one-shot',
      'mode.continuable': 'continuable',
      'mode.unknown': 'unknown mode',
      'state.running': 'running',
      'state.completed': 'completed',
      'state.failed': 'ended abnormally',
      'state.idle': 'not running',
      'catalog.failed': 'Unable to load subagents',
      'action.clear': 'Clear',
      'action.dismiss': 'Dismiss',
      'action.clearRow': 'Clear "{label}" from the panel',
      'action.clearFinished': 'Clear finished',
      'action.clearFailed': 'Clear failed',
      'action.clearFailedHint': 'Clear every subagent that ended abnormally',
      'action.restoreAll': 'Restore all',
      'action.stop': 'Stop',
      'hidden.count': '{count} hidden',
      'hidden.note': 'Clearing only hides rows here; no session is deleted',
      'detail.openMain': 'Open in main view',
      'detail.openAside': 'Open the conversation in the sidebar',
      'detail.transcript': 'Transcript preview',
      'detail.loading': 'Loading conversation…',
      'detail.failed': 'Unable to read the conversation',
      'detail.externalBody': 'External tasks have no local session; nothing to preview.',
      'detail.more': 'Older content omitted; open the session for the full record',
      'detail.created': 'Created',
      'detail.empty': 'No conversation content yet',
      'detail.streaming': 'Generating…',
      'meta.duration': 'active {value}',
      'transcript.jump': 'Jump to latest',
      'card.loading': 'Loading…',
      'card.empty': 'No content yet',
      'card.failed': 'Conversation unavailable',
      'card.provider': 'via',
      'card.model': 'model',
      'role.user': 'User',
      'role.assistant': 'Subagent',
      'branch.expand': 'Expand branch',
      'branch.collapse': 'Collapse branch',
      'tok.k': '{value}K tok',
      'tok.m': '{value}M tok',
      'tok.unit': '{value} tok',
      'dur.s': '{s}s',
      'dur.min': '{m}m {s}s',
      'dur.hour': '{h}h {m}m',
      'dur.day': '{d}d {h}h',
    };

    function makeT(propsT) {
      if (typeof propsT === 'function') return propsT;
      let zhPref = true;
      try {
        const lang = (typeof navigator !== 'undefined' && navigator.language) || '';
        zhPref = String(lang).toLowerCase().indexOf('zh') === 0;
      } catch (e) { zhPref = true; }
      const dict = zhPref ? DICT_ZH : DICT_EN;
      return function t(key, params) {
        let text = dict[key] !== undefined ? dict[key]
          : (DICT_EN[key] !== undefined ? DICT_EN[key] : key);
        if (params) {
          Object.keys(params).forEach(function (k) {
            text = text.split('{' + k + '}').join(String(params[k]));
          });
        }
        return text;
      };
    }

    function localeT(key) {
      const ctx = PLUGIN_CTX;
      if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') {
        try {
          const bound = ctx.locale.bind(NS);
          if (typeof bound === 'function') return bound(key);
        } catch (e) { /* 回退 */ }
      }
      return makeT()(key);
    }

    /* ------------------------------------------------------------------ */
    /* 展示辅助                                                            */
    /* ------------------------------------------------------------------ */

    function tokenTotal(usage) {
      if (usage === undefined || usage === null) return undefined;
      return (usage.uncachedInputTokens || 0) + (usage.outputTokens || 0) +
        (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
    }

    function formatTokens(value, t) {
      if (value === undefined || value === null) return undefined;
      if (value < 1000) return t('tok.unit', { value: value });
      if (value < 999950) return t('tok.k', { value: Math.round(value / 100) / 10 });
      return t('tok.m', { value: Math.round(value / 100000) / 10 });
    }

    function formatDuration(ms, t) {
      const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
      const s = totalSeconds % 60;
      const totalMinutes = Math.floor(totalSeconds / 60);
      if (totalMinutes === 0) return t('dur.s', { s: s });
      const m = totalMinutes % 60;
      const totalHours = Math.floor(totalMinutes / 60);
      if (totalHours === 0) return t('dur.min', { m: totalMinutes, s: String(s).padStart(2, '0') });
      const hours = totalHours % 24;
      const days = Math.floor(totalHours / 24);
      if (days === 0) return t('dur.hour', { h: totalHours, m: String(m).padStart(2, '0') });
      return t('dur.day', { d: days, h: hours });
    }

    function formatCreated(ts) {
      if (typeof ts !== 'number' || !isFinite(ts)) return undefined;
      try {
        const d = new Date(ts);
        const p = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
          ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      } catch (e) { return undefined; }
    }

    function timingMs(timing, activity, now) {
      if (timing === undefined || timing === null) return undefined;
      const settled = typeof timing.settledMs === 'number' && isFinite(timing.settledMs) ? timing.settledMs : 0;
      const active = timing.active;
      if (active === undefined || active === null) return settled;
      if (typeof active.since !== 'number' || !isFinite(active.since)) return settled;
      let end = active.through;
      if (activity === 'running' && typeof now === 'number') end = now;
      if (typeof end !== 'number' || !isFinite(end)) return settled;
      return settled + Math.max(0, end - active.since);
    }

    function projectionValue(listState, id, key) {
      const snapshot = listState.projectionsBySession[id];
      const viaProjection = snapshot && snapshot.values ? snapshot.values[key] : undefined;
      if (viaProjection !== undefined) return viaProjection;
      const row = listState.byId[id];
      return row && row.projectionValues ? row.projectionValues[key] : undefined;
    }

    /**
     * 该子会话实际使用的供应商与模型。
     * 来自子会话自己的 `modelSelection` 投影（`{ lastUsed, pending }`，每项是
     * `{ provider, model, reasoningEffort? }`）：`lastUsed` 是最近一次真正发出去请求
     * 用到的选择，`pending` 是已选但还没发出去的选择，所以优先 lastUsed。
     * 目录条目本身不含模型信息，这里读的是会话投影；读不到就不显示，不猜。
     */
    function selectionOf(listState, id) {
      const projected = projectionValue(listState, id, 'modelSelection');
      if (projected === undefined || projected === null) return undefined;
      const pick = projected.lastUsed || projected.pending;
      if (pick === undefined || pick === null) return undefined;
      if (typeof pick.provider !== 'string' || typeof pick.model !== 'string') return undefined;
      return {
        provider: pick.provider,
        model: pick.model,
        reasoningEffort: typeof pick.reasoningEffort === 'string' ? pick.reasoningEffort : undefined,
      };
    }

    /* ------------------------------------------------------------------ */
    /* 状态模型：running / completed / failed / idle / external            */
    /* ------------------------------------------------------------------ */

    function isRunningChild(listState, statuses, id) {
      if (statuses && typeof statuses.get === 'function') {
        const st = statuses.get(id);
        if (st !== undefined && st !== null) return st.running === true;
      }
      const row = listState.byId[id];
      return row !== undefined && row.running === true;
    }

    /**
     * 只由「是否运行 + 最后一轮是否正常结束」推导，不臆造失败原因：
     * lastTurnCompleted === false 覆盖 aborted / error / blocked / max-tokens。
     */
    function entryState(entry, listState, statuses) {
      if (entry.mode === 'external') return 'external';
      if (isRunningChild(listState, statuses, entry.id)) return 'running';
      const timing = projectionValue(listState, entry.id, 'subagentTiming');
      if (timing !== undefined && timing !== null) {
        if (timing.lastTurnCompleted === true) return 'completed';
        if (timing.lastTurnCompleted === false) return 'failed';
      }
      return 'idle';
    }

    function deriveCatalog(listState, statuses, parentId) {
      const snapshot = listState.projectionsBySession[parentId];
      const projected = snapshot && snapshot.values ? snapshot.values.subagentCatalog : undefined;
      let state = snapshot === undefined ? 'idle' : snapshot.state;
      if (state === 'idle' && projected !== undefined) state = 'ready';
      const entries = (projected === undefined ? [] : projected).map(function (entry) {
        return Object.assign({}, entry, {
          activity: isRunningChild(listState, statuses, entry.id) ? 'running' : 'inactive',
        });
      });
      return {
        state: state,
        error: snapshot === undefined ? null : (snapshot.error || null),
        entries: entries,
      };
    }

    /** 提升计算的最大层数：防止异常数据造成环或过深递归。 */
    const LIFT_MAX_DEPTH = 6;

    /**
     * 过滤掉已清除的卡片，并把它们的下属**上提一层**替换原来的位置。
     * 只清掉外层不该带走整棵子树：被清除的节点让位给它的子级，子级在
     * 当前层级原地出现（缩进也随之少一级），视觉上就是「升了一层」。
     * 被提升的条目带 `lifted` 标记，供渲染层给出提示。
     */
    function liftHiddenLevels(listState, statuses, entries, hiddenSet, depth) {
      const level = typeof depth === 'number' ? depth : 0;
      const out = [];
      entries.forEach(function (entry) {
        if (!hiddenSet.has(entry.id)) { out.push(entry); return; }
        if (level >= LIFT_MAX_DEPTH) return;
        // 该卡片已被清除：把它的子级接到当前层。
        const nested = deriveCatalog(listState, statuses, entry.id);
        if (nested.state !== 'ready' || nested.entries.length === 0) return;
        liftHiddenLevels(listState, statuses, nested.entries, hiddenSet, level + 1)
          .forEach(function (child) {
            out.push(Object.assign({}, child, { lifted: true }));
          });
      });
      return out;
    }

    function progressLabel(entries, listState, statuses, t) {      let completed = 0, active = 0, failed = 0, inactive = 0, external = 0;
      entries.forEach(function (entry) {
        const state = entryState(entry, listState, statuses);
        if (state === 'external') external++;
        else if (state === 'running') active++;
        else if (state === 'completed') completed++;
        else if (state === 'failed') failed++;
        else inactive++;
      });
      const parts = [];
      if (completed > 0) parts.push(t('progress.completed', { count: completed }));
      if (active > 0) parts.push(t('progress.active', { count: active }));
      if (failed > 0) parts.push(t('progress.failed', { count: failed }));
      if (inactive > 0) parts.push(t('progress.inactive', { count: inactive }));
      if (external > 0) parts.push(t('progress.external', { count: external }));
      return parts.join('\u2002·\u2002');
    }

    function canExpand(entry, listState) {
      if (entry.mode === 'external') return false;
      const projection = listState.projectionsBySession[entry.id];
      if (projection === undefined) return false;
      if (projection.state === 'migration-required' || projection.state === 'error') return false;
      const nested = projection.values ? projection.values.subagentCatalog : undefined;
      return nested !== undefined && nested.length > 0;
    }

    function childCatalogFailed(entry, listState) {
      if (entry.mode === 'external') return false;
      const projection = listState.projectionsBySession[entry.id];
      return projection !== undefined && projection.state === 'error';
    }

    /**
     * 可见层级中是否还有运行中的子代理（决定是否启动秒级时钟）。
     * 已从面板清除的行不计入，否则隐藏一个运行中的子级会让面板永远每秒重渲染。
     */
    /**
     * 一次遍历同时回答三个问题：有没有在跑的、有没有刚完成的、有没有失败的。
     * 之前这三个问题各走一遍整棵树，每次渲染就是三次全树扫描；合并成一次。
     * 默认全展开，所以沿两条边下探：未折叠的分支、被清除但子级被上提的分支。
     */
    function scanTree(listState, statuses, rootId, collapsed, hidden, now) {
      const hiddenSet = hidden || new Set();
      const collapsedSet = collapsed || new Set();
      const result = { running: false, flashing: false, failed: false };
      const seen = new Set();
      const queue = [rootId];
      while (queue.length > 0 && seen.size < 200) {
        const id = queue.shift();
        if (typeof id !== 'string' || seen.has(id)) continue;
        seen.add(id);
        const catalog = deriveCatalog(listState, statuses, id);
        for (let i = 0; i < catalog.entries.length; i++) {
          const entry = catalog.entries[i];
          if (hiddenSet.has(entry.id)) { queue.push(entry.id); continue; }
          const state = entryState(entry, listState, statuses);
          if (state === 'running') result.running = true;
          else if (state === 'failed') result.failed = true;
          else if (isFreshlyCompleted(entry, listState, statuses, now)) result.flashing = true;
          if (!collapsedSet.has(entry.id)) queue.push(entry.id);
        }
      }
      return result;
    }

    /**
     * 已加载、且在树里可达的所有层级（根 + 未被折叠的分支 + 被清除分支的子级）。
     * 供「刷新全部」与「清除已结束」使用；有上限，避免异常数据下的爆炸。
     */
    function collectLevelIds(listState, statuses, rootId, collapsed, hidden) {
      const hiddenSet = hidden || new Set();
      const collapsedSet = collapsed || new Set();
      const out = [];
      const seen = new Set();
      const queue = [rootId];
      while (queue.length > 0 && seen.size < 200) {
        const id = queue.shift();
        if (typeof id !== 'string' || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        const catalog = deriveCatalog(listState, statuses, id);
        for (let i = 0; i < catalog.entries.length; i++) {
          const entry = catalog.entries[i];
          if (hiddenSet.has(entry.id)) { queue.push(entry.id); continue; }
          if (!collapsedSet.has(entry.id)) queue.push(entry.id);
        }
      }
      return out;
    }

    /* ------------------------------------------------------------------ */
    /* 排序与闪动                                                          */
    /* ------------------------------------------------------------------ */

    /** 完成的卡片保持彩色条带闪动的时长。 */
    const FLASH_WINDOW_MS = 60000;

    /** 该卡片的子级里是否还有在运行的（只要分支里有活动，整条分支就该前置）。 */
    function hasRunningDescendant(listState, statuses, id, depth) {
      const level = typeof depth === 'number' ? depth : 0;
      if (level > 3) return false;
      const catalog = deriveCatalog(listState, statuses, id);
      for (let i = 0; i < catalog.entries.length; i++) {
        const entry = catalog.entries[i];
        if (entry.activity === 'running') return true;
        if (hasRunningDescendant(listState, statuses, entry.id, level + 1)) return true;
      }
      return false;
    }

    /**
     * 排序默认值：**整体按时间倒序**（最近的排最前），但含运行中子代理的分支
     * 强制提到最前——它们内部同样按时间倒序。父级随运行中的子级一起前置，
     * 否则分支会被拆散。
     */
    function sortLevelEntries(entries, listState, statuses) {
      const busy = [];
      const rest = [];
      entries.forEach(function (entry, index) {
        const active = entry.activity === 'running' ||
          hasRunningDescendant(listState, statuses, entry.id);
        const createdAt = typeof entry.createdAt === 'number' && isFinite(entry.createdAt) ? entry.createdAt : 0;
        if (active) busy.push({ entry: entry, index: index, createdAt: createdAt });
        else rest.push({ entry: entry, index: index, createdAt: createdAt });
      });
      const byNewest = function (a, b) {
        if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
        return a.index - b.index;
      };
      busy.sort(byNewest);
      rest.sort(byNewest);
      return busy.map(function (item) { return item.entry; })
        .concat(rest.map(function (item) { return item.entry; }));
    }

    /**
     * 每张卡片「最后一次活动」的真实时间（毫秒），由卡片自己的事件流写入。
     * 事件都带 wall-clock `time`，所以子代理结束的那一刻就是它最后一个事件的时间 ——
     * 这比会话摘要的 updatedAt 可靠得多（后者可能被标题等无关写入刷新，也可能压根不存在）。
     */
    const lastEventTimes = {};

    /** 刚完成（1 分钟内）的卡片才闪条带。 */
    function isFreshlyCompleted(entry, listState, statuses, now) {
      if (typeof now !== 'number') return false;
      if (entryState(entry, listState, statuses) !== 'completed') return false;
      const lastEventTime = lastEventTimes[entry.id];
      if (typeof lastEventTime !== 'number' || !isFinite(lastEventTime)) return false;
      const age = now - lastEventTime;
      return age >= 0 && age < FLASH_WINDOW_MS;
    }

    /** 可见范围里是否还有刚完成、正在闪条带的卡片（用于让秒级时钟多跑一分钟）。 */

    /* ------------------------------------------------------------------ */
    /* 刷新与动作                                                          */
    /* ------------------------------------------------------------------ */

    function refreshOne(id) {
      const sessions = PLUGIN_CTX && PLUGIN_CTX.sessions;
      if (!sessions || !id) return Promise.resolve();
      return Promise.resolve()
        .then(function () { return sessions.refreshProjections(id); })
        .catch(function (error) {
          console.error('[subagent-panel] refresh projections failed:', error);
        });
    }

    function prepareLevel(parentId) {
      return refreshOne(parentId).then(function () {
        const sessions = PLUGIN_CTX && PLUGIN_CTX.sessions;
        if (!sessions) return undefined;
        const snap = sessions.list.getSnapshot();
        const parent = snap.projectionsBySession[parentId];
        if (parent === undefined || parent.state !== 'ready') return undefined;
        const entries = parent.values ? parent.values.subagentCatalog : undefined;
        if (!Array.isArray(entries)) return undefined;
        let chain = Promise.resolve();
        entries.forEach(function (entry) {
          if (entry.mode === 'external') return;
          const child = snap.projectionsBySession[entry.id];
          if (child !== undefined && (child.state === 'migration-required' || child.state === 'error')) return;
          chain = chain.then(function () { return refreshOne(entry.id); });
        });
        return chain;
      });
    }

    /**
     * 读取可选的客户端服务。
     * Cordis 的 ctx 代理对「未声明在 inject 里的服务」会抛 `cannot get property
     * "x" without inject`，所以必须先用 `ctx.get()`（它被明确记录为
     * "without the inject requirement"），再退回属性访问。
     */
    function getPluginService(name) {
      if (PLUGIN_CTX === null) return undefined;
      try {
        if (typeof PLUGIN_CTX.get === 'function') {
          const optional = PLUGIN_CTX.get(name);
          if (optional !== undefined) return optional;
        }
      } catch (e) { /* 继续尝试属性访问 */ }
      try {
        const direct = PLUGIN_CTX[name];
        if (direct !== undefined) return direct;
      } catch (e) { /* 未注入，按不可用处理 */ }
      return undefined;
    }

    /**
     * 取 `remote.subagents` 命名空间。
     * `remote.<namespace>` 在 cordis 里是**独立的服务键**（api-gateway 的
     * `remote.${namespace}`），不能从 `remote` 对象上取属性——那样会抛
     * `cannot get property "remote.subagents" without inject`，而且是在渲染路径上抛，
     * 会把整个插槽条目打崩。所以必须按完整键名走 ctx.get()。
     */
    function remoteSubagents() {
      let ns;
      try { ns = getPluginService('remote.subagents'); } catch (e) { ns = undefined; }
      if (ns !== undefined && ns !== null && typeof ns.interruptByUser === 'function') return ns;
      return undefined;
    }

    function navState() {
      // 服务探测绝不能把整个面板拖垮：任何一个探测抛错都退回「不可用」，
      // 由调用方隐藏对应按钮即可。历史上就是这里抛错导致插槽条目整块崩掉。
      try {
        const ws = getPluginService('uiWorkspace');
        const sb = getPluginService('sidebarRight');
        return {
          mainAvailable: ws !== undefined && typeof ws.openSession === 'function',
          asideAvailable: sb !== undefined && typeof sb.openResource === 'function',
          stopAvailable: remoteSubagents() !== undefined,
        };
      } catch (e) {
        console.error('[subagent-panel] capability probe failed; degrading:', e);
        return { mainAvailable: false, asideAvailable: false, stopAvailable: false };
      }
    }

    function openMain(address) {
      const target = getPluginService('uiWorkspace');
      if (target === undefined || typeof target.openSession !== 'function') {
        console.error('[subagent-panel] uiWorkspace unavailable; cannot open child in main view');
        return;
      }
      try { target.openSession(address); }
      catch (e) { console.error('[subagent-panel] openSession failed:', e); }
    }

    function subagentChatAddress(address) {
      const query = new URLSearchParams({
        parent: address.parentSessionId,
        mode: address.mode,
      });
      return 'dsh-resource://subagentchat/session/' +
        encodeURIComponent(address.childSessionId) + '?' + query.toString();
    }

    function openAside(address) {
      const target = getPluginService('sidebarRight');
      if (target === undefined || typeof target.openResource !== 'function') {
        console.error('[subagent-panel] sidebarRight unavailable; cannot open child conversation');
        return;
      }
      try { target.openResource(subagentChatAddress(address), { kind: 'subagentchat' }); }
      catch (e) { console.error('[subagent-panel] openResource failed:', e); }
    }

    /**
     * 请求停止一个运行中的子智能体。
     * 客户端 remote 代理返回 `RemoteResult`（`{ok:true,value}` / `{ok:false,error}`），
     * 业务失败不会抛错，所以必须自己检查 `ok`，否则会把拒绝当成成功。
     * @returns `{ ok, message }`，供调用方显示失败原因。
     */
    function requestStop(childSessionId) {
      const subagents = remoteSubagents();
      if (subagents === undefined) {
        console.error('[subagent-panel] interruptByUser unavailable; cannot stop the subagent');
        return Promise.resolve({ ok: false, message: 'interruptByUser unavailable' });
      }
      return Promise.resolve()
        .then(function () { return subagents.interruptByUser(childSessionId); })
        .then(function (result) {
          if (result && result.ok === false) {
            const message = result.error && result.error.message ? result.error.message : 'interrupt refused';
            console.error('[subagent-panel] interruptByUser refused:', message);
            return { ok: false, message: message };
          }
          return { ok: true };
        })
        .catch(function (e) {
          console.error('[subagent-panel] interruptByUser failed:', e);
          return { ok: false, message: (e && e.message) || 'interrupt failed' };
        });
    }

    /* ------------------------------------------------------------------ */
    /* 对话预览：保留 + 跟随最新                                           */
    /* ------------------------------------------------------------------ */

    function blocksText(blocks) {
      if (!Array.isArray(blocks)) return '';
      return blocks
        .filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; })
        .map(function (b) { return b.text; })
        .join('\n')
        .trim();
    }

    /**
     * 只挑真正由人写下的 user 消息。
     * `user/message` 也承载 `agent.inject()` 注入的上下文（文件变更通知、skill 内容等），
     * 那些人造的 user-role 消息不该在预览里被标成「用户」。
     * 人写消息的 `source.kind === 'user'`；缺字段时按人写处理，避免旧日志丢内容。
     */
    function isHumanUserMessage(data) {
      const source = data && data.source;
      if (source === undefined || source === null) return true;
      return source.kind === 'user';
    }

    /** 事件窗口里最后一个带时间戳的事件时间（wall clock 毫秒）。 */
    function extractLastEventTime(win) {
      const entries = (win && win.entries) || [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const row = entries[i];
        if (row === null || typeof row !== 'object' || row.type !== 'event') continue;
        const ev = row.event;
        if (ev === null || typeof ev !== 'object') continue;
        if (typeof ev.time === 'number' && isFinite(ev.time)) return ev.time;
      }
      return undefined;
    }

    /**
     * 取最近几条消息。
     * **从窗口尾部倒着扫，凑够条数就停**：早期版本每次都遍历整个事件窗口再切尾，
     * 而卡片每个事件都会调一次，窗口长、卡片多时就是纯浪费。
     * @param win - 事件窗口快照。
     * @param limit - 需要多少条（默认详情抽屉的条数）。
     */
    function extractTranscript(win, limit) {
      const max = typeof limit === 'number' && limit > 0 ? limit : TRANSCRIPT_LIMIT;
      const entries = (win && win.entries) || [];
      const out = [];
      let i = entries.length - 1;
      for (; i >= 0 && out.length < max; i--) {
        const row = entries[i];
        if (row === null || typeof row !== 'object' || row.type !== 'event') continue;
        const ev = row.event;
        if (ev === null || typeof ev !== 'object') continue;
        if (ev.type === 'user/message') {
          if (!isHumanUserMessage(ev.data)) continue;
          const text = blocksText(ev.data && ev.data.content);
          if (text) out.push({ role: 'user', text: text });
        } else if (ev.type === 'assistant/message') {
          const m = ev.data && ev.data.message;
          const text = blocksText(m && m.content);
          if (text) out.push({ role: 'assistant', text: text });
        }
      }
      out.reverse();
      return {
        messages: out,
        // 停在中途 => 前面还有更早的内容没取
        omitted: Boolean(win && win.hasMore) || i >= 0,
      };
    }

    function TranscriptPreview(props) {
      const address = props.address;
      const t = props.t;
      const entry = props.entry;
      const running = props.running === true;
      const dataState = React.useState(null);
      const data = dataState[0];
      const setData = dataState[1];
      const loadingState = React.useState(true);
      const loading = loadingState[0];
      const setLoading = loadingState[1];
      const failedState = React.useState(false);
      const failed = failedState[0];
      const setFailed = failedState[1];
      // 默认跟随最新；user 主动上滚则暂停跟随。
      const stickState = React.useState(true);
      const stick = stickState[0];
      const setStick = stickState[1];
      const boxRefStore = React.useState(null);
      const boxRef = boxRefStore[0];
      const setBoxRef = boxRefStore[1];
      const external = entry.mode === 'external';

      React.useEffect(function () {
        if (external) { setLoading(false); return undefined; }
        let alive = true;
        let unsub = null;
        let ref = null;
        const teardown = function () {
          alive = false;
          if (unsub !== null) { try { unsub(); } catch (e0) {} unsub = null; }
          if (ref !== null) {
            try { ref.release(); } catch (e1) { /* 已释放 */ }
            ref = null;
          }
        };
        const sessions = PLUGIN_CTX && PLUGIN_CTX.sessions;
        if (!sessions) { setFailed(true); setLoading(false); return teardown; }
        let handle;
        try {
          handle = sessions.retain(address, { source: RETAIN_SOURCE });
        } catch (e) {
          console.error('[subagent-panel] retain failed:', e);
          setFailed(true);
          setLoading(false);
          return teardown;
        }
        if (!alive) {
          try { handle.release(); } catch (e) {}
          return teardown;
        }
        ref = handle;
        Promise.resolve(handle.ready).then(function () {
          if (!alive) return;
          const source = ref && ref.binding ? ref.binding.eventSource : undefined;
          if (!source) { setFailed(true); setLoading(false); return; }
          const pull = function () {
            if (!alive) return;
            try {
              setData(extractTranscript(source.getSnapshot()));
              setLoading(false);
            } catch (e) {
              console.error('[subagent-panel] transcript read failed:', e);
              setFailed(true);
              setLoading(false);
            }
          };
          pull();
          unsub = source.subscribe(pull);
        }).catch(function (e) {
          console.error('[subagent-panel] transcript open failed:', e);
          if (alive) { setFailed(true); setLoading(false); }
        });
        return teardown;
      }, [address.parentSessionId, address.childSessionId, address.mode, external]);

      // 内容变化后，若处于跟随状态则贴到底部（运行中即「动态滚动显示最新消息」）。
      const messageCount = data === null ? 0 : data.messages.length;
      const lastText = data !== null && data.messages.length > 0
        ? data.messages[data.messages.length - 1].text : '';
      React.useEffect(function () {
        const box = boxRef;
        if (!box || !stick) return;
        box.scrollTop = box.scrollHeight;
      }, [messageCount, lastText, stick, boxRef]);

      if (external) return h('p', { className: 'dspDetailNote' }, t('detail.externalBody'));
      if (loading) return h('p', { className: 'dspDetailNote', role: 'status' }, t('detail.loading'));
      if (failed) return h('p', { className: 'dspDetailError', role: 'alert' }, t('detail.failed'));

      const messages = data === null ? [] : data.messages;
      const rows = [];
      if (messages.length === 0) {
        rows.push(h('p', { key: 'empty', className: 'dspDetailNote' },
          running ? t('detail.streaming') : t('detail.empty')));
      }
      messages.forEach(function (msg, index) {
        rows.push(h('div', {
          key: 'msg-' + index, className: 'dspMsg', 'data-role': msg.role,
        },
          h('span', { className: 'dspRole' },
            msg.role === 'user' ? t('role.user') : t('role.assistant')),
          h('span', { className: 'dspText' }, msg.text),
        ));
      });
      if (data !== null && data.omitted) {
        rows.push(h('p', { key: 'more', className: 'dspDetailNote' }, t('detail.more')));
      }
      return h('div', { className: 'dspTranscriptWrap' },
        h('div', {
          key: 'box',
          className: 'dspTranscript',
          ref: setBoxRef,
          tabIndex: 0,
          role: 'log',
          // role="log" 本身隐含 polite；运行中每条增量都改列表，再显式 polite 会把
          // 整条（视觉上被 clamp 的）消息反复读出来。所以显式关掉，靠视觉跟随表达。
          'aria-live': 'off',
          onScroll: function (event) {
            const box = event && event.currentTarget ? event.currentTarget : boxRef;
            if (!box) return;
            const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
            const next = distance < 24;
            if (next !== stick) setStick(next);
          },
        }, rows),
        (!stick && messages.length > 0)
          ? h('button', {
            key: 'jump', type: 'button', className: 'dspJump',
            onClick: function () {
              setStick(true);
              const box = boxRef;
              if (box) box.scrollTop = box.scrollHeight;
            },
          }, t('transcript.jump'))
          : null,
      );
    }

    /* ------------------------------------------------------------------ */
    /* 卡片内的「最近三行」                                                 */
    /* ------------------------------------------------------------------ */

    /** 卡片上显示多少行最新对话。 */
    const CARD_LINES = 3;
    /** 单行裁剪长度：卡片只要一行摘要，超长文本不该把 DOM 撑大。 */
    const CARD_LINE_CHARS = 220;

    /** 压平换行并截断，保证一条消息恰好占一行。 */
    function oneLine(text, max) {
      const flat = String(text).replace(/\s+/g, ' ').trim();
      return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
    }

    /**
     * 一张卡片底部的实时对话摘要：该子会话最近 3 条消息，每条一行。
     * 与详情抽屉一样走 retain + eventSource 订阅，卸载必定 release()；
     * 外部任务没有本地会话，不 retain，也不占位。
     */
    function CardPreview(props) {
      const address = props.address;
      const t = props.t;
      const running = props.running === true;
      const external = props.entry.mode === 'external';
      const dataState = React.useState(null);
      const data = dataState[0];
      const setData = dataState[1];
      const failedState = React.useState(false);
      const failed = failedState[0];
      const setFailed = failedState[1];

      React.useEffect(function () {
        if (external) return undefined;
        let alive = true;
        let unsub = null;
        let ref = null;
        const teardown = function () {
          alive = false;
          if (unsub !== null) { try { unsub(); } catch (e0) {} unsub = null; }
          if (ref !== null) {
            try { ref.release(); } catch (e1) { /* 已释放 */ }
            ref = null;
          }
        };
        const sessions = PLUGIN_CTX && PLUGIN_CTX.sessions;
        if (!sessions) { setFailed(true); return teardown; }
        let handle;
        try {
          handle = sessions.retain(address, { source: RETAIN_SOURCE });
        } catch (e) {
          console.error('[subagent-panel] card retain failed:', e);
          setFailed(true);
          return teardown;
        }
        if (!alive) {
          try { handle.release(); } catch (e) {}
          return teardown;
        }
        ref = handle;
        Promise.resolve(handle.ready).then(function () {
          if (!alive) return;
          const source = ref && ref.binding ? ref.binding.eventSource : undefined;
          if (!source) { setFailed(true); return; }
          // 每个事件都会触发 pull，而 setState 会让整棵树重渲染一次。
          // 多个子代理同时输出时这就是 N×M 次全树渲染 —— 之前把那台机器卡死的就是它。
          // 所以只有「摘要内容真的变了」才 setState。
          let lastSignature = null;
          const pull = function () {
            if (!alive) return;
            try {
              const snapshot = source.getSnapshot();
              // 顺手记下最后一次事件的真实时间：它就是「完成时刻」的时间源。
              const lastTime = extractLastEventTime(snapshot);
              if (typeof lastTime === 'number') lastEventTimes[address.childSessionId] = lastTime;
              const next = extractTranscript(snapshot, CARD_LINES);
              const tail = next.messages.length > 0 ? next.messages[next.messages.length - 1] : undefined;
              const signature = next.messages.length + '|' +
                (tail === undefined ? '' : tail.role + ':' + tail.text.length + ':' + tail.text.slice(-24)) + '|' +
                (next.omitted ? '1' : '0');
              if (signature === lastSignature) return;
              lastSignature = signature;
              setData(next);
            } catch (e) {
              console.error('[subagent-panel] card preview read failed:', e);
              setFailed(true);
            }
          };
          pull();
          unsub = source.subscribe(pull);
        }).catch(function (e) {
          console.error('[subagent-panel] card preview open failed:', e);
          if (alive) setFailed(true);
        });
        return teardown;
      }, [address.parentSessionId, address.childSessionId, address.mode, external]);

      if (external) return null;

      const messages = data === null ? [] : data.messages;
      const lines = [];
      if (failed) {
        lines.push(h('div', { key: 'failed', className: 'dspLine', 'data-tone': 'muted' },
          h('span', { key: 'text', className: 'dspLineText' }, t('card.failed'))));
      } else if (data === null) {
        lines.push(h('div', { key: 'loading', className: 'dspLine', 'data-tone': 'muted' },
          h('span', { key: 'text', className: 'dspLineText' }, t('card.loading'))));
      } else if (messages.length === 0) {
        lines.push(h('div', { key: 'empty', className: 'dspLine', 'data-tone': 'muted' },
          h('span', { key: 'text', className: 'dspLineText' },
            running ? t('detail.streaming') : t('card.empty'))));
      } else {
        messages.slice(-CARD_LINES).forEach(function (msg, index) {
          lines.push(h('div', {
            key: 'line-' + index, className: 'dspLine', 'data-role': msg.role,
          },
            h('span', { key: 'role', className: 'dspLineRole' },
              msg.role === 'user' ? t('role.user') : t('role.assistant')),
            h('span', { key: 'text', className: 'dspLineText', title: msg.text },
              oneLine(msg.text, CARD_LINE_CHARS)),
          ));
        });
      }
      return h('div', { className: 'dspCardLines' }, lines);
    }

    /* ------------------------------------------------------------------ */
    /* 图标                                                                */
    /* ------------------------------------------------------------------ */

    const STROKE = {
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    };

    function svgWrap(size, children) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24',
        'aria-hidden': true, style: { flex: 'none', display: 'block' },
      }, children);
    }

    /**
     * 面板图标：与 bundle 自己的 icon.svg 同构（父节点 + 两个子节点 + 连线），
     * 这样「+」引导页里的卡片和插件列表里的图标是同一个视觉。
     */
    function PanelIcon(props) {
      const size = props && props.size ? props.size : 14;
      return svgWrap(size, [
        h('rect', {
          key: 'a', x: 8.7, y: 3.4, width: 6.6, height: 5, rx: 1.6,
          fill: 'currentColor', stroke: 'none',
        }),
        h('path', Object.assign({ key: 'b', d: 'M12 8.4V12M6.4 12h11.2M6.4 12v3M17.6 12v3' }, STROKE, { strokeWidth: 1.5 })),
        h('rect', {
          key: 'c', x: 3.7, y: 15, width: 5.4, height: 4.4, rx: 1.4,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        }),
        h('rect', {
          key: 'd', x: 14.9, y: 15, width: 5.4, height: 4.4, rx: 1.4,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        }),
      ]);
    }

    function ChevronIcon(props) {
      const size = props.size || 12;
      return svgWrap(size, [
        h('path', Object.assign({ key: 'p', d: 'm9 18 6-6-6-6', strokeWidth: 2 }, STROKE)),
      ]);
    }

    function CloseIcon(props) {
      const size = props.size || 12;
      return svgWrap(size, [
        h('path', Object.assign({ key: 'p', d: 'M18 6 6 18M6 6l12 12', strokeWidth: 1.8 }, STROKE)),
      ]);
    }

    function RefreshIcon(props) {
      const size = props.size || 12;
      return svgWrap(size, [
        h('path', Object.assign({ key: 'a', d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }, STROKE)),
        h('path', Object.assign({ key: 'b', d: 'M21 3v5h-5' }, STROKE)),
      ]);
    }

    function ArrowUpRightIcon(props) {
      const size = props.size || 13;
      return svgWrap(size, [
        h('path', Object.assign({ key: 'a', d: 'M7 17 17 7', strokeWidth: 1.8 }, STROKE)),
        h('path', Object.assign({ key: 'b', d: 'M8 7h9v9', strokeWidth: 1.8 }, STROKE)),
      ]);
    }

    function TrashIcon(props) {
      const size = props.size || 12;
      return svgWrap(size, [
        h('path', Object.assign({ key: 'a', d: 'M3 6h18' }, STROKE)),
        h('path', Object.assign({ key: 'b', d: 'M8 6V4h8v2' }, STROKE)),
        h('path', Object.assign({ key: 'c', d: 'M6 6l1 14h10l1-14' }, STROKE)),
      ]);
    }

    function StopIcon(props) {
      const size = props.size || 11;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true,
        style: { flex: 'none', display: 'block' },
      }, h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: 'currentColor' }));
    }

    /** 状态符号：运行中=品牌色弧线动画，成功=绿，异常结束=红，未运行=空心灰。 */
    function StatusGlyph(props) {
      const state = props.state;
      if (state === 'running') return h('span', { className: 'dspSpin', 'aria-hidden': true });
      if (state === 'completed') return h('span', { className: 'dspDot', 'data-state': 'completed', 'aria-hidden': true });
      if (state === 'failed') return h('span', { className: 'dspDot', 'data-state': 'failed', 'aria-hidden': true });
      return h('span', { className: 'dspDot', 'data-state': 'idle', 'aria-hidden': true });
    }

    /* ------------------------------------------------------------------ */
    /* 样式                                                                */
    /* ------------------------------------------------------------------ */

    const CSS = [
      '.dspRoot{display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;min-width:0;}',
      '.dspHead{display:flex;align-items:center;gap:7px;flex:none;padding:6px 8px 6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dspLead{display:grid;place-items:center;flex:none;width:14px;height:24px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}',
      '.dspTitle{flex:none;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:24px;}',
      '.dspProgress{flex:none;margin-inline-start:4px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:20px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;}',
      '.dspSpring{flex:1 1 auto;min-width:0;}',
      '.dspIconButton{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;transition:color 120ms ease,background 120ms ease;}',
      '.dspIconButton:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));color:var(--dsw-alias-label-primary);outline:2px solid var(--dsw-alias-brand-primary,rgba(127,127,127,0.6));outline-offset:1px;}',
      '.dspIconButton:disabled{cursor:default;opacity:.5;}',
      '@media(hover:hover){.dspIconButton:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));color:var(--dsw-alias-label-primary);}}',
      '.dspIconButton[data-busy="true"] svg{animation:dspSpin .9s linear infinite;}',

      '.dspHiddenBar{display:flex;align-items:center;gap:6px;flex:none;padding:4px 10px 4px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;}',
      '.dspHiddenText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dspLinkButton{flex:none;padding:2px 6px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;}',
      '@media(hover:hover){.dspLinkButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));}}',
      '.dspLinkButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,rgba(127,127,127,0.6));outline-offset:1px;}',

      '.dspBody{flex:1 1 auto;min-height:0;overflow:auto;scrollbar-gutter:stable;padding:4px 6px 8px;}',
      '.dspNotice{padding:8px 10px 8px 12px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;}',
      '.dspError{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;}',
      '.dspRetry{display:inline-flex;align-items:center;gap:3px;flex:none;padding:3px 5px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font-size:11px;cursor:pointer;}',
      '@media(hover:hover){.dspRetry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));}}',
      '.dspRowError{display:flex;align-items:center;gap:6px;padding:2px 10px 6px 37px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;}',
      '.dspActionError{border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dspActionErrorText{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}',

      '.dspNode{position:relative;min-width:0;}',
      // 每张卡片：浅底 + 描边 + 轻微投影，卡片之间留足间距，便于一眼区分。
      '.dspCard{position:relative;display:flex;flex-direction:column;box-sizing:border-box;width:100%;margin:0;padding:7px 8px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,0.04);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:17px;text-align:left;cursor:pointer;transition:background 120ms ease,border-color 120ms ease,box-shadow 120ms ease;}',
      '.dspCard:focus-visible{border-color:var(--dsw-alias-border-l2);outline:2px solid var(--dsw-alias-brand-primary,rgba(127,127,127,0.6));outline-offset:-2px;}',
      '@media(hover:hover){.dspCard:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);box-shadow:0 2px 6px rgba(0,0,0,0.07);}}',
      '.dspCard[aria-disabled="true"]{cursor:default;color:var(--dsw-alias-label-secondary);}',
      '@media(hover:hover){.dspCard[aria-disabled="true"]:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);box-shadow:0 1px 2px rgba(0,0,0,0.04);}}',
      '.dspCardHead{display:flex;align-items:flex-start;gap:7px;min-width:0;}',
      '.dspCardTitle{display:flex;flex:1;flex-direction:column;min-width:0;}',
      '.dspSubLine{display:flex;align-items:baseline;gap:6px;min-width:0;}',
      '.dspId{flex:none;opacity:.55;font-variant-numeric:tabular-nums;letter-spacing:.02em;}',
      // 最近三行：每行一条消息，单行省略，不再折行撑高卡片。
      '.dspCardLines{display:flex;flex-direction:column;gap:1px;margin:4px 0 0 21px;min-width:0;}',
      '.dspLine{display:flex;gap:5px;min-width:0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}',
      '.dspLine[data-tone="muted"]{opacity:.75;}',
      '.dspLine[data-role="user"] .dspLineRole{color:var(--dsw-alias-label-secondary);}',
      '.dspLineRole{flex:none;opacity:.85;}',
      '.dspLineText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

      '.dspDisclosure{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:17px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;position:relative;}',
      '.dspDisclosure::after{content:"";position:absolute;top:-4px;bottom:-4px;left:-7px;width:28px;}',
      '.dspDisclosure svg{width:12px;height:12px;transition:transform 120ms ease;}',
      '.dspDisclosure:focus-visible{color:var(--dsw-alias-label-primary);outline:2px solid var(--dsw-alias-brand-primary,rgba(127,127,127,0.6));outline-offset:1px;}',
      '@media(hover:hover){.dspDisclosure:hover{color:var(--dsw-alias-label-primary);}}',
      '.dspNode[data-open="true"]>.dspCard>.dspCardHead>.dspDisclosure svg{transform:rotate(90deg);}',
      '.dspDisclosureSpace{flex:none;width:14px;height:17px;}',

      // 身份标记：每个子智能体一个首字徽标，避免多张卡片彼此看混。
      '.dspAvatar{display:grid;place-items:center;flex:none;width:20px;height:20px;margin-top:1px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;line-height:1;}',
      '.dspAvatar[data-tone="external"]{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));border-style:dashed;}',
      '.dspTitleLine{display:flex;align-items:center;gap:5px;min-width:0;}',

      // 供应商 / 模型（上下两行，位于 token 之前）与 token / 耗时并排。
      '.dspMetrics{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;flex:none;margin-left:8px;max-width:64%;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:10px;line-height:15px;text-align:right;font-variant-numeric:tabular-nums;}',
      '.dspMetricPair{display:flex;flex-direction:column;min-width:0;}',
      '.dspMetricRow{display:flex;justify-content:flex-end;gap:3px;min-width:0;}',
      '.dspMetricLabel{flex:none;opacity:.7;}',
      '.dspMetricValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dspMetricValues{display:flex;flex-direction:column;white-space:nowrap;}',

      '.dspActivity{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:17px;}',
      '.dspDot{width:8px;height:8px;border-radius:50%;box-sizing:border-box;}',
      '.dspDot[data-state="completed"]{background:var(--dsw-alias-state-success-primary);}',
      '.dspDot[data-state="failed"]{background:var(--dsw-alias-state-error-primary);}',
      '.dspDot[data-state="idle"]{border:1.5px solid var(--dsw-alias-state-idle-primary);opacity:.9;}',
      '.dspSpin{width:10px;height:10px;border-radius:50%;border:2px solid var(--dsw-alias-brand-primary);border-bottom-color:transparent;animation:dspSpin .9s linear infinite;}',
      '@keyframes dspSpin{to{transform:rotate(360deg);}}',

      '.dspTree{display:flex;flex-direction:column;gap:9px;}',
      // 被上提的卡片（原来在已清除的父级之下）用虚线左边框提示它换了一层。
      '.dspNode[data-lifted="true"]>.dspCard{border-left-style:dashed;border-left-width:2px;border-left-color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}',
      // 刚完成的卡片：一圈旋转的彩色渐变环。用 @property 注册角度变量，
      // 由一张 repeating-conic-gradient + mask 只留边框部分，纯 CSS 完成，
      // 命中 GPU 的渐变缓存；不新增 DOM 节点、不碰 JS 计时器。
      '@property --dsp-rotate{syntax:"<angle>";inherits:false;initial-value:0deg;}',
      '.dspNode[data-flash="true"]>.dspCard{position:relative;border-color:transparent;}',
      '.dspNode[data-flash="true"]>.dspCard::after{content:"";position:absolute;inset:-2px;border-radius:calc(var(--dsw-radius-md,12px) + 2px);padding:2px;background:repeating-conic-gradient(from var(--dsp-rotate),#34c759 0deg,#0a84ff 90deg,#bf5af2 180deg,#ff9f0a 270deg,#34c759 360deg);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;animation:dspRing 2.4s linear infinite;pointer-events:none;}',
      '@keyframes dspRing{to{--dsp-rotate:360deg;}}',
      '.dspLabel{color:inherit;flex:1 1 auto;min-width:0;font-size:13px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dspNode[data-current="true"] .dspLabel{font-weight:500;}',
      '.dspSecondary{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dspNode[data-state="failed"] .dspSecondary{color:var(--dsw-alias-state-error-primary);}',

      '.dspAsideButton{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:24px;margin:2px 0;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;transition:color 120ms ease,background 120ms ease;}',
      '.dspAsideButton:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));color:var(--dsw-alias-label-primary);outline:2px solid var(--dsw-alias-brand-primary,rgba(127,127,127,0.6));outline-offset:1px;}',
      '@media(hover:hover){.dspAsideButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));color:var(--dsw-alias-label-primary);}}',

      '.dspRowClear{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;margin:2px 0 2px 0;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));opacity:.75;cursor:pointer;transition:color 120ms ease,background 120ms ease,opacity 120ms ease;}',
      '@media(hover:hover){.dspRowClear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));color:var(--dsw-alias-state-error-primary);opacity:1;}}',
      '.dspRowClear:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));color:var(--dsw-alias-state-error-primary);opacity:1;outline:2px solid var(--dsw-alias-state-error-primary);outline-offset:1px;}',
      '@media(hover:hover){.dspNode:hover .dspRowClear{opacity:1;}}',

      '.dspChildren{display:flex;flex-direction:column;gap:6px;margin:6px 0 0 10px;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l2);}',

      '.dspDetail{padding:2px 10px 10px 30px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}',
      '.dspDetailMeta{margin:0 0 6px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;}',
      '.dspDetailActions{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px;}',
      '.dspDetailActionsSecondary{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;}',
      '.dspDetailButton{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:color 120ms ease,background 120ms ease,border-color 120ms ease;}',
      '.dspDetailButton:focus-visible{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);outline:2px solid var(--dsw-alias-brand-primary,rgba(127,127,127,0.6));outline-offset:1px;}',
      '@media(hover:hover){.dspDetailButton:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.10));}}',
      '.dspDetailButton[data-danger="true"]{color:var(--dsw-alias-state-error-primary);}',
      '@media(hover:hover){.dspDetailButton[data-danger="true"]:hover{border-color:var(--dsw-alias-state-error-primary);}}',
      '.dspTranscriptTitle{margin:0 0 4px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;font-weight:500;}',
      '.dspTranscriptWrap{position:relative;}',
      '.dspTranscript{display:flex;flex-direction:column;gap:4px;max-height:260px;overflow:auto;scrollbar-gutter:stable;outline:none;}',
      '.dspTranscript:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,rgba(127,127,127,0.6));outline-offset:1px;}',
      '.dspJump{position:sticky;bottom:0;align-self:center;margin-top:4px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;}',
      '@media(hover:hover){.dspJump:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}}',
      '.dspMsg{padding:6px 8px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);min-width:0;}',
      '.dspMsg[data-role="user"]{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);}',
      '.dspRole{display:block;margin-bottom:2px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:10px;line-height:14px;}',
      '.dspText{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap;}',
      '.dspDetailNote{margin:0;padding:8px 0 2px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;overflow-wrap:anywhere;}',
      '.dspDetailError{margin:0;padding:8px 0 2px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;overflow-wrap:anywhere;}',
      '@media(prefers-reduced-motion:reduce){.dspSpin,.dspIconButton[data-busy="true"] svg,.dspNode[data-flash="true"]>.dspCard::after{animation:none;}.dspDisclosure svg{transition:none;}}',
    ].join('\n');

    /* ------------------------------------------------------------------ */
    /* 右侧栏标签页本体                                                    */
    /* ------------------------------------------------------------------ */

    function PanelTabBody(props) {
      const tabInfo = props.useTabInfo();
      const tab = tabInfo && tabInfo.tab ? tabInfo.tab : undefined;
      const address = tab !== undefined ? tab.contentId : undefined;
      const resource = props.useResource(address);
      // 资源地址带根会话；引导页的页面地址没有，退回本标签所在会话。
      const rootId = (resource && resource.value && resource.value.sessionId)
        || parsePanelAddress(address)
        || props.sessionId;
      const t = makeT(props.t);
      const listState = props.useSessions(function (v) { return v; });
      const statuses = props.useSessionStatus(function (v) { return v; });

      // 默认全部展开：记录的是「用户手动折叠了哪些分支」，而不是展开了哪些。
      const collapsedState = React.useState(function () { return new Set(); });
      const collapsed = collapsedState[0];
      const setCollapsed = collapsedState[1];
      const detailState = React.useState(undefined);
      const detailId = detailState[0];
      const setDetailId = detailState[1];
      const busyState = React.useState(false);
      const busy = busyState[0];
      const setBusy = busyState[1];
      const nowState = React.useState(Date.now());
      const now = nowState[0];
      const setNow = nowState[1];
      // 清除集合的版本号：变更后强制重渲染。
      // 清除集合存在组件外的 localStorage 里，改它不会触发渲染，所以用一个
      const hiddenTick = React.useState(0);
      const bumpHidden = function () { hiddenTick[1](function (v) { return v + 1; }); };
      // 动作失败（例如停止被拒）要看得见，而不是只进 console。
      const actionErrorState = React.useState(undefined);
      const actionError = actionErrorState[0];
      const setActionError = actionErrorState[1];
      const reportError = function (message) {
        setActionError(typeof message === 'string' && message !== '' ? message : 'error');
      };

      const hidden = rootId === undefined ? new Set() : hiddenOf(rootId);

      // 面板绑定到具体对话：换会话即是另一棵树，折叠与详情状态一并复位，
      // 免得把上一个对话里的子级 id 带过来。
      React.useEffect(function () {
        setCollapsed(new Set());
        setDetailId(undefined);
      }, [rootId]);

      const toggleBranch = function (id) {
        setCollapsed(function (current) {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };
      const closeTab = function () {
        try { if (tab && tab.actions) tab.actions.close(); }
        catch (e) { console.error('[subagent-panel] close tab failed:', e); }
      };
      const doRefresh = function () {
        setBusy(true);
        const tasks = [prepareLevel(rootId)];
        collectLevelIds(listState, statuses, rootId).forEach(function (id) {
          if (id !== rootId) tasks.push(refreshOne(id));
        });
        // 必须保证 busy 一定复位：任何一步 reject 都会让刷新按钮永久禁用。
        void Promise.all(tasks)
          .catch(function (error) { console.error('[subagent-panel] refresh failed:', error); })
          .then(function () { setBusy(false); });
      };

      const dismiss = function (childId) {
        if (rootId === undefined) return;
        const next = new Set(hiddenOf(rootId));
        next.add(childId);
        persistHidden(rootId, next);
        if (detailId === childId) setDetailId(undefined);
        bumpHidden();
        // 被清除的卡片让位给它的子级：先把这个分支的目录拉起来，
        // 否则上提时读不到子级、子树会整块消失。
        void prepareLevel(childId);
      };
      /** 批量清除：覆盖所有已加载层级里"非运行中"的行（默认全展开，所以是整棵树）。 */
      const dismissFinished = function () {
        if (rootId === undefined) return;
        const next = new Set(hiddenOf(rootId));
        collectLevelIds(listState, statuses, rootId).forEach(function (levelId) {
          deriveCatalog(listState, statuses, levelId).entries.forEach(function (entry) {
            if (next.has(entry.id)) return;
            if (entryState(entry, listState, statuses) !== 'running') next.add(entry.id);
          });
        });
        persistHidden(rootId, next);
        bumpHidden();
      };
      /** 只清「未正常结束」的子代理，运行中与正常完成的都不动。 */
      const dismissFailed = function () {
        if (rootId === undefined) return;
        const next = new Set(hiddenOf(rootId));
        collectLevelIds(listState, statuses, rootId).forEach(function (levelId) {
          deriveCatalog(listState, statuses, levelId).entries.forEach(function (entry) {
            if (next.has(entry.id)) return;
            if (entryState(entry, listState, statuses) === 'failed') next.add(entry.id);
          });
        });
        persistHidden(rootId, next);
        if (detailId !== undefined && next.has(detailId)) setDetailId(undefined);
        bumpHidden();
      };
      const restoreAll = function () {
        if (rootId === undefined) return;
        persistHidden(rootId, new Set());
        bumpHidden();
      };

      // bindCommands 只在 tab 变化时重绑，所以这里用 ref 取最新一次渲染的函数，
      // 避免闭包里抓到旧的折叠集合 / rootId。
      const refreshRef = React.useRef(null);
      refreshRef.current = doRefresh;
      React.useEffect(function () {
        if (!tab || !tab.actions || typeof tab.actions.bindCommands !== 'function') return undefined;
        return tab.actions.bindCommands({
          refresh: function () {
            const latest = refreshRef.current;
            if (typeof latest === 'function') latest();
          },
        });
      }, [tab]);

      // 一次全树扫描同时回答三件事（运行中 / 刚完成 / 失败），不再各走一遍。
      const scan = rootId === undefined
        ? { running: false, flashing: false, failed: false }
        : scanTree(listState, statuses, rootId, collapsed, hidden, now);
      const running = scan.running;
      // 刚完成的卡片要在 1 分钟内停掉闪动，所以即使没有运行中的子代理，
      // 只要还有新鲜完成的卡片，时钟也得继续走一小会儿。
      const ticking = running || scan.flashing;
      React.useEffect(function () {
        if (!ticking) return undefined;
        const clock = getPluginService('timer');
        let dispose;
        if (clock && typeof clock.interval === 'function') {
          dispose = clock.interval(function () { setNow(Date.now()); }, 1000);
        } else if (typeof setInterval === 'function') {
          const id = setInterval(function () { setNow(Date.now()); }, 1000);
          dispose = function () { clearInterval(id); };
        }
        return function () { if (typeof dispose === 'function') dispose(); };
      }, [ticking]);

      React.useEffect(function () {
        if (rootId === undefined) return undefined;
        void prepareLevel(rootId);
        return undefined;
      }, [rootId]);

      const onBodyKeyDown = function (event) {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' &&
            event.key !== 'Home' && event.key !== 'End') return;
        // 只有当焦点确实在某一行上时才接管方向键；否则会抢走对话预览等
        // 可滚动区域的键盘滚动（预览是 body 的后代，事件会冒泡到这里）。
        const active = document.activeElement;
        if (!active || active.getAttribute === undefined || active.getAttribute('data-dsp-row') === null) return;
        const root = event.currentTarget;
        if (!root || typeof root.querySelectorAll !== 'function') return;
        const rows = Array.prototype.slice.call(root.querySelectorAll('[data-dsp-row]:not([aria-disabled="true"])'));
        if (rows.length === 0) return;
        const index = rows.indexOf(active);
        event.preventDefault();
        if (event.key === 'Home') { rows[0].focus(); return; }
        if (event.key === 'End') { rows[rows.length - 1].focus(); return; }
        if (event.key === 'ArrowDown') { rows[Math.min(rows.length - 1, index + 1)].focus(); return; }
        rows[Math.max(0, index - 1)].focus();
      };

      if (rootId === undefined) {
        return h('div', { className: 'dspRoot' },
          h('div', { className: 'dspNotice', role: 'status' }, t('panel.loading')));
      }

      const catalog = deriveCatalog(listState, statuses, rootId);
      const visible = catalog.entries.filter(function (e) { return !hidden.has(e.id); });
      const progress = progressLabel(visible, listState, statuses, t);
      let runningCount = 0;
      visible.forEach(function (e) {
        if (entryState(e, listState, statuses) === 'running') runningCount++;
      });
      const hasFinished = visible.some(function (e) {
        return entryState(e, listState, statuses) !== 'running';
      });
      const hasFailed = scan.failed;

      return h('div', { className: 'dspRoot', 'data-subagent-inspector': '' },
        h('div', { className: 'dspHead' },
          h('span', { key: 'lead', className: 'dspLead', 'aria-hidden': true }, h(PanelIcon, { size: 14 })),
          h('span', { key: 'title', className: 'dspTitle' }, t('panel.title')),
          runningCount > 0 ? h('span', { key: 'spin', className: 'dspSpin', 'aria-hidden': true }) : null,
          progress !== '' ? h('span', { key: 'progress', className: 'dspProgress', title: progress }, progress) : null,
          h('span', { key: 'spring', className: 'dspSpring' }),
          // 一键清理失败子代理：文字按钮，比再放一个图标更好认。
          hasFailed
            ? h('button', {
              key: 'clearFailed', type: 'button', className: 'dspLinkButton',
              title: t('action.clearFailedHint'), 'aria-label': t('action.clearFailedHint'),
              onClick: function () { dismissFailed(); },
            }, t('action.clearFailed'))
            : null,
          hasFinished
            ? h('button', {
              key: 'clear', type: 'button', className: 'dspIconButton',
              title: t('action.clearFinished'), 'aria-label': t('action.clearFinished'),
              onClick: function () { dismissFinished(); },
            }, h(TrashIcon, { size: 13 }))
            : null,
          h('button', {
            key: 'refresh', type: 'button', className: 'dspIconButton',
            'data-busy': busy ? 'true' : 'false',
            disabled: busy,
            title: t('panel.refresh'), 'aria-label': t('panel.refresh'),
            onClick: doRefresh,
          }, h(RefreshIcon, { size: 13 })),
          h('button', {
            key: 'close', type: 'button', className: 'dspIconButton',
            title: t('panel.close'), 'aria-label': t('panel.close'),
            onClick: closeTab,
          }, h(CloseIcon, { size: 12 })),
        ),
        hidden.size > 0
          ? h('div', { key: 'hidden', className: 'dspHiddenBar' },
            h('span', { key: 'text', className: 'dspHiddenText', title: t('hidden.note') },
              t('hidden.count', { count: hidden.size }) + ' · ' + t('hidden.note')),
            h('button', {
              key: 'restore', type: 'button', className: 'dspLinkButton',
              onClick: restoreAll,
            }, t('action.restoreAll')),
          )
          : null,
        actionError !== undefined
          ? h('div', { key: 'actionError', className: 'dspError dspActionError', role: 'alert' },
            h('span', { key: 'msg', className: 'dspActionErrorText' }, actionError),
            h('button', {
              key: 'dismiss', type: 'button', className: 'dspLinkButton',
              onClick: function () { setActionError(undefined); },
            }, t('action.dismiss')),
          )
          : null,
        h('div', { className: 'dspBody', onKeyDown: onBodyKeyDown },
          h(PanelRows, {
            parentId: rootId, level: 1, listState: listState, statuses: statuses,
            now: now, currentSessionId: rootId,
            collapsed: collapsed, toggleBranch: toggleBranch,
            detailId: detailId, setDetailId: setDetailId,
            hidden: hidden, dismiss: dismiss, reportError: reportError,
            closePanel: closeTab, t: t,
          }),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 目录树                                                              */
    /* ------------------------------------------------------------------ */

    function PanelRows(props) {
      const parentId = props.parentId;
      const level = props.level;
      const listState = props.listState;
      const statuses = props.statuses;
      const now = props.now;
      const currentSessionId = props.currentSessionId;
      const collapsed = props.collapsed;
      const toggleBranch = props.toggleBranch;
      const detailId = props.detailId;
      const setDetailId = props.setDetailId;
      const hidden = props.hidden;
      const dismiss = props.dismiss;
      const reportError = props.reportError;
      const closePanel = props.closePanel;
      const t = props.t;
      // 嵌套层（某个卡片的下级）没有内容时不显示提示语：默认全展开时，
      // 叶子节点本来就没有子级，不该每张卡都挂一句「尚未加载子智能体」。
      const nested = props.nested === true;

      const catalog = deriveCatalog(listState, statuses, parentId);
      const hiddenSet = hidden || new Set();
      const entries = sortLevelEntries(
        liftHiddenLevels(listState, statuses, catalog.entries, hiddenSet),
        listState, statuses,
      );

      // 默认展开意味着深层目录不一定已加载：本级一渲染就把它的目录拉起来。
      React.useEffect(function () {
        if (nested) void refreshOne(parentId);
      }, [parentId]);

      if (entries.length === 0) {
        if (nested) {
          return catalog.state === 'error'
            ? h('div', { className: 'dspRowError', role: 'alert' }, t('catalog.failed'))
            : null;
        }
        if (catalog.state === 'error') {
          return h('div', { className: 'dspError', role: 'alert' },
            h('span', { key: 'msg' }, t('catalog.failed')),
            h('button', {
              key: 'retry', type: 'button', className: 'dspRetry',
              onClick: function () { void refreshOne(parentId); },
            }, h(RefreshIcon, { size: 12 }), t('panel.refresh')),
          );
        }
        if (catalog.state === 'loading') {
          return h('div', { className: 'dspNotice', role: 'status' }, t('panel.loading'));
        }
        if (catalog.state === 'idle') {
          return h('div', { className: 'dspNotice' }, t('panel.idle'));
        }
        if (catalog.entries.length > 0) {
          return h('div', { className: 'dspNotice' }, t('hidden.count', { count: catalog.entries.length }));
        }
        return h('div', { className: 'dspNotice' }, t('panel.empty'));
      }

      const reserveDisclosure = entries.some(function (e) { return canExpand(e, listState); });

      return h('div', { role: 'tree', className: 'dspTree' }, entries.map(function (entry) {
        const external = entry.mode === 'external';
        const expandable = canExpand(entry, listState);
        const failedChildren = childCatalogFailed(entry, listState);
        const isExpanded = expandable && !collapsed.has(entry.id);
        const isCurrent = entry.id === currentSessionId;
        const summary = listState.byId[entry.id];
        const migration = (summary !== undefined && summary.formatStatus === 'migration-required') ||
          (listState.projectionsBySession[entry.id] !== undefined &&
            listState.projectionsBySession[entry.id].state === 'migration-required');

        const state = entryState(entry, listState, statuses);
        const running = state === 'running';

        const description = entry.label || (summary !== undefined ? summary.title : undefined);
        // 只用目录里真正的 name（continuable / external 才有）。
        // 旧写法回退到会话 id，会让一次性子代理的副标题塞满一长串 id，卡片彼此更难分辨。
        const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : undefined;
        const primaryLabel = description || name || '#' + String(entry.id).slice(-4);
        const secondaryLabel = description && name !== undefined ? name : undefined;

        const mode = external ? t('mode.external')
          : entry.mode === 'unknown' ? t('mode.unknown')
          : entry.mode === 'one-shot' ? t('mode.oneShot')
          : t('mode.continuable');
        const stateLabel = state === 'external' ? undefined
          : state === 'running' ? t('state.running')
          : state === 'completed' ? t('state.completed')
          : state === 'failed' ? t('state.failed')
          : t('state.idle');
        const secondary = [secondaryLabel, mode, stateLabel]
          .filter(function (v) { return v !== undefined && v !== ''; })
          .join(' · ');

        const totalTokens = tokenTotal(projectionValue(listState, entry.id, 'tokenUsage'));
        const tokenMetric = totalTokens === undefined ? undefined : formatTokens(totalTokens, t);
        const durationMs = timingMs(projectionValue(listState, entry.id, 'subagentTiming'), entry.activity, now);
        const durationMetric = durationMs === undefined ? undefined : formatDuration(durationMs, t);
        const metrics = [tokenMetric, durationMetric]
          .filter(function (v) { return v !== undefined; })
          .join(' · ');
        // 两行堆叠渲染，title 保留单行文本供悬停查看。
        const metricRows = [tokenMetric, durationMetric]
          .filter(function (v) { return v !== undefined; });

        const detailOpen = detailId === entry.id;
        const detailDomId = 'dsp-detail-' + entry.id;
        const inert = external || migration;

        const onToggleDetail = function () {
          if (migration) return;
          setDetailId(detailOpen ? undefined : entry.id);
          if (!detailOpen) void refreshOne(entry.id);
        };
        const onOpenMain = function () {
          if (inert) return;
          openMain({ parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode });
          closePanel();
        };
        const onAside = function (event) {
          if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
            event.stopPropagation();
          }
          if (external) return;
          openAside({ parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode });
        };
        const onToggleBranch = function (event) {
          if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
            event.stopPropagation();
          }
          if (!expandable) return;
          if (!isExpanded) void refreshOne(entry.id);
          toggleBranch(entry.id);
        };
        const onStop = function (event) {
          if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
            event.stopPropagation();
          }
          // 中断是「被接受的请求」，失败也可能只是一个 {ok:false} 结果，
          // 不能当成成功；把拒绝原因交给面板显示。
          void requestStop(entry.id).then(function (result) {
            if (!result.ok) reportError(t('action.stop') + ': ' + result.message);
          });
        };
        const onClear = function (event) {
          if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
            event.stopPropagation();
          }
          dismiss(entry.id);
        };

        const cardAddress = {
          parentSessionId: parentId,
          childSessionId: entry.id,
          mode: external ? 'unknown' : entry.mode,
        };

        // 该子会话实际使用的供应商与模型
        const selection = inert ? undefined : selectionOf(listState, entry.id);
        const avatarText = external ? '外' : Array.from(primaryLabel)[0] || '·';

        const cardHead = [
          expandable
            ? h('button', {
              key: 'disc', type: 'button', className: 'dspDisclosure', tabIndex: -1,
              'aria-expanded': isExpanded,
              'aria-label': t(isExpanded ? 'branch.collapse' : 'branch.expand'),
              onClick: onToggleBranch,
            }, h(ChevronIcon, { size: 12 }))
            : (reserveDisclosure ? h('span', { key: 'discSpace', className: 'dspDisclosureSpace' }) : null),
          // 首字徽标：多张卡片并排时最省力的区分锚点。
          h('span', {
            key: 'avatar', className: 'dspAvatar',
            'data-tone': external ? 'external' : undefined,
            title: primaryLabel, 'aria-hidden': true,
          }, avatarText),
          h('span', { key: 'content', className: 'dspCardTitle' },
            h('span', { key: 'titleLine', className: 'dspTitleLine' },
              h('span', {
                key: 'act', className: 'dspActivity',
                title: stateLabel, 'aria-hidden': true,
              }, h(StatusGlyph, { state: state })),
              h('span', { key: 'label', className: 'dspLabel' }, primaryLabel),
            ),
            h('span', { key: 'subLine', className: 'dspSubLine' },
              secondary !== ''
                ? h('span', { key: 'text', className: 'dspSecondary' }, secondary)
                : null,
              h('span', { key: 'id', className: 'dspId', title: entry.id }, '#' + String(entry.id).slice(-4)),
            ),
          ),
          // 供应商 / 模型（上下两行）在前，token / 耗时在后。
          (selection !== undefined || metricRows.length > 0)
            ? h('span', { key: 'metrics', className: 'dspMetrics', title: metrics },
              h('span', { key: 'pair', className: 'dspMetricPair' },
                selection !== undefined
                  ? h('span', {
                    key: 'prov', className: 'dspMetricRow',
                    title: t('card.provider') + ': ' + selection.provider,
                  },
                    h('span', { key: 'pl', className: 'dspMetricLabel' }, t('card.provider')),
                    h('span', { key: 'pv', className: 'dspMetricValue' }, selection.provider),
                  )
                  : null,
                selection !== undefined
                  ? h('span', {
                    key: 'model', className: 'dspMetricRow',
                    title: t('card.model') + ': ' + selection.model,
                  },
                    h('span', { key: 'ml', className: 'dspMetricLabel' }, t('card.model')),
                    h('span', { key: 'mv', className: 'dspMetricValue' }, selection.model),
                  )
                  : null,
              ),
              h('span', { key: 'values', className: 'dspMetricValues' },
                metricRows.map(function (line, index) {
                  return h('span', { key: 'v' + index, className: 'dspMetricValue' }, line);
                })),
            )
            : null,
          external || migration || !navState().asideAvailable
            ? h('span', { key: 'tail', className: 'dspAsideButton', 'aria-hidden': true })
            : h('button', {
              key: 'tail', type: 'button', className: 'dspAsideButton', tabIndex: -1,
              'aria-label': t('detail.openAside'),
              title: t('detail.openAside'),
              onClick: onAside,
            }, h(ArrowUpRightIcon, { size: 13 })),
          // 卡片右上角的单个清除：不必展开详情即可把这张卡从面板移除（仅隐藏，不动会话）。
          h('button', {
            key: 'clearRow', type: 'button', className: 'dspRowClear', tabIndex: -1,
            'aria-label': t('action.clearRow', { label: primaryLabel }),
            title: t('action.clearRow', { label: primaryLabel }) + ' — ' + t('hidden.note'),
            onClick: onClear,
          }, h(TrashIcon, { size: 11 })),
        ];

        const cardChildren = [
          h('div', { key: 'head', className: 'dspCardHead' }, cardHead),
          // 最近三行对话，动态跟随该子会话的事件流。
          external
            ? null
            : h(CardPreview, {
              key: 'lines', address: cardAddress, entry: entry, t: t, running: running,
            }),
        ];

        const nodeChildren = [
          h('div', {
            key: 'row',
            'data-dsp-row': '',
            // 官方目录用 treeitem（内部允许嵌套按钮）；role="button" 的子树会被
            // 视为装饰，嵌套的真实按钮在辅助技术里不可用，故改用树语义。
            role: 'treeitem',
            'aria-level': level,
            tabIndex: migration ? -1 : 0,
            'aria-disabled': inert || undefined,
            'aria-expanded': expandable ? isExpanded : undefined,
            'aria-selected': detailOpen || undefined,
            'aria-controls': detailOpen ? detailDomId : undefined,
            'aria-current': isCurrent || undefined,
            className: 'dspCard',
            onClick: onToggleDetail,
            onKeyDown: function (event) {
              // 只处理卡片本身获得焦点时的按键：否则在卡内按钮或详情里的文本框上
              // 按 Enter/方向键会被这张卡吞掉。
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onToggleDetail();
              } else if (event.key === 'ArrowRight' && expandable && !isExpanded) {
                event.preventDefault();
                event.stopPropagation();
                onToggleBranch(event);
              } else if (event.key === 'ArrowLeft' && isExpanded) {
                event.preventDefault();
                event.stopPropagation();
                onToggleBranch(event);
              }
            },
          }, cardChildren),
        ];

        if (failedChildren && !isExpanded) {
          nodeChildren.push(h('div', { key: 'rowError', className: 'dspRowError', role: 'alert' },
            h('span', { key: 'msg' }, t('catalog.failed')),
            h('button', {
              key: 'retry', type: 'button', className: 'dspRetry',
              onClick: function (event) {
                event.preventDefault();
                event.stopPropagation();
                void refreshOne(entry.id);
              },
            }, h(RefreshIcon, { size: 11 }), t('panel.refresh')),
          ));
        }

        if (detailOpen) {
          const address = cardAddress;
          const createdText = formatCreated(entry.createdAt);
          const metaParts = [
            createdText !== undefined ? t('detail.created') + ' ' + createdText : undefined,
            tokenMetric,
            durationMetric !== undefined ? t('meta.duration', { value: durationMetric }) : undefined,
            stateLabel,
          ].filter(function (v) { return v !== undefined; }).join(' · ');
          const capabilities = navState();

          nodeChildren.push(h('div', {
            key: 'detail',
            id: detailDomId,
            ref: function (el) {
              if (el && typeof el.scrollIntoView === 'function') {
                try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
              }
            },
            className: 'dspDetail',
            role: 'group',
            'aria-label': primaryLabel,
          },
            metaParts !== '' ? h('p', { key: 'meta', className: 'dspDetailMeta' }, metaParts) : null,
            inert ? null : h('div', { key: 'actions', className: 'dspDetailActions' },
              capabilities.mainAvailable
                ? h('button', {
                  key: 'main', type: 'button', className: 'dspDetailButton',
                  onClick: onOpenMain,
                }, t('detail.openMain'))
                : null,
              capabilities.asideAvailable
                ? h('button', {
                  key: 'aside', type: 'button', className: 'dspDetailButton',
                  onClick: onAside,
                }, h(ArrowUpRightIcon, { size: 11 }), t('detail.openAside'))
                : null,
            ),
            h('div', { key: 'actions2', className: 'dspDetailActionsSecondary' },
              (!inert && running && capabilities.stopAvailable)
                ? h('button', {
                  key: 'stop', type: 'button', className: 'dspDetailButton',
                  onClick: onStop,
                }, h(StopIcon, { size: 10 }), t('action.stop'))
                : null,
              h('button', {
                key: 'clear', type: 'button', className: 'dspDetailButton',
                'data-danger': 'true',
                title: t('hidden.note'),
                onClick: onClear,
              }, h(TrashIcon, { size: 11 }), t('action.clear')),
            ),
            h('p', { key: 'tTitle', className: 'dspTranscriptTitle' }, t('detail.transcript')),
            h(TranscriptPreview, {
              key: 'transcript', address: address, entry: entry, t: t, running: running,
            }),
          ));
        }

        if (isExpanded) {
          nodeChildren.push(h('div', {
            key: 'children', className: 'dspChildren',
          },
            h(PanelRows, {
              parentId: entry.id, level: level + 1, listState: listState,
              statuses: statuses, now: now, currentSessionId: currentSessionId,
              collapsed: collapsed, toggleBranch: toggleBranch,
              detailId: detailId, setDetailId: setDetailId,
              hidden: hidden, dismiss: dismiss,
              closePanel: closePanel, t: t, reportError: reportError,
              nested: true,
            }),
          ));
        }

        return h('div', {
          key: 'node-' + entry.id,
          className: 'dspNode',
          'data-open': isExpanded ? 'true' : 'false',
          'data-current': isCurrent ? 'true' : 'false',
          'data-state': state,
          // 原本在已清除卡片之下、被上提一层的条目
          'data-lifted': entry.lifted === true ? 'true' : undefined,
          // 刚完成的卡片：边框走一段彩色条带动画，1 分钟后自动停
          'data-flash': isFreshlyCompleted(entry, listState, statuses, now) ? 'true' : undefined,
        }, nodeChildren);
      }));
    }

    /* ------------------------------------------------------------------ */
    /* 插件入口                                                            */
    /* ------------------------------------------------------------------ */

    return {
      // 只声明真正必需、且客户端一定提供的服务。
      // `remote` / `uiWorkspace` / `timer` 是**可选**依赖，绝不能写进 inject：
      // Cordis 里有一个注入拿不到，整个插件纤维就不会 ACTIVE，它注册的座位会变成
      // inactive —— 座位占着格子却不渲染，表现就是右侧栏一片完全空白。
      // 这三个一律通过 ctx.get()（明确记录为 "without the inject requirement"）取用。
      inject: ['slots', 'locale', 'sessions', 'resources', 'sidebarRight', 'sidebarRightTabs'],
      apply: function (ctx) {
        PLUGIN_CTX = ctx;

        ctx.effect(function () {
          const dispose = ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN });
          return function () { if (typeof dispose === 'function') dispose(); };
        }, 'subagent-panel: dictionaries');

        ctx.effect(function () {
          if (typeof document === 'undefined' || !document.head) return undefined;
          const tag = document.createElement('style');
          tag.setAttribute('data-plugin-css', 'dsh-subagent-panel');
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return function () { if (tag.parentNode) tag.parentNode.removeChild(tag); };
        }, 'subagent-panel: stylesheet');

        ctx.effect(function () {
          return ctx.resources.register({
            protocol: PROTOCOL,
            async *open(address, openCtx) {
              yield { ok: true, value: { sessionId: parsePanelAddress(address) } };
              if (openCtx && openCtx.signal) {
                await new Promise(function (resolve) {
                  if (openCtx.signal.aborted) { resolve(); return; }
                  openCtx.signal.addEventListener('abort', function () { resolve(); }, { once: true });
                });
              }
            },
          });
        }, 'subagent-panel: resource protocol');

        // 同时接受资源地址与引导页的页面地址（sidebar://<kind>）。
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            patterns: [ADDRESS_PREFIX + '**', PAGE_ADDRESS],
            canOpen: function (address) {
              if (typeof address !== 'string') return false;
              if (address === PAGE_ADDRESS) return true;
              return parsePanelAddress(address) !== undefined;
            },
            title: function () { return localeT('panel.title'); },
            guide: [{
              id: 'subagent-panel',
              order: 10,
              title: function () { return localeT('panel.title'); },
              description: function () { return localeT('panel.guideDesc'); },
              icon: PanelIcon,
            }],
          });
        }, 'subagent-panel: tab type');

        // 键盘快捷键：不注入 shortcuts（可选依赖），冲突只影响这条快捷键，不影响插件。
        ctx.effect(function () {
          const shortcuts = getPluginService('shortcuts');
          if (shortcuts === undefined || typeof shortcuts.register !== 'function') return undefined;
          try {
            return shortcuts.register({
              id: 'subagentPanel.open',
              label: function () { return localeT('panel.title'); },
              aliases: ['subagents', 'subagent panel', '子智能体', '子智能体面板'],
              defaults: {
                'desktop:macos': { code: 'KeyS', modifiers: ['primary', 'shift'] },
                'desktop:windows': { code: 'KeyS', modifiers: ['primary', 'shift'] },
                'desktop:linux': { code: 'KeyS', modifiers: ['primary', 'shift'] },
                'web:macos': { code: 'KeyS', modifiers: ['primary', 'shift'] },
                'web:windows': { code: 'KeyS', modifiers: ['primary', 'shift'] },
              },
              regions: ['page', 'editable'],
              modals: [],
              resolve: function () {
                const sb = getPluginService('sidebarRight');
                if (sb === undefined || typeof sb.openTab !== 'function') return { status: 'pass' };
                return { status: 'handled', run: openPanelForCurrentSession };
              },
            });
          } catch (e) {
            console.error('[subagent-panel] shortcut registration failed (binding conflict?):', e);
            return undefined;
          }
        }, 'subagent-panel: shortcut');

        // 侧栏为空且当前会话有子智能体时静默放入；跟随会话切换与数据到达。
        ctx.effect(function () {
          const sb = getPluginService('sidebarRight');
          const sessions = getPluginService('sessions');
          const offs = [];
          const bind = function (source) {
            if (!source || typeof source.subscribe !== 'function') return;
            try {
              const off = source.subscribe(ensurePanelTab);
              if (typeof off === 'function') offs.push(off);
            } catch (e) { /* 不可订阅则只做一次检查 */ }
          };
          bind(sb && sb.mounted);
          bind(sessions && sessions.list);
          ensurePanelTab();
          return function () {
            offs.forEach(function (off) { try { off(); } catch (e) {} });
          };
        }, 'subagent-panel: auto placement');

        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              locale: NS,
            }, PanelTabBody);
          });
        }, 'subagent-panel: pane body');

        ctx.effect(function () {
          return function () {
            const sb = getPluginService('sidebarRight');
            if (!sb || !sb.openTabs || typeof sb.openTabs.getSnapshot !== 'function') return;
            let open;
            try { open = sb.openTabs.getSnapshot(); } catch (e) { return; }
            if (!Array.isArray(open)) return;
            open.forEach(function (entry) {
              if (!entry || entry.kind !== TAB_KIND) return;
              try {
                if (typeof sb.closeIn === 'function') sb.closeIn(entry.sessionId, entry.tabId);
                else if (typeof sb.close === 'function') sb.close(entry.tabId);
              } catch (e) { console.error('[subagent-panel] closing own tab failed:', e); }
            });
          };
        }, 'subagent-panel: close own tabs on unload');
      },
    };
  },
});
