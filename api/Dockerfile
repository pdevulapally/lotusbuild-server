# FastAPI runtime for the LotusBuild API. The TypeScript runner remains a separate image.
FROM python:3.12-slim-bookworm
WORKDIR /app
COPY pyproject.toml ./
COPY lotusbuild ./lotusbuild
RUN pip install --no-cache-dir .
USER nobody
EXPOSE 8080
CMD ["python", "-m", "lotusbuild.main"]
