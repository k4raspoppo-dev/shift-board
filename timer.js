/*
 * 配信シフト — 撤退タイマー・通知（タブ3）
 *
 *   Sound       Web Audio のオシレーターで鳴らす通知音（音声ファイルなし）
 *   TimerLogic  経過・残り時間と段階アラートの判定（DOM に触れない純粋関数）
 *   Ignite      5分着火タイマー
 *   Alerts      1秒ごとの判定（15分前通知・段階アラート・全体バナー・ヘッダーのチップ）
 *   TimerView   タブ3の画面と操作
 *
 * app.js より先に読み込むため、ここでは定義だけを行い、読み込み時には何も実行しない。
 * 時間はすべて「開始時刻（タイムスタンプ）との差分」で求めるので、裏タブ・スリープ復帰でもズレない。
 * タイマーの状態はこの端末の localStorage（Store.local.timer）だけに保存し、同期しない。
 */
"use strict";

/* ---------------------------------------------------------------- Sound */
const Sound = {
  ctx: null,

  // ユーザー操作の中で呼ぶ（自動再生制限の解除）
  unlock() {
    const c = Sound.ensure();
    if (!c) return;
    try {
      // iOS：無音を1回鳴らしておくと、その後のタイマー音が鳴るようになる
      const buf = c.createBuffer(1, 1, 22050);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.start(0);
    } catch (e) {
      /* 何もしない */
    }
  },

  ensure() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!Sound.ctx) {
      try {
        Sound.ctx = new AC();
        Sound.ctx.onstatechange = () => typeof Alerts !== "undefined" && Alerts.renderChips(Date.now());
      } catch (e) {
        return null;
      }
    }
    // iOS 17+：マナースイッチの影響を受けにくい再生モードにする
    try {
      if (navigator.audioSession && navigator.audioSession.type !== "playback") navigator.audioSession.type = "playback";
    } catch (e) {
      /* 非対応 */
    }
    if (Sound.ctx.state !== "running") Sound.ctx.resume().catch(() => {});
    return Sound.ctx;
  },

  ready() {
    return Boolean(Sound.ctx && Sound.ctx.state === "running");
  },
  supported() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  },

  // [周波数Hz, 開始秒, 長さ秒]
  PATTERNS: {
    soft: { wave: "sine", vol: 0.22, notes: [[784, 0, 0.18], [1046, 0.22, 0.26]] },
    ignite: { wave: "triangle", vol: 0.3, notes: [[660, 0, 0.12], [880, 0.15, 0.12], [1320, 0.3, 0.3]] },
    judge: { wave: "sine", vol: 0.25, notes: [[523, 0, 0.25], [659, 0.3, 0.35]] },
    yellow: { wave: "sine", vol: 0.3, notes: [[880, 0, 0.18], [880, 0.28, 0.18]] },
    orange: { wave: "triangle", vol: 0.32, notes: [[988, 0, 0.13], [988, 0.18, 0.13], [988, 0.36, 0.13], [988, 0.9, 0.13], [988, 1.08, 0.13], [988, 1.26, 0.13]] },
    red: { wave: "square", vol: 0.12, notes: [[1046, 0, 0.32], [784, 0.38, 0.32], [1046, 0.76, 0.32], [784, 1.14, 0.32], [1046, 1.52, 0.6]] },
  },

  /** @returns {boolean} 実際に鳴らせたか */
  // 同じブラウザでアプリを複数のタブ・ウィンドウで開いていても、通知音は1つのタブ（leader）だけが鳴らす
  leader: false,
  claimLeader() {
    if (Sound.claimed) return;
    Sound.claimed = true;
    if (!navigator.locks?.request) return void (Sound.leader = true);
    navigator.locks
      .request("shiftBoard-sound-leader", () => {
        Sound.leader = true;
        return new Promise(() => {}); // タブを閉じるまで持ち続ける（閉じると次のタブへ移る）
      })
      .catch(() => (Sound.leader = true));
  },

  play(name, { volume = 1, force = false } = {}) {
    if (!force && Store.local.sound.muted) return false;
    if (!force && !Sound.leader) return false;
    const c = Sound.ensure();
    if (!c || c.state !== "running") return false;
    const p = Sound.PATTERNS[name] || Sound.PATTERNS.soft;
    const t0 = c.currentTime + 0.02;
    for (const [freq, at, dur] of p.notes) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = p.wave;
      osc.frequency.value = freq;
      const peak = Math.max(0.0002, p.vol * volume);
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.05);
    }
    return true;
  },
};

