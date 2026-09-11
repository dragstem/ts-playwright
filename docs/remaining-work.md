# ts-playwright — что осталось доделать (полный реестр)

> Живой чек-лист незавершённой работы по всем фазам. Дополняет план реализации
> `docs/implementation-plan.md` (тикеты P0–P4, X) и три проектных документа
> (`ui-deploy-research.md`, `ui-redesign-spec.md`, `ui-detailed-design.md`).
> Обновлять по мере закрытия пунктов.

## Снимок состояния (на момент составления)

**Ветки (каждая фаза — от предыдущей):**

| Ветка | Содержимое | Тесты | Статус |
|---|---|---|---|
| `phase-0-security` | Фаза 0 (8 тикетов безопасности) | зелёные | ✅ готово, проверено |
| `phase-1-deploy` | Фаза 1 (артефакты Ubuntu) | n/a (скрипты) | ✅ артефакты; ⚠️ не проверено на живом хосте |
| `phase-2-data` | Фаза 2: 8 микрошагов (auth/crypto/audit/PAT/multiproject) | **134** | 🟡 основное готово; инфра-остаток открыт |
| `phase-3-ui` | Real-time бэкенд (SSE, phase/outcome/timings) + SPA (React/Vite): auth, проекты, env+доступность, server-vars, прогон LIVE+Retry, runs, credentials+2FA, PAT, users, audit | **145** | 🟡 каркас+M3-срез+ширина готовы; e2e в браузере не гонялся, легаси-зачистка открыта |
| `phase-4-agent` | — | — | ⬜ не начата |

Полная сборка: `corepack pnpm run typecheck && corepack pnpm test && corepack pnpm run build` — зелёная (server/runner/shared/agent через корневой `tsc -b`; **`apps/web` собирается отдельно**: `corepack pnpm --filter @ts-playwright/web typecheck` + `build`, вне корневых project-refs).

**Легенда статусов:** ✅ готово+проверено · 🟡 частично · ⬜ не начато · ⚠️ не проверено вживую · 🔒 заблокировано зависимостью.

---

## Фаза 0 — Безопасность ✅ (ветка `phase-0-security`)

Полностью реализована и проверена (typecheck + 108 тестов на момент фазы + сборка). Остаток только в приёмке на железе:

- ⚠️ **Прогнать эталонный сценарий на живом Docker** и подтвердить, что `--cap-drop ALL` + лимиты не ломают Chromium; при необходимости включить `APP_DOCKER_NO_NEW_PRIVILEGES` только с `--no-sandbox`. (Риск из P0-T01.)
- 📝 **Решение владельца (открытый вопрос №19):** санитизировать ли закоммиченные сид-файлы `storage/accounts.json`/`merchants.json` (там демо/реальные секреты). Я их не трогал.

---

## Фаза 1 — Развёртывание на Ubuntu 🟡 (ветка `phase-1-deploy`)

Артефакты написаны (`deploy/ubuntu/*`, non-root `Dockerfile`), проверены `bash -n` и YAML-валидатором. **Вся приёмка на живом Ubuntu-ПК — не выполнена** (нет хоста/Docker в среде разработки). Нужно прогнать чек-лист P1-T20 из `deploy/ubuntu/RUNBOOK.md`:

