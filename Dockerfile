FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
ENV UPSTAGE_AGENT_ID=agt_8H8XCDtscqxp9KbwqBzUJw UPSTAGE_PROJECT_ID=proj_e88CHrANRG3JeEdUgt95vf UPSTAGE_CONFIG_ID=4 UPSTAGE_DECISION_NODE="최종판정"
WORKDIR /app
COPY service/requirements.txt /app/service/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/service/requirements.txt
COPY service /app/service
EXPOSE 8080
CMD ["python", "-m", "service.deployment"]
