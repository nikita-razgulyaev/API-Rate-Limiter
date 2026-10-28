# Запуск RateShield на своём сервере / VPS

RateShield — один Node-процесс + Redis. Работает на любом VPS (от ~512 МБ RAM) и в любом окружении с Docker или Node 20+.

## Как выбрать способ подключения

| Способ | Когда подходит | Что менять в продукте |
|---|---|---|
| **Reverse proxy** (`MODE=proxy`) | Любой язык и фреймворк, нужна защита «снаружи» | Ничего — меняется только адрес, на который смотрит интернет |
| **Express-middleware** | Продукт на Node/Express | Одна строка `app.use(rateLimit(...))` |
| **HTTP API** (`/_rateshield/v1/check`) | Нужен тонкий контроль: лимит по пользователю, тарифу, действию | Вызов API из бэкенда |

## 1. Быстрый старт (Docker) — режим proxy

Предположим, ваш API слушает `127.0.0.1:8080` на этом же VPS.

```bash
git clone <ваш-репозиторий> rateshield && cd rateshield
cp .env.example .env
```

Минимальный `.env`:

```env
MODE=proxy
UPSTREAM_URL=http://host.docker.internal:8080
ADMIN_TOKEN=<результат: openssl rand -hex 32>
RULES_FILE=/app/rules/rateshield.rules.json
```

Отредактируйте `rules/rateshield.rules.json` под свой API (см. ниже) и запустите:

```bash
docker compose up -d
curl http://localhost:3000/_rateshield/health   # {"status":"ok","store":"redis",...}
```

Redis поднимется рядом, с постоянным хранилищем (AOF) и без публикации порта наружу.

> Ваш API должен слушать `0.0.0.0` или адрес docker-шлюза, а не только `127.0.0.1`, чтобы контейнер до него достучался. Проще всего поднять API тоже в compose и указать `UPSTREAM_URL=http://имя-сервиса:порт`.

## 2. HTTPS и закрытие прямого доступа (Caddy)

Наружу должен смотреть только прокси с TLS, а не сам порт 3000. Пример `Caddyfile`:

```
api.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

В `docker-compose.yml` замените публикацию порта на `127.0.0.1:3000:3000`, чтобы сервис был доступен только Caddy. Файрвол: открыты только 22, 80, 443.

Про определение IP клиента: по умолчанию RateShield доверяет `X-Forwarded-For` только от локальных и приватных адресов (Caddy/nginx на этой же машине или в docker-сети). Клиент из интернета, подключившийся напрямую, подделать свой IP не может. Если перед сервисом стоит облачный балансировщик с публичными адресами, задайте `TRUST_PROXY` (число хопов или список подсетей). Проверить результат можно на демо-странице: `GET /status` показывает `clientIp`.

## 3. Правила лимитов

Файл `rateshield.rules.json`. Первое подходящее правило выигрывает; если ничего не подошло — применяются `defaults`.

```json
{
  "defaults": { "algorithm": "token", "limit": 120, "windowSec": 60, "key": "ip" },
  "rules": [
    { "name": "health", "match": "GET /health", "skip": true },
    { "name": "login",  "match": "POST /auth/login", "algorithm": "fixed", "limit": 5, "windowSec": 60, "key": "ip" },
    { "name": "api",    "match": "/api/*", "algorithm": "token", "limit": 600, "windowSec": 60, "key": "header:x-api-key" }
  ]
}
```

- `match`: `[МЕТОД] /путь`, `*` — любые символы. Сопоставление нечувствительно к регистру и нормализует `//`, `/../`, `%`-кодирование, так что обойти правило изменением написания пути нельзя.
- `algorithm`: `fixed` (дёшево, возможен двойной всплеск на границе окон), `sliding` (точно, дороже по памяти), `token` (разрешает короткие всплески, держит средний темп).
- `key`: `ip` (IPv6 учитывается по подсети /64), `header:<имя>` (значение хешируется, при отсутствии заголовка — откат на IP), `global`.
- `skip: true` — не лимитировать.
- Применить изменения без рестарта: `docker kill -s HUP <контейнер>` (или `kill -HUP <pid>`). Если новый файл невалиден, останутся прежние правила, а ошибка попадёт в лог.

**Важно про `header:`.** Ключ по заголовку надёжен, только если ваш API отвергает неизвестные значения этого заголовка. Иначе злоумышленник будет присылать случайные значения и получать свежий счётчик каждый раз. Для публичных неаутентифицированных ручек используйте `ip`.

