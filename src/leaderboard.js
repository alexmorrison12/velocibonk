// Global leaderboard (Supabase). Plugs into the title screen (Today / All-time / Mine tabs, with
// BEAT IT buttons that launch a challenge on that run's island) and the game-over screen (name + submit).
// All access goes through two Postgres functions; the table itself is not readable by clients.

const API = 'https://zrwwspvdrcddawyjenqq.supabase.co/rest/v1/rpc/';
const KEY = 'sb_publishable_mQjO544CeOVMMp66j4Uvjw_iYuoAMD1'; // publishable key: safe to ship to browsers

async function rpc(fn, body) {
  const res = await fetch(API + fn, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.message) || `Leaderboard error (${res.status})`);
  return data;
}

const commas = n => Math.round(n).toLocaleString('en-US');
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export class Leaderboard {
  constructor(game, { getName, setName }) {
    this.game = game; this.getName = getName; this.setName = setName;
    this.tab = 'today';
    this.cache = { today: null, all: null };
    this.offline = false;
    this._buildTitle();
    this._buildGameOver();
  }

  // ------------------------------------------------------------ title screen
  _buildTitle() {
    const card = document.querySelector('.vb-bests-card');
    if (!card) return;
    const head = card.querySelector('.vb-card-head');
    if (head && head.lastChild) head.lastChild.textContent = 'LEADERBOARD';
    this.tabs = h('div', 'vb-lb-tabs');
    this.tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['today', 'TODAY'], ['all', 'ALL-TIME'], ['mine', 'MINE']]) {
      const b = h('button', 'vb-lb-tab', label);
      b.type = 'button'; b.dataset.tab = id; b.setAttribute('role', 'tab');
      b.addEventListener('click', () => { this.tab = id; this.renderTitle(); });
      this.tabs.append(b);
    }
    head.after(this.tabs);
    this.mineList = card.querySelector('ol.vb-bests');
    this.globalList = h('ol', 'vb-bests vb-lb-list');
    this.mineList.after(this.globalList);
    this.note = card.querySelector('.vb-daily-note');
  }

  async refresh() {
    if (!this.tabs) return;
    this.renderTitle();
    try {
      const daily = this.game.daily.n;
      const [today, all] = await Promise.all([rpc('top_scores', { p_daily: daily, p_limit: 10 }), rpc('top_scores', { p_daily: null, p_limit: 10 })]);
      this.cache.today = today; this.cache.all = all; this.offline = false;
    } catch {
      this.offline = true;
    }
    this.renderTitle();
  }

  renderTitle() {
    if (!this.tabs) return;
    for (const b of this.tabs.children) {
      const on = b.dataset.tab === this.tab;
      b.classList.toggle('vb-on', on); b.setAttribute('aria-selected', String(on));
    }
    const mine = this.tab === 'mine';
    this.mineList.hidden = !mine;
    this.globalList.hidden = mine;
    if (this.note) this.note.textContent = mine ? 'Your best runs on this device.' : this.tab === 'today' ? `Daily #${this.game.daily.n} · same island for everyone today` : 'Best score per player, any island';
    if (mine) return;
    const ol = this.globalList; ol.textContent = '';
    const rows = this.cache[this.tab];
    if (this.offline) { ol.append(h('li', 'vb-empty', 'Leaderboard is offline here. Play at alexmorrison12.github.io/velocibonk')); return; }
    if (!rows) { ol.append(h('li', 'vb-empty', 'Loading…')); return; }
    if (!rows.length) { ol.append(h('li', 'vb-empty', this.tab === 'today' ? 'No scores today yet. Claim #1.' : 'No scores yet. Claim #1.')); return; }
    const me = (this.getName() || '').toLowerCase();
    rows.forEach((r, i) => {
      const li = h('li', 'vb-best vb-lb-row');
      if (me && r.name.toLowerCase() === me) li.classList.add('vb-me');
      const island = r.tag[0] === 'd' ? `DAILY #${r.tag.slice(1)}` : 'RANDOM ISLAND';
      const text = h('span', 'vb-lb-text');
      const top = h('span', 'vb-lb-top');
      top.append(h('span', 'vb-lb-name', r.name), h('span', 'vb-best-score', commas(r.score)));
      const reached = r.island > 1 ? ` · ISLAND ${r.island}/5` : '';
      text.append(top, h('span', 'vb-best-meta', `${mmss(r.time_s)} · ${commas(r.kills)} KO · ${island}${reached}`));
      const beat = h('button', 'vb-lb-beat', 'BEAT IT');
      beat.type = 'button';
      beat.title = `Play ${island.toLowerCase()} and try to beat ${commas(r.score)}`;
      beat.addEventListener('click', () => this.game.startChallenge({ score: Number(r.score), name: r.name, tag: r.tag }));
      li.append(h('span', 'vb-best-rank', String(i + 1)), text, beat);
      ol.append(li);
    });
  }

  // ------------------------------------------------------------ game over
  _buildGameOver() {
    const anchor = document.querySelector('.vb-over-btns');
    if (!anchor) return;
    const box = h('form', 'vb-lb-submit');
    box.noValidate = true;
    const label = h('label', 'vb-lb-label', 'POST TO THE GLOBAL LEADERBOARD');
    label.htmlFor = 'vb-lb-name';
    const row = h('div', 'vb-lb-row2');
    const input = h('input', 'vb-lb-input');
    Object.assign(input, { id: 'vb-lb-name', maxLength: 14, placeholder: 'YOUR NAME', autocomplete: 'nickname', spellcheck: false });
    const btn = h('button', 'vb-btn vb-btn-md vb-btn-volt');
    btn.type = 'submit';
    const btnIn = h('span', 'vb-btn-in', 'SUBMIT');
    btn.append(btnIn);
    row.append(input, btn);
    const msg = h('div', 'vb-lb-msg');
    msg.setAttribute('role', 'status');
    box.append(label, row, msg);
    anchor.before(box);
    box.addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    // keep typing from leaking into game controls
    input.addEventListener('keydown', (e) => e.stopPropagation());
    this.form = { box, input, btn, btnIn, msg };
  }

  prepareSubmit(run) {
    if (!this.form) return;
    this.pending = run;
    const f = this.form;
    f.box.hidden = !(run.score > 0 && run.time >= 10);
    f.input.value = this.getName() || '';
    f.input.disabled = false; f.btn.disabled = false;
    f.btnIn.textContent = 'SUBMIT';
    f.msg.textContent = run.time < 10 ? '' : 'One name per player. Your best score counts.';
    f.msg.className = 'vb-lb-msg';
  }

  async submit() {
    const f = this.form, run = this.pending;
    if (!run || f.btn.disabled) return;
    const name = f.input.value.trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9 _.\-]{2,14}$/.test(name)) {
      f.msg.textContent = 'Use 2–14 letters, numbers, spaces, dots, dashes or underscores.';
      f.msg.className = 'vb-lb-msg vb-err';
      return;
    }
    this.setName(name);
    f.btn.disabled = true; f.input.disabled = true; f.btnIn.textContent = 'POSTING…';
    try {
      const r = await rpc('submit_score', {
        p_name: name, p_score: Math.round(run.score), p_time: Math.floor(run.time), p_kills: run.kills,
        p_level: run.level, p_top_speed: +run.topSpeed.toFixed(2), p_max_momentum: +Math.min(8.5, run.maxMomentum).toFixed(2), p_tag: run.tag, p_island: run.island || 1,
      });
      f.btnIn.textContent = 'POSTED';
      const parts = [];
      if (r.rank_daily) parts.push(`#${r.rank_daily} TODAY`);
      parts.push(`#${r.rank_all} ALL-TIME`);
      f.msg.textContent = `You're ${parts.join(' · ')}`;
      f.msg.className = 'vb-lb-msg vb-ok';
      this.pending = null;
      this.cache.today = this.cache.all = null;
      this.refresh();
    } catch (err) {
      const offline = err instanceof TypeError;
      f.msg.textContent = offline ? 'Could not reach the leaderboard. It works on the public site.' : err.message;
      f.msg.className = 'vb-lb-msg vb-err';
      f.btnIn.textContent = 'RETRY';
      f.btn.disabled = false; f.input.disabled = false;
    }
  }
}
