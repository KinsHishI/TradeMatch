FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY service/requirements.txt /app/service/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/service/requirements.txt
COPY service /app/service
EXPOSE 8080
CMD ["python", "-m", "service.deployment"]
