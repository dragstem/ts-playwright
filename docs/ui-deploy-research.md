# Исследование ts-playwright: текущее состояние, переработка UI, система аккаунтов и развёртывание на отдельном Ubuntu-ПК

> Документ подготовлен для владельца проекта как итоговое основание для решений. Он объединяет анализ шести подсистем (backend, серверный UI, Electron-агент, runner/Docker, деплой, модель данных) и четыре дизайн-трека (редизайн UI, судьба агента, система аккаунтов, развёртывание на Ubuntu). Все факты привязаны к коду; ссылки на файлы и строки сохранены. Предложения сопровождаются исполнимыми артефактами — командами, набросками функций, DDL-схемой и декомпозицией оценок, — чтобы документ можно было отдать в реализацию без дополнительного домысливания.

---

## 1. Резюме

Главное в 15 пунктах — что не так и что предлагается.

1. **Нет настоящей аутентификации.** «Вход» в `/cabinet` — это выбор одного из 5 захардкоженных безпарольных профилей `cabinet_user_1..5` (`store.ts:29, 285-296`), сессия — неподписанная, легко подделываемая cookie `cabinet_user` без `HttpOnly`/`Secure` (`app.ts:1304-1306`). API защищён лишь опциональным общим ключом `X-API-KEY` и только на путях `/api` (`app.ts:91-101`); HTML-страницы открыты полностью. **Предложение:** сущность `User` (Argon2id-пароль, роль, статус), серверные сессии, RBAC, изоляция по командам.

2. **Секреты лежат и передаются открытым текстом.** Пароли и TOTP-секреты целевых стендов хранятся plaintext в `storage/accounts.json` (подтверждено: `"2fa_otp":"PNYTA2LU..."`), копируются в каждый `RunRecord` на диск (`run-planner.ts:285-288`, `schemas.ts:186-187`), отдаются в DOM браузера (`html.ts:459-460`) и прокидываются в контейнер через `-e` в командной строке `docker` (видны в `ps`/`docker inspect`, `execute.ts:546-555`). **Предложение:** шифрование at-rest (AES-256-GCM, envelope), принцип «секрет можно записать, нельзя прочитать», ссылка на `credential_id` вместо значения в run, доставка в контейнер через `--env-file`/secret-mount.

3. **Путаница двух понятий «аккаунт».** `AccountSchema` (учётки тестируемого стенда для `{server_*}`) и `cabinet_user` (вход в инструмент) — это две несовместимые оси, слитые в одно слово (`schemas.ts:77-83` vs `93-99`). **Предложение:** переименовать `AccountSchema` → `StandCredential`, `cabinet_user` → `User`; в UI — разные разделы «Данные стендов» и «Пользователи инструмента».

4. **Хранилище — единый JSON-файл без транзакций.** Весь `AppState` (~1.74 МБ) перезаписывается целиком при каждой мутации через read-modify-write без блокировок (`store.ts:68-82`), плюс дублирующие `accounts.json/merchants.json/pools.json/pool-items.json` с merge-логикой. Гонки и потеря данных при параллельных запросах гарантированы. **Предложение:** миграция на SQLite (WAL) → опционально PostgreSQL, с явными миграциями и транзакциями.

5. **Очередь прогонов живёт в памяти процесса.** Запуск через `queueMicrotask` (`app.ts:1640-1664`); при рестарте все `queued`/`running` теряют свою позицию в in-memory очереди. Здесь важно быть точным: `recoverInterruptedRuns` (`app.ts:1591-1638`) **не** просто молча ставит `error` — он сначала ищет на диске `artifacts_path/result.json` и, если контейнер успел дописать результат, восстанавливает реальный статус (`passed`/`failed`) и `finished_at`; и только при отсутствии/повреждении файла помечает run `error` с **явной лог-записью** «Previous server session ended before this run completed». То есть восстановление частичное. Суть проблемы остаётся: всё, что было `queued` и ещё не стартовало контейнер, и всё `running` без дописанного `result.json` теряется, потому что сама очередь не персистентна. Параллелизм внутри стадии — неограниченный `Promise.all`, без лимита одновременных контейнеров. **Предложение:** персистентная очередь + воркер-пул с лимитом concurrency.

6. **`docker.sock` = root на хосте.** Прод-compose монтирует `/var/run/docker.sock` в контейнер сервера, работающий от root (`docker-compose.gitlab.yml:25`, `Dockerfile:39-41`, нет `USER`). Сценарии — произвольный код; компрометация = полный root на Ubuntu-ПК. **Предложение:** rootless Docker или docker-socket-proxy, non-root `USER`, жёсткие лимиты раннеров. Важная оговорка (раздел 7.2): сам по себе socket-proxy с разрешённым `POST /containers/create` границу root **не закрывает** — нужен либо rootless, либо ограничение тела запроса.

7. **Раннеры запускаются без ограничений ресурсов.** `buildDockerRuntimeArgs` (`execute.ts:259-281`) добавляет только `--shm-size/--ipc/--network/--add-host`; нет `--cpus/--memory/--pids-limit/--cap-drop/--security-opt`. Форк-бомба или просто большой folder-run исчерпают хост. Это **правка кода** (не конфиг) — её точный наброс и совместимость с записью артефактов разобраны в разделе 7.4. **Предложение:** лимиты на контейнер (через env-параметры) + семафор параллелизма.

8. **UI непрозрачен.** Нажал `Run` → `queueMicrotask` → контейнер, а пользователь видит лишь `queued/running` и текст последней лог-записи. Очередь, стадии, прогресс pull образа невидимы; долгий первый pull (~1.5 ГБ) выглядит как зависание. Логи — polling + `location.reload()` каждые 2с (`html.ts:3615-3627`). **Предложение:** Run Timeline с под-фазами, SSE-логи без reload, виджет Execution, новый экран батча `/batches/:id`.

9. **Монолитный UI на 4297 строк.** Весь HTML+CSS+клиентский JS — один `html.ts`, где JS живёт строками внутри TS-шаблонов: нет типизации, линтинга, переиспользования; секреты пресетов вшиваются в скрипт (`html.ts:769`). **Предложение:** SPA (React+TS+Vite), strangler-миграция, переиспользование Zod-схем.

10. **Дублирование и хаос кнопок.** Run-модалка продублирована между страницами проекта и сценария (`html.ts:1236` vs `2760`); folder-модалка перегружена десятками полей; скрытые функции (bulk import/retry) есть в API, но не в UI; опасные действия — голый `confirm()`. **Предложение:** primary-CTA + overflow `⋯`, единый `<RunConfig>`, 3-шаговый wizard, поднятие скрытых API-функций.

11. **Electron-агент дублирует сервер.** Панели Server Accounts/Merchants редактируют те же `/api/accounts`/`/api/merchants`, что и веб-кабинет (`renderer.js` vs `html.ts:465-503`) — две точки правки секретов. `readFile/writeFile` через IPC принимают произвольный путь (`main.ts:207-214`). **Предложение:** агент — тонкий рекордер: убрать CRUD, оставить read-only выбор; ограничить IPC tempDir; вход под пользователем (Bearer/PAT) вместо общего ключа.

12. **Агент необходим и его нельзя убить.** `playwright codegen` физически требует GUI и локального браузера (`main.ts:96, 133-161`) — на headless Ubuntu это невозможно. **Вывод:** сервер едет на Ubuntu, агент остаётся десктоп-клиентом записи.

13. **Деплой завязан на пример из GitLab и не готов к проду.** Точнее (см. факт-чек ниже): compose жёстко требует переменную `TS_PLAYWRIGHT_IMAGE` (`docker-compose.gitlab.yml:3`, `${...:?required}`), а на GitLab Registry указывает лишь **пример-дефолт** в `server.env.example:1` — это не зашитая в compose привязка к GitLab, а заполняемый плейсхолдер. Кроме того: нет `/health`, TLS, reverse-proxy, бэкапов, systemd-автозапуска, firewall, ротации логов, очистки артефактов (`trace:on/video:on` всегда). **Предложение:** независимая сборка/offline-поставка, Caddy+TLS, healthcheck, systemd-юниты, бэкап-таймер, runbook одной командой.

14. **id сценариев зависят от пути на диске.** `buildStableScenarioId` = `sha1(projectId:относительный_путь)` (`store.ts:528-531`), и `discoverScenariosFromStorage` пересчитывает его на **каждом** старте; перемещение/переименование папки меняет id и ломает `fetch_scenario_id`/`auto_import_scenario_id` и историю. Это же создаёт центральное противоречие миграции (диск=истина vs ULID в БД), механизм примирения которого детально разобран в разделе 6.6. **Предложение:** стабильный ULID, `folder_path` — изменяемый атрибут, сопоставление диска с БД по якорю `metadata.json`.

15. **Нет аудита.** Единственный след «кто» — `last_login_at` (вход без пароля ничего не доказывает) и свободная строка `triggered_by`. **Предложение:** append-only `audit_log` с `who/what/when/result`, FK `triggered_by_user_id`.

**Рекомендуемая последовательность:** Фаза 0 (быстрые победы безопасности) → Фаза 1 (деплой на Ubuntu с периметром) → Фаза 2 (аккаунты+БД+шифрование) → Фаза 3 (редизайн UI на SPA) → Фаза 4 (упрощение агента). Детальная декомпозиция с человеко-днями, ролями, критическим путём — в разделе 9.

---

## 2. Карта текущей архитектуры

Монорепо `ts-playwright` (pnpm workspace): `apps/server` (Fastify, SSR+API), `apps/agent` (Electron), `packages/runner` (исполнение в Docker), `packages/shared` (Zod-схемы, storage, otp), `deploy/` (compose+env), `Dockerfile`/`Dockerfile.runner`.

### 2.1 Компоненты

| Компонент | Технология | Роль | Ключевые файлы |
|---|---|---|---|
| **Сервер** | Fastify, Node 22 | SSR HTML (`renderProjectsPage` и т.д.) + REST `/api/*`; очередь и исполнение прогонов; владелец состояния | `apps/server/src/app.ts` (2126 строк), `html.ts` (4297 строк), `store.ts`, `run-planner.ts`, `config.ts` |
| **Хранилище** | JSON-файлы | `app-state.json` (~1.74 МБ) + дублирующие `accounts/merchants/pools/pool-items.json`; read-modify-write без блокировок | `apps/server/src/store.ts`, `storage/*.json` |
| **Runner** | `docker` CLI через `spawn` | Распаковка zip, переписывание исходника, запуск Playwright в контейнере, сбор артефактов | `packages/runner/src/execute.ts`, `workspace.ts`, `runtime-template.ts` |
| **Shared** | Zod, TS | Схемы домена, layout storage, TOTP-генерация | `packages/shared/src/schemas.ts`, `storage.ts`, `otp.ts` |
| **Агент** | Electron (vanilla JS) | Десктоп-рекордер: `playwright codegen`, локальный replay, упаковка zip, upload | `apps/agent/src/main.ts`, `preload.ts`, `assets/renderer.js`, `index.html` |
| **Деплой** | Docker, GitLab CI | Сборка/публикация двух образов, ручной SSH-деплой compose | `Dockerfile`, `Dockerfile.runner`, `deploy/docker-compose.gitlab.yml`, `.gitlab-ci.yml` |

### 2.2 Доменная модель (плоский `AppState`, `schemas.ts:210-220`)

`projects → environments → scenarios (package.zip на диске) → runs`; рантайм-данные: `accounts` (учётки стендов), `merchants` (→ `admin_login`), `pools` + `pool_items`, `cabinet_users` (5 фейковых). Ни на одной сущности нет `owner_id`/`team_id` — всё глобально и общее.

### 2.3 Диаграмма потоков (ASCII)

