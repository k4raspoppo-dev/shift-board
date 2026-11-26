/*
 * 配信シフト — 配信を副業として無理なく続けるためのシフト管理ツール
 *
 * 構成（このファイルの中を上から順に）
 *   1. CONFIG       設定定数（枠の既定値・タブ・上限値など）
 *   2. Util         日付・時刻・文字列の小道具
 *   3. Store        localStorage の読み書き・データ移行・エクスポート/インポート
 *   4. ShiftLogic   本業シフト → 配信シフトの自動生成（DOM に触れない純粋関数）
 *   5. Announce     X告知文の整形と NG 語チェック（純粋関数）
 *   6. Sync         Google Apps Script との同期
 *   7. UI           共通部品（バッジ・ダイアログ・トースト）
 *   8. Views        TodayView / WeekView / ComingSoon / SettingsView
 *   9. App          タブ切替・イベント・時計・起動
 *
 * タブを追加するとき：CONFIG.TABS に1行足し、Views に同じ id の描画オブジェクトを1つ足す。
 * ES Modules は file:// で動かないため、1ファイル内を名前空間で区切っている。
 */
"use strict";

/* ======================================================================
 * 1. CONFIG
 * ==================================================================== */
const CONFIG = Object.freeze({
  STORAGE_KEY: "shiftBoard.v1",
  SCHEMA: 1,
  PUBLIC_URL: "https://k4raspoppo-dev.github.io/shift-board/",

  TABS: [
    { id: "today", label: "今日", icon: "◉" },
    { id: "week", label: "週間シフト", icon: "▦" },
    { id: "timer", label: "タイマー", icon: "⏱", soon: true },
    { id: "kpi", label: "KPI", icon: "▲", soon: true },
  ],

  SLOT_ORDER: ["morning", "noon", "night"],
  SLOTS: {
    morning: { label: "朝枠", icon: "☀", announceIcon: "🌅", start: "08:00", end: "10:30", kind: "flow" },
    noon: { label: "昼枠", icon: "◐", announceIcon: "☀️", start: "13:00", end: "15:00", kind: "adjust" },
    night: { label: "夜枠", icon: "☾", announceIcon: "🌙", start: "24:00", end: "26:00", kind: "stock" },
  },
  KINDS: {
    flow: { label: "フロー", icon: "☀", hint: "収益・新規獲得" },
    stock: { label: "ストック", icon: "☾", hint: "ファン化・没入" },
    adjust: { label: "調整", icon: "◐", hint: "時間をズラした枠" },
  },

  // 本業シフトの内部ID。表示名は公開コードに書かず、設定データ（jobLabels）に持つ
  JOB_IDS: ["shiftA", "shiftB", "shiftC", "shiftD", "tbd"],
  JOB_DEFAULT_LABELS: { shiftA: "昼〜夜", shiftB: "昼〜深夜", shiftC: "夜間拘束", shiftD: "休み", tbd: "未定" },
  JOB_RULES: {
    shiftA: "昼出勤〜夜終業。朝枠ON、夜枠は週の負荷を見て配置",
    shiftB: "昼出勤〜帰宅0時過ぎ。朝枠ON、夜枠OFF",
    shiftC: "20:00〜翌8:00拘束。夜枠OFF・朝枠OFF、翌日の朝枠もOFF",
    shiftD: "休み。配信OFF（休養・工場日）",
    tbd: "未定。配信を自動配置しない",
  },

  MAX_DOUBLE_DAYS: 3, // 朝＋夜の両方ONにする日の上限（週）
  MIN_REST_DAYS: 1, // 完全配信OFFの日の下限（週）

  DEFAULT_ROUTINE: ["飲み物を準備", "切り抜き投稿を確認", "配信ソフトを起動", "音量チェック"],
  DEFAULT_NG_WORDS: ["仕事", "本業", "出勤", "勤務", "バイト", "職場"],
  ROUTINE_SOFT_LIMIT: 6,

  SYNC_DEBOUNCE_MS: 2000,
  SYNC_POLL_MS: 5 * 60 * 1000,
  TICK_MS: 30 * 1000,
  WEEKDAYS: ["日", "月", "火", "水", "木", "金", "土"],
});

/* ======================================================================
 * 2. Util
 * ==================================================================== */
const Util = {
  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  },
  uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).replace(/-/g, "").slice(0, 12);
  },
  clone(o) {
    return typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o));
  },
  // ---- 日付（ローカル時刻の YYYY-MM-DD をキーにする）
  dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  },
  parseKey(k) {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d);
  },
  addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  },
  mondayOf(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Util.addDays(x, -((x.getDay() + 6) % 7));
  },
  md(d) {
    return `${d.getMonth() + 1}/${d.getDate()}(${CONFIG.WEEKDAYS[d.getDay()]})`;
  },
  ymd(d) {
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  },
  // ---- 時刻（"24:00" のような24時超え表記を分で扱う）
  toMin(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  },
  fmtTime(min, pad = true) {
    const h = Math.floor(min / 60);
    const m = String(min % 60).padStart(2, "0");
    return `${pad ? String(h).padStart(2, "0") : h}:${m}`;
  },
  normTime(t) {
    const m = /^(\d{1,2}):?(\d{2})$/.exec(String(t).trim().replace("：", ":"));
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 47 || mi > 59) return null;
    return Util.fmtTime(h * 60 + mi);
  },
  duration(ms) {
    const total = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? `${h}時間${m}分` : `${m}分`;
  },
  hm(d) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  },
  b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  b64urlDecode(s) {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  },
};

/* ======================================================================
 * 3. Store
 *   state.data  … 同期対象（週のシフト・ルーチン項目・本業表示名・NG語・生成設定）
 *   state.local … この端末だけ（ルーチンのチェック・表示設定・同期設定）
 * ==================================================================== */
const Store = {
  state: null,

  defaultSlot(k) {
    const d = CONFIG.SLOTS[k];
    return { on: false, start: d.start, end: d.end, kind: d.kind, memo: "", lock: null, manual: false };
  },
  emptyDay() {
    const slots = {};
    for (const k of CONFIG.SLOT_ORDER) slots[k] = Store.defaultSlot(k);
    return { job: "tbd", slots };
  },
  defaultData() {
    return {
      schema: CONFIG.SCHEMA,
      weeks: {},
      routineItems: CONFIG.DEFAULT_ROUTINE.map((text) => ({ id: Util.uid(), text })),
      jobLabels: { ...CONFIG.JOB_DEFAULT_LABELS },
      ngWords: [...CONFIG.DEFAULT_NG_WORDS],
      prefs: { suggestNoonOnShiftC: false },
    };
  },
  defaultLocal() {
    return {
      routineChecks: {},
      nightFormat: "sameDay", // sameDay: 24:00〜26:00 / nextDay: 翌日 0:00〜2:00
      hideJob: false,
      installDismissed: false,
      sync: { url: "", key: "", device: "PC", includeJob: true, rev: 0, dirty: false, lastSyncAt: null, lastError: null },
    };
  },

  // 欠けている項目を既定値で埋める（将来のスキーマ追加にも使う）
  migrateData(data) {
    const base = Store.defaultData();
    const d = { ...base, ...(data || {}) };
    d.jobLabels = { ...base.jobLabels, ...(d.jobLabels || {}) };
    d.prefs = { ...base.prefs, ...(d.prefs || {}) };
    if (!Array.isArray(d.routineItems)) d.routineItems = base.routineItems;
    if (!Array.isArray(d.ngWords)) d.ngWords = base.ngWords;
    for (const wk of Object.values(d.weeks || {})) {
      if (!Array.isArray(wk.days) || wk.days.length !== 7) wk.days = Array.from({ length: 7 }, Store.emptyDay);
      wk.days = wk.days.map((day) => {
        const e = Store.emptyDay();
        const out = { job: CONFIG.JOB_IDS.includes(day?.job) ? day.job : "tbd", slots: {} };
        for (const k of CONFIG.SLOT_ORDER) out.slots[k] = { ...e.slots[k], ...(day?.slots?.[k] || {}) };
        return out;
      });
    }
    d.schema = CONFIG.SCHEMA;
    delete d.jobStripped;
    return d;
  },

  load() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || "null");
    } catch (e) {
      raw = null;
    }
    const local = { ...Store.defaultLocal(), ...(raw?.local || {}) };
    local.sync = { ...Store.defaultLocal().sync, ...(raw?.local?.sync || {}) };
    Store.state = { data: Store.migrateData(raw?.data), local };
    Store.pruneChecks();
  },

  write() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(Store.state));
    } catch (e) {
      UI.toast("保存できませんでした（ブラウザの保存領域を確認してください）");
    }
  },
  // 同期対象のデータを変更したとき
  save() {
    Store.state.local.sync.dirty = true;
    Store.write();
    Sync.schedule();
    UI.renderSyncStatus();
  },
  // この端末だけの設定を変更したとき
  saveLocal() {
    Store.write();
  },

  get data() {
    return Store.state.data;
  },
  get local() {
    return Store.state.local;
  },

  getWeek(mondayKey, create = false) {
    let wk = Store.data.weeks[mondayKey];
    if (!wk && create) {
      wk = { days: Array.from({ length: 7 }, Store.emptyDay), generatedAt: null, updatedAt: null };
      Store.data.weeks[mondayKey] = wk;
    }
    return wk || null;
  },
  getDay(date) {
    const mon = Util.mondayOf(date);
    const wk = Store.getWeek(Util.dateKey(mon));
    return wk ? wk.days[(date.getDay() + 6) % 7] : null;
  },
  touchWeek(mondayKey) {
    const wk = Store.getWeek(mondayKey, true);
    wk.updatedAt = new Date().toISOString();
  },
  jobLabel(id) {
    return Store.data.jobLabels[id] || CONFIG.JOB_DEFAULT_LABELS[id] || id;
  },

  pruneChecks() {
    const keep = Util.dateKey(Util.addDays(new Date(), -7));
    for (const k of Object.keys(Store.local.routineChecks)) if (k < keep) delete Store.local.routineChecks[k];
  },

  exportJSON() {
    return JSON.stringify({ app: "shift-board", schema: CONFIG.SCHEMA, exportedAt: new Date().toISOString(), data: Store.data }, null, 2);
  },
  parseImport(text) {
    const obj = JSON.parse(text);
    const data = obj && obj.data ? obj.data : obj;
    if (!data || typeof data !== "object" || typeof data.weeks !== "object") throw new Error("形式が違います");
    return Store.migrateData(data);
  },
};

