// 테마: 색·글꼴·모서리를 바꿔 디자인 방향을 비교합니다. 두 화면이 같은 설정을 씁니다.
// <head>에서 불러 첫 화면부터 고른 테마로 그립니다. 전역 `Theme`으로 노출합니다.
(function (global) {
  'use strict';

  const KEY = 'writingCoach.theme';
  const PRETENDARD = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';
  const GOWUN_BATANG = 'https://fonts.googleapis.com/css2?family=Gowun+Batang&display=swap';

  const THEMES = [
    { id: 'basic', name: '기본', fonts: [] },
    { id: 'paper', name: '종이와 잉크', fonts: [PRETENDARD, GOWUN_BATANG] },
    { id: 'study', name: '산뜻한 학습', fonts: [PRETENDARD] },
    { id: 'night', name: '밤 공책', fonts: [PRETENDARD] },
  ];

  const root = document.documentElement;
  let current = 'basic';
  let cache = null;

  try {
    const saved = localStorage.getItem(KEY);
    if (THEMES.some((t) => t.id === saved)) current = saved;
  } catch {
    // 기억하지 못하면 기본 테마로 씁니다.
  }

  /** 테마에 필요한 웹 글꼴을 불러옵니다. 못 받으면 기기 글꼴로 대신 보입니다. */
  function loadFonts(id) {
    const theme = THEMES.find((t) => t.id === id);
    for (const href of theme.fonts) {
      if (document.querySelector(`link[data-theme-font="${href}"]`)) continue;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.themeFont = href;
      document.head.append(link);
    }
  }

  function apply(id) {
    current = id;
    root.dataset.theme = id;
    cache = null;
    loadFonts(id);
  }

  /** 캔버스에 그릴 때 쓰는 테마 색. CSS 변수 --이름 의 값입니다. */
  function color(name) {
    if (!cache) cache = {};
    if (!(name in cache)) cache[name] = getComputedStyle(root).getPropertyValue('--' + name).trim();
    return cache[name];
  }

  /** 테마 고르기 상자를 채우고 연결합니다. 바뀌면 window에 'themechange'를 보냅니다. */
  function bindSelect(select) {
    for (const theme of THEMES) {
      const option = document.createElement('option');
      option.value = theme.id;
      option.textContent = theme.name;
      select.append(option);
    }
    select.value = current;
    select.addEventListener('change', () => {
      apply(select.value);
      try {
        localStorage.setItem(KEY, current);
      } catch {
        // 기억하지 못해도 이번에는 고른 테마로 씁니다.
      }
      global.dispatchEvent(new Event('themechange'));
    });
  }

  apply(current);
  global.Theme = { color, bindSelect };
})(window);
