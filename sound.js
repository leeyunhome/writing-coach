// 효과음: 파일 없이 브라우저에서 음을 합성합니다. 칸 연습과 필사 화면이 함께 씁니다.
// 켜고 끄기 설정도 두 화면이 같은 값을 씁니다. 전역 `Sound`로 노출합니다.
(function (global) {
  'use strict';

  const KEY = 'writingCoach.sound';

  // freq는 Hz, at·dur은 초입니다.
  const C4 = 261.63, E4 = 329.63, G4 = 392.0, C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5;
  const SOUNDS = {
    // 칸 연습 채점
    good: [   // 80점 이상: 도-미-솔 올라가는 소리
      { freq: C5, at: 0, dur: 0.18 },
      { freq: E5, at: 0.09, dur: 0.18 },
      { freq: G5, at: 0.18, dur: 0.4 },
    ],
    mid: [    // 60~79점: 솔-도 두 음
      { freq: G4, at: 0, dur: 0.2 },
      { freq: C5, at: 0.12, dur: 0.3 },
    ],
    bad: [    // 60점 미만: 낮게 내려가는 부드러운 소리
      { freq: E4, at: 0, dur: 0.25, type: 'triangle' },
      { freq: C4, at: 0.14, dur: 0.4, type: 'triangle' },
    ],
    // 필사
    done: [   // 이미지로 저장: 도-미-솔-도 마무리 소리
      { freq: C5, at: 0, dur: 0.16 },
      { freq: E5, at: 0.08, dur: 0.16 },
      { freq: G5, at: 0.16, dur: 0.16 },
      { freq: C6, at: 0.24, dur: 0.5, vol: 0.14 },
    ],
    page: [   // 줄 더하기: 짧고 가벼운 한 음
      { freq: G5, at: 0, dur: 0.09, vol: 0.1 },
    ],
    erase: [  // 모두 지우기: 낮게 내려가는 소리
      { freq: G4, at: 0, dur: 0.18, type: 'triangle', vol: 0.14 },
      { freq: C4, at: 0.1, dur: 0.3, type: 'triangle', vol: 0.14 },
    ],
  };

  let ctx = null;
  let toggle = null;

  function enabled() {
    return !toggle || toggle.checked;
  }

  /**
   * 소리 장치를 준비합니다. iPad Safari는 버튼을 누른 순간에만 소리를 허락하므로,
   * 소리를 나중에(비동기 작업 뒤) 낼 때는 클릭 처리 첫머리에서 이것을 먼저 부릅니다.
   */
  function unlock() {
    if (!enabled()) return null;
    const AudioCtx = global.AudioContext || global.webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      if (!ctx) ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume();
    } catch {
      return null;
    }
    return ctx;
  }

  /** 이름 붙은 소리를 냅니다. 소리를 못 내는 환경이면 조용히 넘어갑니다. */
  function play(name) {
    const notes = SOUNDS[name];
    const audio = notes && unlock();
    if (!audio) return;
    try {
      const start = audio.currentTime + 0.02;
      for (const note of notes) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        const t = start + note.at;
        osc.type = note.type || 'sine';
        osc.frequency.value = note.freq;
        // 툭 끊기는 잡음이 없도록 소리를 짧게 키웠다가 서서히 줄입니다.
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(note.vol || 0.18, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start(t);
        osc.stop(t + note.dur + 0.02);
      }
    } catch {
      // 효과음이 안 나도 기능은 그대로입니다.
    }
  }

  /** 켜고 끄기 체크 상자를 연결하고, 저장된 설정(기본: 켜짐)을 불러옵니다. */
  function bindToggle(checkbox) {
    toggle = checkbox;
    let saved = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      // 기억하지 못하면 기본값으로 씁니다.
    }
    checkbox.checked = saved !== 'off';
    checkbox.addEventListener('change', () => {
      try {
        localStorage.setItem(KEY, checkbox.checked ? 'on' : 'off');
      } catch {
        // 기억하지 못해도 이번에는 고른 대로 씁니다.
      }
    });
  }

  global.Sound = { play, unlock, bindToggle };
})(window);
