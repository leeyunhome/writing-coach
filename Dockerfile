# AI 조언 전용 서버(Cloud Run). 화면 파일은 넣지 않고 server.py만 담습니다.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    API_ONLY=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY server.py .

RUN useradd --create-home app
USER app

# Cloud Run이 PORT 환경 변수로 포트를 알려 줍니다.
CMD ["python", "server.py"]