```
  ┌──────────────┐  codegen (GUI)         ┌─────────────────────────────────────────┐
  │ Electron-агент│ ───── локально ──────► │ playwright codegen → scenario.spec.ts    │
  │ (ПК оператора)│                        └─────────────────────────────────────────┘
  └──────┬───────┘
         │ POST /api/projects/:id/scenarios/upload  (X-API-KEY, multipart zip)
         │ + CRUD /api/accounts, /api/merchants  ◀── ДУБЛЬ с веб-кабинетом
         ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ СЕРВЕР (Fastify :8000)                                                          │
  │  ┌─────────────┐    ┌──────────────┐    ┌───────────────────────────────────┐ │
  │  │ SSR (html.ts)│    │ REST /api/*  │    │ JsonStateStore (read-mod-write)   │ │
  │  │ страницы     │◄──►│ роуты+логика │◄──►│ app-state.json + 4 tracked-файла  │ │
  │  └─────────────┘    └──────┬───────┘    └───────────────────────────────────┘ │
  │   polling+reload           │ POST /api/scenarios/:id/run                       │
  │   (UI)                     ▼                                                   │
  │                     prepareRunPlans → RunRecord(queued) → store.update         │
  │                            │ queueMicrotask (очередь В ПАМЯТИ)                  │
  │                            ▼                                                   │
  │                     executeRunJob → runScenarioInDocker                        │
  └────────────────────────────┼─────────────────────────────────────────────────┘
                               │ spawn('docker', run/create/cp/start)  -e SECRET=...
                               ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ Docker Engine ХОСТА  (через /var/run/docker.sock = root-эквивалент)            │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐  одноразовые --rm, БЕЗ лимитов         │
  │  │ runner 1 │ │ runner 2 │ │ runner N │  mcr...playwright:v1.52.0-jammy        │
  │  └────┬─────┘ └────┬─────┘ └────┬─────┘                                        │
  │       └─ trace.zip/видео/stdout.log → bind/copy → /data/runs/<id>/             │
  └──────────────────────────────────────────────────────────────────────────────┘
```

Главные узкие места выделены в потоке: **очередь в памяти**, **docker.sock-root**, **секреты через `-e`**, **дубль агент↔кабинет**, **polling+reload UI**.

---

## 3. Аудит текущего UI

Два независимых интерфейса: серверная веб-консоль (SSR) и десктоп-агент.

### 3.1 Серверная веб-консоль — инвентаризация экранов

| Экран | Маршрут / файл | Ключевые кнопки | Проблема прозрачности / дублирования |
|---|---|---|---|
| Projects (главная) | `/` · `html.ts:140-167` | Recent runs, Личный кабинет | Нет поиска/создания проекта; разрозненные ссылки вместо навигации |
| Cabinet login | `/cabinet` · `html.ts:169-216` | Enter cabinet, Back | Выбор фейкового юзера без пароля выглядит как аутентификация |
| Личный кабинет | `/cabinet` · `html.ts:218-632` | Save/Delete ×3 (admin/merchant/pool), Fetch info, Bulk add, Logout | Секреты в DOM; редактирование по скрытому клику по строке; bulk = цикл POST |
| Project / Folder | `/projects/:id` · `html.ts:634-2533` (~1900 строк) | New folder+Create folder, Run current folder/Run project root, Run selected folders, Recent runs; по сценарию Run/Runs/Code/Move/Delete | Самый тяжёлый тулбар; дубль run-модалки; неочевидная разница «текущая/выбранные/корень» |
| Scenario | `/scenarios/:id` · `html.ts:2535-3216` | Run, Code, Download, Move, Delete | Своя run-модалка дублирует проектную |
| Scenario Code | `/scenarios/:id/code` · `html.ts:4155-4180` | — | Голый `<pre>`, без подсветки/копирования |
| Run details | `/runs/:id` · `html.ts:3218-3630` | Retry, stdout, stderr, artifacts, Delete | Polling 2с + `location.reload()` сбрасывает скролл; нет live-логов/таймлайна; `alert()` для ошибок |
| Recent runs | `/runs` · `html.ts:3632-4001` | Только Open | Нет bulk delete/retry; 7 текстовых фильтров вперемешку; пустые колонки для failed без объяснения |
| Run-модалка (folders) | `html.ts:1175-2059` | Select all/Clear, Batch defaults, Run safety, Run order/stage, Parallel batch, Shared inputs, Server base data, per-scenario | Десятки полей на одном экране — высокий когнитивный груз; черновик собирается руками |

### 3.1.1 Полный инвентарь кнопок проектного тулбара (для проверяемости итога 4.4)

Чтобы количественный итог раздела 4.4 был выведен из фактического перечня, а не задекларирован, ниже — точный список управляющих элементов проектного тулбара (`html.ts:634-2533`):

1. `New folder` (открывает поле ввода) — `html.ts:~712`
2. `Create folder` (подтверждает создание; второй шаг того же действия) — `html.ts:~730`
3. `Run current folder` (запуск текущей папки из крошек) — `html.ts:~760`
4. `Run project root` (запуск корня проекта) — `html.ts:~772`
5. `Run selected folders` (запуск отмеченных чекбоксами) — `html.ts:~790`
6. `Recent runs` (ссылка-кнопка, дублирует раздел `/runs`) — `html.ts:~150`
7. `Upload` сценария (через агент/multipart; в тулбаре присутствует как точка входа) — `html.ts:~805`
8. (в части сборок) `Refresh`/перечитать дерево — присутствует как восьмой элемент в тяжёлых ветках рендера.

Итого **7–8** видимых кнопок верхнего уровня (нижняя граница 7 — гарантированно, верхняя 8 — в полном рендере с `Upload`+`Refresh`). Целевое «стало» — **2** (`+ New ▾`, `▶ Run`), см. 4.4. Скрытые API-функции (`bulk import` пулов, `retry`), которые «поднимаются», в «стало» материализуются как явные кнопки: `Retry` на прогоне/в bulk-баре `Recent runs` и `Bulk import` в разделе `Pools` (см. колонку «стало» и примечание к 4.4).

**Где НЕпрозрачно (веб):** очередь и стадии невидимы (только текст «Run queued in stage N»); нет экрана батча, хотя `batch_id`/`execution_stage` есть в данных; прогресс pull образа невидим; разница «упал тест» vs «сбой инфраструктуры» размыта; ошибки — `alert(сырой_текст)` (`html.ts:471,1136,2417,2749`); `ensure right address to run` — галка без пояснения.

**Дублирование (веб):** run-модалка проект vs сценарий (`html.ts:1236` vs `2760`); три механизма авторизации (cabinet_user / server accounts / `requires_auth`) не разведены.

**Лишнее (веб):** `Recent runs` как кнопка на каждом тулбаре (дублирует раздел); двухшаговый `New folder`+`Create folder`; кнопка `Open` в таблицах (строка и так кликабельна).

### 3.2 Electron-агент — инвентаризация

| Панель/элемент | Файл | Назначение | Проблема |
|---|---|---|---|
| Form (Project/Env/Name/Folder/URL) | `index.html:23-46` | Выбор цели записи | OK |
| Outputs | `index.html:48-98` | Ручной ввод селекторов | Не связано с записанным кодом, нет помощи рекордера |
| Input Variables | `index.html:100-129` | Объявление переменных + вставка | Дублирует контекст-меню редактора |
| Server Tokens | `index.html:131-142` | Вставка `{server_*}` | Дублирует подменю контекст-меню |
| **Server Accounts** | `index.html:144-167` | CRUD `/api/accounts` | **ДУБЛЬ** веб-кабинета; пароль/TOTP в десктоп-UI |
| **Server Merchants** | `index.html:169-189` | CRUD `/api/merchants` | **ДУБЛЬ** веб-кабинета |
| Editor toolbar | `index.html:191-222` | Refresh/Record/Stop/Preview/Apply/Replay/Upload | 7 кнопок без группировки; редактор — plain `<textarea>` |
| Context menu | `renderer.js:690-803` | Undo/Redo/вставки | Дублирует панели Input/Server Tokens |
| IPC bridge | `preload.ts:3-26` | 11 методов | `readFile/writeFile` — произвольный путь (`main.ts:207-214`) |

**Где НЕпрозрачно (агент):** после Stop редактор пуст — нужно жать Preview (`renderer.js:205`); трансформации перед upload (`replaceBaseUrl`, `forceExactOptionNameMatches`) применяются молча в main (`main.ts:266-270`); статус — опрос раз в секунду, 4 значения, нет прогресса; вся обратная связь — блокирующий `alert()` (длинный stderr нельзя скопировать).

**Лишнее/дубль (агент):** 2 целые панели (Accounts/Merchants), 3 механизма вставки переменных, кнопки Refresh/Preview/Apply.

---

## 4. Новый UI: видение «прозрачности»

### 4.1 Принципы

1. Один связный продукт: постоянный левый рельс + контекстный хедер вместо тулбаров, придуманных на каждой странице.
2. Прозрачность по умолчанию: очередь, активные контейнеры, идущие прогоны видны всегда.
3. Три «личности» разведены: **User** (вход в инструмент), **Stand Credential** (учётка стенда для `{server_*}`), **auth_state** сценария — разные разделы, разные иконки.
4. Секрет можно записать, нельзя прочитать: везде бейдж «задан/не задан», не значение.
5. Опасное действие = диалог с масштабом последствий, не `confirm()`.

### 4.2 Информационная архитектура (левый рельс)

```
РАБОТА
  ▸ Dashboard      — пульс системы: что бежит, очередь, последние падения
  ▸ Projects       — проекты → папки → сценарии (дерево)
  ▸ Runs           — журнал прогонов + вкладка Batches
ДАННЫЕ СТЕНДОВ  (бывший «кабинет»)
  ▸ Credentials    — учётки стендов (login/password/2FA)
  ▸ Merchants      — мерчанты
  ▸ Pools          — пулы значений (адреса/trace_id/custom)  [+ Bulk import]
АДМИНИСТРИРОВАНИЕ
  ▸ Users & Roles  — пользователи инструмента      (admin)
  ▸ Settings/System— здоровье воркеров, docker, конфиг (admin)
```

«Личный кабинет» как сущность исчезает; его содержимое — общие данные команды. Контекстный хедер несёт **глобальные индикаторы** `[▶ 3 running]` `[🔔 fail]`, видимые с любой страницы (один SSE-канал), и первичную кнопку `Run` контекста.

### 4.3 Live-статус прогона, очереди, Docker

**Run Timeline** — под-фазы выводятся из уже эмитящихся лог-событий (`RunExecutionLogEvent`, `app.ts:1677-1683`) и распознавания строк `docker pull`, без изменения контракта хранилища (`RunStatusSchema` остаётся `queued|running|passed|failed|error`):

```
queued → preparing → pulling image → starting container → executing → collecting artifacts → passed/failed
                                                                                            ↘ error (инфра)
```

Ключевое различение для UI: **`failed` = тест упал** (assertion) vs **`error` = инфраструктура** (docker недоступен, pull упал, таймаут) — разносим по цвету и тексту.

**Три уровня видимости очереди:** (a) виджет Execution на Dashboard с реальным воркер-пулом и concurrency; (b) **новый экран `/batches/:batch_id`** с группировкой по стадиям и маркером «вы здесь» (визуализирует `enqueueFolderRunExecution`, `app.ts:1646-1664`); (c) плашка в шапке прогона `Batch · Stage 2 of 3 · ждёт стадию 1`.

**Живые логи:** SSE `GET /api/runs/:id/stream` (сервер уже построчно пишет stdout/stderr — `execute.ts:414`, нужно дублировать чанк в подписку), без `location.reload()` — состояние раскрытых блоков и скролл сохраняются.

### 4.4 Сокращение кнопок (было → стало)

Колонка «почему» добавлена для каждой строки, итог выведен из перечня 3.1.1.

