// 글씨 채점: 본보기 글자(폰트)의 뼈대와 사용자가 그은 획의 중심선을 작은 마스크로 바꿔 거리로 비교합니다.
// 전역 `Scoring`으로 노출합니다(file://로 열어도 동작하도록 모듈을 쓰지 않습니다).
(function (global) {
  'use strict';

  const S = 96;             // 채점용 마스크 한 변(px)

  // 획 사이 거리 허용치(칸 한 변에 대한 비율).
  // near 이내면 완전히 겹친 것으로, far 이상이면 전혀 겹치지 않은 것으로 봅니다.
  const TOLERANCE = {
    // 한글은 획 간격이 좁아, 이보다 넓히면 옆 획에 걸려 틀린 글자도 점수가 높게 나옵니다.
    trace: { near: 0.03, far: 0.08 },
    free: { near: 0.03, far: 0.08 },
  };

  function makeContext() {
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    return canvas.getContext('2d', { willReadFrequently: true });
  }

  /**
   * 본보기 글자를 칸 가운데에 그립니다. 화면 표시와 채점이 같은 함수를 씁니다.
   * font는 { family, scale, dy }입니다. scale은 글자가 작게 디자인된 글꼴(펜글씨)을 키우는 배율이고,
   * dy는 글자가 위아래로 치우치게 디자인된 글꼴을 칸 가운데로 옮기는 양(칸 한 변에 대한 비율)입니다.
   */
  function drawGlyph(ctx, ch, font, size, color) {
    ctx.save();
    ctx.font = `${Math.round(size * 0.72 * font.scale)}px ${font.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(ch, size / 2, size / 2 + size * (0.03 + (font.dy || 0)));
    ctx.restore();
  }

  /**
   * 획을 그립니다. 점 좌표는 칸 크기로 나눈 0~1 값이고 p는 필압(0~1)입니다.
   * 중간점을 잇는 곡선으로 그려 꺾임을 부드럽게 합니다.
   * fixedWidth를 주면 필압과 무관하게 그 굵기(px)로 그립니다(채점용).
   */
  function drawStrokes(ctx, strokes, size, color, map, fixedWidth) {
    const width = (p) => fixedWidth || size * 0.04 * (0.5 + p);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const stroke of strokes) {
      const pts = map ? stroke.points.map(map) : stroke.points;
      if (pts.length === 0) continue;

      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x * size, pts[0].y * size, width(pts[0].p) / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      let prev = pts[0];
      let prevMid = pts[0];
      for (let i = 1; i < pts.length; i++) {
        const cur = pts[i];
        const mid = { x: (prev.x + cur.x) / 2, y: (prev.y + cur.y) / 2 };
        ctx.beginPath();
        ctx.lineWidth = width((prev.p + cur.p) / 2);
        ctx.moveTo(prevMid.x * size, prevMid.y * size);
        ctx.quadraticCurveTo(prev.x * size, prev.y * size, mid.x * size, mid.y * size);
        ctx.stroke();
        prev = cur;
        prevMid = mid;
      }
      ctx.beginPath();
      ctx.lineWidth = width(prev.p);
      ctx.moveTo(prevMid.x * size, prevMid.y * size);
      ctx.lineTo(prev.x * size, prev.y * size);
      ctx.stroke();
    }
    ctx.restore();
  }

  function toMask(ctx) {
    const data = ctx.getImageData(0, 0, S, S).data;
    const mask = new Uint8Array(S * S);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = data[i * 4 + 3] > 80 ? 1 : 0;
    }
    return mask;
  }

  /** Zhang-Suen 세선화: 두꺼운 글자를 1픽셀 굵기의 뼈대로 줄입니다. */
  function thin(mask) {
    const m = mask.slice();
    const at = (x, y) => (x < 0 || y < 0 || x >= S || y >= S ? 0 : m[y * S + x]);
    let changed = true;
    while (changed) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        const remove = [];
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            if (!m[y * S + x]) continue;
            // 위쪽부터 시계 방향으로 이웃 8칸
            const n = [
              at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1),
              at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1),
            ];
            const neighbors = n[0] + n[1] + n[2] + n[3] + n[4] + n[5] + n[6] + n[7];
            if (neighbors < 2 || neighbors > 6) continue;
            let transitions = 0;
            for (let i = 0; i < 8; i++) {
              if (!n[i] && n[(i + 1) % 8]) transitions++;
            }
            if (transitions !== 1) continue;
            if (step === 0) {
              if (n[0] && n[2] && n[4]) continue;
              if (n[2] && n[4] && n[6]) continue;
            } else {
              if (n[0] && n[2] && n[6]) continue;
              if (n[0] && n[4] && n[6]) continue;
            }
            remove.push(y * S + x);
          }
        }
        if (remove.length) {
          changed = true;
          for (const i of remove) m[i] = 0;
        }
      }
    }
    return m;
  }

  const skeletonCache = new Map();

  /** 본보기 글자의 뼈대 마스크. 글자와 글꼴이 같으면 다시 계산하지 않습니다. */
  function glyphSkeleton(ch, font) {
    const key = font.family + '\n' + font.scale + '\n' + (font.dy || 0) + '\n' + ch;
    if (!skeletonCache.has(key)) {
      const ctx = makeContext();
      drawGlyph(ctx, ch, font, S, '#000');
      skeletonCache.set(key, thin(toMask(ctx)));
    }
    return skeletonCache.get(key);
  }

  /** 사용자의 획을 얇은 중심선으로 그린 마스크 */
  function strokeMask(strokes, map) {
    const ctx = makeContext();
    drawStrokes(ctx, strokes, S, '#000', map, 2);
    return toMask(ctx);
  }

  function boundingBox(mask) {
    let x0 = S, y0 = S, x1 = -1, y1 = -1, count = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (!mask[y * S + x]) continue;
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (count === 0) return null;
    return {
      w: x1 - x0 + 1,
      h: y1 - y0 + 1,
      cx: (x0 + x1 + 1) / 2,
      cy: (y0 + y1 + 1) / 2,
      count,
    };
  }

  /** 각 픽셀에서 마스크의 가장 가까운 켜진 픽셀까지의 거리(두 번 훑는 근사 계산) */
  function distanceMap(mask) {
    const INF = 1e6;
    const DIAG = Math.SQRT2;
    const d = new Float32Array(S * S);
    for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;

    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
        if (y > 0) {
          d[i] = Math.min(d[i], d[i - S] + 1);
          if (x > 0) d[i] = Math.min(d[i], d[i - S - 1] + DIAG);
          if (x < S - 1) d[i] = Math.min(d[i], d[i - S + 1] + DIAG);
        }
      }
    }
    for (let y = S - 1; y >= 0; y--) {
      for (let x = S - 1; x >= 0; x--) {
        const i = y * S + x;
        if (x < S - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
        if (y < S - 1) {
          d[i] = Math.min(d[i], d[i + S] + 1);
          if (x < S - 1) d[i] = Math.min(d[i], d[i + S + 1] + DIAG);
          if (x > 0) d[i] = Math.min(d[i], d[i + S - 1] + DIAG);
        }
      }
    }
    return d;
  }

  /**
   * a의 켜진 픽셀이 상대(거리 지도)에 얼마나 가까운지의 평균(0~1).
   * near 이내는 1, far 이상은 0, 그 사이는 거리에 비례해 줄어듭니다.
   */
  function closeness(a, distanceToOther, near, far) {
    let total = 0, sum = 0;
    for (let i = 0; i < a.length; i++) {
      if (!a[i]) continue;
      total++;
      const d = distanceToOther[i];
      sum += d <= near ? 1 : d >= far ? 0 : (far - d) / (far - near);
    }
    return total === 0 ? 0 : sum / total;
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  /**
   * 한 칸을 채점합니다. 본보기의 뼈대와 사용자가 그은 획의 중심선을 거리로 비교합니다.
   * - trace(따라 쓰기): 본보기 위치 그대로 비교합니다.
   * - free(혼자 쓰기): 크기와 위치를 본보기에 맞춘 뒤 모양을 비교하고,
   *   크기와 위치가 어긋난 만큼 점수를 깎습니다(각각 최대 15%).
   * 본보기가 그려지지 않는 글자(공백 등)는 null을 돌려줍니다.
   */
  function scoreCell(ch, strokes, font, mode) {
    const model = glyphSkeleton(ch, font);
    const modelBox = boundingBox(model);
    if (!modelBox) return null;

    const user = strokeMask(strokes);
    const userBox = boundingBox(user);
    if (!userBox) {
      return { score: 0, empty: true, tags: [] };
    }

    const sizeRatio = Math.max(userBox.w, userBox.h) / Math.max(modelBox.w, modelBox.h);
    const dx = (userBox.cx - modelBox.cx) / S;
    const dy = (userBox.cy - modelBox.cy) / S;

    let aligned = user;
    if (mode === 'free') {
      const scale = Math.max(1 / 3, Math.min(3, 1 / sizeRatio));
      aligned = strokeMask(strokes, (pt) => ({
        x: ((pt.x * S - userBox.cx) * scale + modelBox.cx) / S,
        y: ((pt.y * S - userBox.cy) * scale + modelBox.cy) / S,
        p: pt.p,
      }));
    }

    const tolerance = TOLERANCE[mode === 'free' ? 'free' : 'trace'];
    const near = tolerance.near * S;
    const far = tolerance.far * S;
    const recall = closeness(model, distanceMap(aligned), near, far);     // 본보기 획을 얼마나 따라 그었나
    const precision = closeness(aligned, distanceMap(model), near, far);  // 그은 획이 본보기 위에 있나
    // 둘을 곱해, 획을 빼먹거나 엉뚱한 곳에 그으면 그 비율만큼 점수가 깎이게 합니다.
    const shape = recall * precision;

    let score = 100 * shape;
    if (mode === 'free') {
      const sizeScore = clamp01(1 - Math.abs(Math.log(sizeRatio)) / Math.log(2));
      const posScore = clamp01(1 - Math.hypot(dx, dy) / 0.25);
      score *= 0.7 + 0.15 * sizeScore + 0.15 * posScore;
    }

    const tags = [];
    if (sizeRatio < 0.8) tags.push('작음');
    if (sizeRatio > 1.25) tags.push('큼');
    if (dx > 0.08) tags.push('오른쪽 치우침');
    if (dx < -0.08) tags.push('왼쪽 치우침');
    if (dy > 0.08) tags.push('아래로 치우침');
    if (dy < -0.08) tags.push('위로 치우침');
    if (recall < 0.75) tags.push('빠진 획');
    if (precision < 0.75) tags.push('벗어난 획');

    return { score: Math.round(score), empty: false, tags, recall, precision, sizeRatio, dx, dy };
  }

  global.Scoring = { S, TOLERANCE, drawGlyph, drawStrokes, glyphSkeleton, scoreCell };
})(window);