/* ======================================================================
 * 4. ShiftLogic（本業・睡眠最優先の自動生成）
 * ==================================================================== */
const ShiftLogic = {
  // lock の理由（自動でOFFにした理由）。手動でONにすると「ルール外」表示になる
  lockReason(lock) {
    const c = Store.jobLabel("shiftC");
    return (
      {
        afterC: `「${c}」明けのため自動OFF（回復優先）`,
        shiftC: `「${c}」の日のため自動OFF（体力温存）`,
        shiftB: "帰宅が0時過ぎの日のため自動OFF",
        double: `朝＋夜の日を週${CONFIG.MAX_DOUBLE_DAYS}日までに抑えるため自動OFF`,
        rest: `週${CONFIG.MIN_REST_DAYS}日の完全オフを確保するため自動OFF`,
      }[lock] || ""
    );
  },

  /**
   * @param {string[]} jobs 月〜日の本業シフトID
   * @param {string} prevJob 前週日曜の本業シフトID
   * @param {{suggestNoonOnShiftC:boolean}} prefs
   * @param {object[]} [oldDays] 既存の日データ（企画メモと手動の時間を引き継ぐ）
   */
  generate(jobs, prevJob, prefs, oldDays = []) {
    const days = jobs.map((job, i) => {
      const prev = i === 0 ? prevJob : jobs[i - 1];
      const afterC = prev === "shiftC";
      const slots = {};
      for (const k of CONFIG.SLOT_ORDER) {
        const s = Store.defaultSlot(k);
        const old = oldDays[i]?.slots?.[k];
        if (old) {
          s.memo = old.memo || "";
          s.start = old.start || s.start;
          s.end = old.end || s.end;
          s.kind = old.kind || s.kind;
        }
        slots[k] = s;
      }
      const set = (k, on, lock = null) => {
        slots[k].on = on;
        slots[k].lock = lock;
      };

      switch (job) {
        case "shiftA":
          afterC ? set("morning", false, "afterC") : set("morning", true);
          break; // 夜枠は週全体を見て後で配置
        case "shiftB":
          afterC ? set("morning", false, "afterC") : set("morning", true);
          set("night", false, "shiftB");
          break;
        case "shiftC":
          set("morning", false, afterC ? "afterC" : "shiftC");
          set("night", false, "shiftC");
          if (prefs.suggestNoonOnShiftC) set("noon", true);
          break;
        case "shiftD":
          break; // 休養・工場日
        default:
          if (afterC) set("morning", false, "afterC");
      }
      return { job, slots };
    });

    // 夜枠：shiftA で朝枠ONの日から、朝＋夜の日が上限に収まるよう間隔を空けて配置
    const cands = days.map((_, i) => i).filter((i) => days[i].job === "shiftA" && days[i].slots.morning.on);
    const picks = ShiftLogic.spread(cands, CONFIG.MAX_DOUBLE_DAYS);
    for (const i of cands) {
      const on = picks.includes(i);
      days[i].slots.night.on = on;
      days[i].slots.night.lock = on ? null : "double";
    }

    ShiftLogic.ensureRest(days);
    return days;
  },

  spread(arr, k) {
    if (arr.length <= k) return arr.slice();
    if (k <= 0) return [];
    if (k === 1) return [arr[Math.floor(arr.length / 2)]];
    const out = [];
    for (let j = 0; j < k; j++) out.push(arr[Math.round((j * (arr.length - 1)) / (k - 1))]);
    return [...new Set(out)];
  },

  isOff(day) {
    return CONFIG.SLOT_ORDER.every((k) => !day.slots[k].on);
  },

  // 完全配信OFFの日を最低 MIN_REST_DAYS 日つくる（負担の軽い候補から、週末側を優先）
  ensureRest(days) {
    let need = CONFIG.MIN_REST_DAYS - days.filter(ShiftLogic.isOff).length;
    const priority = [
      (d) => d.job === "tbd",
      (d) => d.job === "shiftC",
      (d) => d.job === "shiftA" && !d.slots.night.on,
      (d) => d.job === "shiftB",
      () => true,
    ];
    for (const test of priority) {
      for (let i = days.length - 1; i >= 0 && need > 0; i--) {
        const d = days[i];
        if (ShiftLogic.isOff(d) || !test(d)) continue;
        for (const k of CONFIG.SLOT_ORDER) {
          if (d.slots[k].on) {
            d.slots[k].on = false;
            d.slots[k].lock = "rest";
          }
        }
        need--;
      }
    }
  },

  summary(days) {
    let slots = 0;
    let doubles = 0;
    let rest = 0;
    for (const d of days) {
      const on = CONFIG.SLOT_ORDER.filter((k) => d.slots[k].on).length;
      slots += on;
      if (d.slots.morning.on && d.slots.night.on) doubles++;
      if (on === 0) rest++;
    }
    return { slots, doubles, rest };
  },

  // 表示用：その日の自分向けステータス（データには持たず、本業シフトから毎回求める）
  statuses(day, prevDay) {
    const out = [];
    const c = Store.jobLabel("shiftC");
    if (prevDay?.job === "shiftC") out.push({ tone: "caution", text: `${c}明け：睡眠優先` });
    if (day?.job === "shiftC") out.push({ tone: "caution", text: `${c}の日：体力温存` });
    return out;
  },
};

/* ======================================================================
 * 5. Announce（X告知文。本業シフトの情報は一切使わない）
 * ==================================================================== */
const Announce = {
  build(mondayKey, days, nightFormat) {
    const mon = Util.parseKey(mondayKey);
    const byDate = new Map();
    days.forEach((day, i) => {
      for (const k of CONFIG.SLOT_ORDER) {
        const s = day.slots[k];
        if (!s.on) continue;
        let date = Util.addDays(mon, i);
        let start = Util.toMin(s.start);
        let end = Util.toMin(s.end);
        if (nightFormat === "nextDay" && start >= 1440) {
          date = Util.addDays(date, 1);
          start -= 1440;
          end -= 1440;
        }
        const key = Util.dateKey(date);
        if (!byDate.has(key)) byDate.set(key, { date, items: [] });
        byDate.get(key).items.push({ k, start, end, memo: s.memo.trim() });
      }
    });
    const sun = Util.addDays(mon, 6);
    const lines = [`【配信予定】${Util.md(mon)}〜${Util.md(sun)}`];
    const keys = [...byDate.keys()].sort();
    if (keys.length === 0) lines.push("", "今週の配信はお休みです");
    for (const key of keys) {
      const { date, items } = byDate.get(key);
      items.sort((a, b) => a.start - b.start);
      lines.push("", `▼${Util.md(date)}`);
      for (const it of items) {
        const def = CONFIG.SLOTS[it.k];
        const time = `${Util.fmtTime(it.start, false)}〜${Util.fmtTime(it.end, false)}`;
        lines.push(`${def.announceIcon} ${time}${it.memo ? `｜${it.memo}` : ""}`);
      }
    }
    return lines.join("\n");
  },

  // 本業を連想させる語が含まれていないか（NG語＋本業シフトの表示名）
  findNG(text) {
    const words = new Set(Store.data.ngWords.map((w) => w.trim()).filter(Boolean));
    for (const id of CONFIG.JOB_IDS) {
      if (id === "tbd") continue;
      const label = Store.jobLabel(id).trim();
      if (label) words.add(label);
    }
    return [...words].filter((w) => text.includes(w));
  },
};