## 4. Поведение при сбое Redis

`FAIL_MODE` определяет, что делать, когда Redis недоступен (таймаут команды — `REDIS_TIMEOUT_MS`, по умолчанию 1 с):

- `open` (по умолчанию): запросы пропускаются, в ответ добавляется `X-RateLimit-Degraded: 1`. Выбирайте, если доступность продукта важнее строгости лимитов.
- `closed`: ответ `503` с `Retry-After`. Выбирайте для защиты логина, платных операций и т. п.

Сервис сам переподключается к Redis. `/_rateshield/health` всегда отвечает 200 и показывает `"status":"degraded"` при проблемах, чтобы оркестратор не перезапускал контейнер зря.

## 5. HTTP API проверки

Включается заданием `ADMIN_TOKEN` (≥16 символов). Без токена эндпоинты не существуют.

```bash
curl -X POST https://api.example.com/_rateshield/v1/check \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"user:42","rule":"login"}'
```

Тело: `key` (обязательно, до 256 символов), `rule` (имя правила из файла) и/или явные `algorithm`, `limit`, `windowSec`. Ответ всегда `200`, решение в поле `allowed`:

```json
{ "allowed": false, "limit": 5, "remaining": 0, "resetIn": 41, "retryAfter": 41, "algorithm": "fixed-window", "degraded": false }
```

Python:

```python
import os, requests

def allowed(user_id: str) -> bool:
    r = requests.post(
        "https://api.example.com/_rateshield/v1/check",
        headers={"Authorization": f"Bearer {os.environ['RATESHIELD_TOKEN']}"},
        json={"key": f"user:{user_id}", "rule": "api"},
        timeout=0.5,
    )
    return r.ok and r.json()["allowed"]   # при недоступности лимитера решайте сами: fail-open или fail-closed
```

Остальные служебные эндпоинты (тоже с токеном): `GET /_rateshield/stats` (счётчики по алгоритмам и источникам), `GET /_rateshield/rules` (действующие правила).

## 6. Запуск без Docker (systemd)

```bash
# Node 20+ и Redis установлены
git clone <ваш-репозиторий> /opt/rateshield && cd /opt/rateshield
npm ci --omit=dev && cp .env.example .env   # заполните .env
```

`/etc/systemd/system/rateshield.service`:

```ini
[Unit]
Description=RateShield
After=network.target redis-server.service

[Service]
WorkingDirectory=/opt/rateshield
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data
EnvironmentFile=/opt/rateshield/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now rateshield
# перечитать правила без рестарта:
kill -HUP $(systemctl show -p MainPID --value rateshield)
```

## 7. Redis

Подойдёт любой Redis 6+ или Valkey, включая управляемые (Upstash, Render Key Value и т. п.): используются только `EVAL`, `INCR`, `ZADD`, `HSET`. Для TLS указывайте `rediss://`. На своём сервере включите пароль и не открывайте порт 6379 наружу. Для лимитеров потеря данных при рестарте Redis некритична (счётчики начнутся заново), поэтому persistence — это удобство, а не требование.

## Диагностика Redis

В логе при старте видно, куда подключается сервис: `Redis: подключаемся {host, port, tls}` (пароль не выводится). При ошибках подключения рядом появляется поле `hint` с вероятной причиной:

| Ошибка | Что проверить |
|---|---|
| `connect ETIMEDOUT` | Адрес и порт в `REDIS_URL`. Облачные Redis (Upstash и др.) принимают только TLS, нужен `rediss://`. Внутренние адреса Render/Railway работают только внутри их сети, снаружи нужен внешний URL и разрешённый IP (allowlist). |
| `ENOTFOUND` | Опечатка в имени хоста |
| `ECONNREFUSED` | Redis не запущен или другой порт |
| `WRONGPASS` / `NOAUTH` | Пароль или пользователь в URL |
| `EPROTO` / TLS | `redis://` вместо `rediss://` или наоборот |

`GET /status` показывает `redis: connected | error`. В режиме `MODE=demo` при недоступном Redis счётчики автоматически ведутся в памяти (в `/status` будет `"fallback": true`), а когда Redis появляется, сервис переключается на него сам. В `MODE=proxy` откат на память намеренно отключён, там действует `FAIL_MODE`.

## Ограничения

- WebSocket / Upgrade через режим proxy не проксируются.
- Время для sliding/token берётся с сервера RateShield; при нескольких инстансах синхронизируйте часы (chrony/NTP).
- Лимиты считаются по запросам, не по размеру тела.