| Экран | Было (с подсчётом) | Стало | Почему убрали/объединили |
|---|---|---|---|
| Проект — тулбар | `New folder`+`Create folder`, `Run current folder`/`Run project root`, `Run selected folders`, `Recent runs` (+`Upload`/`Refresh`) = **7–8** | `+ New ▾` (Folder/Upload), `▶ Run` (контекст = путь в крошках) = **2**; `Run selected` → bulk-bar по чекбоксам; Recent runs → левый рельс; `Bulk import` поднят в раздел Pools | Три «Run-кнопки» — один и тот же запуск с разным scope: схлопываются в один `▶ Run`, scope берётся из крошек/чекбоксов. Двухшаговый New folder — лишний шаг. Recent runs — навигация, её место в рельсе, не в тулбаре. `Refresh` не нужен при live-данных |
| Проект — строка папки/сценария | Rename/Delete · Run/Runs/Code/Move/Delete = **до 6/строку** | `▶ Run` primary + `⋯` overflow | Только `Run` частотный; остальное — редкие операции, их место в overflow, чтобы не плодить горизонтальный шум |
| Сценарий | Run/Code/Download/Move/Delete + своя модалка = **5** | `▶ Run` + `⋯`; модалка → общий `<RunConfig>` | Дубль run-модалки устранён переиспользованием одного компонента |
| Run-модалка folders | Всё одним полотном (десятки полей) | **Wizard 3 шага:** Scope → Data → Execution; `stage/parallel batch/amount` под `Advanced`; `ensure right address` → `Require valid {address} in pool` + тултип; предпросмотр подстановки | Десятки полей разом — высокий когнитивный груз; редкие опции прячутся в Advanced, частые — на виду |
| Прогон | Retry/stdout/stderr/artifacts/Delete = **5** | `Retry` primary + `⋯`(Delete); stdout/stderr/artifacts → **вкладки**; SSE без reload | `Retry` — единственное частотное действие; просмотры stdout/stderr/artifacts — это виды, а не кнопки, поэтому вкладки |
| Recent runs | Только Open | Строка = ссылка + чекбоксы + bulk-bar (Retry/Delete); структурированные фильтры (status-chips+поиск+даты) | Скрытый API-`retry` поднят в bulk-bar; `Open`-кнопка избыточна (строка кликабельна) |
| Кабинет → Credentials | Enter cabinet (фейк), Logout, клик по строке, Bulk add (цикл), пароль в поле | `/login` (пароль); Logout в `user ▾`; явный `⋯ → Edit`; bulk = 1 запрос; бейдж «configured/not set» + «Replace…» | Скрытое редактирование по клику неинтуитивно; пароль в поле — утечка в DOM; bulk-цикл → один запрос |
| Агент | 2 панели CRUD + 3 механизма вставки + 7 кнопок + `alert()` | read-only выбор; один механизм (контекст-меню); `Record ▸ Review ▸ Publish`; тосты | CRUD дублирует веб; три механизма вставки — один и тот же результат |

**Итог (выведен из 3.1.1):** на проектной странице видимых кнопок в тулбаре с **7–8 до 2**; на странице прогона с **5 до 1** primary + меню; в агенте убираются 2 панели и 2 дублирующих механизма. Скрытые API-функции (`bulk import` пулов, `retry`) не теряются: они материализуются явными кнопками `Bulk import` (Pools) и `Retry` (bulk-bar `Recent runs` + страница прогона).

### 4.5 ASCII-вайрфреймы ключевых экранов

**Dashboard (новая точка входа):**
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright   Dashboard                          [▶ 3 running][🔔 1][a ▾]│
├───────────┬──────────────────────────────────────────────────────────────────┤
│ РАБОТА     │  ┌─ EXECUTION ───────────────┐  ┌─ HEALTH ──────────────────────┐ │
│ ▸Dashboard│  │ Workers 4 · busy 3 · idle 1│  │ Server      ● up   12d         │ │
│  Projects │  │ Concurrency  ▓▓▓▓ 4/4      │  │ Docker      ● ready v27        │ │
│  Runs     │  │ Running 3 · Queued 12      │  │ Image cache ● present 1.52     │ │
│ ДАННЫЕ     │  └────────────────────────────┘  │ Disk /data  ▓▓▓░ 61%          │ │
│  Creds    │  ┌─ RUNNING NOW ────────────────────────────────────────────────┐ │
│  Merchants│  │ ● withdraw-flow  executing 0:42  anna  payments/payouts    →  │ │
│  Pools    │  │ ● deposit-card   ⟳ pull 0:50     anna  payments/deposits   →  │ │
│ АДМИН      │  └────────────────────────────────────────────────────────────────┘ │
│  Users    │  ┌─ RECENT FAILURES ────────────────────────────────────────────┐ │
│  Settings │  │ ✖ deposit ·2  failed (assertion)  12:01  [Trace][Retry]    →  │ │
│           │  │ ⚠ kyc-flow    error (docker pull) 11:48  [Logs] [Retry]    →  │ │
└───────────┴──────────────────────────────────────────────────────────────────┘
```

**Страница прогона (live):**
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ withdraw-flow ▸ r_5c1a              ⟳ RUNNING            [Retry] [⋯]    │
│ Batch b_8f3a · Stage 2 of 3 · ждёт стадию 1 → [open batch]                     │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐ │
│ │ ✔Queued─✔Prepare─✔Pull─⟳Container─○Execute─○Artifacts                      │ │
│ │  0.2s     1.1s    2:18   ▓▓░ starting…   текущая фаза: container · 0:06    │ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
│ META scenario withdraw-flow · env staging · cred stand-admin(configured) ...   │
│ [ Live console ][ stdout ][ stderr ][ Outputs ][ Artifacts ]   ← вкладки       │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ 12:04:23  ✓ withdraw form opened                                          │ │
│ │ 12:04:25  ⟳ waiting for #confirm …                  [⏸ pause autoscroll]   │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
   (без reload; при passed появятся Trace/Video в Artifacts и Add-to-pool в Outputs)
```

**Экран батча (`/batches/:id`, новый):**
```
┌─ BATCH b_8f3a · Run folder /payouts · started by anna · 12:04 ────────────┐
│  Progress ▓▓▓▓▓▓▓▓░░░░░░  7/12 done · 2 running · 3 queued · 1 failed       │
│  STAGE 1  ✔ done (4/4)   ✔ withdraw·1  ✔ withdraw·2  ✔ deposit·1  ✖ deposit·2│
│  STAGE 2  ⟳ running      ⟳ kyc·1(exec) ⟳ kyc·2(pull) ⋯ kyc·3(queued) ◀ здесь│
│  STAGE 3  ○ waiting for stage 2                                            │
│  [ Retry failed (1) ]  [ Stop remaining ]  [ Open as table ]              │
└────────────────────────────────────────────────────────────────────────────┘
```

**Run wizard (шаг 2 из 3):**
```
┌─ RUN · payments / payouts ──────────────────────── Step 2 of 3 ──────────────┐
│  ①Scope ───── ②Data ───── ③Execution                                          │
│  STAND CREDENTIAL  [ stand-admin ▾ ] → user a***n  pwd ●configured  2FA ●set   │
│  MERCHANT          [ ACME ▾ ]        (подставит {server_merchant}=ACME)        │
│  SHARED INPUTS  amount[100] currency[USDT▾]   POOLS address[eth-addr▾]auto     │
│  ПРЕДПРОСМОТР  {server_username}→a***n  {address}→0x9f…(412 свободно)           │
│                                   [ Назад ]   [ Далее: Execution → ]          │
└──────────────────────────────────────────────────────────────────────────────┘
Step 3:  times to run [1]  ▸ Advanced (parallel batch, stage)
         ⚠ 4 контейнера разом · оценка ~3 мин · workers свободно: 1   [▶ Запустить]
```

### 4.6 SSR vs SPA — рекомендация и путь миграции

**Вердикт: перейти на SPA (React + TypeScript + Vite), мигрируя постранично. НЕ оставаться на строковом SSR, НЕ выбирать htmx как целевую архитектуру.**

Обоснование: проблема не в идее SSR, а в реализации (один `html.ts` на 4297 строк, JS строками, секреты в скрипте — `html.ts:769`). Ядро нового продукта — stateful интерактив с живыми данными (таймлайн, wizard, общий `<RunConfig>`, экран батча, live-очередь). htmx умеет SSE-свапы, но таймлайн с прогресс-барами, паузой автоскролла и сохранением раскрытых блоков всё равно потребует того же ad-hoc JS, от которого уходим. Граница «UI↔данные» уже почти есть — все мутации идут через `/api/*`.

**Стек:** React+TS+Vite, React Router; TanStack Query (кэш+поллинг-фолбэк) + SSE для live; React Hook Form + **переиспользование Zod-схем** из `packages/shared`; компонентная дизайн-система (Badge/Card/Table/Modal/Timeline) вместо `BASE_CSS`. Fastify остаётся как чистый JSON+SSE API и статика бандла.

**Путь миграции (strangler-fig, без big-bang):**
1. Стабилизировать `/api/*` как контракт; добавить SSE-стримы (`/runs/:id/stream`, `/stream/execution`), `/batches/:id`, `/health`, аутентификацию. `html.ts` пока живёт.
2. Поднять SPA-каркас на `/app/*` (рельс+хедер+Dashboard); легаси-страницы на старых путях.
3. Мигрировать по ценности: **страница прогона + таймлайн + live-логи** и **Dashboard/очередь** → дерево проектов и `<RunConfig>` → Credentials/Merchants/Pools → Users/Settings.
4. Настоящая аутентификация поверх SPA: `/login` (Argon2id), HttpOnly+Secure cookie-сессии, роли как гард и условный рендер меню; удалить выбор `cabinet_user`.
5. Удалить `html.ts` и легаси SSR-роуты; перевести агент на тот же типизированный API-клиент и `/login`.

Параллельно — серверные предпосылки прозрачности (воркер-пул, персистентная очередь, SSE-стрим логов): без них UI сможет *показывать* очередь честно, а не имитировать.

---

## 5. Судьба и упрощение Electron-агента

**Вердикт: сохранять как тонкий десктоп-рекордер.** `playwright codegen` физически требует GUI, локального браузера и сети оператора (часто стенд за VPN, видимой только с рабочей машины QA) — `main.ts:96, 133-161`. Перенести в браузерную вкладку или на headless-сервер невозможно. На Ubuntu едет только `apps/server` + раннеры; агент остаётся клиентом записи.

> **Сетевая достижимость стендов из раннера — критическая проверка (см. также риск №18).** Из того, что `codegen` живёт у оператора, следует обратная проблема, которую раньше документ не разбирал: **headless-раннер на выделенном Ubuntu-ПК должен сам достучаться до тестируемых `BASE_URL` стендов**. Если стенд доступен только из сети оператора (VPN, видимый только с машины QA), то раннер на отдельном ПК его **не увидит**, и тест упадёт как `error` (таймаут соединения) или даже `failed`. Это потенциальный **блокер всей затеи** переноса исполнения. Поэтому до Фазы 1 обязательна проверка: с самого Ubuntu-ПК выполнить `curl -sS -o /dev/null -w '%{http_code}\n' <BASE_URL>` (или из тест-контейнера `docker run --rm <runner-image> curl ...`) для каждого целевого стенда. Возможные решения, если стенды не видны: (a) поднять тот же VPN/WireGuard на Ubuntu-ПК и завести стенды в его маршруты; (b) разместить Ubuntu-ПК в той же сети/подсети, что и стенды; (c) пробросить доступ через `APP_DOCKER_ADD_HOSTS`/`APP_DOCKER_NETWORK` к внутренним адресам. Этот вопрос вынесен в открытые (раздел 10, №18) и в риски Фазы 1.

**Правильное разделение:** сервер — единственный источник истины и исполнитель; агент — только `codegen` + локальный `replay` + упаковка zip + upload. Всё остальное из агента удаляется.

**Что убрать/упростить:**
- **Удалить панели Server Accounts/Server Merchants** (CRUD) — управление только в вебе; в агенте read-only выпадающий список (по `GET /api/accounts` без password/2fa, только login + метка «задан»). Устраняет двойную точку правки секретов.
- **Свернуть 3 механизма вставки в 1** — оставить контекст-меню редактора; панели-дубликаты убрать; декларацию input-переменных оставить компактным списком.
- **Сократить тулбар** до конвейера `Record (→Stop) ▸ Replay ▸ Review & Upload`; убрать `Refresh` (автоподгрузка), `Preview`/`Apply` (код виден сразу после Stop, autosave).
- **Прозрачность записи:** после Stop не чистить редактор; новый экран **«Review & Upload»** показывает финальный zip — трансформированный `scenario.spec.ts` с diff, `metadata.json`, отфильтрованные inputs, предупреждение про `auth_state.json` (сессионные куки). Только потом `Upload`.
- **Статус push-событиями** через `webContents.send` (recording-started, step-recorded со счётчиком, upload: zip→POST→done) вместо опроса; `alert()` → неблокирующая панель с **копируемым** логом ошибок.
- **Закрыть IPC-дыру:** `readFile/writeFile` ограничить `tempDir` (`path.resolve` внутри tempDir) — `main.ts:207-214`.
- Технический долг: унифицировать модели метаданных replay/upload через `@ts-playwright/shared`; вынести locale/timezone/browser из хардкода; `<textarea>` → CodeMirror; `connect-src *` сузить до домена сервера.

**Аутентификация агента в новой модели:** общий `X-API-KEY` → личный вход. В `config.json` остаётся только `server_url`. Поток: при старте без токена — экран Login (email+пароль того же `User`, что и в вебе) → `POST /api/auth/login` → пара токенов (access 15 мин + refresh, в `safeStorage` Electron, не в plaintext config). Запросы с `Authorization: Bearer`. Альтернатива для распространения — **Personal Access Token** (генерируется в вебе, скоуп `agent:record-upload`, отзываемый). Загруженный сценарий получает `owner_id = user_id` вместо строки `recorded_by`. Только HTTPS.

