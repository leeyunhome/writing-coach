// 글씨 교정 연습 화면: 칸 만들기, 필기 입력, 채점 결과 표시, 기록 저장
(function () {
  'use strict';

  const PRESETS = [
    '가나다라마바사',
    '아자차카타파하',
    '다람쥐 헌 쳇바퀴에 타고파',
    '동해물과 백두산이',
    '0123456789',
    'The quick brown fox',
  ];

  // 본보기 글꼴. web이 있으면 구글 폰트에서 받아옵니다.
  // scale은 글자가 작게 디자인된 글꼴(펜글씨)을 고딕과 비슷한 크기로 키우는 배율입니다.
  const FONTS = {
    gothic: { family: '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR", sans-serif', scale: 1 },
    myeongjo: { family: '"Nanum Myeongjo", "AppleMyungjo", "Batang", serif', scale: 1, web: 'Nanum Myeongjo' },
    penNeat: { family: '"Hi Melody", cursive', scale: 1.3, web: 'Hi Melody' },
    penScript: { family: '"Nanum Pen Script", cursive', scale: 1.3, web: 'Nanum Pen Script' },
  };

  const FALLBACK_FAMILY = FONTS.gothic.family;
  const FONT_KEY = 'writingCoach.font';
  const FONT_DB = 'writingCoach';
  const MAX_FONT_BYTES = 30 * 1024 * 1024;
  let customSeq = 0;      // 글꼴을 바꿔 올릴 때마다 새 이름을 붙여 채점 캐시가 섞이지 않게 합니다
  let customFace = null;

  const MAX_CHARS = 40;
  const HISTORY_KEY = 'writingCoach.history';
  const HISTORY_SHOWN = 8;
  const SIZE_KEY = 'writingCoach.size';
  const TAGS_UNDER_CELL_MIN = 88;   // 이보다 작은 칸은 문제 표시가 칸 밑에 들어가지 않아 요약에 모아 보여 줍니다
  const LOW_SCORE_SHOWN = 5;

  const ADVICE = {
    '작음': '글자가 본보기보다 작습니다. 칸을 더 채워 써 보세요.',
    '큼': '글자가 본보기보다 큽니다. 칸 안쪽 여백을 남겨 보세요.',
    '오른쪽 치우침': '글자가 오른쪽으로 치우칩니다. 가운데 점선을 기준으로 잡아 보세요.',
    '왼쪽 치우침': '글자가 왼쪽으로 치우칩니다. 가운데 점선을 기준으로 잡아 보세요.',
    '아래로 치우침': '글자가 아래로 처집니다. 가로 점선에 글자 중심을 맞춰 보세요.',
    '위로 치우침': '글자가 위로 뜹니다. 가로 점선에 글자 중심을 맞춰 보세요.',
    '빠진 획': '본보기의 획 일부가 비어 있습니다. 획을 끝까지 긋는지 확인해 보세요.',
    '벗어난 획': '본보기에서 벗어난 획이 있습니다. 획의 방향과 위치를 본보기와 비교해 보세요.',
  };

  const state = {
    text: PRESETS[0],
    mode: 'trace',
    font: 'gothic',
    size: 64,
    cells: [],        // { ch, strokes, result, canvas, resultEl }
    undoStack: [],    // 획을 그은 순서대로 쌓인 칸
    penSeen: false,   // 펜을 한 번이라도 쓰면 손가락(손바닥) 입력은 무시합니다
  };

  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const summary = $('summary');

  // ---------- 칸 만들기와 그리기 ----------

  function build() {
    grid.replaceChildren();
    state.cells = [];
    state.undoStack = [];
    summary.hidden = true;
    resetAdvice();
    document.documentElement.style.setProperty('--cell', state.size + 'px');

    for (const ch of Array.from(state.text).slice(0, MAX_CHARS)) {
      if (/\s/.test(ch)) {
        const spacer = document.createElement('div');
        spacer.className = 'spacer';
        grid.append(spacer);
        continue;
      }

      const el = document.createElement('div');
      el.className = 'cell';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `'${ch}' 연습 칸`);
      const resultEl = document.createElement('div');
      resultEl.className = 'result';
      el.append(canvas, resultEl);
      grid.append(el);

      const cell = { ch, strokes: [], result: null, canvas, resultEl };
      state.cells.push(cell);
      attachInput(cell);
      redraw(cell);
    }
  }

  function redraw(cell) {
    const size = state.size;
    const dpr = window.devicePixelRatio || 1;
    const canvas = cell.canvas;
    if (canvas.width !== Math.round(size * dpr)) {
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // 가운데 점선(글자 중심을 잡는 기준)
    ctx.save();
    ctx.strokeStyle = '#e3e7ee';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2, size);
    ctx.moveTo(0, size / 2);
    ctx.lineTo(size, size / 2);
    ctx.stroke();
    ctx.restore();

    const font = FONTS[state.font];
    if (state.mode === 'trace') {
      Scoring.drawGlyph(ctx, cell.ch, font,size, '#d3d8e0');
    } else if (cell.result && !cell.result.empty) {
      // 혼자 쓰기는 채점한 뒤에만 본보기를 겹쳐 보여 줍니다.
      Scoring.drawGlyph(ctx, cell.ch, font,size, 'rgba(214, 60, 50, 0.32)');
    }

    Scoring.drawStrokes(ctx, cell.strokes, size, '#1b2a4a');
  }

  function redrawAll() {
    state.cells.forEach(redraw);
  }

  // ---------- 필기 입력 ----------

  function attachInput(cell) {
    const canvas = cell.canvas;
    let activeId = null;
    let stroke = null;

    const toPoint = (e) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
        p: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
      };
    };

    // iOS Safari는 pointerdown의 preventDefault만으로는 길게 누르기 선택·돋보기를 막지 못하므로
    // touchstart에서도 막습니다(무시하는 손바닥 터치 포함).
    canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'pen') state.penSeen = true;
      if (e.pointerType === 'touch' && state.penSeen) { e.preventDefault(); return; }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (activeId !== null) return;

      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      activeId = e.pointerId;
      stroke = { points: [toPoint(e)] };
      cell.strokes.push(stroke);
      state.undoStack.push(cell);
      clearResult(cell);
      redraw(cell);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activeId) return;
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) {
        stroke.points.push(toPoint(ev));
      }
      redraw(cell);
    });

    const end = (e) => {
      if (e.pointerId !== activeId) return;
      activeId = null;
      stroke = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // ---------- 채점 ----------

  function clearResult(cell) {
    cell.result = null;
    cell.resultEl.className = 'result';
    cell.resultEl.replaceChildren();
    resetAdvice();   // 채점 결과가 바뀌면 이전 조언은 맞지 않습니다
  }

  function showResult(cell) {
    const result = cell.result;
    cell.resultEl.replaceChildren();
    if (!result || result.empty) {
      cell.resultEl.className = 'result';
      return;
    }
    const level = result.score >= 80 ? 'good' : result.score >= 60 ? 'mid' : 'bad';
    cell.resultEl.className = 'result ' + level;
    const score = document.createElement('strong');
    score.textContent = result.score + '점';
    cell.resultEl.append(score);
    if (state.size >= TAGS_UNDER_CELL_MIN) cell.resultEl.append(result.tags.join(' · '));
  }

  function grade() {
    const font = FONTS[state.font];
    for (const cell of state.cells) {
      cell.result = Scoring.scoreCell(cell.ch, cell.strokes, font, state.mode, state.size);
      showResult(cell);
      redraw(cell);
    }

    const written = state.cells.filter((c) => c.result && !c.result.empty);
    summary.hidden = false;
    summary.replaceChildren();
    resetAdvice();
    $('advise').disabled = written.length === 0;

    if (written.length === 0) {
      summary.textContent = '먼저 칸에 글씨를 써 주세요.';
      return;
    }

    const average = Math.round(written.reduce((sum, c) => sum + c.result.score, 0) / written.length);
    Sound.play(average >= 80 ? 'good' : average >= 60 ? 'mid' : 'bad');
    const previous = loadHistory().find((h) => h.text === state.text && h.mode === state.mode);

    const total = document.createElement('div');
    total.className = 'total';
    total.textContent = `평균 ${average}점`;
    const detail = document.createElement('div');
    detail.className = 'sub';
    let detailText = `${state.cells.length}글자 중 ${written.length}글자 채점`;
    if (previous) {
      const diff = average - previous.score;
      detailText += ` · 같은 문장 지난 기록 ${previous.score}점 (${diff >= 0 ? '+' : ''}${diff})`;
    }
    detail.textContent = detailText;
    summary.append(total, detail);

    // 쓴 글자의 30% 이상에서 반복된 문제만 조언으로 보여 줍니다.
    const counts = {};
    for (const cell of written) {
      for (const tag of cell.result.tags) counts[tag] = (counts[tag] || 0) + 1;
    }
    const repeated = Object.entries(counts)
      .filter(([, n]) => n / written.length >= 0.3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    const list = document.createElement('ul');
    for (const [tag, n] of repeated) {
      const item = document.createElement('li');
      item.textContent = `${ADVICE[tag]} (${written.length}글자 중 ${n}글자)`;
      list.append(item);
    }
    if (repeated.length === 0) {
      const item = document.createElement('li');
      item.textContent = '여러 글자에서 반복되는 문제는 없습니다. 점수가 낮은 칸을 다시 써 보세요.';
      list.append(item);
    }
    summary.append(list);
    renderLowScores();

    saveAttempt({ t: Date.now(), text: state.text, mode: state.mode, score: average, n: written.length });
    renderHistory();
  }

  /**
   * 작은 칸에서는 글자별 문제 표시가 칸 밑에 들어가지 않으므로,
   * 점수가 낮은 글자부터 몇 개를 요약 아래에 모아 보여 줍니다.
   */
  function renderLowScores() {
    const old = summary.querySelector('.lowscores');
    if (old) old.remove();
    if (summary.hidden || state.size >= TAGS_UNDER_CELL_MIN) return;

    const flagged = state.cells
      .filter((c) => c.result && !c.result.empty && c.result.tags.length > 0)
      .sort((a, b) => a.result.score - b.result.score)
      .slice(0, LOW_SCORE_SHOWN);
    if (flagged.length === 0) return;

    const box = document.createElement('div');
    box.className = 'lowscores';
    const heading = document.createElement('div');
    heading.className = 'sub';
    heading.textContent = '점수가 낮은 글자';
    const list = document.createElement('ul');
    for (const cell of flagged) {
      const item = document.createElement('li');
      const lead = document.createElement('strong');
      lead.textContent = `'${cell.ch}' ${cell.result.score}점`;
      item.append(lead, ' ' + cell.result.tags.join(' · '));
      list.append(item);
    }
    box.append(heading, list);
    summary.append(box);
  }

  // ---------- AI 조언 ----------

  const ADVICE_CELL = 128;       // AI에 보내는 이미지의 칸 크기(px)
  const ADVICE_PER_ROW = 10;
  let adviceRequest = 0;         // 요청 번호. 기다리는 사이 글씨가 바뀌면 늦게 온 응답을 버립니다

  function resetAdvice() {
    adviceRequest++;
    const button = $('advise');
    button.disabled = true;
    button.textContent = 'AI 조언';
    $('advice').hidden = true;
  }

  /**
   * 채점한 글자들을 한 장의 이미지로 만듭니다.
   * 두 줄이 한 묶음(윗줄 본보기, 아랫줄 쓴 글씨)이고, 한 묶음에 10글자씩 왼쪽부터 놓습니다.
   */
  function buildAdviceImage(written) {
    const size = ADVICE_CELL;
    const columns = Math.min(written.length, ADVICE_PER_ROW);
    const bands = Math.ceil(written.length / ADVICE_PER_ROW);
    const canvas = document.createElement('canvas');
    canvas.width = columns * size;
    canvas.height = bands * size * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const font = FONTS[state.font];
    written.forEach((cell, i) => {
      const x = (i % ADVICE_PER_ROW) * size;
      const y = Math.floor(i / ADVICE_PER_ROW) * size * 2;

      ctx.save();
      ctx.translate(x, y);
      Scoring.drawGlyph(ctx, cell.ch, font,size, '#000');
      ctx.fillStyle = '#8a93a3';
      ctx.font = '12px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(String(i + 1), 4, 4);
      ctx.translate(0, size);
      Scoring.drawStrokes(ctx, cell.strokes, size, '#000');
      ctx.restore();

      ctx.strokeStyle = '#c5ccd6';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      ctx.strokeRect(x + 0.5, y + size + 0.5, size - 1, size - 1);
    });
    return canvas.toDataURL('image/png');
  }

  function showAdviceMessage(text, isError) {
    const panel = $('advice');
    const message = document.createElement('p');
    if (isError) message.className = 'error';
    message.textContent = text;
    panel.replaceChildren(message);
    panel.hidden = false;
  }

  function renderAdvice(advice) {
    const panel = $('advice');
    panel.replaceChildren();

    const section = (title, node) => {
      const heading = document.createElement('h3');
      heading.textContent = title;
      panel.append(heading, node);
    };
    const paragraph = (text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    };
    const list = (items, toText) => {
      const ul = document.createElement('ul');
      for (const item of items) {
        const li = document.createElement('li');
        const [lead, rest] = toText(item);
        const strong = document.createElement('strong');
        strong.textContent = lead;
        li.append(strong, ' ' + rest);
        ul.append(li);
      }
      return ul;
    };

    section('AI 조언', paragraph(advice.summary));
    if (advice.points.length) section('먼저 고칠 점', list(advice.points, (p) => [p.title + ':', p.detail]));
    if (advice.chars.length) section('글자별', list(advice.chars, (c) => [`'${c.ch}'`, c.tip]));
    if (advice.drill) section('다음 연습', paragraph(advice.drill));
    panel.hidden = false;
  }

  async function requestAdvice() {
    const written = state.cells.filter((c) => c.result && !c.result.empty);
    if (written.length === 0) return;

    if (location.protocol === 'file:') {
      showAdviceMessage('AI 조언은 파일을 직접 열었을 때는 쓸 수 없습니다. 이 폴더에서 python server.py 를 실행한 뒤 http://localhost:8000 으로 열어 주세요.', true);
      return;
    }

    const button = $('advise');
    const requestId = ++adviceRequest;
    button.disabled = true;
    button.textContent = '조언 받는 중…';
    showAdviceMessage('글씨를 살펴보고 있습니다. 10초쯤 걸릴 수 있습니다.', false);

    let advice = null;
    let errorText = null;
    try {
      const response = await fetch('/api/advice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: state.text,
          mode: state.mode,
          image: buildAdviceImage(written),
          cells: written.map((c) => ({
            ch: c.ch,
            score: c.result.score,
            sizeRatio: c.result.sizeRatio,
            dx: c.result.dx,
            dy: c.result.dy,
            tags: c.result.tags,
          })),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload) {
        advice = payload;
      } else {
        errorText = (payload && payload.error) || `AI 조언을 받아오지 못했습니다. (${response.status})`;
      }
    } catch {
      errorText = '서버에 연결하지 못했습니다. server.py가 실행 중인지 확인해 주세요.';
    }

    if (requestId !== adviceRequest) return;   // 기다리는 사이 글씨나 채점이 바뀌었습니다
    button.disabled = false;
    button.textContent = 'AI 조언';
    if (advice) {
      renderAdvice(advice);
    } else {
      showAdviceMessage(errorText, true);
    }
  }

  // ---------- 기록 ----------

  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveAttempt(attempt) {
    const history = [attempt, ...loadHistory()].slice(0, 200);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      // 저장 공간을 못 쓰는 환경(사생활 보호 모드 등)에서는 기록 없이 계속합니다.
    }
  }

  function renderHistory() {
    const history = loadHistory().slice(0, HISTORY_SHOWN);
    const list = $('historyList');
    list.replaceChildren();
    $('historyEmpty').hidden = history.length > 0;

    for (const h of history) {
      const item = document.createElement('li');
      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = h.score + '점';
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = h.text;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const when = new Date(h.t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      meta.textContent = `${h.mode === 'trace' ? '따라 쓰기' : '혼자 쓰기'} · ${when}`;
      item.append(score, text, meta);
      list.append(item);
    }
  }

  // ---------- 내 글꼴 파일 ----------

  /** 올린 글꼴 파일을 브라우저 안(IndexedDB)에 하나만 보관합니다. */
  function fontStore(write, value) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(FONT_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('fonts');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('fonts', write ? 'readwrite' : 'readonly');
        const store = tx.objectStore('fonts');
        const req = write ? store.put(value, 'custom') : store.get('custom');
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }

  /** ch를 그 글꼴로 그린 모양. 글꼴에 없는 글자는 뒤에 적은 대체 글꼴로 그려집니다. */
  function glyphPixels(ctx, family, ch) {
    ctx.clearRect(0, 0, 64, 64);
    ctx.font = `48px ${family}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, 4, 32);
    return ctx.getImageData(0, 0, 64, 64).data;
  }

  /**
   * 글꼴에 없는 글자를 찾습니다. 대체 글꼴을 고딕과 명조로 바꿔 그렸을 때 모양이 달라지면
   * 그 글자는 이 글꼴에 없어서 대체 글꼴로 그려진 것입니다.
   */
  function missingGlyphs(font, chars) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const missing = [];
    for (const ch of new Set(Array.from(chars))) {
      if (/\s/.test(ch)) continue;
      const a = glyphPixels(ctx, `"${font.own}", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`, ch);
      const b = glyphPixels(ctx, `"${font.own}", "Batang", "AppleMyungjo", serif`, ch);
      for (let i = 3; i < a.length; i += 4) {
        if (a[i] !== b[i]) { missing.push(ch); break; }
      }
    }
    return missing;
  }

  /**
   * 글자들의 평균 크기(가로×세로의 제곱근)와 평균 세로 중심(textBaseline이 middle, 글꼴 크기 100 기준).
   * 손글씨 글꼴은 글자마다 높이가 달라, 전체 경계가 아니라 글자별 값의 평균으로 잽니다.
   */
  function glyphMetrics(family, chars) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `100px ${family}`;
    ctx.textBaseline = 'middle';
    let size = 0, mid = 0, top = Infinity, bottom = -Infinity;
    for (const ch of chars) {
      const m = ctx.measureText(ch);
      const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
      const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      size += Math.sqrt(Math.max(0, w * h));
      mid += (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;
      top = Math.min(top, -m.actualBoundingBoxAscent);
      bottom = Math.max(bottom, m.actualBoundingBoxDescent);
    }
    return { size: size / chars.length, mid: mid / chars.length, span: bottom - top };
  }

  /**
   * 올린 글꼴은 글자 크기와 높이가 제각각이라, 고딕 본보기와 같은 크기로 칸 가운데에 오도록
   * 배율(scale)과 세로 위치(dy)를 맞춥니다. 글꼴에 있는 한글로만 잽니다.
   */
  function fitFont(font) {
    const SAMPLE = '한글가나몸빛';
    const absent = new Set(missingGlyphs(font, SAMPLE));
    const sample = Array.from(SAMPLE).filter((ch) => !absent.has(ch));
    if (sample.length === 0) return;   // 한글이 없는 글꼴은 맞출 기준이 없어 그대로 둡니다
    const ref = glyphMetrics(FALLBACK_FAMILY, sample);
    const own = glyphMetrics(`"${font.own}"`, sample);
    if (!(own.size > 0) || !(ref.size > 0)) return;
    // 가장 긴 글자도 칸의 84% 안에 들도록 배율에 상한을 둡니다(0.72는 drawGlyph의 글꼴 크기 비율).
    const fits = (0.84 * 100) / (0.72 * own.span);
    font.scale = Math.max(0.5, Math.min(2.5, fits, ref.size / own.size));
    // drawGlyph의 글꼴 크기는 칸의 0.72 × scale이므로, 글자 중심의 차이를 칸 비율로 바꿉니다.
    font.dy = 0.72 * (ref.mid - own.mid * font.scale) / 100;
  }

  /** 글꼴 파일을 읽어 '내 글꼴'로 등록합니다. 글꼴 파일이 아니면 예외를 던집니다. */
  async function installCustomFont(buffer, name) {
    const own = `WritingCoachUser${++customSeq}`;
    const face = new FontFace(own, buffer);
    await face.load();
    if (customFace) document.fonts.delete(customFace);
    document.fonts.add(face);
    customFace = face;

    // 글꼴에 없는 글자는 고딕으로 대신 그려지도록 고딕을 뒤에 붙입니다.
    const font = { family: `"${own}", ${FALLBACK_FAMILY}`, own, scale: 1, dy: 0, name };
    fitFont(font);
    FONTS.custom = font;

    const select = $('font');
    let option = select.querySelector('option[value="custom"]');
    if (!option) {
      option = document.createElement('option');
      option.value = 'custom';
      select.append(option);
    }
    option.textContent = '내 글꼴: ' + name.replace(/\.(ttf|otf|woff2?)$/i, '');
  }

  async function uploadFont(file) {
    const notice = $('fontNotice');
    const fail = (message) => {
      notice.textContent = message;
      notice.hidden = false;
    };
    if (file.size > MAX_FONT_BYTES) {
      fail(`'${file.name}'은(는) 너무 큽니다(30MB까지).`);
      return;
    }

    let buffer;
    try {
      buffer = await file.arrayBuffer();
      await installCustomFont(buffer, file.name);
    } catch {
      fail(`'${file.name}'을(를) 글꼴로 읽지 못했습니다. .ttf, .otf, .woff 파일인지 확인해 주세요.`);
      return;
    }

    let saved = true;
    try {
      await fontStore(true, { name: file.name, buffer });
    } catch {
      saved = false;
    }

    await chooseFont('custom');
    if (!saved) {
      notice.textContent = (notice.hidden ? '' : notice.textContent + ' ') +
        '이 브라우저에는 글꼴을 보관하지 못해, 다음에 열면 다시 올려야 합니다.';
      notice.hidden = false;
    }
  }

  /** 지난번에 올린 글꼴을 되살리고, 마지막으로 고른 본보기 글꼴로 돌아갑니다. */
  async function restoreFont() {
    try {
      const stored = await fontStore(false);
      if (stored) await installCustomFont(stored.buffer, stored.name);
    } catch {
      // 보관한 글꼴을 읽지 못하면 내 글꼴 없이 시작합니다.
    }
    const saved = localStorage.getItem(FONT_KEY);
    if (saved && saved !== state.font && FONTS[saved]) await chooseFont(saved);
  }

  // ---------- 설정 ----------

  /** 본보기 글꼴을 바꿉니다. 기준이 바뀌므로 점수는 지우고 쓴 글씨는 남깁니다. */
  async function chooseFont(key) {
    state.font = key;
    $('font').value = key;
    await ensureFont();
    localStorage.setItem(FONT_KEY, state.font);   // 받아오지 못해 고딕으로 돌아갔으면 고딕을 기억합니다
    state.cells.forEach(clearResult);
    summary.hidden = true;
    redrawAll();
  }

  /**
   * 고른 본보기 글꼴이 지금 문장을 그릴 수 있게 준비합니다.
   * 웹 글꼴은 글자 묶음별로 나뉘어 있어 문장이 바뀔 때마다 다시 불러야 합니다.
   * 받아오지 못하면 엉뚱한 글꼴로 채점하지 않도록 고딕으로 되돌리고 알립니다.
   */
  async function ensureFont() {
    const notice = $('fontNotice');
    if (state.font === 'custom') {
      const missing = missingGlyphs(FONTS.custom, state.text);
      notice.textContent = missing.length
        ? `내 글꼴에 없는 글자(${missing.join(' ')})는 고딕으로 대신 보여 주고 채점합니다.`
        : '';
      notice.hidden = missing.length === 0;
      return;
    }
    const web = FONTS[state.font].web;
    if (!web) {
      notice.hidden = true;
      return;
    }

    if (!document.querySelector(`link[data-font="${web}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.crossOrigin = 'anonymous';   // 서비스 워커가 오프라인용으로 보관할 수 있게 합니다
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(web)}&display=swap`;
      link.dataset.font = web;
      document.head.append(link);
      await new Promise((resolve) => {
        link.onload = resolve;
        link.onerror = () => {
          link.remove();   // 다음에 다시 시도할 수 있게 지웁니다
          resolve();
        };
      });
    }

    const spec = `72px "${web}"`;
    let ready = false;
    try {
      const faces = await document.fonts.load(spec, state.text);
      ready = faces.length > 0 && document.fonts.check(spec, state.text);
    } catch {
      ready = false;
    }

    if (ready) {
      notice.hidden = true;
    } else {
      state.font = 'gothic';
      $('font').value = 'gothic';
      notice.textContent = '본보기 글꼴을 받아오지 못해 고딕으로 표시합니다. 인터넷 연결을 확인해 주세요.';
      notice.hidden = false;
    }
  }

  function setText(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    state.text = Array.from(trimmed).slice(0, MAX_CHARS).join('');
    ensureFont().then(build);
  }

  function init() {
    const preset = $('preset');
    for (const text of PRESETS) {
      const option = document.createElement('option');
      option.value = text;
      option.textContent = text;
      preset.append(option);
    }
    preset.addEventListener('change', () => setText(preset.value));

    $('customForm').addEventListener('submit', (e) => {
      e.preventDefault();
      setText($('customText').value);
    });

    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener('change', () => {
        state.mode = radio.value;
        // 방식이 바뀌면 이전 점수는 기준이 달라 의미가 없으므로 지웁니다. 쓴 글씨는 남깁니다.
        state.cells.forEach(clearResult);
        summary.hidden = true;
        redrawAll();
      });
    }

    $('font').addEventListener('change', (e) => chooseFont(e.target.value));

    $('fontFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';   // 같은 파일을 다시 골라도 change가 오도록 비웁니다
      if (file) uploadFont(file);
    });

    const sizeSelect = $('size');
    const sizes = Array.from(sizeSelect.options, (option) => Number(option.value));
    let savedSize = NaN;
    try {
      savedSize = Number(localStorage.getItem(SIZE_KEY));
    } catch {
      // 저장 공간을 못 쓰는 환경에서는 기본 크기로 시작합니다.
    }
    if (sizes.includes(savedSize)) state.size = savedSize;
    sizeSelect.value = String(state.size);

    sizeSelect.addEventListener('change', (e) => {
      state.size = Number(e.target.value);
      try {
        localStorage.setItem(SIZE_KEY, String(state.size));
      } catch {
        // 기억하지 못해도 이번에는 고른 크기로 씁니다.
      }
      document.documentElement.style.setProperty('--cell', state.size + 'px');
      redrawAll();   // 획은 칸 크기에 대한 비율로 저장돼 있어 그대로 따라옵니다
      // 문제 표시를 칸 밑에 둘지 요약에 모을지가 칸 크기에 따라 달라집니다.
      state.cells.forEach((cell) => { if (cell.result) showResult(cell); });
      renderLowScores();
    });

    $('undo').addEventListener('click', () => {
      const cell = state.undoStack.pop();
      if (!cell) return;
      cell.strokes.pop();
      clearResult(cell);
      redraw(cell);
    });

    $('clear').addEventListener('click', () => {
      for (const cell of state.cells) {
        cell.strokes = [];
        clearResult(cell);
        redraw(cell);
      }
      state.undoStack = [];
      summary.hidden = true;
    });

    $('grade').addEventListener('click', grade);

    Sound.bindToggle($('sound'));
    $('advise').addEventListener('click', requestAdvice);

    build();
    renderHistory();
    restoreFont();
    detectAdviceServer();
    registerServiceWorker();
  }

  /**
   * AI 조언은 server.py로 열었을 때만 됩니다. 정적 호스팅이나 설치한 앱에서는
   * 눌러도 실패하는 버튼을 보이지 않게, 서버가 있다고 답할 때만 버튼을 꺼냅니다.
   */
  async function detectAdviceServer() {
    if (location.protocol === 'file:') return;
    try {
      const response = await fetch('api/advice', { cache: 'no-store' });
      const payload = response.ok ? await response.json() : null;
      if (payload && payload.available) $('advise').hidden = false;
    } catch {
      // 서버가 없거나 인터넷이 끊긴 경우: 버튼을 숨긴 채 둡니다.
    }
  }

  /** 설치형 웹앱: 한 번 연 뒤에는 인터넷 없이도 열리게 합니다(https 또는 localhost에서만 동작). */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        // 등록에 실패해도 연습과 채점은 그대로 됩니다.
      });
    });
  }

  init();
})();
