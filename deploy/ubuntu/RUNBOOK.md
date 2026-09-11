# Развёртывание ts-playwright на отдельном Ubuntu-ПК (Phase 1)

Сервер крутится на выделенном Ubuntu-ПК и сам запускает Docker-раннеры (rootless), наружу
смотрит только Caddy по HTTPS. Этот runbook — порядок шагов и приёмка. Подробное обоснование
архитектуры/безопасности — в `docs/ui-deploy-research.md` (раздел 7).

> ⚠️ **Честно о проверке.** Все артефакты этой папки написаны, но **не проверены на живом
> Ubuntu-ПК** (у меня нет такого хоста и Docker-демона в окружении разработки). Их нужно
> прогнать на целевой машине по чеклисту приёмки в конце. Особо проверить: доступность стендов
> из контейнера (шаг 1), доступ сервера к rootless-сокету (шаг 6), и совместимость лимитов
> раннера с Chromium (см. «Известные риски»).

## Состав папки

| Файл | Тикет | Назначение |
|---|---|---|
| `01-preflight-reachability.sh` | P1-T01 | проверка достижимости стендов с хоста И из контейнера (БЛОКЕР) |
| `02-host-setup.sh` | P1-T02..T04 | ОС, таймзона, NTP, cgroups, Docker, пользователь `tsapp`, ротация логов |
| `03-rootless-docker.sh` | P1-T05,T06 | rootless Docker для `tsapp`, `DOCKER_HOST`/сокет |
| `04-images.sh` | P1-T09 | сборка/`save`/`load` образов server+runner (Playwright 1.52.0, global mode) |
| `05-firewall.sh` | P1-T13 | ufw: deny incoming, 22(allowlist)+80+443 |
| `06-clock-drift-check.sh` | P1-T17 | алерт по дрейфу часов (ломает 2FA молча) |
| `docker-compose.yml` | P1-T11 | прод-стек (server+caddy), 8000 не публикуется |
| `Caddyfile` | P1-T12 | reverse-proxy + авто-HTTPS + опц. basic-auth |
| `.env.example` | P1-T18 | прод-конфиг без секретов |
| `backup.sh` / `prune.sh` | P1-T15/T16 | бэкап storage с ротацией / очистка |
| `update.sh` / `rollback.sh` | P1-T19 | обновление с health-gate / откат |
| `systemd/*` | P1-T14..T16 | автозапуск + таймеры (user-units для `tsapp`) |

Репозиторные изменения этой фазы: `Dockerfile` — non-root `USER node` (P1-T08);
`deploy/docker-compose.gitlab.yml` — `user: "0:0"` для legacy root-сокета.

## Порядок

```bash
# 0) Положить репозиторий/артефакты и .env на хост
sudo mkdir -p /opt/ts-playwright && sudo chown -R tsapp:tsapp /opt/ts-playwright
cp deploy/ubuntu/* /opt/ts-playwright/ -r
cd /opt/ts-playwright && cp .env.example .env    # затем заполнить .env

# 1) БЛОКЕР: стенды достижимы и с хоста, и из контейнера?
./01-preflight-reachability.sh https://stand-a.example https://stand-b.example
#   Если FAIL — поднять тот же VPN/WireGuard на ПК или поставить ПК в сеть стендов. Не идти дальше.

# 2) База ОС + Docker + пользователь tsapp + NTP
sudo TIMEZONE=Europe/Riga ./02-host-setup.sh

# 3) Rootless Docker (пишет ROOTLESS_DOCKER_SOCK в .env)
sudo ENV_FILE=/opt/ts-playwright/.env ./03-rootless-docker.sh

# 4) Образы (ОТ имени tsapp, чтобы попали в rootless-демон)
sudo -iu tsapp bash -lc 'cd /opt/ts-playwright && ./04-images.sh build'
#   offline: ./04-images.sh save  ->  перенос ->  ./04-images.sh load

# 5) Заполнить .env: APP_API_KEY (обязателен!), TS_PLAYWRIGHT_DOMAIN, TS_PLAYWRIGHT_IMAGE,
#    APP_DOCKER_IMAGE, ROOTLESS_DOCKER_SOCK (уже проставлен шагом 3).

# 6) Firewall
sudo ADMIN_CIDR=203.0.113.10/32 ./05-firewall.sh

# 7) Автозапуск (user-units tsapp)
sudo -iu tsapp bash -lc '
  mkdir -p ~/.config/systemd/user
  cp /opt/ts-playwright/systemd/*.service /opt/ts-playwright/systemd/*.timer ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now ts-playwright.service
  systemctl --user enable --now ts-playwright-backup.timer ts-playwright-prune.timer
'

# 8) Проверка
curl -fsS https://$TS_PLAYWRIGHT_DOMAIN/health    # 200 {status:ok,...}
```

## Известные риски (проверить на приёмке)

1. **Лимиты раннера vs Chromium.** В `.env` по умолчанию `APP_DOCKER_NO_NEW_PRIVILEGES=false`
   (включение ломает setuid-sandbox Chromium в образе Playwright). `--cap-drop ALL` и
   `--cpus/--memory` включены — на приёмке прогнать эталонный сценарий и подтвердить `passed`
   и наличие trace/video; при падении Chromium снять `APP_DOCKER_CAP_DROP` или включить
   `--no-sandbox`. **Не проверено вживую.**
2. **Доступ сервера к rootless-сокету.** Контейнер сервера запускается `user: "0:0"`; под
   rootless это unprivileged `tsapp` на хосте (userns), и сокет монтируется в стандартный путь.
   Проверить, что прогон реально стартует контейнер-раннер. **Не проверено вживую.**
3. **TLS.** Для домена — авто-Let's Encrypt; для IP/закрытой сети — `tls internal` в Caddyfile
   и доверить корневой CA на клиентах. **Не проверено вживую.**
4. **Периметр до настоящей аутентификации (Фаза 2).** UI-страницы открыты; до Фазы 2 закрывать
   basic-auth в Caddyfile / VPN. `APP_API_KEY` защищает только `/api`.

## Приёмка (P1-T20) — выполнить на реальном ПК

- [ ] `01-preflight-reachability.sh`: все стенды OK с хоста и из контейнера.
- [ ] `curl /health` → 200 без ключа; контейнер `healthy` в `docker compose ps`.
- [ ] Эталонный сценарий из UI → `passed`; `docker inspect` раннера показывает
      `NanoCpus/Memory/PidsLimit/CapDrop:[ALL]`; trace/video на месте.
- [ ] Перезагрузка ПК → стек поднимается сам (linger + user-unit).
- [ ] `backup.sh` создаёт архив; ротация работает.
- [ ] `update.sh <tag>` переключает образ с health-gate; `rollback.sh` возвращает прошлый.
- [ ] ufw: 8000 закрыт снаружи, 443 открыт; SSH только из allowlist.
- [ ] Браузер с другого ПК открывает `https://<домен>`; агент с другого ПК заливает сценарий.
- [ ] `06-clock-drift-check.sh` → OK (часы синхронизированы).