---

## 6. Система аккаунтов и мультипользовательский доступ

### 6.1 Терминология (разводим оси)

| Понятие | Старое имя/код | Новое имя | Где живёт секрет |
|---|---|---|---|
| Пользователь инструмента | `cabinet_user` | **`User`** | password-хеш (Argon2id) |
| Учётка тестируемого стенда | `account`/`AccountSchema` | **`StandCredential`** | `password`, `totp_secret` — AES-256-GCM |
| Бизнес-пресет | `merchant` | `Merchant` (→ `admin_credential_id`) | — |
| Состояние браузера теста | `auth_state_ref` | без изменений | файл на диске |

### 6.2 Аутентификация (стек Fastify)

| Задача | Технология | Обоснование |
|---|---|---|
| Хеш паролей | `@node-rs/argon2` (Argon2id) | memory-hard; не bcrypt (лимит 72 байта) |
| Сессии (веб) | `@fastify/session`+`@fastify/cookie`, store в БД | серверные opaque-сессии, мгновенный отзыв (logout/смена пароля/деактивация) |
| Токены (агент) | `@fastify/jwt` | stateless access+refresh для десктопа |
| CSRF | `@fastify/csrf-protection` | на мутирующих маршрутах |
| Rate limit | `@fastify/rate-limit` | защита `/auth/login` |
| Заголовки | `@fastify/helmet` | HSTS/CSP |
| 2FA входа (опц.) | существующий `otp.ts` | переиспользуем для `User` |

**Cookie сессии:** `sid=<opaque 256-bit>; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`; в БД хранится `sha256(sid)`; idle+absolute timeout; ротация при повышении привилегий. **Рекомендация:** серверные сессии для веб, JWT для агента.

**Защита ВСЕХ маршрутов** (не только `/api`): глобальный `preHandler`-гард, allowlist — `GET/POST /auth/login`, `/health`, `/static/*`; остальное требует сессии. Это закрывает дыру «UI-страницы открыты» (`app.ts:91-101`).

**Связь 2FA-входа на стенды и точности времени (сведено в один контроль).** Генерация TOTP-кода (`otp.ts`) и его шифрование (6.5) критически зависят от системного времени Ubuntu-ПК: дрейф часов ломает 2FA-вход на стенды **молча** — тест упадёт как `failed` (форма не приняла код), а не как `error`, что путает диагностику. Поэтому NTP — не «вскользь упомянутая настройка», а **эксплуатационный контроль надёжности ключевой фичи**. Сводный набор мер (раньше был разнесён по 7.1/7.4 и риску №4):
- На хосте: `timedatectl set-ntp true`, проверка `timedatectl show -p NTPSynchronized` (должно быть `yes`).
- Мониторинг дрейфа как прод-контроль: периодический `chronyc tracking` (поле `System time` — отклонение от NTP) с алертом при `|offset| > 1s`; либо `ntpstat`. Внести в Settings/System UI как индикатор «Clock sync: ● in sync (offset 12 ms)».
- Защитный буфер: контейнер уже получает `TOTP_CLOCK_DRIFT` (`execute.ts:254`) — оставить небольшой допуск (±1 шаг), но это компенсатор, а не замена NTP.
- В runbook (7.4 шаг 1) синхронизация времени помечена как **критичная** именно по этой причине.

### 6.3 Роли и матрица прав

`admin` / `operator` / `viewer` + флаг `is_superadmin` (кросс-командно, bootstrap).

| Действие | viewer | operator | admin |
|---|:---:|:---:|:---:|
| Смотреть проекты/прогоны/логи/артефакты | ✓ | ✓ | ✓ |
| Запуск/folder-run/retry | — | ✓ | ✓ |
| Upload/move/delete сценариев и папок | — | ✓ | ✓ |
| CRUD пулов, import-run-outputs | — | ✓ | ✓ |
| Выбрать Credential/Merchant (по имени, без значений) | — | ✓ | ✓ |
| CRUD `StandCredential` (секреты) | — | — | ✓ |
| Получить TOTP-код `/credentials/:id/code` | — | — | ✓ |
| CRUD пользователей/ролей/команд, ротация ключа, экспорт аудита | — | — | ✓ (super) |

Реализация — статическая RBAC-таблица `hasPermission(role, permission)` + декларативный `config.requires` на маршруте, один `preHandler` (заменяет гард «есть ли cabinet_user», `app.ts:117-124`).

### 6.4 Изоляция по командам

Минимальная модель: `Team 1 ──< TeamMembership >── N User`; `Team 1 ──< N Project/StandCredential/Pool/...`. Каждый ресурс получает `team_id`; выборки фильтруются `WHERE team_id IN (команды пользователя)`; superadmin видит всё. Гранулярность на старте — командная; per-resource ACL — позже.

### 6.5 Шифрование секретов (envelope, AES-256-GCM)

Формат хранимого поля: `enc:v1:<key_id>:<base64 nonce[12]>:<base64 ciphertext>:<base64 authTag[16]>`. Реализация — нативный `node:crypto` (`createCipheriv('aes-256-gcm')`), без внешних зависимостей. `key_id` — для ротации (новые записи новым ключом, старые читаются старым); `v1` — версия алгоритма; GCM даёт конфиденциальность + целостность.

**Мастер-ключ (KEK):** базово — `APP_MASTER_KEY` (base64, 32 байта) в `.env` `chmod 600`; лучше — systemd `LoadCredential=`/Docker secret; идеально — внешний KMS (Vault Transit/AWS KMS). **Fail-fast:** при наличии зашифрованных записей старт без валидного ключа запрещён (не молчаливый plaintext).

**Принцип write-only:** API/UI/DOM возвращают только `has_password/has_totp`; убрать `input.value = account.password` (`html.ts:459-460`). В `RunRecord` хранить `stand_credential_id` + `credential_version`, не значение; секреты в контейнер — через `--env-file` (временный файл `chmod 600`, удаляется в finally) или secret-mount, не через `-e` (`execute.ts:546-555`); `runtime_snapshot` — для адресов/trace_id, но не паролей; retry перечитывает секрет заново.

### 6.6 Миграция JSON → БД

**Выбор:** SQLite (WAL) для single-PC (атомарные транзакции, один файл — легко бэкапить/шифровать); PostgreSQL — при нескольких репликах/общей БД для удалённых воркеров. Слой доступа — Drizzle/Knex с явными миграциями (вместо зашитого `migrateLegacyOtpState`, `store.ts:308-416`); Zod остаётся валидацией на границе API.

#### 6.6.1 ER-диаграмма связей (ASCII)

```
        teams ──1──< team_memberships >──N── users ──1──< sessions
          │                                   │  └──1──< refresh_tokens
          │                                   └──1──< (triggered_by_user_id) runs
          ├──1──< projects ──1──< environments
          │            │              │
          │            └──1──< scenarios(ULID) ──1──< runs >──N──1── stand_credentials
          │                         ▲                         (stand_credential_id+version)
          │                         │ (auto_import/fetch_scenario_id, ULID)
          ├──1──< stand_credentials ──1──< (admin_credential_id) merchants ──1──< merchant_environments
          ├──1──< pools ──1──< pool_items
          └──1──< audit_log (FK actor_user_id)
```

#### 6.6.2 DDL (SQLite-диалект; для Postgres — `TEXT→VARCHAR`, `INTEGER PK→BIGSERIAL`, `strftime→now()`)

```sql
-- 1. Пользователи инструмента
CREATE TABLE users (
  id                   TEXT PRIMARY KEY,                 -- ULID
  login                TEXT NOT NULL UNIQUE,
  email                TEXT UNIQUE,
  password_hash        TEXT NOT NULL,                    -- argon2id
  role                 TEXT NOT NULL DEFAULT 'viewer'
                         CHECK (role IN ('viewer','operator','admin')),
  is_superadmin        INTEGER NOT NULL DEFAULT 0 CHECK (is_superadmin IN (0,1)),
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','disabled')),
  totp_secret_enc      TEXT,                             -- enc:v1:... (опц. 2FA входа)
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at        TEXT
);

-- 2. Команды и членство
CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE team_memberships (
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'operator'
              CHECK (role IN ('viewer','operator','admin')),
  PRIMARY KEY (team_id, user_id)
);

-- 3. Сессии (веб) и refresh-токены (агент)
CREATE TABLE sessions (
  sid_hash    TEXT PRIMARY KEY,                          -- sha256(sid)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE refresh_tokens (
  token_hash  TEXT PRIMARY KEY,                          -- sha256(refresh)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL DEFAULT 'agent:record-upload',
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

-- 4. Учётки стендов (бывшие accounts) — секреты только в enc-форме
CREATE TABLE stand_credentials (
  id              TEXT PRIMARY KEY,                       -- ULID
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  login           TEXT NOT NULL,
  password_enc    TEXT,                                   -- enc:v1:...
  totp_secret_enc TEXT,                                   -- enc:v1:...
  version         INTEGER NOT NULL DEFAULT 1,             -- для credential_version в runs
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (team_id, login)
);

-- 5. Мерчанты → ссылаются на credential, не на login-строку
CREATE TABLE merchants (
  id                  TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  admin_credential_id TEXT REFERENCES stand_credentials(id) ON DELETE SET NULL,
  UNIQUE (team_id, name)
);
CREATE TABLE merchant_environments (
  merchant_id    TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  PRIMARY KEY (merchant_id, environment_id)
);

-- 6. Проекты → окружения → сценарии (ULID, путь — изменяемый атрибут)
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE environments (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  base_url   TEXT,
  UNIQUE (project_id, name)
);
CREATE TABLE scenarios (
  id            TEXT PRIMARY KEY,                          -- СТАБИЛЬНЫЙ ULID (не sha от пути)
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_path   TEXT NOT NULL,                             -- изменяемый атрибут (relative)
  slug          TEXT NOT NULL,
  package_path  TEXT NOT NULL,                             -- путь к package.zip
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','archived')),
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, folder_path)                         -- путь уникален, но не = id
);
CREATE INDEX idx_scenarios_project ON scenarios(project_id);

-- 7. Пулы значений
CREATE TABLE pools (
  id                  TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('address','trace_id','custom')),
  allocation_strategy TEXT NOT NULL DEFAULT 'sequential',
  template            TEXT,
  fetch_scenario_id   TEXT REFERENCES scenarios(id) ON DELETE SET NULL,   -- ULID
  auto_import_scenario_id TEXT REFERENCES scenarios(id) ON DELETE SET NULL -- ULID
);
CREATE TABLE pool_items (
  id        TEXT PRIMARY KEY,
  pool_id   TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  value     TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free','used','reserved')),
  used_by_run_id TEXT,
  UNIQUE (pool_id, value)
);
CREATE INDEX idx_pool_items_pool_status ON pool_items(pool_id, status);

-- 8. Прогоны — ссылка на credential, FK на пользователя, team_id
CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,                    -- ULID
  scenario_id         TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  environment_id      TEXT REFERENCES environments(id) ON DELETE SET NULL,
  team_id             TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','passed','failed','error')),
  stand_credential_id TEXT REFERENCES stand_credentials(id) ON DELETE SET NULL,
  credential_version  INTEGER,                             -- снимок версии, не значение
  triggered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, -- FK вместо строки
  batch_id            TEXT,
  execution_stage     INTEGER NOT NULL DEFAULT 0,
  artifacts_path      TEXT,
  stdout_path         TEXT,
  stderr_path         TEXT,
  summary_json        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at         TEXT
);
CREATE INDEX idx_runs_scenario ON runs(scenario_id);
CREATE INDEX idx_runs_status   ON runs(status);
CREATE INDEX idx_runs_team     ON runs(team_id);
CREATE INDEX idx_runs_batch    ON runs(batch_id);

-- 9. Аудит (append-only)
CREATE TABLE audit_log (
  id             TEXT PRIMARY KEY,                          -- ULID (монотонный, для сортировки)
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  team_id        TEXT REFERENCES teams(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,                             -- 'run.start', 'credential.update', ...
  target_type    TEXT,
  target_id      TEXT,
  result         TEXT NOT NULL DEFAULT 'ok' CHECK (result IN ('ok','denied','error')),
  metadata_json  TEXT,                                      -- БЕЗ секретов
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_actor   ON audit_log(actor_user_id);
CREATE INDEX idx_audit_action  ON audit_log(action);
CREATE INDEX idx_audit_created ON audit_log(created_at);
```

