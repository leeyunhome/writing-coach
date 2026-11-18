// 배포 설정. AI 조언 서버(Cloud Run) 주소를 넣으면 GitHub Pages에서도 AI 조언 버튼이 나옵니다.
// 비워 두면 화면과 같은 서버(내 PC의 python server.py)에 묻습니다.
// deploy-cloudrun.ps1이 배포를 마치면 이 값을 자동으로 채웁니다.
window.WRITING_COACH_CONFIG = {
  adviceApi: 'https://writing-coach-advice-7zswwb4p7q-du.a.run.app',
};
