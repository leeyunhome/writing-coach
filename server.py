"""글씨 교정 연습 서버: 화면 파일을 내보내고, AI 조언 요청을 Gemini로 전달합니다.

내 PC에서 실행:  python server.py            (기본 포트 8000, 화면 파일과 AI 조언을 함께 제공)
                 python server.py 8080
Cloud Run 배포:  deploy-cloudrun.ps1 참고. API_ONLY=1로 AI 조언만 제공하고, 화면은 GitHub Pages가 맡습니다.

환경 변수
  GEMINI_API_KEY        Gemini API 키. 브라우저로 보내지 않습니다.
  GEMINI_MODEL          모델 이름(기본 gemini-flash-latest)
  PORT                  포트(Cloud Run이 정해 줌). 없으면 명령줄 인자, 그것도 없으면 8000
  API_ONLY=1            화면 파일은 내보내지 않고 /api/advice만 엽니다.
  ACCESS_CODE           정해 두면 이 코드를 보낸 요청만 AI 조언을 받습니다.
  ALLOWED_ORIGINS       다른 주소의 화면에서 부를 수 있게 허용할 출처(쉼표로 구분)
  DAILY_LIMIT           하루(한국 시간) 전체 AI 조언 횟수 상한(기본 200)
  PER_IP_DAILY_LIMIT    하루 접속 주소별 상한(기본 30)
  MIN_INTERVAL_SECONDS  같은 접속 주소의 요청 사이 최소 간격(기본 15초)
"""

import base64
import binascii
import hmac
import json
import math
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from google import genai
from google.genai import errors, types
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
MAX_BODY_BYTES = 3 * 1024 * 1024
MAX_CELLS = 40
PNG_PREFIX = "data:image/png;base64,"
API_PATH = "/api/advice"

API_ONLY = os.environ.get("API_ONLY") == "1"
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()
ALLOWED_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
}
DAILY_LIMIT = int(os.environ.get("DAILY_LIMIT", "200"))
PER_IP_DAILY_LIMIT = int(os.environ.get("PER_IP_DAILY_LIMIT", "30"))
MIN_INTERVAL_SECONDS = float(os.environ.get("MIN_INTERVAL_SECONDS", "15"))
KST = timezone(timedelta(hours=9))


class RateLimiter:
    """AI 조언 사용량 제한. 서버 메모리에 두므로 서버가 다시 시작되면 그날 횟수가 초기화됩니다.
    Cloud Run에서는 인스턴스를 1개로 묶어(--max-instances 1) 한 곳에서만 세도록 합니다."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.day = None
        self.total = 0
        self.per_ip: dict[str, int] = {}
        self.last: dict[str, float] = {}

    def take(self, ip: str) -> str | None:
        """한 번 쓸 수 있으면 횟수를 세고 None, 아니면 이유를 돌려줍니다.
        AI 호출이 실패해도 시도 횟수는 셉니다(실패를 이용한 남용을 막기 위해)."""
        now = time.monotonic()
        today = datetime.now(KST).date()
        with self.lock:
            if today != self.day:
                self.day = today
                self.total = 0
                self.per_ip.clear()
                self.last.clear()
            if self.total >= DAILY_LIMIT:
                return "오늘 AI 조언 사용량이 모두 찼습니다. 내일 다시 시도해 주세요."
            if self.per_ip.get(ip, 0) >= PER_IP_DAILY_LIMIT:
                return "오늘 이 기기에서 받을 수 있는 AI 조언을 모두 받았습니다. 내일 다시 시도해 주세요."
            last = self.last.get(ip)
            if last is not None and now - last < MIN_INTERVAL_SECONDS:
                wait = math.ceil(MIN_INTERVAL_SECONDS - (now - last))
                return f"조금 전에 조언을 받았습니다. {wait}초 뒤에 다시 시도해 주세요."
            self.total += 1
            self.per_ip[ip] = self.per_ip.get(ip, 0) + 1
            self.last[ip] = now
            return None


LIMITER = RateLimiter()

SYSTEM_INSTRUCTION = """\
당신은 성인의 손글씨 교정을 돕는 글씨 선생님입니다.
학습자가 칸 공책에 한 글자씩 쓴 글씨를 본보기 글자와 비교해 조언합니다.

받는 자료:
- 이미지: 두 줄이 한 묶음입니다. 윗줄은 본보기 글자, 바로 아랫줄은 학습자가 같은 칸에 쓴 글씨입니다.
  본보기 칸 왼쪽 위의 작은 숫자가 글자 번호이고, 10글자가 넘으면 묶음이 아래로 이어집니다.
- 채점 자료: 글자별 점수(0~100, 본보기 뼈대와 겹치는 정도), 크기 비율(1이면 본보기와 같은 크기),
  가로·세로 치우침(칸 한 변에 대한 비율, 양수는 오른쪽·아래), 프로그램이 붙인 문제 표시.