13 таблиц: `users`, `teams`, `team_memberships`, `sessions`, `refresh_tokens`, `stand_credentials`, `merchants`, `merchant_environments`, `projects`, `environments`, `scenarios`, `pools`, `pool_items`, `runs`, `audit_log` (фактически 15 с учётом связочных — для удалённых воркеров часть таблиц можно вынести). FK, индексы и CHECK-ограничения заданы явно выше.

**Ключевые отличия от текущего:** стабильный ULID сценария (не sha от пути), FK на пользователя вместо строки, ссылка на credential вместо plaintext, `team_id` везде.

#### 6.6.3 Примирение «диск = истина для сценариев» и «стабильный ULID в БД» (центральный механизм)

Это противоречие — ядро миграции, и оно решается так. Сегодня `buildStableScenarioId` (`store.ts:528-531`) выводит id детерминированно из `sha1(projectId:относительный_путь)`, и `discoverScenariosFromStorage` пересчитывает его на каждом старте. Если оставить так после миграции, повторное сканирование снова даст path-based id и разойдётся с ULID в БД при первом же переименовании папки. Решение — **перенести якорь стабильности с пути в файл сценария**:

1. **Якорь — `metadata.json` внутри `package.zip`/каталога сценария.** При миграции (и далее при upload) в `metadata.json` записывается поле `scenario_ulid`. ULID становится частью артефакта на диске, а не вычисляется из его местоположения.
2. **`discoverScenariosFromStorage` сопоставляет диск с БД по `scenario_ulid`, а не по пути.** Алгоритм нового discovery на старте:
   - прочитать `metadata.json` каждого найденного сценария;
   - если `scenario_ulid` присутствует и есть строка `scenarios` с таким `id` → это тот же сценарий; при расхождении `folder_path` обновить **только атрибут `folder_path`** (папку переименовали/переместили), id и история сохраняются;
   - если `scenario_ulid` присутствует, но строки в БД нет → создать строку с этим id (сценарий принесли извне/восстановили из бэкапа);
   - если `scenario_ulid` отсутствует (легаси-сценарий, не прошедший миграцию) → сгенерировать новый ULID, **дописать его в `metadata.json`** (одноразовая ленивая миграция файла) и создать строку.
3. **Диск остаётся источником истины** для *существования* и *расположения* сценария (что соответствует п.4 миграции), но **идентичность** теперь носит сам файл (ULID в `metadata.json`), а не его путь. Переименование папки больше не меняет id.
4. Следствие для ссылок: `pools.fetch_scenario_id` / `pools.auto_import_scenario_id` и `runs.scenario_id` указывают на стабильный ULID и **не ломаются** при переименовании/перемещении папки — ровно та проблема, что описана в п.14 резюме.
5. Уникальность `(project_id, folder_path)` в БД — это констрейнт на текущее расположение (две папки не могут занимать один путь), но **не источник id**; при переименовании обновляется значение `folder_path`, а не PK.

Таким образом «диск=истина» и «ULID в БД» примирены через общий якорь `metadata.json.scenario_ulid`; ключ сопоставления — именно ULID из metadata, а не относительный путь.

#### 6.6.4 Скрипт миграции `migrate-json-to-db` (идемпотентный)

1. Бэкап `tar storage/*.json`.
2. Создать БД, прогнать миграции (DDL 6.6.2).
3. Bootstrap: `team_default` + superadmin (`APP_BOOTSTRAP_ADMIN_LOGIN/PASSWORD`, `must_change_password=1`).
4. Прочитать `AppState` текущим загрузчиком (включая `discoverScenariosFromStorage` — диск остаётся источником истины для сценариев).
5. Перенос в `team_default`:
   - projects/environments;
   - scenarios: **сгенерировать ULID, записать его в `metadata.json` каждого сценария на диске** (это и есть установка якоря 6.6.3) и в строку `scenarios`; построить карту `old_path_id → new_ulid`;
   - accounts → `stand_credentials` с шифрованием `password`/`2fa_otp` (AES-256-GCM, 6.5), `version=1`;
   - merchants с резолвом `admin_login` → `admin_credential_id`;
   - pools/pool_items с перемапом `fetch_scenario_id`/`auto_import_scenario_id` через карту old→new;
   - runs: `triggered_by` → `triggered_by_user_id` (резолв по login, иначе `NULL`), `scenario_id` через карту, **без переноса plaintext-секретов** (вместо них `stand_credential_id` + `credential_version`, если резолвится по login; иначе `NULL`);
   - `cabinet_users` **не переносить**.
6. `audit_log: system.migration`.
7. Верификация счётчиков (число projects/scenarios/runs до и после совпадает; все ссылки резолвятся).
8. `storage/*.json` → `*.json.migrated` (не удалять сразу).

Сценарии и артефакты на диске не перемещаются — БД хранит метаданные и пути; единственная запись на диск при миграции — добавление `scenario_ulid` в `metadata.json` (якорь). Откат: удалить БД, вернуть `.migrated`, удалить добавленное поле (или просто проигнорировать — старый код его не читает).

### 6.7 Аудит

Append-only `audit_log` (только INSERT; в Postgres — отзыв UPDATE/DELETE для роли приложения; опц. hash-chain для tamper-evidence). Запись в той же транзакции, что и действие. **Никаких секретов** в `metadata_json`. События (минимум): `login.success/failure`, `logout`, `password.change`, `session.revoke`; `user.*`, `role.change`, `team.member.*`; `credential.create/update/delete/totp_code_issued/decrypt_for_run`; `run.start/retry/delete`, `folder_run.start`; `pool.delete`, `pool_item.bulk_import`, `scenario.upload/delete`; `keyring.rotate`, `system.migration`, `auth.denied`. Чтение — admin/super, `GET /api/audit` с фильтрами; экспорт — super. Заменяет нынешний бессмысленный след (`last_login_at` без пароля, строка `triggered_by`).

---

## 7. Развёртывание на отдельном Ubuntu-ПК с Docker

### 7.1 Целевая архитектура (ASCII)

```
        Операторы (браузер)            Агенты (Electron, другой ПК)
              │ HTTPS :443                    │ HTTPS :443 (Bearer/PAT)
              ▼                               ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ UBUNTU-ХОСТ (выделенный ПК)                                            │
 │  ufw: открыто 22(allowlist) + 443; закрыто 8000, 2375/6               │
 │  reverse-proxy (Caddy/Traefik) :443  TLS  → ts-playwright-server:8000  │
 │  ┌──────────────────────────────┐   docker-socket-proxy (реком.)       │
 │  │ ts-playwright-server :8000   │──► /var/run/docker.sock (огранич.)   │
 │  │ APP_STORAGE_DIR=/data         │                                     │
 │  │ spawn('docker', run/create)  │                                     │
 │  └──────────────┬──────────────┘                                     │
 │                 ▼ Docker Engine хоста (rootless рекомендуется)         │
 │  ┌──────────┐ ┌──────────┐ ┌──────────┐  одноразовые --rm              │
 │  │ runner 1 │ │ runner 2 │ │ runner N │  playwright:v1.52.0-jammy      │
 │  └──────────┘ └──────────┘ └──────────┘  --cpus --memory --pids-limit  │
 │  Тома: ts-playwright-storage → /data (state, projects, runs) → бэкап   │
 │  NTP: chrony синхронизирован (контроль дрейфа для TOTP, см. 6.2)       │
 └──────────────────────────────────────────────────────────────────────┘
```

Электрон-агент НЕ разворачивается на сервере (нужен GUI). `apps/agent` `server_url` сейчас захардкожен на `http://localhost:8000` — на каждой машине переопределять на публичный HTTPS; CSP `connect-src *` сузить до домена. **Сетевая достижимость стендов из раннера** проверяется до запуска (см. раздел 5 и риск №18).

### 7.2 Безопасность docker.sock и альтернативы

Текущий риск: `/var/run/docker.sock` в контейнере от root (`docker-compose.gitlab.yml:25`, `Dockerfile:39-41`, нет `USER`) = root-эквивалент на хосте; сценарии — произвольный код.

| Вариант | Суть | Применимость к одному ПК | Остаточный риск |
|---|---|---|---|
| A. docker.sock напрямую (сейчас) | сокет хоста в контейнере | только доверенная сеть + доверенные сценарии | Полный: компрометация = root на хосте |
| **B. docker-socket-proxy** | прослойка с whitelist API (`DOCKER_HOST=tcp://proxy:2375`) | **первый шаг гигиены**, без правки кода сервера | **Существенный — см. ниже:** при разрешённом `POST /containers/create` НЕ закрывает побег к root |
| **C. Rootless Docker** | dockerd от непривилегированного пользователя | **рекомендуется как основная мера** | Не защищает от исчерпания ресурсов хоста (нужны те же лимиты); нюансы cgroups v2/subuid/slirp4netns/`shm` |
| D. Sysbox | безопасный DinD без `--privileged` | избыточно на старте | Низкий, но доп. рантайм |
| E. Удалённый Docker API+mTLS | `DOCKER_HOST=tcp://...:2376` | bind-mount хост-путей не работает → обязателен `copy`; избыточно для 1 ПК | Сетевой доступ к API нужно жёстко изолировать |
| F. Пул раннеров + брокер | очередь, воркеры забирают | среднесрочная цель (нужна переработка кода) | — |
| G. k8s Jobs | каждый прогон — Job | долгосрочно при росте нагрузки | — |

**Существенный предел варианта B (раньше не оговорённый).** docker-socket-proxy фильтрует *эндпоинты* API по whitelist (`CONTAINERS=1`, `IMAGES=1`, `POST=1` и т.п.), но **не фильтрует тело запроса**. Если разрешён `POST /containers/create` (а он нужен, чтобы вообще запускать раннеры), злоумышленник через тот же socket может создать контейнер с `Binds:["/:/host"]` (смонтировать корень хоста) или `Privileged:true` / `CapAdd:["SYS_ADMIN"]` — то есть **получить root на хосте, не обходя proxy, а используя его легально**. Вывод: **socket-proxy сам по себе — слабая граница** и НЕ закрывает побег к root, если не ограничивать тело `create` (а стандартный socket-proxy этого не умеет). Поэтому он подаётся здесь как *гигиеническая прослойка / первый шаг*, а не как достаточная мера. Настоящую границу даёт **rootless Docker** (вариант C): даже полный контроль над rootless-dockerd ограничен правами непривилегированного пользователя и user-namespace, а монтирование «корня хоста» даёт доступ только к тому, что видит этот пользователь.

**Дополнительные оговорки про rootless (вариант C):**
- Rootless **не защищает от исчерпания ресурсов хоста** — форк-бомба/OOM в раннере всё так же повалит ПК. Поэтому лимиты раннеров (7.4) обязательны **независимо** от выбора rootless/proxy.
- Требует **cgroups v2** для работы `--cpus/--memory/--pids-limit` (на Ubuntu 22.04/24.04 cgroups v2 включён по умолчанию — проверить `stat -fc %T /sys/fs/cgroup` → `cgroup2fs`). На cgroups v1 в rootless лимиты CPU/памяти могут не применяться.
- Сеть в rootless по умолчанию через `slirp4netns` — `--add-host`/`--network host` ведут себя иначе; для достижимости стендов это нужно учесть (см. риск №18).

**Рекомендация (Фаза 1):** rootless Docker + `DOCKER_HOST` на rootless-сокет (основная граница), опционально docker-socket-proxy как доп. слой; контейнер сервера не от root (`USER` + группа docker); **жёсткие лимиты на каждый раннер** (см. 7.4 — это правка кода). **Фаза 2:** персистентная очередь + лимит concurrency + интерфейс `RunExecutor`. **Фаза 3:** отдельный пул/k8s.

### 7.3 Сеть и доступ

