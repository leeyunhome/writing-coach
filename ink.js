// 필기 보정: 화면에 그릴 때만 손떨림과 필압 흔들림을 걸러 획을 매끄럽게 합니다.
// 저장·채점에는 원래 좌표를 그대로 쓰고, 이 파일의 결과는 그리기에만 씁니다.
// 칸 연습과 필사 화면이 함께 씁니다. 전역 `Ink`로 노출합니다.
(function (global) {
  'use strict';

  // 위치 보정 세기. 펜이 천천히 움직이면 강하게, 빠르게 움직이면 거의 거르지 않습니다.
  // 화면에서 한 번에 FULL_SPEED_PX 이상 움직이면 보정 없이 그대로 따라갑니다.
  const MIN_ALPHA = 0.3;
  const FULL_SPEED_PX = 10;
  const PRESSURE_ALPHA = 0.3;   // 필압은 늘 같은 세기로 걸러 굵기가 마디마다 튀지 않게 합니다

  /**
   * 점을 하나씩 받아 보정된 점을 돌려주는 거르개를 만듭니다.
   * pxPerUnit은 좌표 1이 화면에서 몇 px인지입니다(칸 연습은 칸 크기, 필사는 줄 간격).
   */
  function createSmoother(pxPerUnit) {
    let last = null;
    return {
      push(pt) {
        if (!last) {
          last = { x: pt.x, y: pt.y, p: pt.p };
          return { ...last };
        }
        const movedPx = Math.hypot(pt.x - last.x, pt.y - last.y) * pxPerUnit;
        const a = Math.min(1, MIN_ALPHA + (1 - MIN_ALPHA) * (movedPx / FULL_SPEED_PX));
        last = {
          x: last.x + a * (pt.x - last.x),
          y: last.y + a * (pt.y - last.y),
          p: last.p + PRESSURE_ALPHA * (pt.p - last.p),
        };
        return { ...last };
      },
    };
  }

  /**
   * 한 획의 보정된 점 목록. 걸러 낸 점들 끝에 펜을 뗀 실제 위치를 하나 덧붙여,
   * 보정 때문에 획 끝이 펜 끝보다 짧아지지 않게 합니다.
   */
  function smoothPoints(points, pxPerUnit) {
    if (points.length < 2) return points.slice();
    const smoother = createSmoother(pxPerUnit);
    const out = points.map((pt) => smoother.push(pt));
    const raw = points[points.length - 1];
    out.push({ x: raw.x, y: raw.y, p: out[out.length - 1].p });
    return out;
  }

  function smoothStrokes(strokes, pxPerUnit) {
    return strokes.map((stroke) => ({ points: smoothPoints(stroke.points, pxPerUnit) }));
  }

  global.Ink = { createSmoother, smoothPoints, smoothStrokes };
})(window);
