FROM ghcr.io/home-assistant/base:latest

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}"

RUN apk add --no-cache python3 py3-pip \
    && python3 -m venv /opt/esphome-displayeditor \
    && /opt/esphome-displayeditor/bin/pip install --no-cache-dir --upgrade pip

COPY requirements.txt /tmp/requirements.txt
RUN /opt/esphome-displayeditor/bin/pip install --no-cache-dir -r /tmp/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend
COPY run.sh /run.sh
RUN chmod 0755 /run.sh

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    ESPHOME_CONFIG_ROOT=/homeassistant/esphome \
    ESPHOME_DATA_ROOT=/data

WORKDIR /app
EXPOSE 8099
CMD ["/run.sh"]

