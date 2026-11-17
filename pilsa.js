// 필사 화면: 글을 보며 줄 공책 한 장에 자유롭게 씁니다. 채점은 없습니다.
// 획 좌표는 줄 간격을 1로 하는 단위로 저장해, 줄 간격을 바꾸면 글씨도 같은 비율로 따라옵니다.
(function () {
  'use strict';

  // 저작권 보호 기간이 끝난 시(현대 맞춤법으로 옮긴 것).
  const TEXTS = [
    {
      id: 'seosi', title: '서시', author: '윤동주',
      body: '죽는 날까지 하늘을 우러러\n한 점 부끄럼이 없기를,\n잎새에 이는 바람에도\n나는 괴로워했다.\n별을 노래하는 마음으로\n모든 죽어 가는 것을 사랑해야지\n그리고 나한테 주어진 길을\n걸어가야겠다.\n\n오늘 밤에도 별이 바람에 스치운다.',
    },
    {
      id: 'saeroungil', title: '새로운 길', author: '윤동주',
      body: '내를 건너서 숲으로\n고개를 넘어서 마을로\n\n어제도 가고 오늘도 갈\n나의 길 새로운 길\n\n민들레가 피고 까치가 날고\n아가씨가 지나고 바람이 일고\n\n나의 길은 언제나 새로운 길\n오늘도…… 내일도……\n\n내를 건너서 숲으로\n고개를 넘어서 마을로',
    },
    {
      id: 'jindallae', title: '진달래꽃', author: '김소월',
      body: '나 보기가 역겨워\n가실 때에는\n말없이 고이 보내 드리우리다\n\n영변에 약산\n진달래꽃\n아름 따다 가실 길에 뿌리우리다\n\n가시는 걸음 걸음\n놓인 그 꽃을\n사뿐히 즈려밟고 가시옵소서\n\n나 보기가 역겨워\n가실 때에는\n죽어도 아니 눈물 흘리우리다',
    },
  ];
  const CUSTOM_ID = 'custom';

  const KEY = {
    text: 'pilsa.text',
    gap: 'pilsa.gap',
    custom: 'pilsa.custom',
    days: 'pilsa.days',
    page: (id) => 'pilsa.page.' + id,
  };
  const BASE_LINES = 14;
  const MORE_LINES = 6;
  const MAX_LINES = 80;
  const INK = '#1b2a4a';
  const DAYS_SHOWN = 10;

  const state = {
    textId: TEXTS[0].id,
    custom: '',
    gap: 52,          // 줄 간격(px)
    lines: BASE_LINES,
    strokes: [],      // { points: [{ x, y, p }] }, 좌표는 줄 간격 단위
    penSeen: false,   // 펜을 한 번이라도 쓰면 손가락은 필기 대신 화면 넘기기에 씁니다
  };

  const $ = (id) => document.getElementById(id);
  const paper = $('paper');
  const canvas = $('ink');
  let width = 0;      // 종이 너비(px)

  // ---------- 저장 ----------

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  /** 저장에 실패하면 false. 저장 공간이 찼거나 사생활 보호 모드일 때입니다. */
  function write(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function showNotice(message) {
    const notice = $('notice');
    notice.textContent = message || '';
    notice.hidden = !message;
  }

  function loadPage() {
    state.strokes = [];
    state.lines = BASE_LINES;
    let page = null;
    try {
      page = JSON.parse(read(KEY.page(state.textId)));
    } catch {
      page = null;
    }
    if (!page || !Array.isArray(page.strokes)) return;
    if (Number.isInteger(page.lines)) state.lines = Math.max(BASE_LINES, Math.min(MAX_LINES, page.lines));
    for (const flat of page.strokes) {
      if (!Array.isArray(flat)) continue;
      const points = [];
      for (let i = 0; i + 2 < flat.length; i += 3) {
        points.push({ x: flat[i], y: flat[i + 1], p: flat[i + 2] });
      }
      if (points.length) state.strokes.push({ points });
    }
  }

  let saveTimer = null;

  function savePageNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const round = (v, n) => Math.round(v * n) / n;
    const strokes = state.strokes.map((stroke) => {
      const flat = [];
      for (const pt of stroke.points) flat.push(round(pt.x, 1000), round(pt.y, 1000), round(pt.p, 100));
      return flat;
    });
    const ok = write(KEY.page(state.textId), JSON.stringify({ lines: state.lines, strokes }));
    showNotice(ok ? '' : '쓴 글씨를 이 기기에 보관하지 못했습니다. 저장 공간이 찼을 수 있으니, 남기려면 이미지로 저장해 주세요.');
  }

  function savePageSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePageNow, 400);
  }

  // ---------- 글 ----------

  function currentText() {
    if (state.textId === CUSTOM_ID) return { title: '직접 입력한 글', author: '', body: state.custom };
    return TEXTS.find((t) => t.id === state.textId) || TEXTS[0];
  }

  function renderPassage() {
    const text = currentText();
    const box = $('passage');
    box.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'sub';
    heading.textContent = text.author ? `${text.title} · ${text.author}` : text.title;
    const body = document.createElement('p');
    body.textContent = text.body || '아래 칸에 필사할 글을 넣고 적용을 눌러 주세요.';
    box.append(heading, body);
    $('customForm').hidden = state.textId !== CUSTOM_ID;
  }

  function chooseText(id) {
    if (saveTimer) savePageNow();   // 넘어가기 전에 지금 장을 먼저 보관합니다
    state.textId = id;
    write(KEY.text, id);
    loadPage();
    renderPassage();
    layout();
  }

  // ---------- 종이와 그리기 ----------

  const strokeWidth = (p) => Math.max(1.2, state.gap * 0.05 * (0.5 + p));

  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  /** from에서 to까지, ctrl을 당기는 점으로 한 곡선 한 토막 */
  function drawCurve(ctx, from, ctrl, to, p) {
    const g = state.gap;
    ctx.beginPath();
    ctx.lineWidth = strokeWidth(p);
    ctx.moveTo(from.x * g, from.y * g);
    ctx.quadraticCurveTo(ctrl.x * g, ctrl.y * g, to.x * g, to.y * g);
    ctx.stroke();
  }

  function drawLine(ctx, from, to, p) {
    const g = state.gap;
    ctx.beginPath();
    ctx.lineWidth = strokeWidth(p);
    ctx.moveTo(from.x * g, from.y * g);
    ctx.lineTo(to.x * g, to.y * g);
    ctx.stroke();
  }

  function drawDot(ctx, pt) {
    ctx.beginPath();
    ctx.arc(pt.x * state.gap, pt.y * state.gap, strokeWidth(pt.p) / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * 보정된 점들을 곡선으로 잇습니다. 점과 점의 가운데를 곡선의 이음매로 삼아 모서리가 생기지 않게 합니다.
   * 쓰는 중에 한 토막씩 그리는 LiveStroke와 같은 순서로 그려, 다시 그려도 모양이 바뀌지 않습니다.
   */
  function drawSmoothed(ctx, pts) {
    drawDot(ctx, pts[0]);
    if (pts.length === 1) return;
    let prev = pts[0];
    let prevMid = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const cur = pts[i];
      const mid = midpoint(prev, cur);
      drawCurve(ctx, prevMid, prev, mid, (prev.p + cur.p) / 2);
      prev = cur;
      prevMid = mid;
    }
    drawLine(ctx, prevMid, prev, prev.p);
  }

  /** 쓰는 중인 획: 들어오는 점을 바로 보정해 한 토막씩 이어 그립니다. */
  function LiveStroke(first) {
    const smoother = Ink.createSmoother(state.gap);
    let prev = smoother.push(first);
    let prevMid = prev;
    let moved = false;
    drawDot(inkContext(), prev);

    return {
      add(ctx, pt) {
        const cur = smoother.push(pt);
        const mid = midpoint(prev, cur);
        drawCurve(ctx, prevMid, prev, mid, (prev.p + cur.p) / 2);
        prev = cur;
        prevMid = mid;
        moved = true;
      },
      // 펜을 뗀 실제 위치까지 마저 잇습니다(Ink.smoothPoints의 마지막 점과 같은 처리).
      finish(ctx, raw) {
        if (!moved) return;
        const end = { x: raw.x, y: raw.y, p: prev.p };
        const mid = midpoint(prev, end);
        drawCurve(ctx, prevMid, prev, mid, (prev.p + end.p) / 2);
        drawLine(ctx, mid, end, end.p);
      },
    };
  }

  function drawInk(ctx) {
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of state.strokes) {
      drawSmoothed(ctx, Ink.smoothPoints(stroke.points, state.gap));
    }
  }

  function inkContext() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    return ctx;
  }

  /** 종이 크기를 다시 잡고 전부 다시 그립니다. 줄은 CSS 배경이 그립니다. */
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    width = Math.max(1, Math.floor(paper.clientWidth));
    const height = state.lines * state.gap;
    paper.style.setProperty('--gap', state.gap + 'px');
    canvas.style.height = height + 'px';
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = inkContext();
    ctx.clearRect(0, 0, width, height);
    drawInk(ctx);
    $('more').disabled = state.lines >= MAX_LINES;
  }

  // ---------- 필기 입력 ----------

  function toPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / state.gap,
      y: (e.clientY - rect.top) / state.gap,
      p: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
    };
  }

  function attachInput() {
    let activeId = null;
    let stroke = null;
    let live = null;
    let scrollId = null;
    let scrollY = 0;

    // iOS Safari의 길게 누르기 선택·돋보기를 막습니다. 그래서 손가락 넘기기는 아래에서 직접 처리합니다.
    canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'pen') state.penSeen = true;
      if (e.pointerType === 'touch' && state.penSeen) {
        // 펜으로 쓰는 중에는 손가락으로 종이를 위아래로 넘깁니다.
        e.preventDefault();
        if (scrollId === null) {
          scrollId = e.pointerId;
          scrollY = e.clientY;
        }
        return;
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (activeId !== null) return;

      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // 붙잡지 못해도 종이 안에서는 그대로 쓸 수 있습니다.
      }
      activeId = e.pointerId;
      stroke = { points: [toPoint(e)] };
      state.strokes.push(stroke);
      live = LiveStroke(stroke.points[0]);
      recordDay();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId === scrollId) {
        window.scrollBy(0, scrollY - e.clientY);
        scrollY = e.clientY;
        return;
      }
      if (e.pointerId !== activeId) return;
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const ctx = inkContext();
      for (const ev of events.length ? events : [e]) {
        const pt = toPoint(ev);
        stroke.points.push(pt);   // 저장은 원래 좌표 그대로
        live.add(ctx, pt);        // 화면에는 보정해서 그립니다
      }
    });

    const end = (e) => {
      if (e.pointerId === scrollId) scrollId = null;
      if (e.pointerId !== activeId) return;
      live.finish(inkContext(), stroke.points[stroke.points.length - 1]);
      activeId = null;
      stroke = null;
      live = null;
      savePageSoon();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // ---------- 필사한 날 ----------

  function loadDays() {
    try {
      const parsed = JSON.parse(read(KEY.days));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function today() {
    const now = new Date();
    const two = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  }

  /** 오늘 이 글을 처음 쓰기 시작했을 때 한 번 기록합니다. */
  function recordDay() {
    const title = currentText().title;
    const d = today();
    const days = loadDays();
    if (days.some((day) => day.d === d && day.title === title)) return;
    write(KEY.days, JSON.stringify([{ d, title }, ...days].slice(0, 400)));
    renderDays();
  }

  function renderDays() {
    const days = loadDays().slice(0, DAYS_SHOWN);
    const list = $('dayList');
    list.replaceChildren();
    $('dayEmpty').hidden = days.length > 0;
    for (const day of days) {
      const item = document.createElement('li');
      const date = document.createElement('span');
      date.className = 'meta';
      date.textContent = day.d;
      const title = document.createElement('span');
      title.className = 'text';
      title.textContent = day.title;
      item.append(date, title);
      list.append(item);
    }
  }

  // ---------- 이미지로 저장 ----------

  async function saveImage() {
    if (state.strokes.length === 0) {
      showNotice('아직 쓴 글씨가 없습니다.');
      return;
    }
    // 소리는 이미지를 다 만든 뒤에 내므로, 버튼을 누른 지금 소리 장치를 먼저 깨워 둡니다(iPad).
    Sound.unlock();
    const scale = 2;
    const g = state.gap;
    const footer = 36;
    const height = state.lines * g;
    const out = document.createElement('canvas');
    out.width = width * scale;
    out.height = (height + footer) * scale;
    const ctx = out.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height + footer);

    ctx.strokeStyle = '#cfd6e0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i <= state.lines; i++) {
      ctx.moveTo(0, i * g - 0.5);
      ctx.lineTo(width, i * g - 0.5);
    }
    ctx.stroke();
    drawInk(ctx);

    const text = currentText();
    ctx.fillStyle = '#6b7280';
    ctx.font = '14px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText([text.title, text.author, today()].filter(Boolean).join(' · '), 12, height + footer / 2);

    const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
    if (!blob) {
      showNotice('이미지를 만들지 못했습니다.');
      return;
    }
    Sound.play('done');
    const name = `필사_${text.title}_${today()}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    // 태블릿·휴대폰에서는 공유 창(사진에 저장 등)을 열고, PC에서는 바로 내려받습니다.
    if (window.matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;   // 공유 창을 닫은 경우
        // 공유가 안 되면 아래에서 내려받습니다.
      }
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ---------- 시작 ----------

  function init() {
    state.custom = read(KEY.custom) || '';
    $('customText').value = state.custom;

    const select = $('text');
    for (const text of TEXTS) {
      const option = document.createElement('option');
      option.value = text.id;
      option.textContent = `${text.title} (${text.author})`;
      select.append(option);
    }
    const customOption = document.createElement('option');
    customOption.value = CUSTOM_ID;
    customOption.textContent = '직접 입력';
    select.append(customOption);

    const savedText = read(KEY.text);
    if (savedText === CUSTOM_ID || TEXTS.some((t) => t.id === savedText)) state.textId = savedText;
    select.value = state.textId;
    select.addEventListener('change', () => chooseText(select.value));

    const gapSelect = $('gap');
    const gaps = Array.from(gapSelect.options, (option) => Number(option.value));
    const savedGap = Number(read(KEY.gap));
    if (gaps.includes(savedGap)) state.gap = savedGap;
    gapSelect.value = String(state.gap);
    gapSelect.addEventListener('change', () => {
      state.gap = Number(gapSelect.value);
      write(KEY.gap, String(state.gap));
      layout();
    });

    $('customForm').addEventListener('submit', (e) => {
      e.preventDefault();
      state.custom = $('customText').value.trim();
      write(KEY.custom, state.custom);
      renderPassage();
    });

    $('undo').addEventListener('click', () => {
      if (state.strokes.pop()) {
        layout();
        savePageSoon();
      }
    });

    $('clear').addEventListener('click', () => {
      if (state.strokes.length === 0) return;
      if (!window.confirm('이 장에 쓴 글씨를 모두 지울까요? 되돌릴 수 없습니다.')) return;
      state.strokes = [];
      state.lines = BASE_LINES;
      layout();
      savePageNow();
      Sound.play('erase');
    });

    $('more').addEventListener('click', () => {
      if (state.lines >= MAX_LINES) return;
      state.lines = Math.min(MAX_LINES, state.lines + MORE_LINES);
      layout();
      savePageSoon();
      Sound.play('page');
    });

    $('save').addEventListener('click', saveImage);
    Sound.bindToggle($('sound'));

    window.addEventListener('resize', layout);
    // 화면을 떠날 때 기다리던 저장을 바로 끝냅니다.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && saveTimer) savePageNow();
    });

    loadPage();
    renderPassage();
    renderDays();
    attachInput();
    layout();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  }

  init();
})();