/* ----------------------------------------------------------- TimerLogic */
const TimerLogic = {
  MIN: 60000,

  // 段階アラートの定義（no = 「n/4」表示。損切りは判断の合図なので番号なし）
  STAGES: [
    { id: "loss", no: 0, level: 1, sound: "judge", icon: "⚖", name: "損切り判定", title: "【損切り判定】", text: "同接・コメント・ギフトが無風なら90分で戦略撤退し、改善と切り抜きへ切替" },
    { id: "w20", no: 1, level: 2, sound: "yellow", icon: "📣", name: "終了宣言", title: "【終了宣言タイム】", text: "あと20分で営業終了する旨を口頭宣言" },
    { id: "w5", no: 2, level: 3, sound: "orange", icon: "🎬", name: "クロージング", title: "【クロージング】", text: "次回予告・フォロー誘導・区切り準備" },
    { id: "end", no: 3, level: 4, sound: "red", icon: "⛔", name: "ハードストップ", title: "【ハードストップ】", text: "予定終了時刻です。即時終了（ストック枠も最大+15分厳守）" },
    { id: "over", no: 4, level: 5, sound: "red", icon: "🚨", name: "延長上限", title: "【延長上限】", text: "予定終了から15分を超えました。今すぐ配信を終了してください" },
  ],
  stage(id) {
    return TimerLogic.STAGES.find((s) => s.id === id) || null;
  },

  elapsedMs(t, now) {
    if (!t) return 0;
    const end = t.pausedAt ?? now;
    return Math.max(0, end - t.startedAt - (t.pausedMs || 0));
  },
  remainingMs(t, now) {
    return t.durationMin * TimerLogic.MIN - TimerLogic.elapsedMs(t, now);
  },

  // いま条件を満たしている段階（開始からの経過・残りで判定）
  due(t, now) {
    if (!t) return [];
    const el = TimerLogic.elapsedMs(t, now);
    const rem = t.durationMin * TimerLogic.MIN - el;
    const M = TimerLogic.MIN;
    const out = [];
    // 損切り判定はフロー枠だけ。予定が50分以下の枠では意味がないので出さない
    if (t.info?.kind === "flow" && t.durationMin > CONFIG.LOSS_CUT_MIN && el >= CONFIG.LOSS_CUT_MIN * M) out.push("loss");
    if (rem <= 20 * M) out.push("w20");
    if (rem <= 5 * M) out.push("w5");
    if (rem <= 0) out.push("end");
    if (rem <= -CONFIG.OVERTIME_LIMIT_MIN * M) out.push("over");
    return out;
  },
  // まだ知らせていない段階
  fresh(t, now) {
    const fired = new Set(t?.fired || []);
    return TimerLogic.due(t, now).filter((id) => !fired.has(id));
  },
  // 画面の主表示にする段階（損切り以外で一番強いもの）
  main(t, now) {
    const ids = TimerLogic.due(t, now).filter((id) => id !== "loss");
    return ids.length ? ids[ids.length - 1] : null;
  },
  // 次に段階が変わるまでのミリ秒（裏タブで setInterval が間引かれても、この時刻に setTimeout で起こす）
  nextChangeIn(t, now) {
    if (!t || t.pausedAt) return null;
    const el = TimerLogic.elapsedMs(t, now);
    const M = TimerLogic.MIN;
    const D = t.durationMin * M;
    const points = [CONFIG.LOSS_CUT_MIN * M, D - 20 * M, D - 5 * M, D, D + CONFIG.OVERTIME_LIMIT_MIN * M].filter((p) => p > el);
    return points.length ? Math.min(...points) - el : null;
  },

  create({ durationMin, info }, now) {
    const t = { id: Util.uid(), startedAt: now, pausedAt: null, pausedMs: 0, durationMin, info, fired: [], dismissed: [] };
    // 開始時点ですでに過ぎている段階（短い枠など）は鳴らさない
    t.fired = TimerLogic.due(t, now);
    return t;
  },

  // 1:23:45 / 12:34 / +03:10
  format(ms) {
    const neg = ms < 0;
    const total = Math.floor(Math.abs(neg ? ms : ms + 999) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const body = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return neg ? `+${body}` : body;
  },
};

/* --------------------------------------------------------------- Ignite */
const Ignite = {
  durationMs() {
    return CONFIG.IGNITE_MIN * 60000;
  },
  remaining(now) {
    const i = Store.local.ignite;
    return i ? i.startedAt + Ignite.durationMs() - now : null;
  },
  format(ms) {
    return TimerLogic.format(Math.max(0, ms));
  },
  start() {
    Store.local.ignite = { startedAt: Date.now() };
    Store.saveLocal();
    App.render();
    UI.toast("🔥 まずはソフト起動と音量チェックだけ");
  },
  stop() {
    Store.local.ignite = null;
    Store.saveLocal();
    App.render();
  },
  check(now) {
    const r = Ignite.remaining(now);
    if (r === null || r > 0) return;
    Store.local.ignite = null;
    Store.saveLocal();
    // 長時間放置した後に開いた場合は鳴らさない
    if (r > -60000) {
      Sound.play("ignite");
      UI.toast("🔥 5分経過！ そのまま配信開始へ");
    }
    Alerts.queueRender();
  },
};

/* --------------------------------------------------------------- Alerts */
const Alerts = {
  lastMain: null,
  wakeTimer: null,
  renderQueued: false,

  queueRender() {
    if (Alerts.renderQueued) return;
    Alerts.renderQueued = true;
    setTimeout(() => {
      Alerts.renderQueued = false;
      App.safeRender();
    }, 0);
  },

  tick(now) {
    if (!Store.state) return;
    Sound.claimLeader();
    Ignite.check(now);
    const calm = Store.local.sound.calm ? "true" : "";
    if (document.body.dataset.calm !== calm) document.body.dataset.calm = calm;
    Alerts.checkTimer(now);
    Alerts.checkPre(now);
    Alerts.renderBanner(now);
    Alerts.renderChips(now);
    Alerts.updateBinds(now);
  },

  // ---- 撤退タイマーの段階アラート
  checkTimer(now) {
    const t = Store.local.timer;
    if (!t) return Alerts.setStage(null);
    if (TimerView.isStale(t, now)) return Alerts.setStage(null); // 放置されたタイマーは鳴らさない（画面で終了確認）
    if (TimerLogic.fresh(t, now).length) Alerts.fireFresh();
    Alerts.setStage(TimerLogic.main(t, now));
    Alerts.scheduleWake(t, now);
  },

  // 新しく越えた段階を記録して鳴らす（別タブが先に記録した段階は取り込んで鳴らさない）
  fireFresh() {
    const t = Store.local.timer;
    if (!t) return;
    const disk = Store.peekLocal()?.timer;
    if (disk && disk.startedAt === t.startedAt && Array.isArray(disk.fired)) t.fired = [...new Set([...t.fired, ...disk.fired])];
    const fresh = TimerLogic.fresh(t, Date.now());
    if (!fresh.length) return;
    t.fired.push(...fresh);
    Store.saveLocal();
    // 一度に複数の段階を越えたら（スリープ復帰など）、一番強い段階の音だけ鳴らす
    const top = fresh.map(TimerLogic.stage).sort((a, b) => b.level - a.level)[0];
    Sound.play(top.sound);
    Alerts.flash(top.id);
    Alerts.queueRender();
  },

  setStage(id) {
    if (Alerts.lastMain === id) return;
    Alerts.lastMain = id;
    document.body.dataset.timerStage = id || "";
  },

  // 裏タブでは setInterval が1分ごとに間引かれるため、段階が変わる時刻に合わせて起こす
  scheduleWake(t, now) {
    clearTimeout(Alerts.wakeTimer);
    const ms = TimerLogic.nextChangeIn(t, now);
    if (ms !== null && ms < 6 * 3600000) Alerts.wakeTimer = setTimeout(App.fastTick, ms + 50);
  },

  flash(id) {
    if (Store.local.sound.calm) return;
    const el = document.getElementById("flashOverlay");
    if (!el) return;
    el.removeAttribute("data-flash");
    void el.offsetWidth; // アニメーションをやり直す
    el.dataset.flash = id;
  },

  // ---- 開始15分前通知
  preKey(it) {
    return `${it.date}:${it.k}`;
  },
  preTarget(now) {
    const lead = CONFIG.PRE_ALERT_MIN * 60000;
    return TodayView.timeline(new Date(now)).find((it) => it.start - lead <= now && now < it.start) || null;
  },
  checkPre(now) {
    if (!Store.local.sound.preAlert) return;
    const it = Alerts.preTarget(now);
    if (!it) return;
    const key = Alerts.preKey(it);
    if (Store.local.alerted[key]) return;
    const timerOn = Boolean(Store.local.timer);
    // 配信中（タイマー作動中）は邪魔をしないよう、小さな音とトーストだけ
    Store.local.alerted[key] = timerOn ? 2 : 1;
    Store.saveLocal();
    Sound.play("soft", { volume: timerOn ? 0.35 : 1 });
    if (timerOn) UI.toast(`⏰ ${CONFIG.PRE_ALERT_MIN}分後に${CONFIG.SLOTS[it.k].label}（${it.s.start}）`);
  },

  // ---- 全体バナー（どのタブでも出す。タイマータブでは画面の中に出すので重ねない）
  bannerModel(now) {
    const t = Store.local.timer;
    if (t && !TimerView.isStale(t, now) && App.tab !== "timer") {
      const main = TimerLogic.main(t, now);
      const dismissed = new Set(t.dismissed || []);
      if (main && !dismissed.has(main)) return { kind: "timer", stage: TimerLogic.stage(main) };
      if (TimerLogic.due(t, now).includes("loss") && !dismissed.has("loss") && !main) return { kind: "timer", stage: TimerLogic.stage("loss") };
    }
    if (Store.local.sound.preAlert && !t && App.tab !== "today") {
      const it = Alerts.preTarget(now);
      if (it && Store.local.alerted[Alerts.preKey(it)] === 1) return { kind: "pre", it };
    }
    return null;
  },

  renderBanner(now) {
    const el = document.getElementById("alertBanner");
    if (!el) return;
    const m = Alerts.bannerModel(now);
    const sig = !m ? "" : m.kind === "timer" ? `timer:${m.stage.id}` : `pre:${Alerts.preKey(m.it)}:${Ignite.remaining(now) !== null}`;
    if (el.dataset.sig === sig) {
      if (m?.kind === "pre") {
        const left = el.querySelector("[data-bind=pre-left]");
        if (left) left.textContent = Util.duration(m.it.start - now);
      }
      return;
    }
    el.dataset.sig = sig;
    // 読み上げは段階が変わった時の見出しだけ（毎秒・毎分の書き換えは読ませない）
    const live = document.getElementById("alertLive");
    if (live) live.textContent = !m ? "" : m.kind === "timer" ? `${m.stage.title} ${m.stage.text}` : `まもなく${CONFIG.SLOTS[m.it.k].label} ${m.it.s.start} 開始`;
    if (!m) {
      el.hidden = true;
      el.innerHTML = "";
      delete el.dataset.tone;
      return;
    }
    el.hidden = false;
    if (m.kind === "timer") {
      const st = m.stage;
      el.dataset.tone = st.id;
      el.innerHTML = `
        <span class="alert-icon" aria-hidden="true">${st.icon}</span>
        <span class="alert-body"><b>${st.no ? `${st.no}/4 ` : ""}<span class="when-wide">${Util.esc(st.title)}</span><span class="when-narrow">${Util.esc(st.name)}</span></b><span>${Util.esc(st.text)}</span></span>
        <button type="button" class="btn small" data-variant="ghost" data-action="tab" data-tab="timer"><span class="when-wide">タイマーを</span>開く</button>
        <button type="button" class="icon-btn" data-action="alert-dismiss" data-stage="${st.id}" aria-label="閉じる">✕</button>`;
    } else {
      const it = m.it;
      const def = CONFIG.SLOTS[it.k];
      el.dataset.tone = "pre";
      el.innerHTML = `
        <span class="alert-icon" aria-hidden="true">⏰</span>
        <span class="alert-body"><b>まもなく${def.label} ${Util.esc(it.s.start)} 開始（あと <span data-bind="pre-left" aria-hidden="true">${Util.esc(Util.duration(it.start - now))}</span>）</b><span>${it.s.memo ? `${Util.esc(it.s.memo)}・` : ""}準備を始めよう</span></span>
        ${Ignite.remaining(now) === null ? `<button type="button" class="btn small" data-variant="ghost" data-action="ignite-start">🔥 5分着火</button>` : ""}
        <button type="button" class="btn small" data-variant="primary" data-action="timer-from-slot" data-date="${it.date}" data-slot="${it.k}">▶ 開始</button>
        <button type="button" class="icon-btn" data-action="alert-dismiss" data-pre="${Alerts.preKey(it)}" aria-label="閉じる">✕</button>`;
    }
  },

  // ---- ヘッダーの小さな表示（タイマー残り・着火・音の状態）
  renderChips(now) {
    const t = Store.local.timer;
    const timerChip = document.getElementById("timerChip");
    if (timerChip) {
      const rem = Ignite.remaining(now);
      if (t) {
        const ms = TimerLogic.remainingMs(t, now);
        timerChip.hidden = false;
        timerChip.textContent = `${t.pausedAt ? "⏸" : "⏱"}${TimerLogic.format(ms)}`;
        timerChip.dataset.stage = TimerLogic.main(t, now) || "";
        timerChip.setAttribute("aria-label", `撤退タイマー 残り ${TimerLogic.format(ms)}`);
      } else if (rem !== null) {
        timerChip.hidden = false;
        timerChip.textContent = `🔥${Ignite.format(rem)}`;
        timerChip.dataset.stage = "";
        timerChip.setAttribute("aria-label", `着火タイマー 残り ${Ignite.format(rem)}`);
      } else timerChip.hidden = true;
    }
    const soundChip = document.getElementById("soundChip");
    if (soundChip) {
      const need = Boolean(t) || Store.local.sound.preAlert || Store.local.ignite;
      let text = "";
      if (Store.local.sound.muted) text = "🔇";
      else if (need && Sound.supported() && !Sound.ready()) text = "🔈 クリックで音を有効化";
      soundChip.hidden = !text;
      soundChip.textContent = text;
      soundChip.dataset.state = Store.local.sound.muted ? "muted" : "locked";
      soundChip.title = Store.local.sound.muted ? "ミュート中（押すと解除）" : "クリックすると通知音が鳴るようになります";
    }
  },

  // ---- 表示中の数字だけ書き換える
  updateBinds(now) {
    const view = document.getElementById("view");
    if (!view) return;
    const ign = view.querySelector("[data-bind=ignite]");
    if (ign) ign.textContent = Ignite.format(Ignite.remaining(now) ?? 0);
    if (App.tab === "timer") TimerView.update(now);
  },
};

/* ------------------------------------------------------------ TimerView */
const TimerView = {
  renderedStage: undefined,

  isStale(t, now) {
    return Boolean(t) && now - t.startedAt > CONFIG.TIMER_STALE_HOURS * 3600000;
  },
  isRunningFor(dateKey, k) {
    const t = Store.local.timer;
    return Boolean(t && t.info?.source && t.info.source.date === dateKey && t.info.source.slot === k);
  },

  // ---- 開始
  async begin(durationMin, info) {
    const cur = Store.local.timer;
    if (cur) {
      const ok = await UI.confirm({ title: "タイマーを入れ替えますか？", body: `<p>動いているタイマー（${Util.esc(cur.info?.title || "企画名なし")}・経過 ${Math.floor(TimerLogic.elapsedMs(cur, Date.now()) / 60000)}分）は記録されずに終了します。</p>`, ok: "入れ替えて開始", danger: true });
      if (!ok) return;
    }
    Sound.unlock();
    Store.local.timer = TimerLogic.create({ durationMin, info }, Date.now());
    Store.local.ignite = null;
    Store.saveLocal();
    App.setTab("timer");
  },

  fromSlot(dateKey, k) {
    const day = Store.getDay(Util.parseKey(dateKey));
    const s = day?.slots?.[k];
    if (!s) return UI.toast("枠が見つかりませんでした");
    const durationMin = Math.max(1, Util.toMin(s.end) - Util.toMin(s.start));
    const kind = s.kind === "stock" ? "stock" : s.kind === "adjust" ? "adjust" : "flow";
    return TimerView.begin(durationMin, { date: dateKey, slot: k, kind, title: s.memo || "", test: s.test || "", plannedStart: s.start, plannedEnd: s.end, source: { date: dateKey, slot: k } });
  },

  quick(kind) {
    const now = new Date();
    return TimerView.begin(CONFIG.TIMER_PRESETS[kind], { date: TimerView.guessDate(now), slot: TimerView.guessSlot(now), kind, title: "", test: "", source: null });
  },

  startCustom(form) {
    const fd = new FormData(form);
    const min = Kpi.toInt(fd.get("minutes"));
    const err = form.querySelector("[data-form-error]");
    if (!Number.isInteger(min) || min < 1 || min > 600) {
      err.textContent = "時間は 1〜600 分で入力してください";
      err.hidden = false;
      return;
    }
    const now = new Date();
    const kind = ["flow", "stock", "adjust"].includes(fd.get("kind")) ? fd.get("kind") : "flow";
    return TimerView.begin(min, { date: TimerView.guessDate(now), slot: TimerView.guessSlot(now), kind, title: String(fd.get("title") || "").trim(), test: String(fd.get("test") || "").trim(), source: null });
  },

  // 深夜0〜5時の手動開始は、前日の夜枠（24:00〜）として扱う（予定から開始した場合と日付をそろえる）
  guessDate(now) {
    return now.getHours() < 5 ? Util.dateKey(Util.addDays(now, -1)) : Util.dateKey(now);
  },
  // 手動開始のときの時間帯枠：今の時刻に一番近い既定枠
  guessSlot(now) {
    const m = now.getHours() * 60 + now.getMinutes();
    if (m < 5 * 60) return "night";
    if (m < 12 * 60) return "morning";
    if (m < 18 * 60) return "noon";
    return "night";
  },

  // ---- 操作
  async action(a, el) {
    const t = Store.local.timer;
    const now = Date.now();
    switch (a) {
      case "timer-from-slot":
        return TimerView.fromSlot(el.dataset.date, el.dataset.slot);
      case "timer-quick":
        return TimerView.quick(el.dataset.kind);
      case "timer-pause":
        if (!t || t.pausedAt) return;
        t.pausedAt = now;
        Store.saveLocal();
        return App.render();
      case "timer-resume":
        if (!t || !t.pausedAt) return;
        t.pausedMs += now - t.pausedAt;
        t.pausedAt = null;
        Store.saveLocal();
        return App.render();
      case "timer-reset": {
        if (!t) return;
        const ok = await UI.confirm({ title: "タイマーをリセットしますか？", body: "<p>経過時間は記録されません。記録する場合は「配信終了 → KPI記録へ」を押してください。</p>", ok: "リセット", danger: true });
        if (!ok) return;
        Store.local.timer = null;
        Store.saveLocal();
        return App.render();
      }
      case "timer-finish":
        return TimerView.finish();
      case "ignite-start":
        Sound.unlock();
        return Ignite.start();
      case "ignite-stop":
        return Ignite.stop();
      case "sound-test":
        Sound.unlock();
        setTimeout(() => {
          if (!Sound.play("yellow", { force: true })) UI.toast(Sound.supported() ? "音を鳴らせませんでした（もう一度押してください）" : "このブラウザは通知音に対応していません");
          else if (Store.local.sound.muted) UI.toast("テスト再生しました（通常はミュート中です）");
        }, 60);
        return Alerts.renderChips(now);
      case "sound-mute":
        Store.local.sound.muted = !Store.local.sound.muted;
        Store.saveLocal();
        Sound.unlock();
        Alerts.renderChips(now);
        return App.tab === "timer" ? App.render() : null;
      case "sound-unlock":
        if (Store.local.sound.muted) {
          Store.local.sound.muted = false;
          Store.saveLocal();
          UI.toast("ミュートを解除しました");
        }
        Sound.unlock();
        setTimeout(() => Alerts.renderChips(Date.now()), 100);
        return App.tab === "timer" ? App.render() : null;
      case "alert-dismiss":
        if (el.dataset.pre) {
          Store.local.alerted[el.dataset.pre] = 2;
        } else if (t) {
          t.dismissed = [...new Set([...(t.dismissed || []), el.dataset.stage])];
        }
        Store.saveLocal();
        Alerts.renderBanner(now);
        return App.tab === "timer" ? App.render() : null;
    }
  },

  async finish() {
    const t = Store.local.timer;
    if (!t) return;
    const now = Date.now();
    const minutes = Math.max(1, Math.round(TimerLogic.elapsedMs(t, now) / 60000));
    const draft = Store.local.kpiDraft;
    if (draft && typeof KpiView !== "undefined" && KpiView.draftHasInput(draft)) {
      const ok = await UI.confirm({ title: "入力中のKPI記録があります", body: "<p>入力途中の内容を、この配信の情報で置き換えますか？</p>", ok: "置き換える", danger: true });
      if (!ok) return;
    }
    const i = t.info || {};
    Store.local.kpiDraft = KpiView.newDraft({ date: i.date, slot: i.slot, kind: i.kind === "stock" ? "stock" : i.kind === "adjust" ? "adjust" : "flow", title: i.title || "", minutes: String(minutes), test: i.test || "", fromTimer: true });
    Store.local.timer = null;
    Store.saveLocal();
    Alerts.setStage(null);
    App.setTab("kpi");
    UI.toast(`おつかれさまでした（実配信 ${minutes}分）`);
  },

  // ---- 描画
  render() {
    const t = Store.local.timer;
    const now = Date.now();
    TimerView.renderedStage = t ? TimerLogic.main(t, now) : null;
    return `<div class="timer-view">${t ? TimerView.running(t, now) : TimerView.idle(now)}${TimerView.soundRow()}</div>`;
  },

  idle(now) {
    const upcoming = TodayView.timeline(new Date(now)).filter((it) => it.end > now);
    const next = upcoming[0];
    const suggest = next
      ? `
        <div class="timer-suggest" data-kind="${next.s.kind}">
          <div>
            <div class="muted small">${next.start <= now ? "配信中の枠" : "次の枠"}</div>
            <div class="timer-suggest-title">${UI.kindBadge(next.s.kind)} ${CONFIG.SLOTS[next.k].label} <span class="num">${Util.esc(next.s.start)}–${Util.esc(next.s.end)}</span></div>
            ${next.s.memo ? `<div class="muted">${Util.esc(next.s.memo)}${next.s.test ? `　🧪 ${Util.esc(next.s.test)}` : ""}</div>` : ""}
          </div>
          <button type="button" class="btn big" data-variant="primary" data-action="timer-from-slot" data-date="${next.date}" data-slot="${next.k}">▶ この枠で開始</button>
        </div>`
      : `<p class="muted">今日はこのあとの配信枠がありません。下のクイック開始から始められます。</p>`;
    return `
      <section class="panel timer-idle">
        <div class="timer-idle-head">
          <div class="empty-icon" aria-hidden="true">⏱</div>
          <div>
            <h2>撤退タイマー</h2>
            <p class="muted">終わる時刻を先に決めて、段階的に「やめどき」を知らせます。</p>
          </div>
        </div>
        ${suggest}
        <div class="timer-quick">
          <span class="field-label">クイック開始</span>
          <div class="row-gap">
            <button type="button" class="btn big" data-action="timer-quick" data-kind="flow"><span aria-hidden="true">☀</span> フロー ${CONFIG.TIMER_PRESETS.flow}分</button>
            <button type="button" class="btn big" data-action="timer-quick" data-kind="stock"><span aria-hidden="true">☾</span> ストック ${CONFIG.TIMER_PRESETS.stock}分</button>
          </div>
        </div>
        <details class="timer-custom">
          <summary>任意の時間で開始</summary>
          <form data-form="timer-custom" class="form-grid timer-custom-form" novalidate>
            <label class="field"><span class="field-label">配信時間（分）</span><input class="input num" type="text" inputmode="numeric" name="minutes" value="90" maxlength="3" enterkeyhint="next"></label>
            <div class="field"><span class="field-label">種別</span>
              <div class="segmented" role="radiogroup">${Object.entries(CONFIG.KINDS)
                .map(([id, kd]) => `<label class="seg-radio"><input type="radio" name="kind" value="${id}" ${id === "flow" ? "checked" : ""}><span>${kd.icon} ${kd.label}</span></label>`)
                .join("")}</div>
            </div>
            <label class="field"><span class="field-label">企画・ゲーム名</span><input class="input" type="text" name="title" list="timerMemoList" autocomplete="off" enterkeyhint="next">
              <datalist id="timerMemoList">${WeekView.memoSuggestions().map((m) => `<option value="${Util.esc(m)}">`).join("")}</datalist></label>
            <label class="field"><span class="field-label">🧪 試す変更点</span><input class="input" type="text" name="test" autocomplete="off" enterkeyhint="go"></label>
            <p class="form-error" data-form-error hidden></p>
            <div><button type="submit" class="btn big" data-variant="primary">▶ 開始</button></div>
          </form>
        </details>
        <p class="hint muted">タイマーはこの端末だけで動きます（同期しません）。iPhone は画面ロック中やアプリが裏にある間、音を鳴らせません。</p>
      </section>`;
  },

  running(t, now) {
    const i = t.info || {};
    const main = TimerLogic.main(t, now);
    const st = main ? TimerLogic.stage(main) : null;
    const due = TimerLogic.due(t, now);
    const showLoss = due.includes("loss") && !(t.dismissed || []).includes("loss") && !["w5", "end", "over"].includes(main);
    const stale = TimerView.isStale(t, now);
    const endAt = new Date(t.startedAt + (t.pausedMs || 0) + (t.pausedAt ? now - t.pausedAt : 0) + t.durationMin * 60000);
    const def = CONFIG.SLOTS[i.slot];
    const loss = TimerLogic.stage("loss");
    return `
      ${stale ? `
        <section class="panel timer-stale">
          <p><b>前回のタイマーが動いたままです</b>（${Util.md(new Date(t.startedAt))} ${Util.hm(new Date(t.startedAt))} 開始）。配信は終わっていますか？</p>
          <div class="row-gap">
            <button type="button" class="btn" data-variant="primary" data-action="timer-finish">配信終了 → KPI記録へ</button>
            <button type="button" class="btn" data-variant="danger" data-action="timer-reset">破棄する</button>
          </div>
        </section>` : ""}
      <section class="panel timer-stage" data-stage="${main || "none"}" ${t.pausedAt ? 'data-paused="true"' : ""}>
        <div class="timer-info">
          ${UI.kindBadge(i.kind || "flow")}
          <span class="timer-info-slot">${def ? def.label : ""}${i.date ? ` <span class="num timer-info-date">${Util.md(Util.parseKey(i.date))}</span>` : ""}</span>
          <span class="timer-info-title">${i.title ? Util.esc(i.title) : '<span class="timer-info-none">企画名なし</span>'}</span>
          ${i.test ? `<span class="timer-info-test">🧪 ${Util.esc(i.test)}</span>` : ""}
        </div>

        <div class="timer-stage-label" data-bind="stage-label">${st ? `<span aria-hidden="true">${st.icon}</span> ${st.no}/4 ${Util.esc(st.name)}` : t.pausedAt ? "⏸ 一時停止中" : "● 配信中"}</div>

        <div class="timer-dial" style="--p:${TimerView.progress(t, now).toFixed(2)}" data-bind="dial">
          <div class="timer-dial-inner">
            <div class="timer-remaining num" data-bind="remaining" aria-live="off">${TimerLogic.format(TimerLogic.remainingMs(t, now))}</div>
            <div class="timer-remaining-label" data-bind="remaining-label">${TimerLogic.remainingMs(t, now) < 0 ? "予定超過" : "残り時間"}</div>
          </div>
        </div>

        <div class="timer-meta">
          <span>実経過 <b class="num" data-bind="elapsed">${Math.floor(TimerLogic.elapsedMs(t, now) / 60000)}</b>分</span>
          <span class="sep" aria-hidden="true">／</span><span>予定 <b class="num">${t.durationMin}</b>分</span>
          <span class="sep" aria-hidden="true">／</span><span>終了予定 <b class="num" data-bind="end-at">${Util.hm(endAt)}</b></span>
        </div>

        ${st ? `<p class="timer-msg"><b>${Util.esc(st.title)}</b>${Util.esc(st.text)}</p>` : ""}
        ${showLoss ? `
          <div class="timer-judge" role="status">
            <span class="alert-icon" aria-hidden="true">${loss.icon}</span>
            <span><b>${Util.esc(loss.title)}</b>${Util.esc(loss.text)}</span>
            <button type="button" class="icon-btn" data-action="alert-dismiss" data-stage="loss" aria-label="判定を閉じる">✕</button>
          </div>` : ""}

        <div class="timer-actions">
          ${t.pausedAt
            ? `<button type="button" class="btn big" data-action="timer-resume">▶ 再開</button>`
            : `<button type="button" class="btn big" data-action="timer-pause">⏸ 一時停止</button>`}
          <button type="button" class="btn big" data-variant="ghost" data-action="timer-reset">↺ リセット</button>
          <button type="button" class="btn big timer-finish" data-variant="primary" data-action="timer-finish">■ 配信終了 → KPI記録へ</button>
        </div>
      </section>
      <section class="panel timer-steps" aria-label="段階アラートの予定">
        <ol class="step-list">${TimerLogic.STAGES.filter((s) => s.id !== "loss" || (i.kind === "flow" && t.durationMin > CONFIG.LOSS_CUT_MIN))
          .map((s) => `<li data-stage="${s.id}" ${due.includes(s.id) ? 'data-done="true"' : ""}><span class="step-dot" aria-hidden="true">${s.icon}</span><span class="step-when num">${TimerView.stageWhen(s, t)}</span><span>${Util.esc(s.name)}</span></li>`)
          .join("")}</ol>
      </section>`;
  },

  stageWhen(s, t) {
    if (s.id === "loss") return `経過${CONFIG.LOSS_CUT_MIN}分`;
    return { w20: "残り20分", w5: "残り5分", end: "残り0分", over: `+${CONFIG.OVERTIME_LIMIT_MIN}分` }[s.id];
  },

  progress(t, now) {
    const total = t.durationMin * 60000;
    const rem = TimerLogic.remainingMs(t, now);
    // 予定超過中は、延長上限（+15分）までの進み具合を描く
    if (rem < 0) return Math.min(100, (-rem / (CONFIG.OVERTIME_LIMIT_MIN * 60000)) * 100);
    return Math.min(100, Math.max(0, (TimerLogic.elapsedMs(t, now) / total) * 100));
  },

  soundRow() {
    const muted = Store.local.sound.muted;
    return `
      <section class="panel sound-row">
        <span class="field-label">通知音</span>
        <button type="button" class="btn" data-variant="ghost" data-action="sound-mute" aria-pressed="${muted}">${muted ? "🔇 ミュート中" : "🔔 音あり"}</button>
        <button type="button" class="btn" data-variant="ghost" data-action="sound-test">テスト再生</button>
        <button type="button" class="link-btn" data-action="open-settings" data-section="sound">通知の設定</button>
      </section>`;
  },

  // 1秒ごと：数字とリングだけ書き換える。段階が変わった時だけ描き直す
  update(now) {
    const t = Store.local.timer;
    const stage = t ? TimerLogic.main(t, now) : null;
    if (stage !== TimerView.renderedStage) return Alerts.queueRender();
    if (!t) return;
    const view = document.getElementById("view");
    const q = (b) => view.querySelector(`[data-bind="${b}"]`);
    const rem = TimerLogic.remainingMs(t, now);
    const r = q("remaining");
    if (r) r.textContent = TimerLogic.format(rem);
    const rl = q("remaining-label");
    if (rl) rl.textContent = rem < 0 ? "予定超過" : "残り時間";
    const e = q("elapsed");
    if (e) e.textContent = String(Math.floor(TimerLogic.elapsedMs(t, now) / 60000));
    const d = q("dial");
    if (d) d.style.setProperty("--p", TimerView.progress(t, now).toFixed(2));
    if (t.pausedAt) {
      const ea = q("end-at");
      if (ea) ea.textContent = Util.hm(new Date(t.startedAt + t.pausedMs + (now - t.pausedAt) + t.durationMin * 60000));
    }
  },
};
