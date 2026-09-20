FROM python:3.13-slim

WORKDIR /app

COPY app.py ./app.py
COPY webapp ./webapp
COPY supabase ./supabase

ENV PYTHONUNBUFFERED=1
ENV WEB_ONLY=1

EXPOSE 8080

CMD ["python3", "app.py"]