/* ======================================================================
 * 6. Sync（Google Apps Script 経由で Google ドライブと同期）
 * ==================================================================== */
const Sync = {
  timer: null,
  pollTimer: null,
  busy: false,
  sending: false,

  get cfg() {
    return Store.local.sync;
  },
  enabled() {
    return Boolean(Sync.cfg.url && Sync.cfg.key);
  },

  async call(action, extra = {}, cfg = Sync.cfg) {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // プリフライトを発生させない
      body: JSON.stringify({ key: cfg.key, action, device: cfg.device, ...extra }),
      redirect: "follow",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  errorText(code) {
    return (
      {
        unauthorized: "合言葉が違います",
        offline: "通信できませんでした（電波・URLを確認）",
        busy: "サーバーが混み合っています",
        bad_request: "送信データが不正です",
      }[code] ||
      code ||
      ""
    );
  },

  schedule() {
    if (!Sync.enabled()) return;
    clearTimeout(Sync.timer);
    Sync.timer = setTimeout(() => Sync.push(), CONFIG.SYNC_DEBOUNCE_MS);
  },

  payload() {
    const data = Util.clone(Store.data);
    if (!Sync.cfg.includeJob) {
      for (const wk of Object.values(data.weeks)) for (const d of wk.days) d.job = "tbd";
      data.jobLabels = { ...CONFIG.JOB_DEFAULT_LABELS };
      data.jobStripped = true;
    }
    return data;
  },

  apply(res) {
    if (res.data) {
      const incoming = res.data;
      if (incoming.jobStripped) {
        // 本業を含めない同期のとき、手元の本業シフトは残す
        for (const [k, wk] of Object.entries(incoming.weeks || {})) {
          const mine = Store.data.weeks[k];
          if (mine) wk.days?.forEach((d, i) => (d.job = mine.days[i]?.job || "tbd"));
        }
        incoming.jobLabels = Store.data.jobLabels;
      }
      Store.state.data = Store.migrateData(incoming);
    }
    Object.assign(Sync.cfg, { rev: res.rev, dirty: false, lastSyncAt: new Date().toISOString(), lastError: null });
    Store.write();
    App.render();
  },

  async push(force = false) {
    if (!Sync.enabled()) return;
    if (Sync.busy) return Sync.schedule();
    Sync.busy = true;
    Sync.sending = true;
    UI.renderSyncStatus();
    let conflict = null;
    try {
      const res = await Sync.call("push", { baseRev: Sync.cfg.rev, data: Sync.payload(), force });
      if (res.ok) Object.assign(Sync.cfg, { rev: res.rev, dirty: false, lastSyncAt: new Date().toISOString(), lastError: null });
      else if (res.error === "conflict") conflict = res;
      else Sync.cfg.lastError = res.error;
    } catch (e) {
      Sync.cfg.lastError = "offline";
    } finally {
      Sync.busy = false;
      Sync.sending = false;
      Store.write();
      UI.renderSyncStatus();
    }
    if (conflict) await Sync.resolveConflict(conflict);
  },

  async pull() {
    if (!Sync.enabled() || Sync.busy) return;
    Sync.busy = true;
    let res = null;
    try {
      res = await Sync.call("pull");
      if (!res.ok) Sync.cfg.lastError = res.error;
    } catch (e) {
      Sync.cfg.lastError = "offline";
    } finally {
      Sync.busy = false;
      Store.write();
      UI.renderSyncStatus();
    }
    if (!res || !res.ok) return;

    if (res.rev === Sync.cfg.rev) {
      Sync.cfg.lastSyncAt = new Date().toISOString();
      Sync.cfg.lastError = null;
      Store.write();
      UI.renderSyncStatus();
      if (Sync.cfg.dirty) Sync.push();
    } else if (res.rev > Sync.cfg.rev) {
      if (Sync.cfg.dirty) await Sync.resolveConflict(res);
      else Sync.apply(res);
    } else {
      // サーバー側が作り直された（rev が手元より小さい）→ 手元の内容を送り直す
      Sync.cfg.rev = res.rev;
      Sync.cfg.dirty = true;
      Sync.push();
    }
  },

  async resolveConflict(res) {
    const when = res.updatedAt ? `${Util.md(new Date(res.updatedAt))} ${Util.hm(new Date(res.updatedAt))}` : "不明な時刻";
    const choice = await UI.choose({
      title: "別の端末で更新されています",
      body: `<p>「${Util.esc(res.device || "別の端末")}」で ${Util.esc(when)} に保存された内容があります。<br>この端末でも未送信の変更があります。どちらを残しますか？</p>`,
      options: [
        { value: "remote", label: "ドライブ側を取り込む", variant: "primary" },
        { value: "local", label: "この端末の内容で上書き", variant: "danger" },
      ],
    });
    if (choice === "remote") Sync.apply(res);
    else if (choice === "local") Sync.push(true);
  },

  startPolling() {
    clearInterval(Sync.pollTimer);
    Sync.pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") Sync.pull();
    }, CONFIG.SYNC_POLL_MS);
  },

  // iPhone 用：PC が表示した QR（URL の # 以降）から同期設定を取り込む
  importFromHash() {
    const m = /[#&]sync=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!m) return false;
    try {
      const cfg = JSON.parse(Util.b64urlDecode(m[1]));
      if (cfg.u && cfg.k) {
        Object.assign(Sync.cfg, { url: cfg.u, key: cfg.k, device: cfg.d || "iPhone", rev: 0, dirty: false, lastError: null });
        Store.write();
        UI.toast("同期設定を読み込みました");
      }
    } catch (e) {
      UI.toast("同期設定を読み込めませんでした");
    }
    history.replaceState(null, "", location.pathname + location.search); // 合言葉を URL から消す
    return true;
  },

  setupUrl(device = "iPhone") {
    const payload = Util.b64urlEncode(JSON.stringify({ u: Sync.cfg.url, k: Sync.cfg.key, d: device }));
    return `${CONFIG.PUBLIC_URL}#sync=${payload}`;
  },
};

/* ======================================================================
 * 7. UI（共通部品）
 * ==================================================================== */
const UI = {
  kindBadge(kind) {
    const k = CONFIG.KINDS[kind] || CONFIG.KINDS.flow;
    return `<span class="badge" data-kind="${kind}"><span aria-hidden="true">${k.icon}</span>${k.label}</span>`;
  },
  pill(text, tone = "muted") {
    return `<span class="pill" data-tone="${tone}">${Util.esc(text)}</span>`;
  },
  jobChip(jobId) {
    if (!jobId || jobId === "tbd" || Store.local.hideJob) return "";
    return `<span class="job-chip">${Util.esc(Store.jobLabel(jobId))}</span>`;
  },
  timeRange(s) {
    return `<span class="num">${Util.esc(s.start)}–${Util.esc(s.end)}</span>`;
  },

  toastTimer: null,
  toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(UI.toastTimer);
    UI.toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  },

  renderSyncStatus() {
    const el = document.getElementById("syncStatus");
    if (!el) return;
    const s = Sync.cfg;
    let text;
    let tone;
    if (!Sync.enabled()) [text, tone] = ["☁ 同期オフ", "muted"];
    else if (Sync.sending) [text, tone] = ["☁ 送信中…", "secondary"];
    else if (s.lastError) [text, tone] = [s.dirty ? "☁ 未送信あり" : "☁ 同期エラー", "caution"];
    else if (s.dirty) [text, tone] = ["☁ 送信待ち", "secondary"];
    else [text, tone] = [`☁ 同期済み ${s.lastSyncAt ? Util.hm(new Date(s.lastSyncAt)) : ""}`, "muted"];
    el.textContent = text;
    el.dataset.tone = tone;
    el.title = s.lastError ? Sync.errorText(s.lastError) : "同期設定を開く";
  },

  // ---- ダイアログ（<dialog> を1つ使い回す）
  modal() {
    return document.getElementById("modal");
  },
  openModal(html, { onClose } = {}) {
    const dlg = UI.modal();
    if (dlg.open) dlg.close();
    dlg.innerHTML = html;
    dlg.onclose = () => {
      dlg.innerHTML = "";
      onClose?.(dlg.returnValue);
    };
    dlg.returnValue = "";
    dlg.showModal();
    dlg.querySelector("[autofocus]")?.focus();
  },
  closeModal(value = "") {
    const dlg = UI.modal();
    if (dlg.open) dlg.close(value);
  },
  choose({ title, body, options }) {
    return new Promise((resolve) => {
      const buttons = options
        .map((o) => `<button type="button" class="btn" data-variant="${o.variant || "ghost"}" data-action="modal-return" data-value="${Util.esc(o.value)}">${Util.esc(o.label)}</button>`)
        .join("");
      UI.openModal(
        `<div class="modal-head"><h2 id="modalTitle">${Util.esc(title)}</h2></div>
         <div class="modal-body">${body}</div>
         <div class="modal-foot"><button type="button" class="btn" data-variant="ghost" data-action="modal-return" data-value="">キャンセル</button>${buttons}</div>`,
        { onClose: (v) => resolve(v || null) },
      );
    });
  },
  async confirm({ title, body, ok = "OK", danger = false }) {
    const v = await UI.choose({ title, body, options: [{ value: "ok", label: ok, variant: danger ? "danger" : "primary" }] });
    return v === "ok";
  },

  async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  },

  download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