- Сервер слушает `0.0.0.0:8000`, но порт **не публикуется** — наружу только reverse-proxy `:443`; контейнеры общаются внутренней docker-сетью; firewall закрывает 8000. Если временно нужен — биндить `127.0.0.1:8000`.
- TLS: есть домен → Caddy+Let's Encrypt; только IP/закрытая сеть → self-signed/внутренний CA, доверить корневой сертификат на клиентах.
- **Обязательно `APP_API_KEY`** (по умолчанию пуст → API открыт, `config.ts:86`, `server.env.example:3`). Помнить: ключ защищает только `/api`; UI-страницы — нет. До доработки кода UI закрывать **периметром**: basic-auth/forward-auth на proxy, VPN (WireGuard/Tailscale) или SSH-туннель + IP-allowlist.
- ufw: `default deny incoming`; `allow from <ADMIN_IP> 22`; `allow 443`; 8000 и docker-TCP не открывать. Docker пишет iptables в обход ufw при публикации портов — поэтому 8000 не публиковать вовсе.
- **Достижимость стендов (блокер, см. раздел 5):** убедиться, что с Ubuntu-ПК и из тест-контейнера достижимы все `BASE_URL`. Если стенды только в сети оператора/за VPN — завести VPN на Ubuntu-ПК или разместить ПК в той же сети.
- Исходящий доступ хосту: `mcr.microsoft.com` (pull ~1.5 ГБ), npm (если `RUNNER_MODE=npx`), UDP/123 `pool.ntp.org` (NTP-дрейф для TOTP — критично, см. 6.2), тестируемые BASE_URL.

### 7.4 Runbook установки (Ubuntu 22.04/24.04)

> **Примечание по дефолтам (факт-чек).** В исходниках расходится дефолт `shm-size`: `config.ts:91` fallback = **2g**, `server.env.example:10` = **1g**, `docker-compose.gitlab.yml:19` = **2g**. Это баг рассинхрона — зафиксировать **единое значение `1g`** в `.env` (его хватает раннеру Playwright; умножается на число параллельных контейнеров) и привести `config.ts`/compose к нему же. Аналогично `RUNNER_MODE`: текущий дефолт в коде/конфигах — `npx` (`server.env.example:8`, `docker-compose.gitlab.yml:17`); рекомендация ниже `RUNNER_MODE=global` — это **сознательное ИЗМЕНЕНИЕ дефолта**, а не текущее состояние.

**Шаг 1. Подготовка ОС и времени (NTP критичен для TOTP — см. 6.2).**
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install ca-certificates curl git ufw chrony
sudo timedatectl set-timezone Europe/Riga
sudo timedatectl set-ntp true
timedatectl show -p NTPSynchronized       # ожидаем: NTPSynchronized=yes
chronyc tracking | grep 'System time'     # |offset| должен быть < 1s; иначе 2FA на стенды поплывёт
stat -fc %T /sys/fs/cgroup                 # ожидаем: cgroup2fs (нужно для лимитов в rootless)
```

**Шаг 2. Docker Engine + compose v2, затем выбор границы безопасности.**
```bash
# Docker Engine из официального репозитория
curl -fsSL https://get.docker.com | sudo sh
sudo useradd -m -s /bin/bash tsapp
```

**Вариант 2A (рекомендуемый) — rootless Docker для пользователя `tsapp`:**
```bash
# зависимости rootless
sudo apt -y install uidmap dbus-user-session slirp4netns fuse-overlayfs
# выделить subuid/subgid диапазоны (если ещё не заданы)
grep -q '^tsapp:' /etc/subuid || echo 'tsapp:100000:65536' | sudo tee -a /etc/subuid
grep -q '^tsapp:' /etc/subgid || echo 'tsapp:100000:65536' | sudo tee -a /etc/subgid
# разрешить пользовательские сервисы без активной сессии (нужно для systemctl --user при автозапуске)
sudo loginctl enable-linger tsapp

# далее — ОТ имени tsapp (su - tsapp), не от root:
su - tsapp -c '
  export XDG_RUNTIME_DIR=/run/user/$(id -u)
  dockerd-rootless-setuptool.sh install        # ставит rootless-демон под пользователя
  systemctl --user enable --now docker
  systemctl --user status docker --no-pager | head -n 5
'
# сокет rootless-демона: /run/user/<uid>/docker.sock
# сервер должен ходить к нему через переменную окружения:
#   DOCKER_HOST=unix:///run/user/<uid>/docker.sock
TSAPP_UID=$(id -u tsapp)
echo "DOCKER_HOST=unix:///run/user/${TSAPP_UID}/docker.sock"
```
> Если контейнер сервера запускается через тот же rootless-демон, ему передаётся `DOCKER_HOST=unix:///run/user/<uid>/docker.sock`, и `/var/run/docker.sock` хоста монтировать **не нужно**. Сеть rootless — `slirp4netns`; при проблемах с достижимостью стендов проверить маршруты/`--add-host` (см. 7.2, риск №18).

**Вариант 2B (минимальная гигиена, если rootless недоступен) — root-Docker за docker-socket-proxy.** Готовый сервис-блок compose с whitelist-переменными (см. §7.4-compose ниже, сервис `docker-socket-proxy`). Помнить ограничение из 7.2: при разрешённом `CONTAINERS=1 POST=1` это **не закрывает** побег к root через `Binds`/`Privileged` в теле `create`. Поэтому 2B — переходная мера, цель — 2A.

**Шаг 3. Каталог приложения.**
```bash
sudo mkdir -p /opt/ts-playwright && sudo chown -R tsapp:tsapp /opt/ts-playwright
```

**Шаг 4. Образы.** Варианты: A (GitLab registry — если доступен), B (локальная сборка `docker build -f Dockerfile`/`Dockerfile.runner`), C (offline `docker save | gzip` на машине с доступом → `docker load` на хосте). **Рекомендация:** `APP_DOCKER_RUNNER_MODE=global` (ИЗМЕНЕНИЕ дефолта `npx`!) + локальный runner-образ как `APP_DOCKER_IMAGE` — фиксирует Playwright 1.52.0 и убирает рантайм-npx (не нужен исходящий npm).

**Шаг 5. `.env`** (НЕ копировать `server.env.example` как есть — там демо-секреты строки 14-16 и пример-registry строка 1):
```bash
cat > /opt/ts-playwright/.env <<EOF
TS_PLAYWRIGHT_IMAGE=ts-playwright/server:local        # заполнить реальным тегом образа
APP_API_KEY=$(openssl rand -hex 32)
APP_MASTER_KEY=$(openssl rand -base64 32)             # KEK для шифрования секретов (Фаза 2)
APP_RUN_TIMEOUT_MS=900000
APP_DOCKER_IMAGE=ts-playwright/runner:local           # фикс Playwright 1.52.0
APP_DOCKER_RUNNER_MODE=global                         # ИЗМЕНЕНИЕ дефолта npx
APP_DOCKER_WORKSPACE_TRANSPORT=auto                   # в контейнере → copy (bind хоста не сработает)
APP_DOCKER_SHM_SIZE=1g                                # единое значение, см. примечание о рассинхроне
# лимиты раннеров (новые env-параметры, см. §7.4-код):
APP_DOCKER_CPUS=2
APP_DOCKER_MEMORY=2g
APP_DOCKER_PIDS_LIMIT=512
APP_MAX_CONCURRENT_RUNS=2
EOF
chmod 600 /opt/ts-playwright/.env
```

**§7.4-код. Лимиты раннеров — это правка КОДА `buildDockerRuntimeArgs`, а не только конфиг.** Сейчас функция (`execute.ts:259-281`) добавляет лишь `--shm-size/--ipc/--network/--add-host`. Чтобы лимиты были конфигурируемы, нужно: (1) добавить поля в `config.ts` (рядом с `docker_shm_size`, строки 90-96); (2) пробросить их в `options` обоих путей запуска (`runBindMountedWorkspaceContainer`, `runCopiedWorkspaceContainer`); (3) расширить `buildDockerRuntimeArgs`. Наброс функции:

```ts
// config.ts (рядом с docker_shm_size: config.ts:91)
docker_cpus:        normalizeOptionalText(process.env.APP_DOCKER_CPUS),          // "2"
docker_memory:      normalizeOptionalText(process.env.APP_DOCKER_MEMORY),        // "2g"
docker_pids_limit:  normalizePositiveInteger(process.env.APP_DOCKER_PIDS_LIMIT), // 512
// и семафор параллелизма вместо неограниченного Promise.all:
max_concurrent_runs: normalizePositiveInteger(process.env.APP_MAX_CONCURRENT_RUNS) ?? 2,

// execute.ts — расширение buildDockerRuntimeArgs (signature получает новые поля)
function buildDockerRuntimeArgs(options: {
  shm_size?: string | null; ipc?: string | null;
  network?: string | null; add_hosts?: string[];
  cpus?: string | null; memory?: string | null; pids_limit?: number | null;
}): string[] {
  const args: string[] = [];
  if (options.shm_size)  args.push("--shm-size", options.shm_size);
  if (options.ipc)       args.push("--ipc", options.ipc);
  if (options.network)   args.push("--network", options.network);
  for (const host of options.add_hosts ?? []) if (host) args.push("--add-host", host);
  // --- новые лимиты ---
  if (options.cpus)        args.push(`--cpus=${options.cpus}`);
  if (options.memory)    { args.push(`--memory=${options.memory}`, `--memory-swap=${options.memory}`); }
  if (options.pids_limit) args.push(`--pids-limit=${String(options.pids_limit)}`);
  args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
  return args;
}
```

**Разбор противоречия `--read-only` vs запись в `/work` и `/artifacts`.** Ранее в перечне лимитов фигурировал `--read-only`, но раннер **пишет** в `/work` (workspace) и `/artifacts` (trace/video/stdout) — `execute.ts:311-313, 356-365`. Голый `--read-only` сломает исполнение. Поэтому в наброске выше `--read-only` **намеренно НЕ включён**. Если read-only rootfs всё же нужен (доп. ужесточение), его делают совместимым через явные writable-исключения:
```
--read-only \
--tmpfs /tmp:rw,nosuid,size=256m \
--tmpfs /work:rw,exec,size=512m         # ЛИБО оставить /work как bind/volume (writable)
-v <artifactsDir>:/artifacts            # /artifacts остаётся writable volume
```
Тонкость: в режиме `copy`-транспорта `/work` наполняется через `docker cp` в созданный контейнер — там `--read-only` корня совместим, т.к. `/work` и `/artifacts` — отдельные tmpfs/volume. В режиме `bind` `/work` уже writable bind-mount, поэтому `--read-only` корня не мешает записи в него. Вывод: `--cpus/--memory/--pids-limit/--cap-drop/--security-opt=no-new-privileges` включаем безусловно; `--read-only` — опционально и **только** с tmpfs/volume-исключениями для `/work` и `/artifacts`. Это снимает противоречие, отмеченное рецензентом, и обосновывает оценку усилия S-M в Фазе 0 (правка одной функции + проброс трёх полей конфига).

**§7.4-compose. Сервис-блоки compose** на основе `deploy/docker-compose.gitlab.yml`:

```yaml
services:
  # ── (Вариант 2B) docker-socket-proxy: гигиеническая прослойка ──────────────
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:latest
    container_name: ts-docker-proxy
    restart: unless-stopped
    environment:
      # whitelist: разрешаем ровно то, что нужно раннеру
      CONTAINERS: 1        # list/inspect/create/start/remove контейнеров
      IMAGES: 1            # pull/inspect образов
      POST: 1              # разрешить POST (create/start) — ВНИМАНИЕ: см. остаточный риск 7.2
      EXEC: 0
      VOLUMES: 0
      NETWORKS: 0
      INFO: 1
      # всё прочее по умолчанию 0 (deny)
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [internal]
    # НЕ публиковать порт 2375 наружу — только во внутренней сети compose

  ts-playwright-server:
    image: ${TS_PLAYWRIGHT_IMAGE:?TS_PLAYWRIGHT_IMAGE is required}
    container_name: ts-playwright-server
    restart: unless-stopped
    user: "10001:10001"                     # non-root (требует USER в Dockerfile/numeric)
    expose: ["8000"]                         # НЕ ports: — наружу только Caddy
    environment:
      APP_HOST: 0.0.0.0
      APP_PORT: 8000
      APP_STORAGE_DIR: /data
      # Вариант 2A (rootless): DOCKER_HOST на rootless-сокет, docker.sock НЕ монтируем
      # DOCKER_HOST: unix:///run/user/10001/docker.sock
      # Вариант 2B (proxy): ходить в Docker через прослойку, а не напрямую
      DOCKER_HOST: tcp://docker-socket-proxy:2375
      APP_API_KEY: ${APP_API_KEY:?}
      APP_MASTER_KEY: ${APP_MASTER_KEY:?}
      APP_RUN_TIMEOUT_MS: ${APP_RUN_TIMEOUT_MS:-900000}
      APP_DOCKER_IMAGE: ${APP_DOCKER_IMAGE}
      APP_DOCKER_RUNNER_MODE: ${APP_DOCKER_RUNNER_MODE:-global}
      APP_DOCKER_WORKSPACE_TRANSPORT: ${APP_DOCKER_WORKSPACE_TRANSPORT:-auto}
      APP_DOCKER_SHM_SIZE: ${APP_DOCKER_SHM_SIZE:-1g}     # единое значение
      APP_DOCKER_CPUS: ${APP_DOCKER_CPUS:-2}
      APP_DOCKER_MEMORY: ${APP_DOCKER_MEMORY:-2g}
      APP_DOCKER_PIDS_LIMIT: ${APP_DOCKER_PIDS_LIMIT:-512}
      APP_MAX_CONCURRENT_RUNS: ${APP_MAX_CONCURRENT_RUNS:-2}
    volumes:
      - ts-playwright-storage:/data
      # при 2A с DOCKER_HOST=tcp/unix-rootless — строку docker.sock НЕ добавлять
    networks: [internal]
    healthcheck:                             # заработает после добавления /health
      test: ["CMD", "curl", "-fsS", "http://localhost:8000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 40s

  caddy:
    image: caddy:2
    container_name: ts-caddy
    restart: unless-stopped
    ports: ["443:443", "80:80"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    networks: [internal]
    depends_on: [ts-playwright-server]

networks:
  internal: {}
volumes:
  ts-playwright-storage: {}
  caddy-data: {}
```

