"""글씨 교정 연습 서버: 화면 파일을 내보내고, AI 조언 요청을 Gemini로 전달합니다.

실행:  python server.py            (기본 포트 8000)
       python server.py 8080

API 키는 환경 변수 GEMINI_API_KEY에서 읽으며 브라우저로 보내지 않습니다.
모델은 환경 변수 GEMINI_MODEL로 바꿀 수 있습니다.
"""

import base64
import binascii
import json
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from google import genai
from google.genai import errors, types
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
MAX_BODY_BYTES = 3 * 1024 * 1024
MAX_CELLS = 40
PNG_PREFIX = "data:image/png;base64,"

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
    except json.JSONDecodeError as exc:
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

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self) -> None:
        # 개발 중 고친 화면 파일이 iPad에서 바로 보이도록 캐시를 끕니다.
        if self.command == "GET":
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        # 화면이 AI 조언 버튼을 보일지 정할 때 묻습니다.
        if self.path.split("?")[0] == "/api/advice":
            self.send_json(200, {"available": self.client is not None})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path != "/api/advice":
            self.send_json(404, {"error": "없는 주소입니다."})
            return
        if self.client is None:
            self.send_json(503, {"error": "서버에 GEMINI_API_KEY가 설정돼 있지 않습니다."})
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
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    api_key = os.environ.get("GEMINI_API_KEY")
    if api_key:
        Handler.client = genai.Client(api_key=api_key)
    else:
        print("주의: GEMINI_API_KEY가 없어 AI 조언은 동작하지 않습니다. 연습과 채점은 됩니다.")

    server = ThreadingHTTPServer(("0.0.0.0", port), partial(Handler, directory=str(ROOT)))
    print(f"글씨 교정 연습: http://localhost:{port}  (AI 모델: {MODEL})")
    print("같은 와이파이의 iPad에서는 http://<이 PC의 IP 주소>:%d 로 엽니다. 끝내려면 Ctrl+C." % port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