/* ======================================================================
 * 8. Views
 * ==================================================================== */

/* ---------- 今日のシフト ---------- */
const TodayView = {
  editing: false,

  // 今日の枠＋（日付を跨いで続いている）昨日の夜枠を、実時刻つきで並べる
  timeline(now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const items = [];
    const push = (date, day, own) => {
      if (!day) return;
      for (const k of CONFIG.SLOT_ORDER) {
        const s = day.slots[k];
        if (!s.on) continue;
        const start = date.getTime() + Util.toMin(s.start) * 60000;
        const end = date.getTime() + Util.toMin(s.end) * 60000;
        if (!own && end <= today.getTime()) continue;
        items.push({ k, s, start, end, own });
      }
    };
    push(Util.addDays(today, -1), Store.getDay(Util.addDays(today, -1)), false);
    push(today, Store.getDay(today), true);
    return items.sort((a, b) => a.start - b.start);
  },

  render() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = Util.addDays(today, 1);
    const day = Store.getDay(today);
    const prevDay = Store.getDay(Util.addDays(today, -1));
    const wk = Store.getWeek(Util.dateKey(Util.mondayOf(today)));

    const statuses = Store.local.hideJob ? [] : ShiftLogic.statuses(day, prevDay);
    const head = `
      <div class="today-head">
        <div>
          <h1 class="today-date">${today.getMonth() + 1}月${today.getDate()}日<span class="today-wd">（${CONFIG.WEEKDAYS[today.getDay()]}）</span></h1>
          <div class="pill-row">${statuses.map((s) => UI.pill(`⚠ ${s.text}`, s.tone)).join("")}</div>
        </div>
        ${UI.jobChip(day?.job)}
      </div>`;

    let main;
    const items = TodayView.timeline(now);
    const upcoming = items.filter((it) => it.end > now.getTime());
    const created = wk && (wk.generatedAt || wk.days.some((d) => d.job !== "tbd" || !ShiftLogic.isOff(d)));

    if (!created && upcoming.length === 0) {
      main = `
        <section class="panel empty-state">
          <div class="empty-icon" aria-hidden="true">▦</div>
          <h2>今週のシフトがまだありません</h2>
          <p class="muted">週間シフトタブで本業シフトを入れて、自動生成してください。</p>
          <button type="button" class="btn" data-variant="primary" data-action="tab" data-tab="week">週間シフトを作る</button>
        </section>`;
    } else if (upcoming.length > 0) {
      const hero = upcoming[0];
      const others = day ? CONFIG.SLOT_ORDER.filter((k) => !(hero.own && hero.k === k)) : [];
      main = `
        ${TodayView.heroCard(hero, now)}
        <div class="slot-grid">${others.map((k) => TodayView.smallCard(k, day.slots[k], now, today)).join("")}</div>`;
    } else if (day && !ShiftLogic.isOff(day)) {
      main = `
        <section class="panel hero done">
          <div class="hero-label">今日の配信はすべて終了</div>
          <div class="hero-title">おつかれさまでした</div>
          <p class="muted">${TodayView.firstSlotText(tomorrow) || "明日は配信オフです"}</p>
        </section>
        <div class="slot-grid">${CONFIG.SLOT_ORDER.map((k) => TodayView.smallCard(k, day.slots[k], now, today)).join("")}</div>`;
    } else {
      const restDays = wk ? wk.days.filter(ShiftLogic.isOff).length : 0;
      main = `
        <section class="panel hero rest">
          <div class="rest-icon" aria-hidden="true">🌿</div>
          <div class="hero-title">本日は配信オフ</div>
          <div class="rest-sub">休養・工場日</div>
          <p class="muted">切り抜き・ツール整備をしてもいいし、何もしなくてもいい日です。</p>
          <p class="rest-count">今週の休養日 ${restDays}日 確保済み ✓</p>
        </section>`;
    }

    return `
      <div class="today-grid">
        <div class="today-main">${head}${main}</div>
        <aside class="today-side">
          ${TodayView.tomorrowCard(tomorrow)}
          ${TodayView.routineCard(today, day)}
        </aside>
      </div>`;
  },

  heroCard(it, now) {
    const t = now.getTime();
    const live = it.start <= t;
    const def = CONFIG.SLOTS[it.k];
    const pct = live ? Math.min(100, ((t - it.start) / (it.end - it.start)) * 100) : 0;
    const rel = live ? `配信中・残り ${Util.duration(it.end - t)}` : `あと ${Util.duration(it.start - t)} で開始`;
    const fromYesterday = !it.own ? `<span class="pill" data-tone="muted">昨日の${def.label}</span>` : "";
    return `
      <section class="panel hero" data-kind="${it.s.kind}" ${live ? 'data-live="true"' : ""}>
        <div class="hero-top">
          <div class="hero-label">${UI.kindBadge(it.s.kind)}<span>${def.label}</span>${fromYesterday}</div>
          <span class="hero-state">${live ? "● ON AIR" : "次の枠"}</span>
        </div>
        <div class="hero-time num">${Util.esc(it.s.start)}<span class="hero-dash">–</span>${Util.esc(it.s.end)}</div>
        ${it.s.memo ? `<div class="hero-memo">📝 ${Util.esc(it.s.memo)}</div>` : `<div class="hero-memo muted">企画メモなし</div>`}
        <div class="hero-rel">${rel}</div>
        ${live ? `<div class="progress" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></div>` : ""}
      </section>`;
  },

  smallCard(k, s, now, today) {
    const def = CONFIG.SLOTS[k];
    const end = today.getTime() + Util.toMin(s.end) * 60000;
    const done = s.on && end <= now.getTime();
    if (!s.on) {
      return `<div class="slot-card" data-on="false"><div class="slot-card-head"><span>${def.icon} ${def.label}</span><span class="muted">OFF</span></div></div>`;
    }
    return `
      <div class="slot-card" data-kind="${s.kind}" data-on="true" ${done ? 'data-done="true"' : ""}>
        <div class="slot-card-head"><span>${UI.kindBadge(s.kind)} ${def.label}</span>${done ? '<span class="muted">終了</span>' : ""}</div>
        <div class="slot-card-time">${UI.timeRange(s)}</div>
        ${s.memo ? `<div class="slot-card-memo">${Util.esc(s.memo)}</div>` : ""}
      </div>`;
  },

  firstSlotText(date) {
    const d = Store.getDay(date);
    if (!d) return "";
    const k = CONFIG.SLOT_ORDER.find((x) => d.slots[x].on);
    return k ? `明日は ${CONFIG.SLOTS[k].label} ${d.slots[k].start} から` : "";
  },

  tomorrowCard(date) {
    const d = Store.getDay(date);
    const on = d ? CONFIG.SLOT_ORDER.filter((k) => d.slots[k].on) : [];
    const body = !d
      ? `<span class="muted">未作成</span>`
      : on.length === 0
        ? `<span class="pill" data-tone="rest">🌿 配信オフ</span>`
        : on
            .map((k) => {
              const s = d.slots[k];
              return `<span class="mini-slot" data-kind="${s.kind}"><span aria-hidden="true">${CONFIG.KINDS[s.kind].icon}</span><span class="num">${Util.esc(s.start)}</span>${s.memo ? `<span class="mini-memo">${Util.esc(s.memo)}</span>` : ""}</span>`;
            })
            .join("");
    return `
      <section class="panel side-card">
        <h2 class="side-title">明日 <span class="muted">${Util.md(date)}</span></h2>
        <div class="mini-row">${body}</div>
      </section>`;
  },

  routineCard(today, day) {
    const key = Util.dateKey(today);
    const items = Store.data.routineItems;
    const checked = new Set(Store.local.routineChecks[key] || []);
    const done = items.filter((it) => checked.has(it.id)).length;
    const restDay = day && ShiftLogic.isOff(day);
    const title = restDay ? "工場日メニュー（任意）" : "配信前ルーチン";

    if (TodayView.editing) {
      const rows = items
        .map(
          (it, i) => `
          <li class="routine-edit-row">
            <input class="input" type="text" value="${Util.esc(it.text)}" data-routine-text="${it.id}" aria-label="項目${i + 1}">
            <button type="button" class="icon-btn" data-action="routine-move" data-id="${it.id}" data-dir="-1" aria-label="上へ" ${i === 0 ? "disabled" : ""}>↑</button>
            <button type="button" class="icon-btn" data-action="routine-move" data-id="${it.id}" data-dir="1" aria-label="下へ" ${i === items.length - 1 ? "disabled" : ""}>↓</button>
            <button type="button" class="icon-btn" data-action="routine-del" data-id="${it.id}" aria-label="削除">✕</button>
          </li>`,
        )
        .join("");
      const warn = items.length > CONFIG.ROUTINE_SOFT_LIMIT ? `<p class="hint" data-tone="caution">項目が多いと初動が重くなります（おすすめは3〜4個）</p>` : "";
      return `
        <section class="panel side-card">
          <h2 class="side-title">${title}を編集</h2>
          <ul class="routine-edit">${rows}</ul>${warn}
          <div class="row-gap">
            <button type="button" class="btn" data-variant="ghost" data-action="routine-add">＋ 項目を追加</button>
            <button type="button" class="btn" data-variant="primary" data-action="routine-edit-done">完了</button>
          </div>
        </section>`;
    }

    const allDone = items.length > 0 && done === items.length;
    return `
      <section class="panel side-card">
        <div class="side-title-row">
          <h2 class="side-title">${title}</h2>
          <span class="num muted">${done}/${items.length}</span>
        </div>
        <div class="progress thin" aria-hidden="true"><span style="width:${items.length ? (done / items.length) * 100 : 0}%"></span></div>
        <ul class="checklist">
          ${items
            .map(
              (it) => `
            <li><label class="check-row" ${checked.has(it.id) ? 'data-checked="true"' : ""}>
              <input type="checkbox" data-routine-check="${it.id}" ${checked.has(it.id) ? "checked" : ""}>
              <span class="check-box" aria-hidden="true"></span><span>${Util.esc(it.text)}</span>
            </label></li>`,
            )
            .join("")}
        </ul>
        ${allDone ? `<p class="routine-done">${restDay ? "おつかれさま。ゆっくり休んでください" : "準備OK、いってらっしゃい"}</p>` : ""}
        <div class="row-end"><button type="button" class="btn small" data-variant="ghost" data-action="routine-edit">✎ 編集</button></div>
      </section>`;
  },
};