조언 원칙:
- 이미지에서 실제로 보이는 것만 말합니다. 보이지 않는 획 순서나 쓰는 속도는 추측하지 않습니다.
- 채점 자료와 이미지가 어긋나면 이미지를 따릅니다.
- 자음·모음·받침의 크기와 간격, 획의 길이와 기울기, 글자 중심처럼 손으로 고칠 수 있는 것을 짚습니다.
- "더 예쁘게" 같은 막연한 말 대신 "받침 ㄴ의 가로획을 지금의 1.5배로 길게"처럼 무엇을 얼마나 바꿀지 말합니다.
- 잘된 점이 실제로 있으면 한 가지만 짧게 말하고, 없으면 지어내지 않습니다.
- 존댓말로, 군더더기 없이 씁니다.
"""


class Point(BaseModel):
    title: str
    detail: str


class CharTip(BaseModel):
    ch: str
    tip: str


class Advice(BaseModel):
    summary: str
    points: list[Point]
    chars: list[CharTip]
    drill: str


def build_prompt(text: str, mode: str, cells: list[dict]) -> str:
    lines = [
        f"연습 문장: {text}",
        f"연습 방식: {'본보기 위에 따라 쓰기' if mode == 'trace' else '본보기 없이 혼자 쓰기'}",
        "",
        "채점 자료(번호는 이미지의 글자 번호와 같습니다):",
    ]
    for i, cell in enumerate(cells, 1):
        tags = ", ".join(cell["tags"]) or "없음"
        lines.append(
            f"{i}. '{cell['ch']}' 점수 {cell['score']}, 크기 비율 {cell['sizeRatio']:.2f}, "
            f"가로 치우침 {cell['dx']:+.2f}, 세로 치우침 {cell['dy']:+.2f}, 문제 표시: {tags}"
        )
    lines += [
        "",
        "다음을 작성해 주세요.",
        "- summary: 전체 인상을 한두 문장으로.",
        "- points: 여러 글자에 공통된, 가장 먼저 고칠 점 2~3개. title은 짧은 제목, detail은 고치는 방법.",
        "- chars: 가장 아쉬운 글자 최대 3개. ch는 그 글자, tip은 그 글자에서 고칠 곳.",
        "- drill: 다음 연습에서 해 볼 것 한 가지.",
    ]
    return "\n".join(lines)


def parse_request(body: bytes) -> tuple[str, str, list[dict], bytes]:
    """요청 본문을 검사해 (문장, 방식, 채점 자료, PNG 바이트)로 돌려줍니다. 잘못되면 ValueError."""
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:   # UTF-8이 아닌 본문도 같은 안내로
        raise ValueError("요청 형식이 잘못됐습니다.") from exc
    if not isinstance(data, dict):
        raise ValueError("요청 형식이 잘못됐습니다.")

    text = data.get("text")
    mode = data.get("mode")
    cells = data.get("cells")
    image = data.get("image")
    if not isinstance(text, str) or not text.strip() or len(text) > 200:
        raise ValueError("연습 문장이 없습니다.")
    if mode not in ("trace", "free"):
        raise ValueError("연습 방식이 잘못됐습니다.")
    if not isinstance(cells, list) or not 1 <= len(cells) <= MAX_CELLS:
        raise ValueError("채점한 글자가 없습니다. 먼저 채점해 주세요.")

    clean = []
    for cell in cells:
        try:
            clean.append({
                "ch": str(cell["ch"])[:2],
                "score": int(cell["score"]),
                "sizeRatio": float(cell["sizeRatio"]),
                "dx": float(cell["dx"]),
                "dy": float(cell["dy"]),
                "tags": [str(tag)[:20] for tag in cell.get("tags", [])][:8],
            })
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("채점 자료 형식이 잘못됐습니다.") from exc

    if not isinstance(image, str) or not image.startswith(PNG_PREFIX):
        raise ValueError("글씨 이미지가 없습니다.")
    try:
        png = base64.b64decode(image[len(PNG_PREFIX):], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("글씨 이미지를 읽을 수 없습니다.") from exc
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("글씨 이미지를 읽을 수 없습니다.")

    return text.strip(), mode, clean, png


def request_advice(client: genai.Client, text: str, mode: str, cells: list[dict], png: bytes) -> dict:
    response = client.models.generate_content(
        model=MODEL,
        contents=[
            types.Part.from_bytes(data=png, mime_type="image/png"),
            build_prompt(text, mode, cells),
        ],
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTION,
            response_mime_type="application/json",
            response_schema=Advice,
        ),
    )
    if not response.text:
        raise RuntimeError("AI가 빈 응답을 돌려줬습니다.")
    return Advice.model_validate_json(response.text).model_dump()


class Handler(SimpleHTTPRequestHandler):
    client: genai.Client | None = None
    # Windows는 레지스트리에 따라 .js 형식이 틀리게 나올 수 있고, 그러면 서비스 워커가 등록되지 않습니다.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
    }

    # ---------- 출처(CORS)와 접속 주소 ----------

    def origin_allowed(self) -> bool:
        """요청을 보낸 화면의 출처가 허용된 곳인지. 출처가 없으면(브라우저 밖 호출) 접속 코드와 사용량 제한에 맡깁니다."""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        origin = origin.rstrip("/")
        same_origin = urlsplit(origin).netloc == self.headers.get("Host", "")
        return same_origin or origin in ALLOWED_ORIGINS

    def send_cors_headers(self) -> None:
        origin = (self.headers.get("Origin") or "").rstrip("/")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def client_ip(self) -> str:
        # Cloud Run 같은 중계 서버 뒤에서는 실제 접속 주소가 X-Forwarded-For 끝에 붙는다고 보고 마지막 값을 씁니다.
        # 앞쪽 값은 접속자가 마음대로 넣을 수 있기 때문입니다.
        forwarded = self.headers.get("X-Forwarded-For")
        if API_ONLY and forwarded:
            return forwarded.split(",")[-1].strip()
        return self.client_address[0]

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        """다른 주소의 화면(GitHub Pages)이 POST 전에 보내는 사전 확인 요청"""
        if self.path.split("?")[0] != API_PATH:
            self.send_json(404, {"error": "없는 주소입니다."})
            return
        if not self.origin_allowed():
            self.send_json(403, {"error": "허용되지 않은 출처입니다."})
            return
        self.send_response(204)
        self.send_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Access-Code")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def end_headers(self) -> None:
        # 개발 중 고친 화면 파일이 iPad에서 바로 보이도록 캐시를 끕니다.
        if self.command == "GET":
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        # 화면이 AI 조언 버튼을 보일지 정할 때 묻습니다.
        if self.path.split("?")[0] == API_PATH:
            self.send_json(200, {"available": self.client is not None, "needsCode": bool(ACCESS_CODE)})
            return
        if API_ONLY:
            self.send_json(404, {"error": "없는 주소입니다."})
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        if API_ONLY:
            self.send_response(404)
            self.end_headers()
            return
        super().do_HEAD()

    def do_POST(self) -> None:
        if self.path.split("?")[0] != API_PATH:
            self.send_json(404, {"error": "없는 주소입니다."})
            return
        if not self.origin_allowed():
            self.send_json(403, {"error": "허용되지 않은 출처입니다."})
            return
        if self.client is None:
            self.send_json(503, {"error": "서버에 GEMINI_API_KEY가 설정돼 있지 않습니다."})
            return
        if ACCESS_CODE:
            given = self.headers.get("X-Access-Code", "").strip()
            if not hmac.compare_digest(given.encode("utf-8"), ACCESS_CODE.encode("utf-8")):
                self.send_json(401, {"error": "접속 코드가 맞지 않습니다.", "needsCode": True})
                return

        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(411, {"error": "요청 크기를 알 수 없습니다."})
            return
        if not 0 < length <= MAX_BODY_BYTES:
            self.send_json(413, {"error": "요청이 너무 큽니다."})
            return

        try:
            text, mode, cells, png = parse_request(self.rfile.read(length))
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
            return

        refused = LIMITER.take(self.client_ip())
        if refused:
            self.send_json(429, {"error": refused})
            return

        try:
            advice = request_advice(self.client, text, mode, cells, png)
        except errors.APIError as exc:
            self.log_error("Gemini API 오류: %s", exc)
            if exc.code == 429:
                self.send_json(429, {"error": "AI 사용량 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요."})
            else:
                self.send_json(502, {"error": f"AI 요청이 실패했습니다. (코드 {exc.code})"})
            return
        except Exception as exc:  # 응답 형식 오류, 네트워크 끊김 등
            self.log_error("조언 생성 실패: %r", exc)
            self.send_json(502, {"error": "AI 조언을 받아오지 못했습니다. 다시 시도해 주세요."})
            return

        self.send_json(200, advice)


def main() -> None:
    port = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8000))
    api_key = os.environ.get("GEMINI_API_KEY")
    if api_key:
        Handler.client = genai.Client(api_key=api_key)
    else:
        print("주의: GEMINI_API_KEY가 없어 AI 조언은 동작하지 않습니다. 연습과 채점은 됩니다.")

    server = ThreadingHTTPServer(("0.0.0.0", port), partial(Handler, directory=str(ROOT)))
    limits = f"하루 {DAILY_LIMIT}회, 접속 주소별 {PER_IP_DAILY_LIMIT}회, 간격 {MIN_INTERVAL_SECONDS:g}초"
    print(f"AI 모델: {MODEL} | 접속 코드: {'사용' if ACCESS_CODE else '없음'} | 제한: {limits}", flush=True)
    if API_ONLY:
        print(f"AI 조언 전용 서버: 포트 {port}{API_PATH} | 허용 출처: {', '.join(sorted(ALLOWED_ORIGINS)) or '없음'}", flush=True)
    else:
        print(f"글씨 교정 연습: http://localhost:{port}")
        print("같은 와이파이의 iPad에서는 http://<이 PC의 IP 주소>:%d 로 엽니다. 끝내려면 Ctrl+C." % port, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