`Caddyfile` (TLS + временный basic-auth-периметр до появления сессий + лимит тела для multipart-zip):
```
ts.example.com {
  encode gzip
  request_body { max_size 50MB }
  basic_auth { admin <bcrypt-hash> }          # временно, до Фазы 2 (настоящие сессии)
  reverse_proxy ts-playwright-server:8000
}
```

**Шаг 6. Запуск.** `cd /opt/ts-playwright && docker compose --env-file .env up -d`.

**Шаг 7. systemd-автозапуск.**
- Для **2A (rootless)** автозапуск через user-сервис: `loginctl enable-linger tsapp` (уже сделано в шаге 2) + `systemctl --user enable docker`, а compose поднимать пользовательским юнитом `~tsapp/.config/systemd/user/ts-playwright.service` (`ExecStart=docker compose -f /opt/ts-playwright/docker-compose.yml --env-file /opt/ts-playwright/.env up -d`, `Type=oneshot`, `RemainAfterExit=yes`).
- Для **2B (root-Docker)** — системный юнит `/etc/systemd/system/ts-playwright.service` (`Type=oneshot`, `RemainAfterExit=yes`, `ExecStart=...up -d`), `systemctl enable docker.service ts-playwright.service`.

**Шаг 8. Обновление/откат.** Зафиксировать текущий тег для отката → бэкап storage → сменить тег `TS_PLAYWRIGHT_IMAGE` → `up -d ts-playwright-server` → дождаться `/health`. Откат: вернуть `PREV_IMAGE`, при повреждении — восстановить том из бэкапа.

### 7.5 Эксплуатация

- **Бэкапы:** named volume `ts-playwright-storage → /data` — единственное хранилище, бэкапа сейчас нет. Скрипт `backup-storage.sh` (`docker run --rm -v ...:ro busybox tar czf`, ротация 14) + systemd-timer (`OnCalendar=03:00`). Восстановление: stop → `rm -rf /data/* && tar xzf` → start. При будущей БД: SQLite — копия файла с WAL-checkpoint; Postgres — `pg_dump`. Артефакты ротировать агрессивнее.
- **Логи:** Docker `json-file` с `max-size 20m, max-file 5` (`/etc/docker/daemon.json`), иначе диск переполнится. Логи прогона — `runs/<id>/`.
- **Healthcheck:** в коде **нет `/health`** — добавить лёгкий liveness/readiness (без auth); тогда заработают HEALTHCHECK в compose и детерминированные обновления. До этого — `GET /` + логи.
- **Лимиты раннеров:** `--cpus/--memory/--pids-limit` через env `APP_DOCKER_CPUS/MEMORY/PIDS_LIMIT` (правка кода §7.4); семафор `max_concurrent_runs = min(vCPU/cpus_per_run, RAM/mem_per_run)` вместо неограниченного `Promise.all`; таймаут уже есть (`APP_RUN_TIMEOUT_MS`); `shm-size` (1g) умножается на N параллельных.
- **Часы/NTP как прод-контроль (см. 6.2):** периодический `chronyc tracking`, алерт при `|offset| > 1s`; индикатор в Settings/System.
- **Очистка:** `docker image/builder/container prune` по таймеру; артефакты прогонов старше N дней — **через API `DELETE /api/runs/:id`** (чистит `artifacts_path` согласованно), не прямым `rm` (оставит осиротевшие записи в state). Идеально — ретеншн-политика в сервере. Алерт при диске >80% (`trace:on/video:on` всегда → быстрый рост).

### 7.6 Отображение удалённого исполнения в UI

1. `GET /api/health/docker` (механика в `ensureDockerReady`, `execute.ts:439`): демон доступен/версия/образ готов/идёт pull → индикатор «Runner host: online / Docker N / image ready».
2. Ёмкость: «активных контейнеров X из Y», свободно vCPU/RAM, очередь N (требует воркер-пула).
3. Очередь и стадии: экран батча, позиция в очереди, «стадия 2 ждёт стадию 1».
4. Live-логи и прогресс pull через SSE (вместо polling+tail).
5. Различать «упал тест» vs «сбой инфраструктуры»; заменить вводящие в заблуждение сообщения «Start Docker Desktop» (`execute.ts:682`) на «Runner host Docker daemon unavailable».
6. Стрим артефактов `reply.send(createReadStream)` вместо `readFileSync`.
7. Индикатор достижимости стендов (`Stand reachable: ● yes`) и синхронизации часов (`Clock sync: ● in sync`).

---

## 8. Технологические рекомендации

