/*
 * 配信シフト — 意思決定KPIロガー＆自動分析（タブ4）
 *
 *   Kpi      記録の正規化・指標の計算・入力の検証・端末間の合流・集計・CSV（DOM に触れない純粋関数）
 *   KpiView  1分記録フォーム、分析ダッシュボード、履歴
 *
 * 記録は Store.data.kpi.logs に入り、既存の同期（shift-data.json）にそのまま乗る。
 * 端末間で別々に記録しても消えないよう、記録は id ごとに合流させる（Kpi.merge）。削除は deleted フラグで残す。
 * 入力途中の下書きは Store.local.kpiDraft（この端末だけ）。
 */
"use strict";

/* ------------------------------------------------------------------ Kpi */
const Kpi = {
  BOTTLENECKS: [
    { id: "reach", label: "集客不足（タイトル/時間）" },
    { id: "bounce", label: "3秒離脱（画面UI/無言）" },
    { id: "rom", label: "ROM専（介入ハードル高）" },
    { id: "funnel", label: "導線漏れ（フォロー誘導なし）" },
    { id: "condition", label: "コンディション低下" },
  ],
  SHORT_TYPES: [
    { id: "scream", label: "絶叫" },
    { id: "jam", label: "妨害" },
    { id: "rule", label: "ルール系" },
    { id: "other", label: "その他" },
  ],
  MIN_SAMPLE: 3, // これ未満の件数の集計は「参考値」
  TOMBSTONE_DAYS: 180, // 削除フラグを残しておく日数

  // 全角数字・カンマ・空白を許して整数に。空なら null、数字でなければ NaN
  toInt(v) {
    const s = String(v ?? "")
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[\s,，　]/g, "");
    if (s === "") return null;
    return /^\d+$/.test(s) ? Number(s) : NaN;
  },
  num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  },
  round1(n) {
    return Math.round(n * 10) / 10;
  },
  // 集計用の企画名キー（全角半角・空白・大文字小文字の揺れをそろえる）
  titleKey(s) {
    return String(s || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  },

  calc(r) {
    const hours = Kpi.num(r.minutes) / 60;
    return {
      coinPerHour: hours > 0 ? Kpi.round1(Kpi.num(r.coins) / hours) : 0,
      followPerHour: hours > 0 ? Kpi.round1(Kpi.num(r.follows) / hours) : 0,
      coinPerGifter: Kpi.num(r.gifters) > 0 ? Kpi.round1(Kpi.num(r.coins) / Kpi.num(r.gifters)) : 0,
    };
  },

  // 欠けた項目を既定値で埋める（知らない項目は残す）
  normalize(r) {
    const slot = CONFIG.SLOT_ORDER.includes(r.slot) ? r.slot : "morning";
    const kind = CONFIG.KINDS[r.kind] ? r.kind : "flow";
    const short = r.short && typeof r.short === "object" ? r.short : {};
    const out = {
      ...r,
      id: String(r.id),
      date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : Util.dateKey(new Date()),
      slot,
      kind,
      title: String(r.title || ""),
      test: String(r.test || ""),
      minutes: Kpi.num(r.minutes),
      coins: Kpi.num(r.coins),
      gifters: Kpi.num(r.gifters),
      follows: Kpi.num(r.follows),
      avgViewSec: Kpi.num(r.avgViewSec),
      maxStayMin: Kpi.num(r.maxStayMin),
      peakViewers: Kpi.num(r.peakViewers),
      short: { posted: short.posted === true, type: Kpi.SHORT_TYPES.some((t) => t.id === short.type) ? short.type : null },
      bottlenecks: Array.isArray(r.bottlenecks) ? r.bottlenecks.filter((b) => Kpi.BOTTLENECKS.some((x) => x.id === b)) : [],
      next: String(r.next || ""),
      createdAt: r.createdAt || r.updatedAt || new Date(0).toISOString(),
      updatedAt: r.updatedAt || r.createdAt || new Date(0).toISOString(),
    };
    if (!out.short.posted) out.short.type = null;
    if (r.deleted) {
      out.deleted = true;
      out.deletedAt = r.deletedAt || out.updatedAt;
    }
    if (!out.calc || typeof out.calc !== "object") out.calc = Kpi.calc(out);
    return out;
  },

  /**
   * 2つの記録一覧を id ごとに合流させる。片方にしかない記録は残す（「無い」は削除の意味にしない）。
   * 同じ id は updatedAt が新しい方。削除は deleted フラグ付きの記録として伝わる。
   */
  merge(a = [], b = []) {
    const map = new Map();
    for (const r of [...(a || []), ...(b || [])]) {
      if (!r || !r.id) continue;
      const cur = map.get(r.id);
      if (!cur || String(r.updatedAt || "") > String(cur.updatedAt || "") || (r.updatedAt === cur.updatedAt && r.deleted && !cur.deleted)) map.set(r.id, r);
    }
    return Kpi.prune([...map.values()]).sort((x, y) => (x.date === y.date ? String(y.createdAt).localeCompare(String(x.createdAt)) : String(y.date || "").localeCompare(String(x.date || ""))));
  },
  // 合流結果がドライブ側と違う（＝送り返す必要がある）か
  differs(merged, remote = []) {
    const r = new Map((remote || []).map((x) => [x.id, x.updatedAt]));
    if (merged.length !== r.size) return true;
    return merged.some((x) => r.get(x.id) !== x.updatedAt);
  },
  prune(logs, now = Date.now()) {
    const limit = now - Kpi.TOMBSTONE_DAYS * 86400000;
    return logs.filter((r) => !r.deleted || Date.parse(r.deletedAt || r.updatedAt || 0) > limit);
  },
  live(logs) {
    return (logs || []).filter((r) => !r.deleted);
  },

  // フォームの値（文字列）→ 記録。エラーがあれば errors に入れる
  fromDraft(d) {
    const errors = [];
    const intField = (key, label, { required = false, max = 10000000 } = {}) => {
      const v = Kpi.toInt(d[key]);
      if (v === null) {
        if (required) errors.push(`${label}を入力してください`);
        return 0;
      }
      if (Number.isNaN(v) || v > max) {
        errors.push(`${label}は0以上の整数で入力してください`);
        return 0;
      }
      return v;
    };
    const minutes = intField("minutes", "実配信時間（分）", { required: true, max: 1440 });
    if (minutes === 0 && !errors.length) errors.push("実配信時間は1分以上にしてください");
    const viewMin = intField("viewMin", "平均視聴時間（分）", { max: 1440 });
    const viewSec = intField("viewSec", "平均視聴時間（秒）", { max: 59 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || "")) errors.push("日付を入力してください");
    const rec = {
      date: d.date,
      slot: CONFIG.SLOT_ORDER.includes(d.slot) ? d.slot : "morning",
      kind: CONFIG.KINDS[d.kind] ? d.kind : "flow",
      title: String(d.title || "").trim(),
      minutes,
      test: String(d.test || "").trim(),
      coins: intField("coins", "獲得コイン数"),
      gifters: intField("gifters", "ギフター数"),
      follows: intField("follows", "新規フォロワー数"),
      avgViewSec: viewMin * 60 + viewSec,
      maxStayMin: intField("maxStayMin", "最大滞在時間"),
      peakViewers: intField("peakViewers", "最大同接"),
      short: { posted: d.shortPosted === "yes", type: d.shortPosted === "yes" && d.shortType ? d.shortType : null },
      bottlenecks: Array.isArray(d.bottlenecks) ? d.bottlenecks : [],
      next: String(d.next || "").trim(),
    };
    rec.calc = Kpi.calc(rec);
    return { record: rec, errors };
  },

  // ---- 集計
  filter(logs, { period = "all", kind = "all" } = {}, today = new Date()) {
    const days = { 7: 7, 30: 30 }[period];
    const from = days ? Util.dateKey(Util.addDays(new Date(today.getFullYear(), today.getMonth(), today.getDate()), -(days - 1))) : "";
    return Kpi.live(logs).filter((r) => (!from || r.date >= from) && (kind === "all" || r.kind === kind));
  },

  // 平均は時間で重みづけ（合計コイン ÷ 合計時間）。短い配信1回で数字が振れないように
  aggregate(rows) {
    const n = rows.length;
    const minutes = rows.reduce((a, r) => a + r.minutes, 0);
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    const hours = minutes / 60;
    const viewW = rows.reduce((a, r) => a + r.avgViewSec * r.minutes, 0);
    return {
      n,
      minutes,
      coins: sum("coins"),
      follows: sum("follows"),
      gifters: sum("gifters"),
      coinPerHour: hours > 0 ? sum("coins") / hours : 0,
      followPerHour: hours > 0 ? sum("follows") / hours : 0,
      avgViewSec: minutes > 0 ? viewW / minutes : 0,
      avgGifters: n ? sum("gifters") / n : 0,
      avgFollows: n ? sum("follows") / n : 0,
      low: n < Kpi.MIN_SAMPLE,
    };
  },

  groupBy(rows, keyFn) {
    const map = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return map;
  },

  // 企画別。表示名はいちばん新しい記録の表記
  byTitle(rows, sort = "coin") {
    const groups = Kpi.groupBy(
      rows.filter((r) => r.title.trim()),
      (r) => Kpi.titleKey(r.title),
    );
    const list = [...groups.values()].map((g) => {
      const latest = [...g].sort((a, b) => (a.date + a.createdAt < b.date + b.createdAt ? 1 : -1))[0];
      return { name: latest.title.trim(), ...Kpi.aggregate(g) };
    });
    const key = sort === "follow" ? "followPerHour" : "coinPerHour";
    // 件数が少ないものは上位に入れない
    return list.sort((a, b) => (a.low !== b.low ? (a.low ? 1 : -1) : b[key] - a[key]));
  },

  bySlotKind(rows) {
    const out = [];
    for (const slot of CONFIG.SLOT_ORDER) {
      for (const kind of Object.keys(CONFIG.KINDS)) {
        const g = rows.filter((r) => r.slot === slot && r.kind === kind);
        if (g.length) out.push({ slot, kind, ...Kpi.aggregate(g) });
      }
    }
    return out;
  },

  byShort(rows) {
    return { yes: Kpi.aggregate(rows.filter((r) => r.short.posted)), no: Kpi.aggregate(rows.filter((r) => !r.short.posted)) };
  },

  // A/Bテスト：テスト変数のある記録と、同じ企画のテストなし平均との比較
  abLog(rows) {
    const base = Kpi.groupBy(
      rows.filter((r) => !r.test.trim()),
      (r) => Kpi.titleKey(r.title),
    );
    return rows
      .filter((r) => r.test.trim())
      .sort((a, b) => (a.date === b.date ? String(b.createdAt).localeCompare(String(a.createdAt)) : b.date.localeCompare(a.date)))
      .map((r) => {
        const g = base.get(Kpi.titleKey(r.title));
        return { r, base: g ? Kpi.aggregate(g) : null };
      });
  },

  // ---- CSV（Excel で文字化けしないよう BOM 付き UTF-8。数式として解釈されないようにする）
  CSV_COLUMNS: [
    ["日付", (r) => r.date],
    ["時間帯", (r) => CONFIG.SLOTS[r.slot]?.label || r.slot],
    ["種別", (r) => CONFIG.KINDS[r.kind]?.label || r.kind],
    ["企画・ゲーム名", (r) => r.title],
    ["実配信時間(分)", (r) => r.minutes],
    ["試した変更点", (r) => r.test],
    ["獲得コイン", (r) => r.coins],
    ["ギフター数", (r) => r.gifters],
    ["新規フォロワー", (r) => r.follows],
    ["平均視聴時間(秒)", (r) => r.avgViewSec],
    ["最大滞在時間(分)", (r) => r.maxStayMin],
    ["最大同接", (r) => r.peakViewers],
    ["ショート投稿", (r) => (r.short.posted ? "あり" : "なし")],
    ["ショートの型", (r) => Kpi.SHORT_TYPES.find((t) => t.id === r.short.type)?.label || ""],
    ["ボトルネック", (r) => r.bottlenecks.map((b) => Kpi.BOTTLENECKS.find((x) => x.id === b)?.label || b).join(" / ")],
    ["次回の一手", (r) => r.next],
    ["時給コイン", (r) => Kpi.calc(r).coinPerHour],
    ["時給フォロワー", (r) => Kpi.calc(r).followPerHour],
    ["ギフター単価", (r) => Kpi.calc(r).coinPerGifter],
  ],
  csvCell(v) {
    let s = String(v ?? "");
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  },
  csv(logs) {
    const rows = [...Kpi.live(logs)].sort((a, b) => (a.date === b.date ? String(a.createdAt).localeCompare(String(b.createdAt)) : a.date.localeCompare(b.date)));
    const lines = [Kpi.CSV_COLUMNS.map(([h]) => Kpi.csvCell(h)).join(",")];
    for (const r of rows) lines.push(Kpi.CSV_COLUMNS.map(([, f]) => Kpi.csvCell(f(r))).join(","));
    return "﻿" + lines.join("\r\n") + "\r\n";
  },
};