/* ---------- 週間シフト作成 ---------- */
const WeekView = {
  mondayKey: null,
  flashKeys: new Set(),

  current() {
    if (!WeekView.mondayKey) WeekView.mondayKey = Util.dateKey(Util.mondayOf(new Date()));
    return WeekView.mondayKey;
  },
  setWeek(mon) {
    WeekView.mondayKey = Util.dateKey(Util.mondayOf(mon));
    App.render();
  },
  days() {
    const wk = Store.getWeek(WeekView.current());
    return wk ? wk.days : Array.from({ length: 7 }, Store.emptyDay);
  },
  prevJob() {
    const prevMon = Util.dateKey(Util.addDays(Util.parseKey(WeekView.current()), -7));
    return Store.getWeek(prevMon)?.days[6]?.job || "tbd";
  },

  render() {
    const monKey = WeekView.current();
    const mon = Util.parseKey(monKey);
    const sun = Util.addDays(mon, 6);
    const thisMon = Util.dateKey(Util.mondayOf(new Date()));
    const nextMon = Util.dateKey(Util.addDays(Util.mondayOf(new Date()), 7));
    const days = WeekView.days();
    const wk = Store.getWeek(monKey);
    const sum = ShiftLogic.summary(days);
    const prevJob = WeekView.prevJob();

    const weekNav = `
      <section class="panel step">
        <h2 class="step-title"><span class="step-no">1</span>対象週</h2>
        <div class="week-nav">
          <button type="button" class="icon-btn" data-action="week-shift" data-dir="-7" aria-label="前の週">‹</button>
          <div class="segmented" role="group" aria-label="週を選ぶ">
            <button type="button" data-action="week-jump" data-key="${thisMon}" aria-pressed="${monKey === thisMon}">今週</button>
            <button type="button" data-action="week-jump" data-key="${nextMon}" aria-pressed="${monKey === nextMon}">来週</button>
          </div>
          <button type="button" class="icon-btn" data-action="week-shift" data-dir="7" aria-label="次の週">›</button>
          <span class="week-range num">${Util.ymd(mon)}(月) 〜 ${Util.ymd(sun).slice(5)}(日)</span>
          <label class="date-pick"><span>開始日を指定</span><input class="input" type="date" value="${monKey}" data-week-date></label>
        </div>
      </section>`;

    const jobs = `
      <section class="panel step pc-only">
        <h2 class="step-title"><span class="step-no">2</span>本業シフト <button type="button" class="link-btn" data-action="open-settings" data-section="labels">表示名を変更</button></h2>
        <div class="job-grid">
          ${days
            .map((d, i) => {
              const date = Util.addDays(mon, i);
              const prev = i === 0 ? prevJob : days[i - 1].job;
              return `
              <div class="job-col">
                <div class="job-day">${CONFIG.WEEKDAYS[date.getDay()]} <span class="num muted">${date.getMonth() + 1}/${date.getDate()}</span>${prev === "shiftC" ? `<span class="carry" title="前日が「${Util.esc(Store.jobLabel("shiftC"))}」">→</span>` : ""}</div>
                <div class="job-options" role="radiogroup" aria-label="${CONFIG.WEEKDAYS[date.getDay()]}曜の本業シフト">
                  ${CONFIG.JOB_IDS.map((id) => `<button type="button" role="radio" aria-checked="${d.job === id}" data-action="set-job" data-day="${i}" data-job="${id}" title="${Util.esc(CONFIG.JOB_RULES[id])}">${Util.esc(Store.jobLabel(id))}</button>`).join("")}
                </div>
              </div>`;
            })
            .join("")}
        </div>
      </section>`;

    const restOk = sum.rest >= CONFIG.MIN_REST_DAYS;
    const generate = `
      <section class="panel step pc-only">
        <h2 class="step-title"><span class="step-no">3</span>自動生成</h2>
        <div class="gen-row">
          <button type="button" class="btn big" data-variant="primary" data-action="generate">⚡ 本業シフトから配信シフトを自動生成</button>
          <label class="switch-label">
            <input type="checkbox" role="switch" class="switch" data-pref="suggestNoonOnShiftC" ${Store.data.prefs.suggestNoonOnShiftC ? "checked" : ""}>
            <span>「${Util.esc(Store.jobLabel("shiftC"))}」の日は昼枠を自動提案</span>
          </label>
        </div>
        <p class="summary">
          配信 <b class="num">${sum.slots}</b>枠
          <span class="sep">／</span>朝+夜の日 <b class="num" ${sum.doubles > CONFIG.MAX_DOUBLE_DAYS ? 'data-tone="caution"' : ""}>${sum.doubles}/${CONFIG.MAX_DOUBLE_DAYS}</b>
          <span class="sep">／</span>完全オフ <b class="num" data-tone="${restOk ? "rest" : "caution"}">${sum.rest}日 ${restOk ? "✓" : "⚠"}</b>
          ${wk?.generatedAt ? `<span class="muted small">（${Util.md(new Date(wk.generatedAt))} 生成）</span>` : ""}
        </p>
      </section>`;

    const cards = `
      <section class="panel step">
        <h2 class="step-title"><span class="step-no">4</span>配信シフト <span class="muted small">スイッチでON/OFF、枠をクリックで編集</span></h2>
        <p class="mobile-note">本業シフトの入力・自動生成・X告知はPCで行います</p>
        <div class="week-grid">${days.map((d, i) => WeekView.dayCard(d, i, mon, i === 0 ? prevJob : days[i - 1].job, wk)).join("")}</div>
      </section>`;

    const text = Announce.build(monKey, days, Store.local.nightFormat);
    const ng = Announce.findNG(text);
    const announce = `
      <section class="panel step pc-only">
        <h2 class="step-title"><span class="step-no">5</span>X告知テキスト</h2>
        <div class="announce-opts">
          <span class="muted">夜枠の表記</span>
          <div class="segmented" role="radiogroup" aria-label="夜枠の表記">
            <button type="button" role="radio" aria-checked="${Store.local.nightFormat === "sameDay"}" data-action="night-format" data-value="sameDay">24:00〜26:00（同日）</button>
            <button type="button" role="radio" aria-checked="${Store.local.nightFormat === "nextDay"}" data-action="night-format" data-value="nextDay">0:00〜2:00（翌日に繰り上げ）</button>
          </div>
        </div>
        <div class="announce-box">
          <pre class="announce-preview" ${ng.length ? 'data-ng="true"' : ""}>${Util.esc(text)}</pre>
          <button type="button" class="btn" data-variant="primary" data-action="copy-announce" ${ng.length ? "disabled" : ""}>📋 コピー</button>
        </div>
        ${ng.length ? `<p class="hint" data-tone="danger">⚠ 告知文に私生活が透ける語が含まれています：${ng.map((w) => `「${Util.esc(w)}」`).join("")}　企画メモを修正してください</p>` : `<p class="hint muted">本業シフトの情報は告知文に含まれません。</p>`}
      </section>`;

    return `<div class="week-view">${weekNav}${jobs}${generate}${cards}${announce}</div>`;
  },

  dayCard(d, i, mon, prevJob, wk) {
    const date = Util.addDays(mon, i);
    const isToday = Util.dateKey(date) === Util.dateKey(new Date());
    const off = ShiftLogic.isOff(d);
    const rest = off && (d.job !== "tbd" || wk?.generatedAt);
    const statuses = ShiftLogic.statuses(d, { job: prevJob });
    return `
      <article class="day-card" ${isToday ? 'data-today="true"' : ""} ${rest ? 'data-rest="true"' : ""}>
        <header class="day-head">
          <span class="day-date"><b>${CONFIG.WEEKDAYS[date.getDay()]}</b> <span class="num">${date.getMonth() + 1}/${date.getDate()}</span>${isToday ? '<span class="today-dot">今日</span>' : ""}</span>
          ${d.job !== "tbd" ? `<span class="job-chip">${Util.esc(Store.jobLabel(d.job))}</span>` : ""}
        </header>
        ${statuses.length ? `<div class="pill-row">${statuses.map((s) => UI.pill(s.text, s.tone)).join("")}</div>` : ""}
        ${rest ? `<div class="pill-row">${UI.pill("🌿 休養・工場日", "rest")}</div>` : ""}
        <div class="slot-list">${CONFIG.SLOT_ORDER.map((k) => WeekView.slotRow(d.slots[k], k, i)).join("")}</div>
      </article>`;
  },

  slotRow(s, k, i) {
    const def = CONFIG.SLOTS[k];
    const flash = WeekView.flashKeys.has(`${i}-${k}`) ? 'data-flash="true"' : "";
    const outside = s.on && s.lock ? `<span class="rule-out" title="${Util.esc(ShiftLogic.lockReason(s.lock))}">⚠ ルール外</span>` : "";
    const lock = !s.on && s.lock ? `<span class="lock" title="${Util.esc(ShiftLogic.lockReason(s.lock))}" aria-label="${Util.esc(ShiftLogic.lockReason(s.lock))}">🔒</span>` : "";
    return `
      <div class="slot-row" data-kind="${s.kind}" data-on="${s.on}" ${flash}>
        <input type="checkbox" role="switch" class="switch" ${s.on ? "checked" : ""} data-slot-toggle="${i}:${k}" aria-label="${def.label}のON/OFF">
        <button type="button" class="slot-body" data-action="edit-slot" data-day="${i}" data-slot="${k}">
          <span class="slot-line"><span class="slot-name">${CONFIG.KINDS[s.kind].icon} ${def.label}</span>${lock}${outside}</span>
          ${s.on ? `<span class="slot-time">${UI.timeRange(s)}</span>` : `<span class="slot-time muted">OFF</span>`}
          ${s.on && s.memo ? `<span class="slot-memo">${Util.esc(s.memo)}</span>` : ""}
        </button>
      </div>`;
  },

  // ---- 操作
  mutate(fn) {
    const key = WeekView.current();
    const wk = Store.getWeek(key, true);
    fn(wk);
    Store.touchWeek(key);
    Store.save();
    App.render();
  },

  async generate() {
    const key = WeekView.current();
    const wk = Store.getWeek(key, true);
    const manual = wk.days.reduce((n, d) => n + CONFIG.SLOT_ORDER.filter((k) => d.slots[k].manual).length, 0);
    if (manual > 0) {
      const ok = await UI.confirm({
        title: "自動生成で上書きしますか？",
        body: `<p>手動で編集した <b>${manual}</b> 枠のON/OFFが上書きされます（企画メモと時間は残ります）。</p>`,
        ok: "上書きして生成",
      });
      if (!ok) return;
    }
    const before = Util.clone(wk.days);
    const jobs = wk.days.map((d) => d.job);
    wk.days = ShiftLogic.generate(jobs, WeekView.prevJob(), Store.data.prefs, before);
    wk.generatedAt = new Date().toISOString();
    WeekView.flashKeys = new Set();
    wk.days.forEach((d, i) => CONFIG.SLOT_ORDER.forEach((k) => d.slots[k].on !== before[i].slots[k].on && WeekView.flashKeys.add(`${i}-${k}`)));
    Store.touchWeek(key);
    Store.save();
    App.render();
    setTimeout(() => (WeekView.flashKeys = new Set()), 900);
    UI.toast("配信シフトを生成しました");
  },

  openEditor(i, k) {
    const key = WeekView.current();
    const d = WeekView.days()[i];
    const s = d.slots[k];
    const def = CONFIG.SLOTS[k];
    const date = Util.addDays(Util.parseKey(key), i);
    const memos = WeekView.memoSuggestions();
    UI.openModal(`
      <form class="slot-editor" data-form="slot" data-day="${i}" data-slot="${k}" method="dialog">
        <div class="modal-head"><h2 id="modalTitle">${Util.md(date)} ${def.label}を編集</h2><button type="button" class="icon-btn" data-action="modal-return" aria-label="閉じる">✕</button></div>
        <div class="modal-body form-grid">
          <label class="switch-label"><input type="checkbox" role="switch" class="switch" name="on" ${s.on ? "checked" : ""}><span>配信する</span></label>
          ${s.lock ? `<p class="hint" data-tone="caution">🔒 ${Util.esc(ShiftLogic.lockReason(s.lock))}。ONにすると「ルール外」として表示されます。</p>` : ""}
          <div class="field">
            <span class="field-label">時間 <span class="muted small">24時以降は 24:00〜 の表記で入力</span></span>
            <div class="time-row">
              ${WeekView.timeInput("start", s.start)}<span>〜</span>${WeekView.timeInput("end", s.end)}
            </div>
          </div>
          <div class="field">
            <span class="field-label">種別</span>
            <div class="segmented" role="radiogroup">
              ${Object.entries(CONFIG.KINDS)
                .map(([id, kd]) => `<label class="seg-radio"><input type="radio" name="kind" value="${id}" ${s.kind === id ? "checked" : ""}><span>${kd.icon} ${kd.label}</span></label>`)
                .join("")}
            </div>
          </div>
          <label class="field"><span class="field-label">企画メモ</span>
            <input class="input" type="text" name="memo" value="${Util.esc(s.memo)}" list="memoList" placeholder="例：マイクラ妨害、ホラー" autocomplete="off" autofocus>
            <datalist id="memoList">${memos.map((m) => `<option value="${Util.esc(m)}">`).join("")}</datalist>
          </label>
          <p class="form-error" data-form-error hidden></p>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn" data-variant="ghost" data-action="slot-reset">既定の時間に戻す</button>
          <span class="spacer"></span>
          <button type="button" class="btn" data-variant="ghost" data-action="modal-return">キャンセル</button>
          <button type="submit" class="btn" data-variant="primary">保存</button>
        </div>
      </form>`);
  },

  timeInput(name, value) {
    return `
      <span class="time-input">
        <button type="button" class="icon-btn" data-action="time-step" data-target="${name}" data-step="-15" aria-label="15分早く">−</button>
        <input class="input num" type="text" inputmode="numeric" name="${name}" value="${Util.esc(value)}" maxlength="5" aria-label="${name === "start" ? "開始" : "終了"}時刻">
        <button type="button" class="icon-btn" data-action="time-step" data-target="${name}" data-step="15" aria-label="15分遅く">＋</button>
      </span>`;
  },

  memoSuggestions() {
    const set = new Set();
    for (const wk of Object.values(Store.data.weeks)) for (const d of wk.days) for (const k of CONFIG.SLOT_ORDER) if (d.slots[k].memo) set.add(d.slots[k].memo.trim());
    return [...set].slice(-30);
  },

  saveEditor(form) {
    const i = Number(form.dataset.day);
    const k = form.dataset.slot;
    const fd = new FormData(form);
    const start = Util.normTime(fd.get("start"));
    const end = Util.normTime(fd.get("end"));
    const err = form.querySelector("[data-form-error]");
    if (!start || !end || Util.toMin(end) <= Util.toMin(start)) {
      err.textContent = "時間は「08:00」の形式で、終了を開始より後にしてください（24時以降は 24:00〜47:59）";
      err.hidden = false;
      return;
    }
    WeekView.mutate((wk) => {
      const s = wk.days[i].slots[k];
      Object.assign(s, { on: fd.get("on") === "on", start, end, kind: fd.get("kind") || s.kind, memo: String(fd.get("memo") || "").trim(), manual: true });
    });
    UI.closeModal("saved");
  },
};

