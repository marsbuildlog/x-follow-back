// 控制台就绪清单纯逻辑(ADR-0010): 读 storage 快照 → 缺料项列表。
// options / 测试共用, 挂 globalThis.RFReadiness。
(function () {
  const GQL_OPS = [
    { id: 'TweetDetail', label: '帖子详情模板', hint: '打开任意帖子详情页一次', url: 'https://x.com/home' },
    { id: 'SearchTimeline', label: '搜索模板', hint: '打开互关标签页或点「手动供血」', url: null },
    { id: 'BlueVerifiedFollowers', label: '认证粉丝模板', hint: '打开自己的认证粉丝页', url: null },
    { id: 'Following', label: '关注列表模板', hint: '打开自己的 /following', url: null },
    { id: 'UserByScreenName', label: '用户查询模板', hint: '打开任意用户主页一次', url: null },
  ];

  // snap = chrome.storage.local 整包或子集; handle = rf_active
  function evaluate(snap, handle) {
    const RF = globalThis.RF || {};
    const K = RF.KEY || {};
    const items = [];
    const now = Date.now();

    items.push({
      id: 'identity',
      ok: !!handle,
      label: '登录身份',
      hint: handle ? ('已识别 @' + handle) : '打开任意 x.com 完成识别',
      action: 'open-x',
      url: 'https://x.com/home',
    });

    for (const op of GQL_OPS) {
      const tpl = snap[(K.gqlTpl || 'rf_tpl') + ':' + op.id];
      const ok = !!(tpl && tpl.p && tpl.q && tpl.v0);
      let url = op.url;
      if (op.id === 'BlueVerifiedFollowers' && handle) url = `https://x.com/${handle}/verified_followers`;
      if (op.id === 'Following' && handle) url = `https://x.com/${handle}/following`;
      if (op.id === 'SearchTimeline' && (snap[K.settings || 'rf_settings'] || {}).tags?.length) {
        const tag = snap[K.settings || 'rf_settings'].tags[0];
        url = `https://x.com/hashtag/${encodeURIComponent(tag)}`;
      }
      items.push({
        id: 'tpl:' + op.id,
        ok,
        label: op.label,
        hint: ok ? '已旁听' : op.hint,
        action: ok ? null : 'open-url',
        url,
        harvest: op.id === 'SearchTimeline',
      });
    }

    const followSeen = snap[K.followTplSeen || 'rf_follow_tpl_seen'];
    const followOk = !!(followSeen && Number(followSeen) > 0);
    items.push({
      id: 'follow-tpl',
      ok: followOk,
      label: '回关兑底模板(create.json)',
      hint: followOk ? '已旁听(仅传输失败时用)' : '在认证粉丝页点一次「回关」',
      action: followOk ? null : 'open-url',
      url: handle ? `https://x.com/${handle}/verified_followers` : 'https://x.com/home',
      optional: true,
    });

    const bearer = snap[K.bearer || 'rf_bearer'];
    items.push({
      id: 'bearer',
      ok: !!bearer,
      label: 'Bearer',
      hint: bearer ? '已收割' : '打开任意 x.com 刷一下即可',
      action: bearer ? null : 'open-x',
      url: 'https://x.com/home',
    });

    const pool = snap[K.tidPool || 'rf_tid_pool'] || [];
    const cd = (RF.AF && RF.AF.TID_COOLDOWN_MS) || 70_000;
    const readyBy = {};
    for (const e of pool) {
      const label = String(e.p || '').split('/').pop() || '(空)';
      const ready = now - Math.max(e.at || 0, e.ok || 0) >= cd;
      if (!readyBy[label]) readyBy[label] = { total: 0, ready: 0 };
      readyBy[label].total++;
      if (ready) readyBy[label].ready++;
    }
    const poolParts = Object.keys(readyBy).sort().map((k) => `${k} ${readyBy[k].ready}/${readyBy[k].total}`);
    items.push({
      id: 'tid-pool',
      ok: pool.length > 0,
      label: 'tid 池',
      hint: pool.length ? (poolParts.join(' · ') || `${pool.length} 条`) : '刷 x.com 或手动供血',
      action: pool.length ? null : 'harvest',
      optional: true,
    });

    const required = items.filter((i) => !i.optional);
    const ready = required.every((i) => i.ok);
    return { ready, items, handle: handle || null };
  }

  function isConsoleHostAlive(snap, now) {
    const RF = globalThis.RF || {};
    const K = RF.KEY || {};
    const h = snap[K.consoleHost || 'rf_console_host'];
    const fresh = RF.CONSOLE_HOST_FRESH_MS || 15_000;
    return !!(h && (now || Date.now()) - (h.at || 0) < fresh);
  }

  globalThis.RFReadiness = { evaluate, isConsoleHostAlive, GQL_OPS };
})();