- ⚠️ Достижимость стендов из контейнера (`01-preflight-reachability.sh`).
- ⚠️ Rootless Docker + доступ сервера к сокету (контейнер `user: "0:0"` под userns).
- ⚠️ TLS (Let's Encrypt для домена / `tls internal` для IP).
- ⚠️ systemd-автозапуск после reboot, бэкап-таймер, ufw.
- ⚠️ Сквозной прогон сценария на развёрнутом сервере.
- ⬜ (опц.) docker-socket-proxy как переходный вариант 2B, если rootless недоступен (P1-T07).

---

## Фаза 2 — Аккаунты / данные / мультипроект 🟡 (ветка `phase-2-data`)

### Готово (8 микрошагов, 134 теста)

- ✅ Шифрование секретов (envelope AES-256-GCM + KEK, ротация по `key_id`).
- ✅ Хеширование паролей (scrypt).
- ✅ `AuthStore`: пользователи + сессии, первый пользователь = admin.
- ✅ Auth-маршруты + RBAC + session-cookie (register/login/logout/me/users).
- ✅ Шифрование секретов стендов at rest (opt-in `APP_KEK`, обратная совместимость).
- ✅ Аудит-лог + admin-чтение.
- ✅ PAT-токены + Bearer-аутентификация (для агента).
- ✅ Project-scoped `server_*` + резолв-fallback (мультипроект).

### Осталось в Фазе 2

| # | Пункт | Почему не сделано / риск | Зависимость |
|---|---|---|---|
| 2-R1 | ✅ **SQLite-бэкенд** вместо JSON (репозитории, WAL, транзакции) (P2-2.1) | Встроенный `node:sqlite` (Node ≥22, без нативной зависимости). `SqliteStateStore` реализует общий интерфейс `StateStore` (как JSON-стор): таблица-на-сущность (PK + JSON `data`), WAL, транзакции; сценарии гидрируются с диска (пакеты остаются файлами). **Opt-in `APP_STATE_BACKEND=sqlite`**, JSON — дефолт, переключение обратимо. Проверено: 173 API-теста проходят под SQLite + выделенные `sqlite-store`/`sqlite-migrate`. (17 JSON-фикстурных тестов читают `app-state.json` напрямую — специфичны для JSON.) | — |
| 2-R2 | ✅ **Миграция JSON→БД** (dry-run/verify, сохранность данных) (P2-2.5) | `migrateStateToSqlite(state, db, {dryRun})` + `verifySqliteMatchesState` (lossless) + CLI `pnpm db:migrate-sqlite`. Проверено на реальном storage (**614 строк, verify: OK**). ✅ **Авто-cutover:** при первом старте с `APP_STATE_BACKEND=sqlite` существующее JSON-состояние импортируется автоматически; JSON-файлы не трогаются → откат = убрать флаг. | 2-R1 |
| 2-R3 | 🟡 **Персистентная очередь `run_queue` + воркеры** (P2-2.9) | ✅ Crash-recovery сделана (`reconcileOrphanedRuns` на старте → orphan-прогоны = `interrupted`, тест `server-run-recovery`). Остаётся полноценная очередь с воркерами и реконструкцией плана (`otp_secrets` не персистятся — авто-resume небезопасен; сейчас interrupt+Retry). | связано с Ф3 |
| 2-R4 | 🟡 **ULID-идентификаторы сценариев** + примирение discovery (P2-2.6, research 6.6.3) | ✅ Безопасно: новые сценарии получают ULID-id (`generateUlid`/`isUlid` в shared, без зависимостей, сортируемые); якорь `scenario_ulid` пишется в `metadata.json` пакета при загрузке; re-upload примиряется по якорю (тот же id + storage-dir даже при смене папки). Существующие UUID-id **не трогаются** — ссылки целы. Тесты `ulid` (формат/сортировка/валидация) + upload не сломан. Остаётся: разовая перегенерация старых id (решение владельца) + round-trip якоря через агента. | — |
| 2-R5 | ✅ **Глобальный RBAC на ВСЕХ маршрутах** + удаление фейкового `cabinet_user` (P2-2.4) | Сделано в Ф3 (L1–L3, микрошаги 3.15–3.17): login-экран в SPA готов, RBAC secure-by-default, `cabinet_user` и `html.ts` удалены. | — |
| 2-R6 | ✅ **Login MFA** (2FA для входа в инструмент: TOTP-enroll, confirm, recovery-коды) (P2-2.3, spec 8.4) | Сделано: shared (`generateTotpSecret`/`verifyTotpCode`/`buildOtpAuthUri`), AuthStore (enroll/confirm/disable/verify, in-memory MFA-челлендж, recovery-коды хешируются), роуты `/api/auth/mfa/{enroll,confirm,disable}` + `/api/auth/login/mfa` (двухшаговый вход), UI (шаг кода в Login + MfaPanel на экране Tokens). Тест `server-mfa` (5 кейсов: enroll/confirm, TOTP-вход, recovery, disable). ✅ `mfa_secret` шифруется at rest под KEK (2-R8), при выключенном KEK — plaintext (обратная совместимость). | — |
| 2-R7 | **Run-снапшот без plaintext-секрета** (`stand_credential_id` + `credential_version`) (P2-2.M6) | Сейчас run хранит расшифрованный секрет в снапшоте (как и раньше). | 2-R1 желательно |
| 2-R8 | 🟡 **KEK lifecycle (эксплуатация):** фоновый `rekey`, `needs_reentry` при потере KEK, утилита генерации KEK (spec 8.6) | ✅ Утилита генерации KEK (`pnpm kek:generate`). ✅ `mfa_secret` шифруется at rest (тот же KEK); при потере KEK `openMfaSecret`→"" (вход-MFA не падает, а корректно отклоняется = needs_reentry). ✅ Reseal-миграция plaintext→encrypted (`resealAppStateSecrets` + `AuthStore.resealMfaSecrets` + `pnpm secrets:reseal`), идемпотентная (`needsReseal` шифрует только plaintext). Тесты `server-kek-reseal`. Остаётся: кросс-ключевая ротация (нужны оба ключа одновременно) как отдельная процедура. | — |
| 2-R9 | 🟡 **Project-scope для accounts/merchants/pools** (добавить `project_id`, `UNIQUE(project_id,…)`) + миграция глобальных данных в `project_default` (P2-2.M2/2.M5) | ✅ Бэкенд: `project_id` (nullable, null=global) в `AccountSchema`/`MerchantSchema` (у pools уже был); резолв `pickProjectScoped` — приоритет project-match, fallback на global; CRUD accounts/merchants принимают `project_id`, уникальность по `(project_id, login/name)`, list-фильтр `?project_id`. Обратная совместимость: старые записи = global. ✅ UI: селектор Scope (Global/проект) + бейдж scope на экранах Credentials и Merchants; scoped delete (`DELETE ?project_id`). Тесты `folder-run-planner` (scoped+fallback) + `server-account-scope` (create/list/filter/delete). ✅ UI project-scope на всех трёх экранах: Credentials, Merchants, Pools. | — |
| 2-R10 | ✅ **Подстановка произвольных `extra` server_\*** токенов в рантайме | Сделано: `resolveSelectedBaseData` пробрасывает project-scoped `extra` в `SelectedBaseData`, `resolveServerValueTemplate` подставляет `{key}` для каждого объявленного extra-ключа (коллизии с 4 стандартными именами отбрасываются, неизвестные `{…}` не трогаются, пустое значение → ошибка). UI: редактор key/value в `ProjectServerVarsPanel`. Тесты в `folder-run-planner` (3 кейса). | — |
| 2-R11 | 🟡 **Поля прогона `phase/outcome/phase_timings`, агрегат `batches`, `effects_applied`** (P2-2.M8) | `phase/outcome/phase_timings` — ✅ сделаны (Ф3, питают Timeline+SSE). ✅ `batches`-агрегат: модуль `batches.ts` (`summarizeBatch`/`summarizeBatches`, чистый над `AppState`) + эндпоинты `GET /api/batches[/:id]` (статус `running/passed/failed/partial`, counts/outcomes/stages/прогресс); тесты `batches` (5) + API-тест в `server-folder-runs`. Остаётся `effects_applied` (идемпотентность эффектов). | связано с Ф3 |
| 2-R12 | **E2E-тест резолва project-vars** в реальном прогоне | Код типизирован и подключён, но отдельного e2e-теста нет. | — |

---

## Фаза 3 — Новый UI (SPA), real-time, очередь 🟡 (ветка `phase-3-ui`)

Самый большой блок (~88 чел.-дн). Эталон — `docs/ui-detailed-design.md` (экраны+стек) и `ui-redesign-spec.md` (real-time, флоу). Стек по факту: React 18 + TS + Vite, React Router 6, TanStack Query 5, нативный `EventSource` (SSE), своя дизайн-система на CSS-токенах (`packages/ui`). Отложено относительно эталона: Radix/Lucide/Recharts/RHF, i18n-словарь — пока не подключены.

### Готово в Фазе 3 (микрошаги 3.1–3.12, 145 тестов)
- ✅ **Каркас фронта:** `packages/ui` (токены + Button/StatusBadge), `apps/web` (Vite+Router+Query), типизированный API-клиент (`api.ts`, cookie-auth), AuthProvider, переиспользование Zod-типов из shared, тёмная/светлая токены.
- ✅ **Раздача SPA из Fastify** под `/app/` (scoped @fastify/static, SPA-fallback, пропуск если бандл не собран) — X-T04 (тест `server-spa-serving`).
- ✅ **Бэкенд real-time:** поля прогона `phase`/`outcome`/`phase_timings` (= 2-R11, частично), `recordRunPhase`/`applyPhaseTransition`, эмиттер `runEvents`, **SSE `/api/runs/:id/stream`** (snapshot + run.phase/log/status) — P3-3.M3 (тесты `shared-run-phase`, `server-run-sse`).
- ✅ **Экраны:** Login/Register; Projects; ProjectDetail (сценарии + ▶Run + **Configure… (RunWizard)**); **Прогон LIVE** (Timeline по фазам, live-консоль по SSE, **↻Retry**, **■Stop**); Runs (список с авто-refetch); Credentials (write-only + 2FA + тест-код); **Environments + кнопка «Проверить доступность»**; **матрица project `server_*`**; Merchants; **Pools/Items**; PAT-токены (для агента); admin Users; admin Audit.
- ✅ **Run-wizard `<RunConfig>`** (3.21): ввод declared inputs сценария (маркер 🔐 2FA) + выбор env/account/merchant + run count → `POST /api/scenarios/:id/run`; переход на прогон или список (батч).
- ✅ **Мульти-запуск из проекта** (`BatchRunWizard`): чекбоксы на сценариях + «выбрать папку» + панель «Run selected (N)…» → выбор account/merchant + shared inputs (с подсказками имён) + run count → `POST /api/projects/:id/folder-runs` (folder_paths `[""]` + scenario_ids + scenario_execution) → переход на экран батча. Тест `server-folder-runs` (project-wide selection + per-scenario count).
- ✅ **Панель настроек запуска в RunLive** (`RunSettings`): env/аккаунт/мерчант/server_username/server_merchant, итерация/стадия/таймаут, кто/когда запустил, ссылки на batch и retry-of, таблица inputs. Секреты (`server_password`/`server_2faotp`) — только бейдж set/unset (снапшот хранит plaintext, 2-R7 не закрыт).
- ✅ **Панель «Проверить доступность стенда»:** `POST /api/environments/:id/reachability` (probe c таймаутом, relaxed TLS) + UI-бейдж reachable/latency/status (3.11; тест `server-reachability`).
- ✅ Маскировка `GET /api/accounts` и project-`server_*` (write-only по API, не только в HTML).

### Осталось в Фазе 3
- 🟡 **i18n RU/EN** — инфраструктура `t()` + переключатель готовы (3.23); ✅ навигация, дашборд и заголовки всех экранов переведены через `page.*` ключи. ✅ **Каталог серверных кодов ошибок** (P3-3.M8): `sendError` отдаёт `{error, code}`; клиент (`ApiError.code` + `localizeError`) мапит `err.<code>`→локализованное сообщение (RU/EN) с fallback на текст сервера; тосты локализуются автоматически. Коды на *.not_found (project/scenario/run/account/merchant/batch/pool) + auth/MFA. Тест `server-error-codes`. ✅ Подписи форм/кнопок: общие ключи `action.*`/`form.*` (RU/EN) применены в cabinet-экранах (Credentials/Merchants/Pools). Остальные экраны — по тому же паттерну `t()` (английский fallback).
- 🟡 **Каталог компонентов** до эталона. ✅ Toast (провайдер + `useToast`, заменил все 15 `alert()` в SPA — неблокирующие, копируемые, авто-dismiss), ✅ HealthIndicator (live storage/Docker readiness в шапке), ✅ ConfirmDialog (promise-based `useConfirm`, подключён ко всем деструктивным действиям: удаление учётки/мерчанта/пула/item/токена, Clear all server-vars). ✅ SecretField (`packages/ui`, show/hide для секретов; применён в Credentials + ProjectServerVarsPanel), ✅ Spinner/EmptyState/ErrorState (`packages/ui`, применены в Projects/Runs). ✅ PhaseTimeline (вынесен из RunLive в компонент), ✅ NotificationCenter (колокольчик в шапке + история уведомлений из Toast). ✅ ProjectSwitcher (селектор проекта в шапке). ✅ Tabs (`packages/ui`, применён в ProjectDetail: Scenarios/Settings). ✅ Универсальный **Table** (колонки + опциональный bulk-выбор чекбоксами) в `packages/ui`, применён в Audit и Users. Каталог компонентов эталона закрыт.
- ⬜ **Персистентная очередь `run_queue`/`workers`** (= 2-R3) — несущая для Execution-виджета/ETA.
- 🟡 **Доп. SSE-потоки:** ✅ `/api/stream/execution` (глобальный live-фид статусов: snapshot активных прогонов + `execution.run`/`execution.active` дельты) — питает счётчик running в шапке; ✅ общий хелпер `startSseChannel` (hijack/headers + heartbeat 15s + **бэкпрешер**: дроп медленного потребителя при буфере >1 МиБ) переиспользован обоими стримами; авторизация — глобальный `/api`-RBAC (cookie для браузерного EventSource, PAT/x-api-key для машин). ✅ `/api/stream/health` (snapshot готовности storage+Docker на коннект + каждые 10s) → питает HealthIndicator в шапке. ✅ `/api/batches/:id/stream` (live-стрим батча: `batch.snapshot` агрегат на коннект + `batch.run`/`batch.aggregate` дельты; новые члены из retry-failed/complete подхватываются лениво). Тесты `server-run-sse` (execution-фид + health + batch snapshot/дельта). Остаётся: per-project scope-гард (заблокирован 2-R9 — нет модели project-membership).
- ✅ **Stop-механика** (3.19 / 3.M9): детерминированное имя контейнера (`tsp_run_<id>`) + реестр `activeRuns` + `docker kill` + `POST /api/runs/:id/stop` + кнопка Stop в RunLive; финализация как `outcome=stopped`. Тест `server-run-stop`. ⚠️ реальный kill живого контейнера не гонялся (нужен daemon).
- ✅ Аутентификация-онбординг: **MFA-шаг входа**, enroll 2FA, recovery-коды (= 2-R6 готов; см. таблицу Фазы 2). Остаётся отдельный экран профиля (сейчас MFA-панель на экране Tokens).
- 🟡 Двухуровневая навигация + **project switcher** + 5 механизмов изоляции (P3-3.M1). ✅ Project switcher в шапке (быстрый переход между проектами). Остаётся: полноценная двухуровневая навигация и механизмы изоляции (зависят от project-scope 2-R9).
- ✅ **Дашборд** (3.22): stat-карточки (проекты/активные/passed/failed по `/api/runs` с refetch), быстрые ссылки, недавние сбои; стал лендингом. Остаётся Health-виджет/фильтры/bulk.
- ✅ **i18n RU/EN** (3.23): `t()` + плоский словарь + переключатель EN/RU (localStorage); применён к навигации/шапке и дашборду. Остальные экраны — по тому же паттерну `t()` (английский fallback).
- 🟡 Дерево сценариев + просмотр кода; список прогонов с фильтрами/bulk. ✅ Список прогонов: фильтр по статусу (чипы с счётчиками) + текстовый поиск по сценарию/id + ссылка на батч из строки прогона + ✅ bulk-выбор (чекбоксы) и «Stop selected» (останавливает активных выбранных). ✅ **Дерево сценариев** (ProjectDetail группирует по `folder_path`) + ✅ **просмотр кода** (`GET /api/scenarios/:id/code` читает `scenario.spec.ts` из zip + модалка ScenarioCodeModal; тест в `server-folder-runs`). ✅ Сворачивание папок + вкладки Scenarios/Settings в ProjectDetail. ✅ Подсветка синтаксиса в просмотре кода (`highlightTs` — регексный TS-хайлайтер без зависимостей, HTML-экранизация; тест `highlight-ts`). CodeMirror-редактор — при необходимости позже.
- 🟡 Run-wizard: ✅ предпросмотр итоговой подстановки `server_*` — `POST /api/scenarios/:id/run/preview` (`previewServerBindings`: резолвит username/merchant/extra, секреты маскирует set/unset) + live-панель «Resolved server vars» в RunWizard. Тесты в `folder-run-planner` (2 кейса). Остаётся: pool_selections UI в визарде.
- 🟡 **Экран батча** (стадии, частичные сбои, Retry failed, Stop remaining, «Дозавершить»). ✅ Экран `/batches` (список с агрегат-статусом + прогрессом, авто-refetch) и `/batches/:id` (шапка-агрегат + список прогонов-членов со ссылками на live-страницу). ✅ Bulk-действия: `POST /api/batches/:id/stop` (останавливает активных членов) и `POST /api/batches/:id/retry-failed` (повторяет failed/error в тот же batch, пропуская stopped) + кнопки Stop remaining / Retry failed; общий хелпер `stopRunInternal` (одиночный stop отрефакторен на него); аудит `batch.stop`/`batch.retry_failed`; тест `server-batch-actions` (4). ✅ «Дозавершить»: `POST /api/batches/:id/complete` (для каждого сценария добирает прогоны до target=amount_times_to_run по числу passed; клонирует последнего члена; no-op если хватает) + кнопка Complete; общий хелпер `buildBatchMemberPlan` (retry-failed переведён на него); аудит `batch.complete`; тесты в `server-batch-actions` (top-up + no-op). **Экран батча закрыт.**
- ✅ NotificationCenter / счётчик running в шапке. ✅ Live-счётчик активных прогонов (`useExecutionStream` над `/api/stream/execution`, бейдж со ссылкой на `/runs`). ✅ NotificationCenter (колокольчик + история последних уведомлений, общая с Toast).
- ⬜ Завершаемость флоу: `effects_applied`, batch-aware recover, resume записи.

### Перевод и зачистка ✅ (выполнено владельцем-подтверждённо, микрошаги 3.15–3.17)
- ✅ **Удаление `html.ts`** (4031 стр.) и всех HTML-роутов (`/`, `/runs`, `/cabinet*`, `/projects/:id`, `/scenarios/:id[/code]`, HTML `/runs/:id`); `GET /` → редирект на `/app/`. HTML-тесты удалены/перенесены на `/api/`. (L1 / 3.15)
- ✅ **Удаление `cabinet_user`** из схемы и стора (миграция автоматическая — zod стрипает ключ). (L2 / 3.16)
- ✅ **Глобальный RBAC** на всех `/api/*` (кроме login/register): cookie/PAT/x-api-key, secure-by-default `APP_REQUIRE_AUTH`. Тест `server-rbac`. (L3 / 3.17)
- ⬜ Остаток: legacy-редиректы для старых внешних ссылок (опц.), переименование теста `server-runtime-cabinet` → `server-runtime-api` (косметика).

---

## Фаза 4 — Упрощение Электрон-агента ⬜ (ветка `phase-4-agent`, не начата)

Эталон — `ui-detailed-design.md` §8, `ui-deploy-research.md` §5. Зависит от Фазы 2 (токены/owner_id — уже есть PAT) и Фазы 3 (общий API-клиент/дизайн-система).

### Готово (ветка `phase-4-agent`)
- ✅ **Вход агента по PAT** (4.1): `safeStorage`-шифрование токена в userData, `authHeaders()` Bearer>API-key, IPC get-auth-header/set-token/get-auth-status, sign-in бар в UI; токен не попадает в renderer.
- ✅ **`owner_id` на сценарии** (4.2): авторизованный upload проставляет `created_by = uploader.login` (server-attested) + аудит `scenario.upload`. Тест `server-scenario-owner`.
- ✅ **Копируемые тосты** (4.3) вместо 24× `alert()`.
- ✅ **Read-only Accounts/Merchants** (4.4): убран write-CRUD из агента (управление — в SPA); `resolveDefaultOtpAccountLogin` чинит `has_totp`.
- ✅ **Push-статусы** (4.5): `emitRuntime()`→`webContents.send` на всех переходах; renderer подписан, опрос 1s→8s safety-net.

### Осталось в Фазе 4 (renderer — не тестируется в этой среде; либо заблокировано)
- ⬜ Свести 3 механизма вставки в 1 (контекст-меню). (renderer, низкий приоритет)
- ⬜ Конвейер `Record → Replay → Review&Upload` + экран **Review&Upload** (diff, metadata, фильтр inputs, предупреждение про `auth_state.json`). Крупный renderer-рефактор, не верифицируется без Electron.
- 🔒 `scenario_ulid` как ключ upsert + **resume** — зависит от 2-R4 (ULID ломает ссылки, **решение владельца**).
- ⬜ CodeMirror вместо `<textarea>` (новая зависимость, renderer); сузить CSP `connect-src` (сейчас `*`, нужно для произвольного `server_url`).
- ⬜ Настройки агента (server_url/язык/locale) в UI вместо `config.json`.
- 🚧 **Упаковка/дистрибуция** (electron-builder + подпись) — требует платформенного тулинга/сертификатов, **невозможно собрать/проверить в этой среде**.

---

## Сквозные практики ⬜ (не начаты)

- ⬜ **Структура монорепо** под новый UI (`apps/web`, `packages/ui`, project-refs, build-скрипты) (X-T01..T05).
- ⬜ **Тест-уровни:** компонентные (Testing Library), MSW (мок API/SSE), e2e (Playwright на самом продукте), контракт Zod сервер↔клиент; гейт «green-before-merge».
- ⬜ **CI/CD:** расширить `.gitlab-ci.yml` (lint/typecheck/test/build:web/build:server, кеш pnpm, публикация образов server+runner, SSH-деплой), матрица стадий (X-T13..T18).
- ⬜ **Миграция данных** (единый план JSON→SQLite, dry-run+rollback) (= 2-R2).
- ⬜ **Rollout/feature-flags** (параллельная жизнь `html.ts`↔SPA, периметр-защита до auth).
- ⬜ **Наблюдаемость/эксплуатация:** структурные логи, метрики очереди/воркеров/диска, NTP-алерт (скрипт есть — Ф1), ретеншн прогонов/артефактов, бэкап БД+KEK **раздельно**.
- ⬜ Шаблон **Definition of Done** + порядок веток/ревью.

---

## Долг по верификации (что НЕ проверено вживую)

Сводно — то, что написано/типизировано, но не подтверждено реальным прогоном:

1. **Фаза 1 целиком** на живом Ubuntu (rootless-сокет, TLS, systemd, сквозной прогон) — чек-лист P1-T20.
2. **Лимиты раннера vs Chromium** (cap-drop / no-new-privileges) на живом Docker — Фаза 0.
3. **Резолв project-scoped `server_*`** в реальном прогоне (есть код+типы, нет e2e-теста) — 2-R12.
4. **Прогон с зашифрованным секретом** (KEK включён) до контейнера на живом Docker.
5. **SPA Фазы 3 не гонялась в браузере:** все экраны типизируются (`tsc --noEmit`) и собираются (`vite build`), бэкенд-эндпоинты под ними покрыты серверными тестами (`app.inject` + реальный listen для SSE), но кликов в реальном браузере против живого сервера+Docker не было. Нет компонентных/MSW/Playwright-e2e тестов фронта.
6. **Reachability-probe** проверен юнит-тестом (локальный сервер + закрытый порт), но не против реального стенда с self-signed TLS.

> Принцип: каждый микрошаг помечается verified (юнит/интеграция) и явно — что осталось проверить руками.

---

## Рекомендованный порядок добивки

Вертикальными срезами, тонкий путь первым (вехи M1–M5 из `implementation-plan.md` §8):

1. **Закрыть инфра-Фазу 2, питающую Фазу 3:** `run_queue`/воркеры (2-R3/2-R11) + Stop-механика → затем SSE.
2. **Каркас фронта** (`packages/ui` + `apps/web` + SSE-обёртка) — можно параллельно п.1 (разные роли).
3. **Тонкий срез M3:** один проект → запуск → LIVE-статус (Timeline+консоль) → Stop. Тут же логин-экран → **глобальный RBAC** (2-R5) → удаление `cabinet_user`.
4. **Расширение вширь:** мультипроект-экраны, кабинет, доступность стенда, батчи (M4).
5. **SQLite + миграция** (2-R1/2-R2), ULID (2-R4), run-snapshot без plaintext (2-R7), Login MFA (2-R6).
6. **Фаза 4 (агент)** параллельно хвосту Фазы 3; удаление `html.ts` — последним.
7. **Сквозные практики** (CI-гейт, ретеншн, бэкапы) → GA (M5).

---

## Открытые вопросы владельцу (нужны решения)

- №19: санитизировать ли закоммиченные `storage/*.json` (демо/реальные секреты)?
- SQLite сейчас или позже? (Я отложил ради зелёной сборки; готов внедрить, когда подтвердите готовность тянуть нативную/`node:sqlite` зависимость.)
- Нужна ли **командная** изоляция (`Account`→несколько `User`), или достаточно ролей в одном аккаунте на старте?
- Нужна ли **Login MFA** (2FA для входа в сам инструмент) в ближайшем срезе?
- Где хранить **мастер-ключ (KEK)** в проде: файл / Docker secret / внешний KMS?
- Допустима ли разовая **перегенерация id сценариев** в ULID с якорем (ломает старые ссылки, нужен механизм примирения)?
- Язык интерфейса по умолчанию (RU/EN) и набор ролей (admin/operator/viewer — ок?).