/* ---------- タイマー / KPI（将来拡張） ---------- */
const ComingSoon = {
  defs: {
    timer: { icon: "⏱", title: "撤退タイマー", text: "配信の「やめどき」を先に決めておく機能を準備中です。", items: ["終了予定時刻までのカウントダウン", "延長しすぎ防止のアラート", "今日の枠から終了時刻を自動セット"] },
    kpi: { icon: "▲", title: "KPI記録", text: "配信ごとの数字を記録して、続け方を振り返る機能を準備中です。", items: ["同接・新規フォロー・収益の記録", "フロー枠／ストック枠ごとの比較", "週ごとの推移グラフ"] },
  },
  render(id) {
    const d = ComingSoon.defs[id];
    return `
      <section class="panel empty-state soon">
        <div class="empty-icon" aria-hidden="true">${d.icon}</div>
        <h2>${d.title} <span class="soon-chip">SOON</span></h2>
        <p class="muted">${d.text}</p>
        <div class="soon-list"><span class="muted small">予定している機能</span><ul>${d.items.map((x) => `<li>${x}</li>`).join("")}</ul></div>
      </section>`;
  },
};

/* ---------- 設定・データ管理（ダイアログ） ---------- */
const SettingsView = {
  open(section) {
    const data = Store.data;
    const local = Store.local;
    const s = local.sync;
    UI.openModal(
      `
      <div class="modal-head"><h2 id="modalTitle">設定・データ管理</h2><button type="button" class="icon-btn" data-action="modal-return" aria-label="閉じる">✕</button></div>
      <div class="modal-body settings">
        <section class="settings-sec" id="sec-sync">
          <h3>Google ドライブ同期</h3>
          <label class="field"><span class="field-label">ウェブアプリURL</span><input class="input" type="url" data-sync="url" value="${Util.esc(s.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
          <label class="field"><span class="field-label">合言葉</span>
            <span class="input-with-btn"><input class="input" type="password" data-sync="key" value="${Util.esc(s.key)}" autocomplete="off"><button type="button" class="btn small" data-variant="ghost" data-action="toggle-secret">表示</button></span>
          </label>
          <label class="field"><span class="field-label">この端末の名前</span><input class="input" type="text" data-sync="device" value="${Util.esc(s.device)}" maxlength="20"></label>
          <label class="switch-label"><input type="checkbox" role="switch" class="switch" data-sync-bool="includeJob" ${s.includeJob ? "checked" : ""}><span>同期データに本業シフトを含める</span></label>
          <div class="row-gap">
            <button type="button" class="btn" data-variant="ghost" data-action="sync-test">接続テスト</button>
            <button type="button" class="btn" data-variant="primary" data-action="sync-save">保存して同期</button>
          </div>
          <p class="hint" data-sync-result>${s.lastError ? `⚠ ${Util.esc(Sync.errorText(s.lastError))}` : s.lastSyncAt ? `最終同期：${Util.md(new Date(s.lastSyncAt))} ${Util.hm(new Date(s.lastSyncAt))}（rev ${s.rev}）` : ""}</p>
          <div class="qr-area">
            <button type="button" class="btn" data-variant="ghost" data-action="show-qr" ${Sync.enabled() ? "" : "disabled"}>📱 iPhone用に設定をQRで表示</button>
            <div data-qr></div>
          </div>
        </section>

        <section class="settings-sec" id="sec-labels">
          <h3>本業シフトの表示名</h3>
          <p class="hint muted">この名前はこの画面の中だけで使い、X告知には出ません。自動生成のルールは右の説明のとおりです。</p>
          ${CONFIG.JOB_IDS.filter((id) => id !== "tbd")
            .map((id) => `<label class="field label-row"><input class="input" type="text" data-job-label="${id}" value="${Util.esc(Store.jobLabel(id))}" maxlength="10"><span class="muted small">${Util.esc(CONFIG.JOB_RULES[id])}</span></label>`)
            .join("")}
        </section>

        <section class="settings-sec">
          <h3>X告知のNG語</h3>
          <p class="hint muted">告知文にこれらの語（と本業シフトの表示名）が含まれるとコピーできなくなります。1行に1語。</p>
          <textarea class="input" rows="4" data-ng-words>${Util.esc(data.ngWords.join("\n"))}</textarea>
        </section>

        <section class="settings-sec">
          <h3>表示</h3>
          <label class="switch-label"><input type="checkbox" role="switch" class="switch" data-local-bool="hideJob" ${local.hideJob ? "checked" : ""}><span>今日タブで本業シフト・体調ステータスを隠す（配信画面への映り込み対策）</span></label>
        </section>

        <section class="settings-sec">
          <h3>バックアップ</h3>
          <div class="row-gap">
            <button type="button" class="btn" data-variant="ghost" data-action="export">⬇ JSONエクスポート</button>
            <label class="btn" data-variant="ghost">⬆ JSONインポート<input type="file" accept="application/json,.json" data-import hidden></label>
          </div>
        </section>
      </div>`,
      { onClose: () => App.render() },
    );
    if (section) UI.modal().querySelector(`#sec-${section}`)?.scrollIntoView({ block: "start" });
  },

  readSyncForm() {
    const dlg = UI.modal();
    const v = (n) => dlg.querySelector(`[data-sync="${n}"]`)?.value.trim() || "";
    return { url: v("url"), key: v("key"), device: v("device") || "PC", includeJob: dlg.querySelector('[data-sync-bool="includeJob"]').checked };
  },

  result(text, tone = "") {
    const el = UI.modal().querySelector("[data-sync-result]");
    if (el) {
      el.textContent = text;
      el.dataset.tone = tone;
    }
  },

  async test() {
    const f = SettingsView.readSyncForm();
    if (!/^https:\/\/script\.google\.com\//.test(f.url) || !f.key) return SettingsView.result("URL（https://script.google.com/…）と合言葉を入力してください", "caution");
    SettingsView.result("接続中…");
    try {
      const r = await Sync.call("ping", {}, { ...Sync.cfg, ...f });
      if (r.ok) {
        const last = r.updatedAt ? `最終更新 ${Util.md(new Date(r.updatedAt))} ${Util.hm(new Date(r.updatedAt))}・${r.device}` : "まだデータはありません";
        SettingsView.result(`✓ 接続できました（${last}）`, "rest");
      } else SettingsView.result(`⚠ ${Sync.errorText(r.error)}`, "caution");
    } catch (e) {
      SettingsView.result(`⚠ ${Sync.errorText("offline")}`, "caution");
    }
  },

  async saveSync() {
    const f = SettingsView.readSyncForm();
    const changedTarget = f.url !== Sync.cfg.url || f.key !== Sync.cfg.key;
    Object.assign(Sync.cfg, f);
    if (changedTarget) {
      Sync.cfg.rev = 0;
      Sync.cfg.lastError = null;
      // 手元にデータがあれば送る候補にする（サーバー側にデータがあれば競合ダイアログで選ぶ）
      Sync.cfg.dirty = Object.keys(Store.data.weeks).length > 0;
    }
    Store.write();
    UI.renderSyncStatus();
    SettingsView.result("同期中…");
    await Sync.pull();
    SettingsView.result(Sync.cfg.lastError ? `⚠ ${Sync.errorText(Sync.cfg.lastError)}` : "✓ 同期しました", Sync.cfg.lastError ? "caution" : "rest");
    const qrBtn = UI.modal().querySelector('[data-action="show-qr"]');
    if (qrBtn) qrBtn.disabled = !Sync.enabled();
  },

  showQR() {
    const box = UI.modal().querySelector("[data-qr]");
    if (typeof qrcode !== "function") return (box.textContent = "QRを作れませんでした（vendor/qrcode.js を確認）");
    const url = Sync.setupUrl("iPhone");
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    box.innerHTML = `
      <div class="qr-code">${qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true })}</div>
      <p class="hint">iPhone のカメラで読み取り → Safari で開く → 共有 →「ホーム画面に追加」。<br><b>このQRには合言葉が含まれます。</b>撮影・共有しないでください。</p>`;
  },
};

/* ======================================================================
 * 9. App
 * ==================================================================== */
const App = {
  tab: "today",
  lastDateKey: Util.dateKey(new Date()),

  views: {
    today: () => TodayView.render(),
    week: () => WeekView.render(),
    timer: () => ComingSoon.render("timer"),
    kpi: () => ComingSoon.render("kpi"),
  },

  renderNav() {
    document.getElementById("tabnav").innerHTML = CONFIG.TABS.map(
      (t, i) => `
      <button type="button" role="tab" id="tab-${t.id}" aria-selected="${App.tab === t.id}" aria-controls="view" data-action="tab" data-tab="${t.id}" title="${t.label}（${i + 1}キー）">
        <span class="tab-icon" aria-hidden="true">${t.icon}</span><span class="tab-label">${t.label}</span>${t.soon ? '<span class="soon-chip">SOON</span>' : ""}
      </button>`,
    ).join("");
  },

  render() {
    App.renderNav();
    const view = document.getElementById("view");
    view.setAttribute("aria-labelledby", `tab-${App.tab}`);
    view.dataset.tab = App.tab;
    view.innerHTML = App.views[App.tab]();
    UI.renderSyncStatus();
    App.renderClock();
  },

  setTab(id) {
    if (!App.views[id]) return;
    App.tab = id;
    TodayView.editing = false;
    App.render();
    window.scrollTo({ top: 0 });
    if (id === "week") {
      const todayCard = document.querySelector('.day-card[data-today="true"]');
      if (todayCard && window.matchMedia("(max-width: 599px)").matches) todayCard.scrollIntoView({ block: "center" });
    }
  },

  renderClock() {
    const now = new Date();
    const el = document.getElementById("clock");
    if (el) el.textContent = `${Util.md(now)} ${Util.hm(now)}`;
  },

  tick() {
    App.renderClock();
    const key = Util.dateKey(new Date());
    const busy = UI.modal().open || TodayView.editing || document.activeElement?.matches("input, textarea");
    if (key !== App.lastDateKey) {
      App.lastDateKey = key;
      Store.pruneChecks();
      Store.saveLocal();
      if (!busy) App.render();
    } else if (App.tab === "today" && !busy) {
      App.render(); // 「あと◯分」とプログレスを更新
    }
  },

  // ---- イベント（すべて委譲で受ける）
  bind() {
    document.addEventListener("click", App.onClick);
    document.addEventListener("change", App.onChange);
    document.addEventListener("input", App.onInput);
    document.addEventListener("submit", (e) => {
      const form = e.target.closest('[data-form="slot"]');
      if (form) {
        e.preventDefault();
        WeekView.saveEditor(form);
      }
    });
    document.addEventListener("keydown", App.onKey);
    UI.modal().addEventListener("click", (e) => {
      if (e.target === UI.modal()) UI.closeModal(); // 背景クリックで閉じる
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        App.tick();
        Sync.pull();
      }
    });
    window.addEventListener("online", () => Sync.pull());
  },

  async onClick(e) {
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled) return;
    const a = el.dataset.action;
    const wkDays = () => WeekView.days();

    switch (a) {
      case "tab":
        return App.setTab(el.dataset.tab);
      case "modal-return":
        return UI.closeModal(el.dataset.value || "");
      case "open-settings":
        return SettingsView.open(el.dataset.section);
      case "dismiss-install":
        Store.local.installDismissed = true;
        Store.saveLocal();
        return (document.getElementById("installBanner").hidden = true);

      // 今日：ルーチン
      case "routine-edit":
        TodayView.editing = true;
        return App.render();
      case "routine-edit-done":
        TodayView.editing = false;
        Store.data.routineItems = Store.data.routineItems.filter((it) => it.text.trim());
        Store.save();
        return App.render();
      case "routine-add":
        Store.data.routineItems.push({ id: Util.uid(), text: "" });
        Store.save();
        App.render();
        return document.querySelector(".routine-edit-row:last-child input")?.focus();
      case "routine-del":
        Store.data.routineItems = Store.data.routineItems.filter((it) => it.id !== el.dataset.id);
        Store.save();
        return App.render();
      case "routine-move": {
        const list = Store.data.routineItems;
        const i = list.findIndex((it) => it.id === el.dataset.id);
        const j = i + Number(el.dataset.dir);
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        Store.save();
        return App.render();
      }

      // 週間
      case "week-shift":
        return WeekView.setWeek(Util.addDays(Util.parseKey(WeekView.current()), Number(el.dataset.dir)));
      case "week-jump":
        return WeekView.setWeek(Util.parseKey(el.dataset.key));
      case "set-job":
        return WeekView.mutate((wk) => (wk.days[Number(el.dataset.day)].job = el.dataset.job));
      case "generate":
        return WeekView.generate();
      case "edit-slot":
        return WeekView.openEditor(Number(el.dataset.day), el.dataset.slot);
      case "time-step": {
        const input = el.closest("form").querySelector(`[name="${el.dataset.target}"]`);
        const cur = Util.toMin(Util.normTime(input.value) || "00:00");
        input.value = Util.fmtTime(Math.min(47 * 60 + 45, Math.max(0, cur + Number(el.dataset.step))));
        return;
      }
      case "slot-reset": {
        const form = el.closest("form");
        const def = CONFIG.SLOTS[form.dataset.slot];
        form.querySelector('[name="start"]').value = def.start;
        form.querySelector('[name="end"]').value = def.end;
        form.querySelector(`[name="kind"][value="${def.kind}"]`).checked = true;
        return;
      }
      case "night-format":
        Store.local.nightFormat = el.dataset.value;
        Store.saveLocal();
        return App.render();
      case "copy-announce": {
        const text = Announce.build(WeekView.current(), wkDays(), Store.local.nightFormat);
        if (Announce.findNG(text).length) return UI.toast("NG語が含まれているためコピーできません");
        const ok = await UI.copy(text);
        if (ok) {
          el.textContent = "✓ コピーしました";
          setTimeout(() => (el.textContent = "📋 コピー"), 2000);
        } else UI.toast("コピーできませんでした");
        return;
      }

      // 設定
      case "toggle-secret": {
        const input = el.parentElement.querySelector("input");
        input.type = input.type === "password" ? "text" : "password";
        el.textContent = input.type === "password" ? "表示" : "隠す";
        return;
      }
      case "sync-test":
        return SettingsView.test();
      case "sync-save":
        return SettingsView.saveSync();
      case "show-qr":
        return SettingsView.showQR();
      case "export":
        return UI.download(`shift-board-${Util.dateKey(new Date()).replace(/-/g, "")}.json`, Store.exportJSON());
    }
  },

  async onChange(e) {
    const t = e.target;
    if (t.dataset.routineCheck) {
      const key = Util.dateKey(new Date());
      const set = new Set(Store.local.routineChecks[key] || []);
      t.checked ? set.add(t.dataset.routineCheck) : set.delete(t.dataset.routineCheck);
      Store.local.routineChecks[key] = [...set];
      Store.saveLocal();
      return App.render();
    }
    if (t.dataset.slotToggle) {
      const [i, k] = t.dataset.slotToggle.split(":");
      return WeekView.mutate((wk) => {
        const s = wk.days[Number(i)].slots[k];
        s.on = t.checked;
        s.manual = true;
      });
    }
    if (t.dataset.pref) {
      Store.data.prefs[t.dataset.pref] = t.checked;
      Store.save();
      return App.render();
    }
    if (t.dataset.weekDate !== undefined && t.value) return WeekView.setWeek(Util.parseKey(t.value));
    if (t.dataset.localBool) {
      Store.local[t.dataset.localBool] = t.checked;
      return Store.saveLocal();
    }
    if (t.dataset.jobLabel) {
      Store.data.jobLabels[t.dataset.jobLabel] = t.value.trim() || CONFIG.JOB_DEFAULT_LABELS[t.dataset.jobLabel];
      return Store.save();
    }
    if (t.dataset.ngWords !== undefined) {
      Store.data.ngWords = t.value
        .split(/[\n,、]/)
        .map((w) => w.trim())
        .filter(Boolean);
      return Store.save();
    }
    if (t.dataset.import !== undefined && t.files?.[0]) {
      try {
        const data = Store.parseImport(await t.files[0].text());
        const n = Object.keys(data.weeks).length;
        const ok = await UI.confirm({ title: "インポートしますか？", body: `<p>${n}週分のデータで、今のデータを<b>すべて置き換えます</b>。</p>`, ok: "置き換える", danger: true });
        if (ok) {
          Store.state.data = data;
          Store.save();
          App.render();
          UI.toast("インポートしました");
        }
      } catch (err) {
        UI.toast("読み込めませんでした（JSONの形式を確認してください）");
      }
      t.value = "";
    }
  },

  onInput(e) {
    const t = e.target;
    if (t.dataset.routineText) {
      const it = Store.data.routineItems.find((x) => x.id === t.dataset.routineText);
      if (it) {
        it.text = t.value;
        Store.save();
      }
    }
  },

  onKey(e) {
    if (UI.modal().open || e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= CONFIG.TABS.length) return App.setTab(CONFIG.TABS[n - 1].id);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      if (!e.target.closest('[role="tablist"]')) return;
      const i = CONFIG.TABS.findIndex((t) => t.id === App.tab);
      const j = (i + (e.key === "ArrowRight" ? 1 : -1) + CONFIG.TABS.length) % CONFIG.TABS.length;
      App.setTab(CONFIG.TABS[j].id);
      document.getElementById(`tab-${CONFIG.TABS[j].id}`)?.focus();
    }
  },

  showInstallBanner() {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (ios && location.protocol === "https:" && navigator.standalone === false && !Store.local.installDismissed) {
      document.getElementById("installBanner").hidden = false;
    }
  },

  start() {
    Store.load();
    Sync.importFromHash();
    App.bind();
    App.render();
    App.showInstallBanner();
    setInterval(App.tick, CONFIG.TICK_MS);
    Sync.startPolling();
    Sync.pull();
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  },
};

App.start();