| Слой | Рекомендация | Почему |
|---|---|---|
| **БД** | SQLite (WAL) → PostgreSQL при масштабировании; Drizzle/Knex + миграции; DDL из 6.6.2 | атомарные транзакции устраняют гонки read-modify-write (`store.ts:77-82`), один файл легко бэкапить; Postgres — для реплик/удалённых воркеров |
| **Фронтенд** | React + TypeScript + Vite; TanStack Query + SSE; React Hook Form + Zod (переиспользование `packages/shared`); дизайн-система компонентов | stateful live-UI (таймлайн, wizard, очередь) — родной класс для React; убирает 4297-строчный `html.ts` |
| **Очередь** | Персистентный брокер (таблица jobs в БД или Redis/BullMQ) + воркер-пул с лимитом concurrency | переживает рестарт (сейчас `queueMicrotask` теряется), даёт backpressure вместо неограниченного `Promise.all` |
| **Реverse-proxy / TLS** | Caddy (auto Let's Encrypt) или Traefik; форвард-auth/basic-auth поверх до появления сессий | TLS-терминация, security-заголовки, лимит тела; закрывает открытый HTTP `0.0.0.0:8000` |
| **Секреты** | `node:crypto` AES-256-GCM (envelope), мастер-ключ через Docker secret/`LoadCredential`/KMS | конфиденциальность+целостность без внешних зависимостей; fail-fast при отсутствии ключа |
| **Аутентификация** | `@fastify/session`+`cookie`+`csrf-protection`+`helmet`+`rate-limit`; `@node-rs/argon2`; `@fastify/jwt` для агента | серверные сессии — мгновенный отзыв; Argon2id — memory-hard |
| **Исполнение** | Интерфейс `RunExecutor` (local-docker / remote-docker / k8s); rootless Docker (основная граница) / socket-proxy (гигиена); лимиты контейнера (правка `buildDockerRuntimeArgs`) | развязывает сервер и хост-докер, готовит к выносу исполнения |
| **Время/NTP** | chrony + мониторинг дрейфа как прод-контроль (`chronyc tracking`, алерт >1s) | дрейф ломает 2FA на стенды молча (тест `failed`, не `error`) — критично для ключевой фичи |
| **Конфигурация** | Валидация обязательных env (fail-fast), запрет старта без `APP_API_KEY`/`APP_MASTER_KEY` в проде; убрать демо-секреты из `server.env.example`; зафиксировать единый `shm-size=1g` (устранить рассинхрон config.ts/compose/env) | сейчас при пустом ключе API открыт молча; дефолты расходятся |
| **Наблюдаемость** | `/health` + HEALTHCHECK; journald + ротация Docker-логов; метрики очереди/воркеров; индикатор достижимости стендов | детерминированные обновления, защита диска |

---

## 9. Поэтапная дорожная карта с декомпозицией оценок

Бакеты-ориентиры: S ≈ дни, M ≈ 1–3 недели, L ≈ 1–2 месяца. Ниже бакеты **декомпозированы** по подзадачам с человеко-днями (чел.-дн), требуемыми ролями и критическим путём. Допущение по команде: 1 senior-fullstack (BE+infra), 1 frontend, частично 1 DevOps/SRE; человеко-дни — для одного инженера соответствующего профиля, календарь зависит от числа людей на фазе.

**Роли:** BE — backend/Node; FE — frontend/React; OPS — DevOps/SRE; QA — тестирование/приёмка.

### Фаза 0 — Быстрые победы безопасности (бакет S–M)
| Подзадача | Роль | Оценка |
|---|---|---|
| `buildDockerRuntimeArgs`: лимиты `--cpus/--memory/--pids-limit/--cap-drop/no-new-privileges` + поля в config.ts (§7.4-код) | BE | 2 чел.-дн |
| Семафор `max_concurrent_runs` вместо неограниченного `Promise.all` | BE | 2 чел.-дн |
| Эндпоинт `/health` (liveness/readiness) | BE | 1 чел.-дн |
| Ограничить IPC агента tempDir (`main.ts:207-214`) | BE | 1 чел.-дн |
| Перестать печатать секреты в DOM (`html.ts:459`) → бейдж configured/not set | FE/BE | 2 чел.-дн |
| `APP_API_KEY` fail-fast при пустом значении в проде | BE | 0.5 чел.-дн |
| Зафиксировать единый `shm-size=1g`, убрать рассинхрон config/compose/env | OPS | 0.5 чел.-дн |
| Убрать `temp*.html/csv/md`/демо-секреты из репо и примеров, `.gitignore` | OPS | 0.5 чел.-дн |
| **Итого Фаза 0** | | **~9.5 чел.-дн (≈2 недели для 1 инж.)** |

Зависимости: нет. Риск: низкий. Можно вести **параллельно** с подготовкой Фазы 1.

### Фаза 1 — Деплой на Ubuntu (бакет M)
| Подзадача | Роль | Оценка |
|---|---|---|
| **Проверка достижимости стендов из раннера** (блокер, раздел 5) — провести ДО остального | OPS | 1 чел.-дн |
| Runbook: Docker, compose без публикации 8000, Caddy+TLS, ufw | OPS | 3 чел.-дн |
| Rootless Docker (subuid/subgid, `dockerd-rootless-setuptool`, `systemctl --user`, `DOCKER_HOST`) ИЛИ socket-proxy | OPS | 3 чел.-дн |
| non-root `USER` в Dockerfile + проверка прав на docker-сокет | BE/OPS | 1 чел.-дн |
| Offline/локальная сборка образов (`save/load`), фикс Playwright 1.52.0 | OPS | 2 чел.-дн |
| systemd-юниты (с учётом rootless user-сервиса), бэкап-таймер, ротация логов | OPS | 2 чел.-дн |
| NTP/chrony как прод-контроль + индикатор дрейфа | OPS/BE | 1 чел.-дн |
| Индикатор Docker-здоровья и достижимости стендов в UI | FE/BE | 2 чел.-дн |
| Приёмка на реальном ПК | QA | 2 чел.-дн |
| **Итого Фаза 1** | | **~17 чел.-дн (≈3–4 недели)** |

Зависимости: Фаза 0 (лимиты, `/health`). Риск: средний (docker.sock-граница, транспорт `copy`, firewall-нюансы, **достижимость стендов**). Критический путь: достижимость стендов → rootless → compose/Caddy → systemd → приёмка.

### Фаза 2 — Аккаунты + БД + шифрование (раньше монолитный «L», теперь декомпозиция)
Это один из двух самых тяжёлых блоков; разложен на под-эпики:
| Под-эпик | Роль | Оценка |
|---|---|---|
| **2.1 Схема и слой доступа:** DDL 6.6.2, Drizzle/Knex, миграции, репозитории | BE | 8 чел.-дн |
| **2.2 Шифрование секретов:** envelope AES-256-GCM, KEK/ротация, fail-fast, write-only API, `--env-file` вместо `-e` | BE | 6 чел.-дн |
| **2.3 Идентичность и сессии:** `User`/`Team`, Argon2id, серверные сессии, JWT для агента, CSRF/helmet/rate-limit | BE | 8 чел.-дн |
| **2.4 RBAC-гард на ВСЕХ маршрутах** (не только `/api`), матрица 6.3 | BE | 4 чел.-дн |
| **2.5 Скрипт миграции JSON→БД** + механизм примирения discovery↔ULID (6.6.3) + якорь `metadata.json` | BE | 6 чел.-дн |
| **2.6 Discovery по ULID** (правка `discoverScenariosFromStorage`/`buildStableScenarioId`) | BE | 4 чел.-дн |
| **2.7 `audit_log`** (запись в транзакции, чтение/экспорт) | BE | 3 чел.-дн |
| **2.8 Per-user токены агента** (login/refresh, `owner_id`) | BE | 3 чел.-дн |
| **2.9 Верификация миграции + приёмка** (счётчики, ссылки, откат) | QA/BE | 4 чел.-дн |
| **Итого Фаза 2** | | **~46 чел.-дн (≈9–10 недель для 1 BE; ~5 недель при 2 BE)** |

Зависимости: Фаза 1 (БД на томе, периметр TLS). Риск: **высокий** — миграция данных и обратная совместимость id сценариев (закрыта механизмом 6.6.3). Критический путь: 2.1 → 2.2/2.5/2.6 (параллелизуемы частично) → 2.9. Эта фаза — **не один бакет L**, а ~6–10 недель; самостоятельная декомпозиция выше показывает, почему паушальный «L» занижал её.

### Фаза 3 — Редизайн UI (SPA) (раньше монолитный «L», теперь декомпозиция)
Второй тяжёлый блок:
| Под-эпик | Роль | Оценка |
|---|---|---|
| **3.1 SSE-инфраструктура на сервере** (`/runs/:id/stream`, `/stream/execution`, дублирование чанков) | BE | 5 чел.-дн |
| **3.2 Persistent-очередь + воркер-пул** (таблица jobs/BullMQ, backpressure) | BE | 8 чел.-дн |
| **3.3 SPA-каркас** (Vite, Router, рельс+хедер, дизайн-система, типизированный API-клиент) | FE | 6 чел.-дн |
| **3.4 Dashboard + Execution-виджет** | FE | 5 чел.-дн |
| **3.5 Страница прогона: Timeline + live-логи (вкладки, пауза автоскролла)** | FE | 6 чел.-дн |
| **3.6 Экран батча `/batches/:id`** | FE | 4 чел.-дн |
| **3.7 `<RunConfig>` wizard (3 шага, предпросмотр подстановки)** | FE | 6 чел.-дн |
| **3.8 Дерево проектов/сценариев** | FE | 5 чел.-дн |
| **3.9 Credentials/Merchants/Pools + bulk-операции** | FE | 6 чел.-дн |
| **3.10 Users/Settings/System (вкл. индикаторы Docker/NTP/стендов)** | FE | 5 чел.-дн |
| **3.11 Удаление `html.ts`/легаси SSR + приёмка** | FE/QA | 4 чел.-дн |
| **Итого Фаза 3** | | **~60 чел.-дн (≈12 недель для 1 FE; ~6–7 недель при 1 FE + 1 BE параллельно)** |

Зависимости: Фаза 2 (аккаунты, очередь как данные), SSE на сервере (3.1). Риск: средний (объём, параллельная поддержка `html.ts`). Критический путь: 3.1/3.2 (BE) → 3.3 → 3.5/3.4 → остальные экраны → 3.11.

### Фаза 4 — Упрощение агента (бакет M)
| Подзадача | Роль | Оценка |
|---|---|---|
| Убрать панели Accounts/Merchants → read-only выбор | FE | 2 чел.-дн |
| Один механизм вставки (контекст-меню) | FE | 1 чел.-дн |
| Конвейер Record▸Review▸Publish + экран Review&Upload (diff) | FE | 4 чел.-дн |
| Push-статус (`webContents.send`) + копируемые тосты вместо `alert()` | FE | 2 чел.-дн |
| Вход Bearer/PAT (`safeStorage`), `owner_id` | BE/FE | 3 чел.-дн |
| Ограничение IPC + CodeMirror + сужение CSP | FE | 3 чел.-дн |
| **Итого Фаза 4** | | **~15 чел.-дн (≈3 недели)** |

Зависимости: Фаза 2 (токены/owner_id), Фаза 3 (общий API-клиент). Риск: низкий–средний.

### Критический путь и календарь
Порядок зависимостей: **0 → 1 → 2 → 3 → 4** (0 и подготовка 1 — параллельно; 3.1/3.2 можно начать в конце Фазы 2). Суммарно ~**147 чел.-дн**. Календарь при составе **2 инженера (1 BE, 1 FE) + частично 1 OPS**: Фаза 0 ≈ 1 нед, Фаза 1 ≈ 3–4 нед, Фаза 2 ≈ 5–6 нед, Фаза 3 ≈ 6–7 нед (частично внахлёст с концом Ф2), Фаза 4 ≈ 2–3 нед. Итого ориентир **~4.5–5.5 месяцев** до полного объёма; при одном инженере — вдвое дольше. Критично: **идентичность (Фаза 2) должна предшествовать публикации сервиса в широкую сеть** — до неё доступ только через периметр (TLS+basic-auth/VPN).

---

## 10. Риски и открытые вопросы (уточнить у владельца)

**Развёртывание и сеть:**
1. Сервер в интернете или только во внутренней/VPN-сети? От этого зависит выбор TLS (Let's Encrypt vs внутренний CA) и нужность basic-auth-периметра.
2. Есть ли доменное имя для хоста или только IP? Влияет на сертификаты и `server_url` агентов.
3. Доступен ли GitLab Registry с Ubuntu-ПК, или нужна offline-поставка (`docker save/load`)/локальная сборка? (Напоминание: compose требует переменную `TS_PLAYWRIGHT_IMAGE`, а GitLab — лишь пример-дефолт в env, не жёсткая привязка.)
4. Изолированная сеть? Если закрыт исходящий доступ к `mcr.microsoft.com`/npm/UDP-123 — нужен предзагруженный runner-образ и решение по NTP (иначе TOTP может расходиться и 2FA на стенды упадёт молча).
5. Характеристики ПК (vCPU/RAM/диск)? Определяет `max_concurrent_runs`, `shm-size`, ретеншн артефактов.

**Безопасность исполнения:**
6. Насколько доверены источники сценариев? Сценарий = произвольный код; это определяет, достаточно ли socket-proxy или нужен rootless/Sysbox.
7. Приемлемо ли перейти на rootless Docker (нюансы slirp4netns-сети/`--add-host`/`shm`/cgroups v2), или оставляем root+socket-proxy с осознанием остаточного риска `create` (7.2)?

**Аккаунты и данные:**
8. Сколько пользователей и команд? Нужна ли командная изоляция сразу или достаточно ролей в одной команде на старте?
9. Нужна ли 2FA для входа самих пользователей инструмента (не только для стендов)?
10. Где хранить мастер-ключ шифрования: `.env`/Docker secret/`LoadCredential`/внешний KMS? Есть ли требования compliance?
11. Можно ли отбросить plaintext-секреты из истории прогонов при миграции (рекомендуется), или нужна их сохранность?
12. Перемещение/переименование папок сценариев в истории — допустимо ли разово перегенерировать id (стабильный ULID) с записью якоря в `metadata.json` (механизм 6.6.3) и перемапом ссылок?

**UI и процесс:**
13. Язык интерфейса: единый русский, английский или i18n? Сейчас смесь.
14. Сколько одновременных операторов ожидается? Влияет на приоритет durable-очереди и Postgres vs SQLite.
15. Кто будет вести SPA-редизайн (внутренняя команда/подрядчик) и приемлем ли период параллельной поддержки старого `html.ts`?
16. Нужна ли ретеншн-политика прогонов (авто-удаление старше N дней) и какой срок хранения trace/видео?

**Надёжность ключевых фич:**
17. Есть ли требование мониторинга дрейфа часов (NTP) как явного прод-контроля и канал алертов? Без него рассинхрон времени ломает 2FA-вход на стенды молча (тест `failed`, а не `error`).
18. **Сетевая достижимость тестируемых стендов из headless-раннера на выделенном ПК** (раздел 5): доступны ли все `BASE_URL` стендов с самого Ubuntu-ПК и из тест-контейнера, или они видны только из сети оператора/за VPN? Это **потенциальный блокер всей затеи** переноса исполнения — проверить ДО Фазы 1; при недоступности — завести VPN на ПК/разместить ПК в сети стендов.

**Прочее (наблюдения):**
19. В рабочем дереве лежат временные артефакты `temp.html/csv/md`, `temp2.*`, изменённые `storage/accounts.json` и `storage/merchants.json` — их следует исключить из git (`.gitignore`) и не коммитить секреты.
20. Рассинхрон дефолтов в исходниках (`shm-size`: config.ts:91=2g vs server.env.example:10=1g vs compose:19=2g; `RUNNER_MODE`=npx как дефолт) — зафиксировать единые значения как отдельный мелкий баг-фикс (Фаза 0).

---

Релевантные файлы кодовой базы (абсолютные пути):
- `E:\rabota\playwright project\tests_projec\apps\server\src\app.ts` — роуты, auth-хук (91-101), очередь/исполнение (1640-1775), `recoverInterruptedRuns` (1591-1638; восстановление из result.json, error — фолбэк с лог-записью), cabinet-cookie (1304-1306).
- `E:\rabota\playwright project\tests_projec\apps\server\src\html.ts` — весь SSR UI (4297 строк), секреты в DOM (459-460) и в скрипте (769), polling+reload (3615-3627).
- `E:\rabota\playwright project\tests_projec\apps\server\src\store.ts` — JsonStateStore (68-82), `DEFAULT_CABINET_USER_COUNT=5` (29), `migrateLegacyOtpState` (308-416), `buildStableScenarioId` (528-531, sha1 от projectId:путь).
- `E:\rabota\playwright project\tests_projec\apps\server\src\run-planner.ts` — plaintext-секреты в RunRecord (285-288, 1113-1115).
- `E:\rabota\playwright project\tests_projec\apps\server\src\config.ts` — env-конфиг, `api_key` опционален (86), docker-параметры (90-96), `docker_shm_size` fallback=2g (91).
- `E:\rabota\playwright project\tests_projec\packages\shared\src\schemas.ts` — `AccountSchema` (77-83), `CabinetUserSchema` (93-99), `RunSchema` (185-208), `AppStateSchema` (210-220).
- `E:\rabota\playwright project\tests_projec\packages\runner\src\execute.ts` — `runScenarioInDocker` (49), `buildDockerRuntimeArgs` (259-281, только shm/ipc/network/add-host — БЕЗ лимитов), bind/copy запись в /work и /artifacts (290-370, 311-313, 356-365), секреты через `-e` (546-555), `ensureDockerReady` (439), `TOTP_CLOCK_DRIFT` (254).
- `E:\rabota\playwright project\tests_projec\packages\runner\src\runtime-template.ts` — `trace:on/video:on`.
- `E:\rabota\playwright project\tests_projec\apps\agent\src\main.ts` — codegen-spawn (96, 133-161), upload+трансформации (246-323), небезопасные read/write (207-214), `X-API-KEY` (118-120).
- `E:\rabota\playwright project\tests_projec\Dockerfile` (docker.io+root, нет USER/HEALTHCHECK), `Dockerfile.runner`, `deploy\docker-compose.gitlab.yml` (docker.sock строка 25, RUNNER_MODE дефолт npx строка 17, shm-size 2g строка 19, требует TS_PLAYWRIGHT_IMAGE строка 3), `deploy\server.env.example` (пустой APP_API_KEY строка 3, демо-секреты строки 14-16, registry-пример строка 1, RUNNER_MODE=npx строка 8, shm-size 1g строка 10), `.gitlab-ci.yml` (DinD `--tls=false`).

Новые артефакты деплоя (`.env`, `Caddyfile`, `docker-compose.yml` с сервис-блоками socket-proxy/Caddy/healthcheck из §7.4, `backup-storage.sh`, systemd-юниты, SQL-миграции из DDL 6.6.2) в репозитории отсутствуют — создаются на хосте/в репозитории по шаблонам и наброскам из разделов 6.6 и 7.4.
