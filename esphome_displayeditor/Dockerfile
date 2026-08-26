FROM ghcr.io/home-assistant/base:latest

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}"

# --copies: venv's default symlinks bin/python(3) to the *system*
# interpreter outside this tree (e.g. /usr/bin/python3.x). AppArmor mediates
# exec() against that resolved target, not the symlink path, so no rule
# scoped to /opt/esphome-displayeditor/** can ever cover it - see
# apparmor.txt. Copying the interpreter in keeps every executable the venv
# needs genuinely inside the tree the profile already grants rix on.
RUN apk add --no-cache python3 py3-pip \
    && python3 -m venv --copies /opt/esphome-displayeditor \
    && /opt/esphome-displayeditor/bin/pip install --no-cache-dir --upgrade pip

COPY requirements.txt /tmp/requirements.txt
COPY constraints.txt /tmp/constraints.txt
RUN SKIP_CYTHON=1 /opt/esphome-displayeditor/bin/pip install --no-cache-dir \
    -c /tmp/constraints.txt -r /tmp/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend
COPY run.sh /run.sh
RUN chmod 0755 /run.sh

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    APP_VERSION=${BUILD_VERSION} \
    ESPHOME_CONFIG_ROOT=/homeassistant/esphome \
    ESPHOME_DATA_ROOT=/data

WORKDIR /app
EXPOSE 8099 8100
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8099/api/v1/health', timeout=2)" || exit 1
ENTRYPOINT []
CMD ["/run.sh"]
