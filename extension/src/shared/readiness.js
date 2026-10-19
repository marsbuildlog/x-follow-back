// 控制台就绪清单纯逻辑(ADR-0010): 读 storage 快照 → 缺料项列表。
// options / 测试共用, 挂 globalThis.RFReadiness。
(function () {
  // 旁听引导页: 用户查询 / create.json 兑底都指向作者主页(顺带支持一下)
  const AUTHOR_HANDLE = 'marsbuildlog';
  const AUTHOR_URL = `https://x.com/${AUTHOR_HANDLE}`;

  const GQL_OPS = [
    { id: 'TweetDetail', label: '帖子详情模板', hint: '打开任意帖子详情页一次', url: 'https://x.com/home' },
    { id: 'SearchTimeline', label: '搜索模板', hint: '打开 #蓝V互关 旁听一次即可', url: 'https://x.com/hashtag/' + encodeURIComponent('蓝V互关') },
    { id: 'BlueVerifiedFollowers', label: '认证粉丝模板', hint: null, url: null }, // 与 Following 合并 → follow-lists
    { id: 'Following', label: '关注列表模板', hint: null, url: null },
    { id: 'UserByScreenName', label: '用户查询模板', hint: null, url: AUTHOR_URL }, // 与兑底合并 → author-visit
  ];

  // snap = chrome.storage.local 整包或子集; handle = rf_active
  function evaluate(snap, handle) {
    const RF = globalThis.RF || {};
    const K = RF.KEY || {};
    const items = [];
    const now = Date.now();

    // 身份与 bearer 合并: 刷 x.com 时通常同一次旁听齐; Route 1 缺 bearer 仍跑不动。
    // 例外: DOM/HTML 可先认出 handle、公共 bearer 可撑探针但不写入 rf_bearer——故 ok 要两项都齐。
    const bearer = snap[K.bearer || 'rf_bearer'];
    const identityOk = !!(handle && bearer);
    let identityHint = '打开任意 x.com 完成识别';
    if (handle && bearer) identityHint = `已识别 @${handle} · Bearer 已收割`;
    else if (handle) identityHint = `已识别 @${handle}, 再刷一下收割 Bearer`;
    else if (bearer) identityHint = 'Bearer 已有, 打开任意 x.com 完成账号识别';
    items.push({
      id: 'identity',
      ok: identityOk,
      label: '登录身份',
      hint: identityHint,
      action: identityOk ? null : 'open-x',
      url: 'https://x.com/home',
    });

    // 用户查询(必备) + create.json 兑底(可选) 同行: 打开作者主页 → 点关注即可一次旁听两项。
    // 缺查询 → ❗ 挡就绪; 仅缺兑底 → ○ 不挡就绪。紧挨登录身份, 优先引导。
    const userTpl = snap[(K.gqlTpl || 'rf_tpl') + ':UserByScreenName'];
    const userTplOk = !!(userTpl && userTpl.p && userTpl.q && userTpl.v0);
    const followSeen = snap[K.followTplSeen || 'rf_follow_tpl_seen'];
    const followOk = !!(followSeen && Number(followSeen) > 0);
    const authorOk = userTplOk && followOk;
    let authorHint = `打开 @${AUTHOR_HANDLE} → 点「关注」(已关注则先取关再关注)`;
    if (authorOk) authorHint = '已旁听(查询+兑底)';
    else if (userTplOk) authorHint = '查询已旁听, 再点一次「关注」完成兑底(已关注则先取关再关注)';
    items.push({
      id: 'author-visit',
      ok: authorOk,
      label: '用户查询与回关兑底',
      hint: authorHint,
      action: authorOk ? null : 'open-url',
      url: AUTHOR_URL,
      btnLabel: '@' + AUTHOR_HANDLE,
      optional: userTplOk, // 查询齐后剩兑底为可选
    });

    // 认证粉丝 + 关注列表同行(两页各旁听一次), 紧挨作者引导下方。
    const tplPrefix = K.gqlTpl || 'rf_tpl';
    const vfTpl = snap[tplPrefix + ':BlueVerifiedFollowers'];
    const flTpl = snap[tplPrefix + ':Following'];
    const vfOk = !!(vfTpl && vfTpl.p && vfTpl.q && vfTpl.v0);
    const flOk = !!(flTpl && flTpl.p && flTpl.q && flTpl.v0);
    const listsOk = vfOk && flOk;
    let listsHint = '各打开一次自己的认证粉丝页与关注列表';
    if (listsOk) listsHint = '已旁听';
    else if (!handle) listsHint = '先完成登录身份, 再打开自己的认证粉丝与 /following';
    else if (vfOk) listsHint = '认证粉丝已旁听, 再打开 /following';
    else if (flOk) listsHint = '关注列表已旁听, 再打开认证粉丝页';
    const listButtons = [];
    if (!listsOk && handle) {
      if (!vfOk) listButtons.push({ url: `https://x.com/${handle}/verified_followers`, label: '认证粉丝' });
      if (!flOk) listButtons.push({ url: `https://x.com/${handle}/following`, label: '关注列表' });
    }
    items.push({
      id: 'follow-lists',
      ok: listsOk,
      label: '认证粉丝与关注列表',
      hint: listsHint,
      action: listButtons.length ? 'open-url' : null,
      buttons: listButtons,
    });

    for (const op of GQL_OPS) {
      // UserByScreenName → author-visit; BlueVerifiedFollowers/Following → follow-lists
      if (op.id === 'UserByScreenName' || op.id === 'BlueVerifiedFollowers' || op.id === 'Following') continue;
      const tpl = snap[(K.gqlTpl || 'rf_tpl') + ':' + op.id];
      const ok = !!(tpl && tpl.p && tpl.q && tpl.v0);
      let url = op.url;
      let hint = op.hint;
      let btnLabel = op.btnLabel || null;
      if (op.id === 'SearchTimeline') {
        // 优先用配置里第一个标签, 否则默认 #蓝V互关(与 DEFAULTS.tags 一致)
        const cfgTags = (snap[K.settings || 'rf_settings'] || {}).tags;
        const tags = (cfgTags && cfgTags.length) ? cfgTags : ((RF.DEFAULTS && RF.DEFAULTS.tags) || ['蓝V互关']);
        const tag = String(tags[0] || '蓝V互关').replace(/^#/, '').trim() || '蓝V互关';
        url = `https://x.com/hashtag/${encodeURIComponent(tag)}`;
        hint = `打开 #${tag} 旁听一次即可`;
        btnLabel = '#' + tag;
      }
      items.push({
        id: 'tpl:' + op.id,
        ok,
        label: op.label,
        hint: ok ? '已旁听' : hint,
        action: ok ? null : (url ? 'open-url' : null),
        url,
        btnLabel,
      });
    }

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