/* -------------------------------------------------------------- KpiView */
const KpiView = {
  DRAFT_KEYS: ["date", "slot", "kind", "title", "minutes", "test", "coins", "gifters", "follows", "viewMin", "viewSec", "maxStayMin", "peakViewers", "shortPosted", "shortType", "next"],

  // 新しい下書き（指定がなければ、直近に始まった枠の情報を入れる）
  newDraft(preset = {}) {
    const d = { id: null, date: "", slot: "morning", kind: "flow", title: "", minutes: "", test: "", coins: "", gifters: "", follows: "", viewMin: "", viewSec: "", maxStayMin: "", peakViewers: "", shortPosted: "no", shortType: "", bottlenecks: [], next: "", metaOpen: false, detailsOpen: false, fromTimer: false };
    if (!preset.date) {
      const now = new Date();
      const recent = TodayView.timeline(now)
        .filter((it) => it.start <= now.getTime())
        .pop();
      if (recent) {
        Object.assign(d, { date: recent.date, slot: recent.k, kind: recent.s.kind, title: recent.s.memo || "", test: recent.s.test || "", minutes: String(Math.round((recent.end - recent.start) / 60000)) });
      } else {
        Object.assign(d, { date: Util.dateKey(now), slot: typeof TimerView !== "undefined" ? TimerView.guessSlot(now) : "morning" });
      }
    }
    return { ...d, ...preset };
  },
  draft() {
    if (!Store.local.kpiDraft) {
      Store.local.kpiDraft = KpiView.newDraft();
      Store.saveLocal();
    }
    return Store.local.kpiDraft;
  },
  draftHasInput(d) {
    return ["coins", "gifters", "follows", "viewMin", "viewSec", "maxStayMin", "peakViewers", "next"].some((k) => String(d[k] || "").trim()) || (d.bottlenecks || []).length > 0;
  },

  // 入力のたびに下書きへ保存（同期の取り込みで描き直されても消えない）
  onFormInput(form) {
    const d = KpiView.draft();
    const fd = new FormData(form);
    for (const k of KpiView.DRAFT_KEYS) if (fd.has(k)) d[k] = String(fd.get(k));
    d.bottlenecks = fd.getAll("bottlenecks").map(String);
    if (!fd.has("shortPosted")) d.shortPosted = "no";
    Store.saveLocal();
    // 自動計算のプレビューと、ショートの型の有効/無効だけ更新
    const { record } = Kpi.fromDraft(d);
    const pv = form.querySelector("[data-bind=kpi-preview]");
    if (pv) pv.innerHTML = KpiView.previewHtml(record);
    const types = form.querySelector("[data-short-types]");
    if (types) types.toggleAttribute("disabled", d.shortPosted !== "yes");
    const sum = form.querySelector("[data-bind=meta-summary]");
    if (sum) sum.innerHTML = KpiView.metaSummary(d);
  },
  onToggle(el) {
    if (!el.matches?.("details[data-draft-open]")) return;
    const d = Store.local.kpiDraft;
    if (!d) return;
    d[el.dataset.draftOpen] = el.open;
    Store.saveLocal();
  },

  submit(form) {
    KpiView.onFormInput(form);
    const d = KpiView.draft();
    const { record, errors } = Kpi.fromDraft(d);
    const err = form.querySelector("[data-form-error]");
    if (errors.length) {
      err.innerHTML = errors.map((e) => `<span>⚠ ${Util.esc(e)}</span>`).join("");
      err.hidden = false;
      if (errors.some((e) => /日付|実配信/.test(e))) {
        d.metaOpen = true;
        Store.saveLocal();
        form.querySelector("details.kpi-meta")?.setAttribute("open", "");
      }
      return;
    }
    const nowIso = new Date().toISOString();
    const logs = Store.data.kpi.logs;
    const old = d.id ? logs.find((r) => r.id === d.id) : null;
    const rec = Kpi.normalize({ ...(old || {}), ...record, id: old?.id || Util.uid(), createdAt: old?.createdAt || nowIso, updatedAt: nowIso });
    delete rec.deleted;
    delete rec.deletedAt;
    Store.data.kpi.logs = Kpi.merge(
      logs.filter((r) => r.id !== rec.id),
      [rec],
    );
    Store.save();
    Store.local.kpiDraft = KpiView.newDraft();
    Store.local.kpiDraft.date = Util.dateKey(new Date());
    Store.saveLocal();
    document.activeElement?.blur?.();
    App.render();
    UI.toast(`${old ? "更新" : "記録"}しました（時給コイン ${KpiView.fmt(rec.calc.coinPerHour)}）`);
  },

  async action(a, el) {
    const v = Store.local.kpiView;
    switch (a) {
      case "kpi-filter":
        v[el.dataset.key] = el.dataset.value;
        if (el.dataset.key !== "limit") v.limit = 30;
        Store.saveLocal();
        return KpiView.rerenderKeepScroll();
      case "kpi-more":
        v.limit = (v.limit || 30) + 50;
        Store.saveLocal();
        return KpiView.rerenderKeepScroll();
      case "kpi-clear": {
        const d = Store.local.kpiDraft;
        if (d && KpiView.draftHasInput(d)) {
          const ok = await UI.confirm({ title: "入力内容を消しますか？", body: "<p>入力中の数字とメモを消して、新しい記録にします。</p>", ok: "消す", danger: true });
          if (!ok) return;
        }
        Store.local.kpiDraft = KpiView.newDraft();
        Store.saveLocal();
        return App.render();
      }
      case "kpi-edit": {
        const r = Store.data.kpi.logs.find((x) => x.id === el.dataset.id);
        if (!r) return;
        const d = Store.local.kpiDraft;
        if (d && KpiView.draftHasInput(d) && d.id !== r.id) {
          const ok = await UI.confirm({ title: "入力中の記録があります", body: "<p>入力途中の内容を破棄して、この記録を編集しますか？</p>", ok: "破棄して編集", danger: true });
          if (!ok) return;
        }
        const s = (n) => (n ? String(n) : "");
        Store.local.kpiDraft = KpiView.newDraft({
          id: r.id,
          date: r.date,
          slot: r.slot,
          kind: r.kind,
          title: r.title,
          minutes: String(r.minutes),
          test: r.test,
          coins: String(r.coins),
          gifters: String(r.gifters),
          follows: String(r.follows),
          viewMin: s(Math.floor(r.avgViewSec / 60)),
          viewSec: s(r.avgViewSec % 60),
          maxStayMin: s(r.maxStayMin),
          peakViewers: s(r.peakViewers),
          shortPosted: r.short.posted ? "yes" : "no",
          shortType: r.short.type || "",
          bottlenecks: [...r.bottlenecks],
          next: r.next,
          metaOpen: true,
          detailsOpen: Boolean(r.bottlenecks.length || r.next || r.maxStayMin),
        });
        Store.saveLocal();
        App.render();
        return document.querySelector(".kpi-form-panel")?.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      case "kpi-delete": {
        const r = Store.data.kpi.logs.find((x) => x.id === el.dataset.id);
        if (!r) return;
        const ok = await UI.confirm({ title: "この記録を削除しますか？", body: `<p>${Util.esc(Util.md(Util.parseKey(r.date)))} ${Util.esc(CONFIG.SLOTS[r.slot].label)}「${Util.esc(r.title || "企画名なし")}」を削除します。ほかの端末からも消えます。</p>`, ok: "削除する", danger: true });
        if (!ok) return;
        const now = new Date().toISOString();
        Object.assign(r, { deleted: true, deletedAt: now, updatedAt: now });
        if (Store.local.kpiDraft?.id === r.id) Store.local.kpiDraft = KpiView.newDraft();
        Store.save();
        return KpiView.rerenderKeepScroll();
      }
      case "kpi-csv": {
        const logs = Kpi.live(Store.data.kpi.logs);
        if (!logs.length) return UI.toast("書き出す記録がありません");
        UI.download(`kpi-${Util.dateKey(new Date()).replace(/-/g, "")}.csv`, Kpi.csv(logs), "text/csv;charset=utf-8");
        return UI.toast(`${logs.length}件をCSVに書き出しました`);
      }
    }
  },

  rerenderKeepScroll() {
    const y = window.scrollY;
    App.render();
    window.scrollTo({ top: y });
  },

  // ---- 表示の小道具
  fmt(n, d = 0) {
    if (!Number.isFinite(n)) return "–";
    return n.toLocaleString("ja-JP", { maximumFractionDigits: d, minimumFractionDigits: 0 });
  },
  fmtSec(sec) {
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  },
  fmtMin(min) {
    const h = Math.floor(min / 60);
    return h ? `${h}時間${min % 60 ? `${min % 60}分` : ""}` : `${min}分`;
  },
  delta(a, b) {
    if (!b) return "";
    const diff = a - b;
    if (Math.abs(diff) < 0.05) return `<span class="delta" data-sign="0">±0</span>`;
    return `<span class="delta" data-sign="${diff > 0 ? "+" : "-"}">${diff > 0 ? "+" : "−"}${KpiView.fmt(Math.abs(diff), 1)}</span>`;
  },
  n(agg) {
    return `<span class="n-badge" ${agg.low ? 'data-low="true"' : ""}>n=${agg.n}</span>`;
  },
  slotLabel(r) {
    return `${CONFIG.SLOTS[r.slot]?.label || ""}`;
  },

  previewHtml(rec) {
    const c = rec.calc;
    return `
      <span><span class="muted">時給コイン</span> <b class="num">${KpiView.fmt(c.coinPerHour, 1)}</b></span>
      <span><span class="muted">時給フォロワー</span> <b class="num">${KpiView.fmt(c.followPerHour, 1)}</b></span>
      <span><span class="muted">ギフター単価</span> <b class="num">${KpiView.fmt(c.coinPerGifter, 1)}</b></span>`;
  },
  metaSummary(d) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? Util.parseKey(d.date) : null;
    return `
      <span class="num">${date ? Util.md(date) : "日付未入力"}</span>
      <span>${CONFIG.SLOTS[d.slot]?.icon || ""} ${CONFIG.SLOTS[d.slot]?.label || ""}</span>
      ${UI.kindBadge(d.kind)}
      <span class="meta-title">${d.title ? Util.esc(d.title) : '<span class="muted">企画名なし</span>'}</span>
      <span class="num">${d.minutes ? `${Util.esc(d.minutes)}分` : '<span data-tone="caution">時間未入力</span>'}</span>
      ${d.test ? `<span class="meta-test">🧪 ${Util.esc(d.test)}</span>` : ""}`;
  },

  numField(name, label, unit, value, extra = "") {
    return `
      <label class="kpi-num">
        <span class="kpi-num-label">${label}</span>
        <span class="kpi-num-box"><input class="input num" type="text" inputmode="numeric" pattern="[0-9]*" name="${name}" value="${Util.esc(value)}" autocomplete="off" enterkeyhint="next" ${extra}><span class="kpi-unit">${unit}</span></span>
      </label>`;
  },

  // ---- 描画
  render() {
    return `<div class="kpi-view">${KpiView.form()}${KpiView.board()}</div>`;
  },

  form() {
    const d = KpiView.draft();
    const { record } = Kpi.fromDraft(d);
    const editing = d.id && Store.data.kpi.logs.some((r) => r.id === d.id && !r.deleted);
    return `
      <section class="panel kpi-form-panel">
        <div class="kpi-form-head">
          <h2>${editing ? "✎ 記録を編集" : "1分KPI記録"}</h2>
          ${d.fromTimer && !editing ? '<span class="pill" data-tone="rest">⏱ タイマーから自動入力</span>' : ""}
        </div>
        <form data-form="kpi" class="kpi-form" novalidate autocomplete="off">
          <details class="kpi-meta" data-draft-open="metaOpen" ${d.metaOpen ? "open" : ""}>
            <summary><span class="meta-summary" data-bind="meta-summary">${KpiView.metaSummary(d)}</span><span class="meta-edit">✎ 変更</span></summary>
            <div class="kpi-meta-grid">
              <label class="field"><span class="field-label">日付</span><input class="input" type="date" name="date" value="${Util.esc(d.date)}"></label>
              <div class="field"><span class="field-label">時間帯枠</span>
                <div class="segmented" role="radiogroup" aria-label="時間帯枠">${CONFIG.SLOT_ORDER.map((k) => `<label class="seg-radio"><input type="radio" name="slot" value="${k}" ${d.slot === k ? "checked" : ""}><span>${CONFIG.SLOTS[k].icon} ${CONFIG.SLOTS[k].label.replace("枠", "")}</span></label>`).join("")}</div>
              </div>
              <div class="field"><span class="field-label">枠種別</span>
                <div class="segmented" role="radiogroup" aria-label="枠種別">${Object.entries(CONFIG.KINDS)
                  .map(([id, kd]) => `<label class="seg-radio"><input type="radio" name="kind" value="${id}" ${d.kind === id ? "checked" : ""}><span>${kd.icon} ${kd.label}</span></label>`)
                  .join("")}</div>
              </div>
              <label class="field"><span class="field-label">企画・ゲーム名</span><input class="input" type="text" name="title" value="${Util.esc(d.title)}" list="kpiTitleList" enterkeyhint="next">
                <datalist id="kpiTitleList">${KpiView.titleSuggestions().map((m) => `<option value="${Util.esc(m)}">`).join("")}</datalist></label>
              <label class="field"><span class="field-label">実配信時間（分）</span><input class="input num" type="text" inputmode="numeric" pattern="[0-9]*" name="minutes" value="${Util.esc(d.minutes)}" enterkeyhint="next"></label>
              <label class="field"><span class="field-label">🧪 試した変更点（A/Bテスト変数）</span><input class="input" type="text" name="test" value="${Util.esc(d.test)}" maxlength="60" enterkeyhint="next"></label>
            </div>
          </details>

          <div class="kpi-nums">
            ${KpiView.numField("coins", "獲得コイン", "枚", d.coins)}
            ${KpiView.numField("gifters", "ギフター", "人", d.gifters)}
            ${KpiView.numField("follows", "新規フォロワー", "人", d.follows)}
            ${KpiView.numField("peakViewers", "最大同接", "人", d.peakViewers)}
            <div class="kpi-num">
              <span class="kpi-num-label" id="viewLabel">平均視聴時間</span>
              <span class="kpi-num-pair" role="group" aria-labelledby="viewLabel">
                <span class="kpi-num-box"><input class="input num" type="text" inputmode="numeric" pattern="[0-9]*" name="viewMin" value="${Util.esc(d.viewMin)}" aria-label="平均視聴時間（分）" enterkeyhint="next"><span class="kpi-unit">分</span></span>
                <span class="kpi-num-box"><input class="input num" type="text" inputmode="numeric" pattern="[0-9]*" name="viewSec" value="${Util.esc(d.viewSec)}" maxlength="2" aria-label="平均視聴時間（秒）" enterkeyhint="next"><span class="kpi-unit">秒</span></span>
              </span>
            </div>
          </div>

          <fieldset class="kpi-short">
            <legend class="field-label">配信30〜60分前のショート動画</legend>
            <div class="kpi-short-row">
              <div class="segmented" role="radiogroup" aria-label="ショート動画の投稿">
                <label class="seg-radio"><input type="radio" name="shortPosted" value="yes" ${d.shortPosted === "yes" ? "checked" : ""}><span>あり</span></label>
                <label class="seg-radio"><input type="radio" name="shortPosted" value="no" ${d.shortPosted !== "yes" ? "checked" : ""}><span>なし</span></label>
              </div>
              <fieldset class="segmented kpi-short-types" data-short-types ${d.shortPosted === "yes" ? "" : "disabled"} aria-label="動画の型">
                ${Kpi.SHORT_TYPES.map((t) => `<label class="seg-radio"><input type="radio" name="shortType" value="${t.id}" ${d.shortType === t.id ? "checked" : ""}><span>${t.label}</span></label>`).join("")}
              </fieldset>
            </div>
          </fieldset>

          <details class="kpi-details" data-draft-open="detailsOpen" ${d.detailsOpen ? "open" : ""}>
            <summary>詳細（ボトルネック・最大滞在・次の一手）${d.bottlenecks.length ? `<span class="pill">${d.bottlenecks.length}件チェック</span>` : ""}</summary>
            <div class="kpi-details-body">
              <div class="field"><span class="field-label">不調時のボトルネック（複数可）</span>
                <div class="chip-checks">${Kpi.BOTTLENECKS.map((b) => `<label class="chip-check"><input type="checkbox" name="bottlenecks" value="${b.id}" ${d.bottlenecks.includes(b.id) ? "checked" : ""}><span>${Util.esc(b.label)}</span></label>`).join("")}</div>
              </div>
              <div class="kpi-nums one">${KpiView.numField("maxStayMin", "最大滞在時間", "分", d.maxStayMin)}</div>
              <label class="field"><span class="field-label">次回の一手</span><input class="input" type="text" name="next" value="${Util.esc(d.next)}" maxlength="80" placeholder="例：冒頭3分でルール説明を固定表示" enterkeyhint="done"></label>
            </div>
          </details>

          <div class="kpi-preview" data-bind="kpi-preview" aria-live="polite">${KpiView.previewHtml(record)}</div>
          <p class="form-error" data-form-error hidden></p>
          <div class="kpi-actions">
            <button type="button" class="btn" data-variant="ghost" data-action="kpi-clear">${editing ? "編集をやめる" : "クリア"}</button>
            <button type="submit" class="btn big kpi-save" data-variant="primary">${editing ? "更新して保存" : "保存する"}</button>
          </div>
        </form>
      </section>`;
  },

  titleSuggestions() {
    const set = new Set(WeekView.memoSuggestions());
    for (const r of Kpi.live(Store.data.kpi.logs).slice(0, 50)) if (r.title.trim()) set.add(r.title.trim());
    return [...set].slice(-40);
  },

  seg(key, options, cur) {
    return `<div class="segmented" role="group">${options.map(([v, label]) => `<button type="button" data-action="kpi-filter" data-key="${key}" data-value="${v}" aria-pressed="${cur === v}">${label}</button>`).join("")}</div>`;
  },

  board() {
    const v = Store.local.kpiView;
    const all = Kpi.live(Store.data.kpi.logs);
    const rows = Kpi.filter(all, v);
    const filters = `
      <div class="kpi-filters">
        ${KpiView.seg("period", [["7", "直近7日"], ["30", "30日"], ["all", "全期間"]], v.period)}
        ${KpiView.seg("kind", [["all", "全体"], ["flow", "☀ フロー"], ["stock", "☾ ストック"], ["adjust", "◐ 調整"]], v.kind)}
      </div>`;
    if (!all.length) {
      return `
        <section class="panel empty-state kpi-empty">
          <div class="empty-icon" aria-hidden="true">▲</div>
          <h2>最初の1件を記録しましょう</h2>
          <p class="muted">配信が終わったら、上のフォームに数字を入れて保存してください。<br>3件たまると、企画ごとの比較が見えてきます。</p>
        </section>`;
    }
    const body = rows.length
      ? [KpiView.summary(rows), KpiView.ab(rows), KpiView.ranking(rows, v.sort), KpiView.slotTable(rows), KpiView.shortCompare(rows)].join("")
      : `<section class="panel empty-state"><p class="muted">この条件の記録はまだありません。期間か種別を変えてください。</p></section>`;
    return `
      <div class="kpi-board">
        <div class="kpi-board-head"><h2>分析ダッシュボード</h2>${filters}</div>
        <p class="hint muted small">時給・視聴時間の平均は配信時間で重みづけしています。<span class="n-badge" data-low="true">n=2</span> のように薄い表示は件数が${Kpi.MIN_SAMPLE}件未満の参考値です。</p>
        ${body}
        ${KpiView.history(all, v.limit)}
      </div>`;
  },

  summary(rows) {
    const a = Kpi.aggregate(rows);
    const card = (label, value, unit, sub = "") => `<div class="stat-card"><span class="stat-label">${label}</span><span class="stat-value num">${value}<span class="stat-unit">${unit}</span></span>${sub ? `<span class="stat-sub">${sub}</span>` : ""}</div>`;
    return `
      <section class="kpi-section" aria-label="サマリー">
        <div class="stat-grid">
          ${card("累計配信時間", KpiView.fmt(a.minutes / 60, 1), "時間", `${a.n}回・${KpiView.fmtMin(a.minutes)}`)}
          ${card("平均時給コイン", KpiView.fmt(a.coinPerHour, 1), "枚/h", `合計 ${KpiView.fmt(a.coins)}枚`)}
          ${card("平均時給フォロワー", KpiView.fmt(a.followPerHour, 1), "人/h", `合計 ${KpiView.fmt(a.follows)}人`)}
          ${card("平均視聴時間", KpiView.fmtSec(a.avgViewSec), "", "分:秒")}
        </div>
      </section>`;
  },

  ab(rows) {
    const list = Kpi.abLog(rows);
    const inner = list.length
      ? `
        <table class="data-table">
          <thead><tr><th>日付</th><th>企画</th><th>変えた内容</th><th class="r">時給コイン</th><th class="r">視聴時間</th><th class="r">ギフター</th></tr></thead>
          <tbody>${list
            .map(({ r, base }) => {
              const c = Kpi.calc(r);
              return `<tr>
                <td data-label="日付" class="num nowrap">${Util.md(Util.parseKey(r.date))} ${KpiView.slotLabel(r)}</td>
                <td data-label="企画">${Util.esc(r.title || "—")}</td>
                <td data-label="変えた内容" class="ab-test">🧪 ${Util.esc(r.test)}</td>
                <td data-label="時給コイン" class="r num">${KpiView.fmt(c.coinPerHour, 1)} ${base ? KpiView.delta(c.coinPerHour, base.coinPerHour) : ""}</td>
                <td data-label="視聴時間" class="r num">${KpiView.fmtSec(r.avgViewSec)} ${base ? KpiView.delta(r.avgViewSec / 60, base.avgViewSec / 60) : ""}</td>
                <td data-label="ギフター" class="r num">${r.gifters} ${base ? KpiView.delta(r.gifters, base.avgGifters) : ""}</td>
              </tr>`;
            })
            .join("")}</tbody>
        </table>
        <p class="hint muted small">±は同じ企画の「テストなし」平均との差（視聴時間は分）。比較元がない場合は表示しません。</p>`
      : `<p class="muted">まだA/Bテストの記録がありません。週間シフトの枠編集か、KPI記録の「🧪 試した変更点」に入れると、ここで比較できます。</p>`;
    return `<section class="panel kpi-section"><h3 class="kpi-h">🧪 A/Bテスト検証ログ</h3>${inner}</section>`;
  },

  ranking(rows, sort) {
    const list = Kpi.byTitle(rows, sort);
    if (!list.length) return `<section class="panel kpi-section"><h3 class="kpi-h">企画・ゲーム別ランキング</h3><p class="muted">企画名のある記録がまだありません。</p></section>`;
    const maxC = Math.max(...list.map((x) => x.coinPerHour), 1);
    const maxF = Math.max(...list.map((x) => x.followPerHour), 1);
    const bar = (v, max, tone) => `<span class="bar" data-tone="${tone}" style="--w:${((v / max) * 100).toFixed(1)}%"></span>`;
    return `
      <section class="panel kpi-section">
        <div class="kpi-h-row"><h3 class="kpi-h">企画・ゲーム別ランキング</h3>${KpiView.seg("sort", [["coin", "時給コイン順"], ["follow", "フォロワー効率順"]], sort)}</div>
        <table class="data-table rank-table">
          <thead><tr><th>#</th><th>企画</th><th class="r">回数</th><th>時給コイン</th><th>時給フォロワー</th><th class="r">視聴時間</th><th class="r">ギフター/回</th></tr></thead>
          <tbody>${list
            .map(
              (x, i) => `<tr ${x.low ? 'data-low="true"' : ""}>
                <td data-label="順位" class="num rank-no">${x.low ? "–" : i + 1}</td>
                <td data-label="企画" class="rank-name">${Util.esc(x.name)}</td>
                <td data-label="回数" class="r num">${KpiView.n(x)}</td>
                <td data-label="時給コイン" class="barcell"><span class="num">${KpiView.fmt(x.coinPerHour, 1)}</span>${bar(x.coinPerHour, maxC, "coin")}</td>
                <td data-label="時給フォロワー" class="barcell"><span class="num">${KpiView.fmt(x.followPerHour, 1)}</span>${bar(x.followPerHour, maxF, "follow")}</td>
                <td data-label="視聴時間" class="r num">${KpiView.fmtSec(x.avgViewSec)}</td>
                <td data-label="ギフター/回" class="r num">${KpiView.fmt(x.avgGifters, 1)}</td>
              </tr>`,
            )
            .join("")}</tbody>
        </table>
      </section>`;
  },

  slotTable(rows) {
    const list = Kpi.bySlotKind(rows);
    const maxC = Math.max(...list.map((x) => x.coinPerHour), 1);
    return `
      <section class="panel kpi-section">
        <h3 class="kpi-h">時間帯 × 枠種別 の期待値</h3>
        <table class="data-table">
          <thead><tr><th>枠</th><th class="r">回数</th><th>平均時給コイン</th><th class="r">時給フォロワー</th><th class="r">平均視聴時間</th></tr></thead>
          <tbody>${list
            .map(
              (x) => `<tr ${x.low ? 'data-low="true"' : ""}>
                <td data-label="枠" class="nowrap">${CONFIG.SLOTS[x.slot].icon} ${CONFIG.SLOTS[x.slot].label.replace("枠", "")} ${UI.kindBadge(x.kind)}</td>
                <td data-label="回数" class="r num">${KpiView.n(x)}</td>
                <td data-label="平均時給コイン" class="barcell"><span class="num">${KpiView.fmt(x.coinPerHour, 1)}</span><span class="bar" data-tone="coin" style="--w:${((x.coinPerHour / maxC) * 100).toFixed(1)}%"></span></td>
                <td data-label="時給フォロワー" class="r num">${KpiView.fmt(x.followPerHour, 1)}</td>
                <td data-label="平均視聴時間" class="r num">${KpiView.fmtSec(x.avgViewSec)}</td>
              </tr>`,
            )
            .join("")}</tbody>
        </table>
      </section>`;
  },

  shortCompare(rows) {
    const { yes, no } = Kpi.byShort(rows);
    const col = (label, a, other) => `
      <div class="cmp-col" ${a.low ? 'data-low="true"' : ""}>
        <div class="cmp-head">${label} ${KpiView.n(a)}</div>
        ${a.n
          ? `<dl class="cmp-list">
              <div><dt>新規フォロワー/回</dt><dd class="num">${KpiView.fmt(a.avgFollows, 1)} ${other.n ? KpiView.delta(a.avgFollows, other.avgFollows) : ""}</dd></div>
              <div><dt>時給コイン</dt><dd class="num">${KpiView.fmt(a.coinPerHour, 1)} ${other.n ? KpiView.delta(a.coinPerHour, other.coinPerHour) : ""}</dd></div>
              <div><dt>時給フォロワー</dt><dd class="num">${KpiView.fmt(a.followPerHour, 1)}</dd></div>
            </dl>`
          : `<p class="muted small">記録がありません</p>`}
      </div>`;
    const note = !yes.n || !no.n ? `<p class="hint muted small">比較するには「あり」「なし」両方の記録が必要です。</p>` : `<p class="hint muted small">±はもう一方との差。</p>`;
    return `
      <section class="panel kpi-section">
        <h3 class="kpi-h">直前ショート動画：あり vs なし</h3>
        <div class="cmp-grid">${col("🎬 あり", yes, no)}${col("なし", no, yes)}</div>
        ${note}
      </section>`;
  },

  history(all, limit = 30) {
    const list = all.slice(0, limit);
    return `
      <section class="panel kpi-section">
        <div class="kpi-h-row">
          <h3 class="kpi-h">履歴 <span class="muted small">${all.length}件</span></h3>
          <button type="button" class="btn small" data-variant="ghost" data-action="kpi-csv">⬇ CSVエクスポート</button>
        </div>
        <table class="data-table history-table">
          <thead><tr><th>日付</th><th>企画</th><th class="r">時間</th><th class="r">コイン</th><th class="r">時給</th><th class="r">フォロワー</th><th class="r">同接</th><th></th></tr></thead>
          <tbody>${list
            .map((r) => {
              const c = Kpi.calc(r);
              return `<tr>
                <td data-label="日付" class="nowrap"><span class="num">${Util.md(Util.parseKey(r.date))}</span> ${CONFIG.SLOTS[r.slot].icon} ${UI.kindBadge(r.kind)}</td>
                <td data-label="企画">${Util.esc(r.title || "—")}${r.test ? `<div class="muted small">🧪 ${Util.esc(r.test)}</div>` : ""}${r.next ? `<div class="muted small">→ ${Util.esc(r.next)}</div>` : ""}</td>
                <td data-label="時間" class="r num">${r.minutes}分</td>
                <td data-label="コイン" class="r num">${KpiView.fmt(r.coins)}</td>
                <td data-label="時給コイン" class="r num">${KpiView.fmt(c.coinPerHour, 1)}</td>
                <td data-label="フォロワー" class="r num">${KpiView.fmt(r.follows)}</td>
                <td data-label="最大同接" class="r num">${KpiView.fmt(r.peakViewers)}</td>
                <td class="row-actions">
                  <button type="button" class="btn small" data-variant="ghost" data-action="kpi-edit" data-id="${Util.esc(r.id)}">編集</button>
                  <button type="button" class="icon-btn" data-action="kpi-delete" data-id="${Util.esc(r.id)}" aria-label="削除">🗑</button>
                </td>
              </tr>`;
            })
            .join("")}</tbody>
        </table>
        ${all.length > limit ? `<div class="row-end"><button type="button" class="btn small" data-variant="ghost" data-action="kpi-more">さらに表示（残り ${all.length - limit}件）</button></div>` : ""}
      </section>`;
  },
};
