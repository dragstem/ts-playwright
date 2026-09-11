# UI/UX-СПЕЦИФИКАЦИЯ нового интерфейса ts-playwright

> Рабочий документ для реализации. Дополняет `docs/ui-deploy-research.md` (базовое исследование) и углубляет UI, мультипроектность и 2FA. Где база и треки расходятся, расхождение разрешено в пользу требований владельца и зафиксировано явно. Все факты привязаны к коду (`file:line`).
>
> **Главное разрешённое противоречие (раз и навсегда для всего документа):** базовое исследование изолирует данные по **команде** (`team_id`, research 6.4). Владелец требует изоляцию по **проекту** внутри аккаунта. Принятая модель — **двухуровневая**: `Account` (владение/биллинг, бывш. `team`) → `Project` (рабочая изоляция данных стендов). `server_*`, credentials, merchants, pools, environments живут на уровне **проекта**. Команда/аккаунт остаётся **над** проектом только для доступа пользователей. Это единственное системное расширение модели данных базы, и оно сквозное.

---

## 1. Принципы UI

Три столпа владельца — это не лозунги, а проверяемые инварианты, против которых принимается каждое решение ниже.

**Столп 1 — Real-time прозрачность.** Пользователь видит ВСЕ статусы в реальном времени, без поллинга и без `location.reload()`. Сегодня страница прогона делает `setInterval(refreshRun, 2000)` + 3 запроса каждые 2с + `location.reload()` на терминальном статусе (`html.ts:3597,3615-3627`), что сбрасывает скролл и раскрытые блоки. Заменяется на SSE-стримы (`run.phase`/`run.log`/`run.status`) и точечный патч DOM. Прогресс выражается **типизированной осью `phase`** (7 под-фаз), а не парсингом последней лог-строки (`describeRunProgress`, `html.ts:3527-3540`). Очередь, стадии, pull образа, дрейф NTP, достижимость стенда — всё видимо.

**Столп 2 — Завершаемость + повторяемость.** ЛЮБОЙ флоу можно завершить (явное терминальное состояние) и повторить (idempotent/resumable). Точки реализации: `Stop` для run и батча (сегодня отмены нет вообще — `queueMicrotask` не прерывается, `app.ts:1640-1664`, и нет реестра дочерних процессов, §6.7); `Retry`/`Retry failed` идемпотентно через `runtime_snapshot` (trace_id и pool-значения не регенерируются, `run-planner.ts:306`); восстановление после прерывания (`recoverInterruptedRuns`, `app.ts:1591-1638`) с честным состоянием `error · interrupted` и кнопкой «Дозавершить».

**Столп 3 — Ненагруженность.** Чистый, плотный дизайн без визуального шума. Один primary-CTA на экран + overflow `⋯`; три Run-кнопки → один `▶ Run` со scope из крошек/чекбоксов; полотно run-формы (десятки полей, `html.ts:1175-1462`) → 3-шаговый wizard с `Advanced`; постоянный левый рельс вместо тулбара на каждой странице.

**+ RU/ENG.** Лёгкий переключатель `🌐 RU/EN` без i18n-движка: плоский словарь `{ru,en}` + хук `t(key)`, тексты не хардкодятся (убираем смесь `Projects`/`Личный кабинет`, `html.ts:144,149`). Переводятся не только JSX-литералы, но и **серверные сообщения об ошибках** через каталог кодов (§3.3).

**+ Мультипроект-first.** Проект — первая ось навигации и первичная граница изоляции данных, а не атрибут. `server_*` каждого проекта изолированы (сегодня резолвятся глобально, `run-planner.ts:996,999,1002`).

**+ 2FA-first.** Два слоя 2FA сохранены и усилены: (a) TOTP тестируемых стендов — ядро бизнес-логики, project-scoped; (b) опциональная 2FA входа в инструмент — account-scoped. Разведены терминологически и по навигации, чтобы их нельзя было перепутать.

---

## 2. Мультипроектность

### 2.1 Модель: account → проекты

```
User (self-register, Argon2id) ──< Membership >── Account (владелец/биллинг-граница)
                                        │              │
                                        │              └──1──< Project ───────────────┐
                                        │                         │ (всё ниже scoped по project_id)
                                        └── роль account-wide /    ├──1──< Environment (уже scoped)
                                            project-level          ├──1──< StandCredential (бывш. account)
                                                                  ├──1──< Merchant ──> admin_credential_id (того же project)
                                                                  ├──1──< Pool ──1──< PoolItem
                                                                  ├──1──1  ProjectServerVars (дефолты + произвольные server_*)
                                                                  └──1──< Scenario(ULID) ──1──< Run ──> stand_credential_id
```

### 2.2 Что project-scoped, что глобальное

Граница в одной фразе: **если данные подставляются в `{...}`-плейсхолдер сценария — они project-scoped; если они про доступ к самому инструменту — account-scoped.**

| Сущность | Scope | Состояние в коде сегодня | Что меняем |
|---|---|---|---|
| User, sessions, refresh_tokens | глобальный | `cabinet_user` фейковый (`store.ts:285-296`) | → `User` Argon2id, серверные сессии |
| Account (бывш. team) | глобальный (верх) | нет | новая граница владения |
| Membership | связка User↔Account/Project | только `team_memberships` (research) | двухуровневая (account-wide / project-level); частичный уникальный индекс (§2.6) |
| **StandCredential** (`{server_username/password/2faotp}`) | **project-scoped** | глобальный `state.accounts`, нет `project_id` (`schemas.ts:77-83`) | **+`project_id`**, `UNIQUE(project_id, login)` |
| **Merchant** (`{server_merchant}`) | **project-scoped** | глобальный, нет `project_id` (`schemas.ts:85-91`); у всех `admin_login=null` (`storage/merchants.json`) | **+`project_id`**, `admin_credential_id` того же проекта (проставляется вручную, §9.3) |
| **Pool / PoolItem** | **project-scoped** | `project_id` nullable, `null`=все проекты (`schemas.ts:116`) | **`project_id` → NOT NULL** |
| Environment (`base_url`) | **project-scoped** | уже `project_id` (`schemas.ts:69-75`) — единственная корректная | сохраняем |
| **ProjectServerVars** | **project-scoped (1:1)** | нет | новая: дефолты + произвольные `server_*` |
| Scenario | project-scoped (через `metadata.project_id`) | `project_id` есть (`schemas.ts:39`) | + стабильный `scenario_ulid` |
| Run | project-scoped (унаследован) | хранит plaintext `server_password/2faotp` (`schemas.ts:185-188`) | → `stand_credential_id` + `credential_version`; инвариант синхронизации `runs.project_id` (§2.6) |
| audit_log | одна таблица с `account_id`+`project_id` | — | фильтрация по проекту |

**Ключевой сдвиг относительно research:** разделы Credentials/Merchants/Pools, которые в research 4.2 живут в **глобальном** рельсе, переезжают **внутрь проекта** (`/p/:pid/*`). Глобальными остаются только люди, система и аудит.

### 2.3 Переключатель проектов (project switcher)

Постоянный контекст в левом верхнем углу рельса, всегда виден на каждом project-scoped экране — главная защита от «в каком я проекте?».

```
[ Проект: Payments ▾ ]
   ├─ 🔍 [ поиск проекта…            ]
   ├─ ● Payments        ▶2 running   ✓ (активный, accent-цвет проекта)
   ├─   KYC             idle
   ├─ ⚠ Withdrawals     ▶1  🔔        (есть падения)
   ├─────────────────────────────
   ├─ + Новый проект…
   └─ ↪ Все проекты (/projects)
```

**Хранение выбора (URL первичен):**
1. **URL — источник истины.** `projectId` в пути (`/p/:pid/...`). Ссылкой делишься — собеседник в том же проекте.
2. **Cookie `last_project`** (per-user, server-side, рядом с сессией) — для редиректа с голого `/`. Заменяет небезопасную cookie `cabinet_user` (`app.ts:1278-1305`).
3. **Переключение = смена URL** с сохранением подраздела: `/p/A/runs` → переключение на B → `/p/B/runs`, не сброс на обзор.

### 2.4 Пять механизмов изоляции от путаницы

1. **Цветовой токен проекта** — `hash(projectId) → палитра`, полоска слева от switcher + акцент шапки.
2. **Имя проекта в каждой крошке** — `Payments ▸ Scenarios ▸ payouts` (расширяет `renderFolderBreadcrumbs`, `html.ts:4197`).
3. **Бейдж проекта на опасных/запускающих действиях** — `▶ Run · Payments`; «Удалить пул в проекте **Payments**?».
4. **Заголовок вкладки браузера** — `Payments · Runs — ts-playwright` (вместо голого `title`, `html.ts:4187`).
5. **Баннер при cross-project переходе по ссылке** — «Вы в проекте Withdrawals (перешли по ссылке)».

### 2.5 Резолв project-scoped `server_*`

Главная утечка сегодня: `resolveSelectedBaseData` ищет credential/merchant в **глобальном** `state.accounts/state.merchants` без scope (`run-planner.ts:995-1004`):

```ts
// run-planner.ts:995-1004 — НЕТ фильтра по проекту:
const account = state.accounts.find((item) => item.login === normalizedAccountLogin) ?? null;
const merchant = state.merchants.find((item) => item.name === normalizedMerchantName) ?? null;
```

После правки функция принимает `projectId` и фильтрует `WHERE project_id = ?` (детали и пример резолва — §9.2). Изоляция автоматическая: credential принадлежит проекту, run принадлежит проекту — межпроектная утечка секрета невозможна на уровне выборки.

### 2.6 Два инварианта изоляции, которые нельзя оставить «по умолчанию»

Денормализация и поведение `NULL` в SQLite создают тихие дыры, если их не закрыть явно. Оба фиксируются на уровне схемы и кода, а не на уровне «договорённости».

**(а) Инвариант `runs.project_id == scenario.project_id`.** `RunSchema` (`schemas.ts`) не несёт `project_id` — он выводится через сценарий. DDL (§9.1) добавляет `runs.project_id` как денормализацию ради быстрого scope-гарда и индексов. Чтобы денормализация не разошлась:
- `runs.project_id` **проставляется один раз при планировании** из `scenario.project_id` и далее **иммутабелен** (триггер `BEFORE UPDATE` запрещает менять).
- Перемещение сценария между проектами (`Move`) **разрешено только при отсутствии незавершённых runs** (`queued/running`); исторические runs сохраняют исходный `project_id` (они принадлежат проекту, в котором были запущены). UI на `Move` показывает: «N исторических прогонов останутся в проекте X».
- Гард `/p/:pid/runs/:rid` проверяет именно `runs.project_id == :pid` (а не пере-резолвит через сценарий), иначе после `Move` старый run «перепрыгнул» бы проект.

**(б) Баг `UNIQUE`-с-`NULL` в `memberships`.** Ограничение `UNIQUE(user_id, account_id, project_id)` в SQLite **не отклоняет** два account-wide членства для одной пары `(user, account)`, потому что `NULL` не участвует в `UNIQUE`. Это даёт дубль-членство и потенциальный рассинхрон ролей. Решение — **два частичных уникальных индекса** вместо составного `UNIQUE` (§9.1, таблица C):
```sql
CREATE UNIQUE INDEX uq_membership_account_wide ON memberships(user_id, account_id)
  WHERE project_id IS NULL;                 -- максимум одно account-wide членство
CREATE UNIQUE INDEX uq_membership_project ON memberships(user_id, project_id)
  WHERE project_id IS NOT NULL;             -- максимум одно членство на проект
```

---

## 3. Информационная архитектура и карта экранов

### 3.1 Двухуровневая навигация

**УРОВЕНЬ АККАУНТА (глобальное, рельса проекта НЕТ):**

| Раздел | Маршрут | Кто видит |
|---|---|---|
| Мои проекты | `/projects` | все |
| Профиль / Безопасность | `/account/profile` | сам |
| Пользователи и роли | `/account/users` | admin |
| Система | `/account/system` | admin |
| Аудит | `/account/audit` | admin |

**УРОВЕНЬ ПРОЕКТА (`/p/:projectId/*`):**

| Раздел | Маршрут | Что изолировано |
|---|---|---|
| Обзор | `/p/:pid` | прогоны этого проекта |
| Сценарии | `/p/:pid/scenarios` | `scenarios.project_id` |
| Прогоны | `/p/:pid/runs` | runs через сценарий |
| Credentials | `/p/:pid/credentials` | `stand_credentials.project_id` (новый) |
| Merchants | `/p/:pid/merchants` | `merchants.project_id` (новый) |
| Pools | `/p/:pid/pools` | `pools.project_id` (NOT NULL) |
| Окружения • | `/p/:pid/environments` | `environments.project_id` |
| Переменные `server_*` | `/p/:pid/variables` | агрегат credentials+merchants+extra_vars |
| Настройки | `/p/:pid/settings` | `projects` |

• = есть кнопка «Проверить доступность стенда».

### 3.2 Полный sitemap

```
PUBLIC / AUTH
  /login                 вход (Argon2id) — заменяет /cabinet-выбор
  /login/2fa             2FA входа в инструмент (опц., слой «b»)
  /register              САМОРЕГИСТРАЦИЯ (внутренний инструмент — разрешено)
  /logout

ACCOUNT-LEVEL (без :pid — это и есть граница изоляции в URL)
  /                      → redirect на /p/:lastProject или /projects
  /projects              мои проекты
  /account/profile       профиль, смена пароля, 2FA входа
  /account/users         пользователи и роли          (admin)
  /account/system        воркеры/Docker/NTP/image cache (admin)
  /account/audit         аудит-журнал                  (admin)

PROJECT-LEVEL (/p/:projectId/*)
  /p/:pid                          обзор проекта
  /p/:pid/scenarios                дерево папок/сценариев
  /p/:pid/scenarios/:sid           сценарий
  /p/:pid/scenarios/:sid/code      код сценария
  /p/:pid/runs                     журнал прогонов
  /p/:pid/runs/:rid                прогон (live timeline + SSE)
  /p/:pid/batches/:bid             экран батча
  /p/:pid/credentials              учётки → {server_username/password/2faotp}
  /p/:pid/credentials/:cid         учётка + on-demand TOTP-код
  /p/:pid/merchants                мерчанты → {server_merchant}
  /p/:pid/pools                    пулы [+ Bulk import]
  /p/:pid/pools/:poolId            элементы пула
  /p/:pid/environments             окружения + «Проверить доступность»
  /p/:pid/variables                сводка server_* (новый)
  /p/:pid/settings                 настройки проекта, участники, удаление

ПРАВИЛО ГАРДА: каждый /p/:pid/* проходит preHandler:
  (a) проект существует; (b) есть доступ (project-level или account-wide membership);
  иначе 404 (НЕ 403 — не раскрываем существование чужого проекта; НЕ молчаливый редирект).
  Для подчинённых сущностей — проверка entity.project_id == :pid (защита от IDOR).
  ЭТОТ ЖЕ ГАРД ОБЯЗАТЕЛЕН ДЛЯ SSE-СТРИМОВ (§5.4) и POST-команд (stop/retry/reachability).
```

**Маппинг на старые роуты (strangler-миграция):** `/projects/:id` (`app.ts:162`) → `/p/:pid/scenarios`; `/scenarios/:id` (`app.ts:201`) → `/p/:pid/scenarios/:sid`; `/runs/:id` (`app.ts:241`) → `/p/:pid/runs/:rid`; `/cabinet` (`app.ts:116`) **разбирается** на `credentials`/`merchants`/`pools` + `/login`. Глобальный `/runs` (`app.ts:108`) → cross-project журнал только для admin в `/account/`.

### 3.3 Языковой переключатель RU/ENG (лёгкое решение, включая серверные ошибки)

- **Плоский словарь, без i18n-фреймворка.** `locales/ru.ts`, `locales/en.ts` — `Record<string, string>` с ключами `nav.scenarios`, `run.cta`. Никаких `i18next`/ICU/плюрализации.
- **Хук `t(key)`** поверх React Context (~30 строк). Fallback: нет ключа в `ru` → `en` → сам ключ.
- **Переключатель** — в `[user ▾]` (account-уровень) + на Login/Register; выбор → cookie `lang` (server-side) + мгновенный ре-рендер. Сервер читает `lang` для `<title>` и SSR-логина.
- **Литералы в JSX запрещены линт-правилом** (`eslint-plugin-i18next/no-literal-string`).
- **Серверные ошибки — через каталог кодов, не сырой текст.** Сегодня бэкенд формирует сообщения на английском прямо в коде (`run-planner.ts:1062` «Set server username…», `execute.ts:488` «Docker failed to pull…», `otp.ts` «OTP secret must be a valid base32»). Эти строки попадают в те же модалки/тосты, что и переведённый JSX, и без правки дают «русский интерфейс + английская ошибка». Решение:
  - API-ответ об ошибке несёт `{ "code": "server_username_required", "params": {...}, "message_en": "…" }`. `code` стабилен, не локализуется.
  - Клиент мапит `code` → `t("error." + code, params)`; `message_en` — fallback для незакаталогизированных/неизвестных кодов.
  - Каталог `error.*` ведётся в тех же `ru.ts/en.ts`; ~30-40 кодов покрывают валидацию резолва, Docker-инфраструктуру, OTP.
- **НЕ переводим (осознанно):** имена проектов, логины, `{server_*}`-плейсхолдеры, технические идентификаторы (`TOTP`, `trace_id`), **лог-строки контейнера** (это вывод Playwright/раннера, не наш UI — они идут в консоль/Artifacts как есть).
- **Объём:** ~180-240 ключей (включая каталог ошибок), два файла поддерживаются вручную, diff виден в PR.

---

## 4. Дизайн-язык «без шума»

### 4.1 Рельс vs верхнее меню — почему рельс

- **Постоянный левый рельс** несёт project-навигацию + switcher. Вертикальный список ~9 пунктов масштабируется без переполнения.
- **Тонкая верхняя шапка** — switcher слева (в рельсе), крошки по центру, глобальные индикаторы + `[user ▾]` справа. **Никаких страничных тулбаров** (сегодня тулбар 7-8 кнопок на каждой странице, `html.ts:634-2533`).
- **Account-уровень** рендерится **без project-рельса** — отсутствие рельса само сигналит «ты вышел из проекта».

**Project-уровень:**
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright   Payments ▸ Runs                  [▶3 running][🔔1][ru▾][a▾]│
├───────────────┬──────────────────────────────────────────────────────────────┤
│ ┌───────────┐ │                                                                │
│ │▸Payments ▾│ │  ← PROJECT SWITCHER (accent-цвет проекта = полоса слева)        │
│ └───────────┘ │                                                                │
│ ПРОЕКТ         │   ┌─ RUNS · Payments ───────────────────── [▶ Run·Payments]─┐ │
│ ▸ Обзор        │   │ ● withdraw-flow  running 0:42  anna  payouts          → │ │
│   Сценарии     │   │ ✖ deposit·2      failed        12:01 [Trace][Retry]    → │ │
│   Прогоны      │   └──────────────────────────────────────────────────────────┘ │
│ ДАННЫЕ СТЕНДА  │                                                                │
│   Credentials  │                                                                │
│   Merchants    │   (Credentials/Merchants/Pools/Environments — ВСЁ этого        │
│   Pools        │    проекта; server_* изолированы в Payments)                   │
│   Окружения •  │                                                                │
│   Переменные   │                                                                │
│ ──────────     │                                                                │
│   Настройки    │   • = есть «Проверить доступность стенда»                       │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

**Account-уровень (рельса нет):**
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright   Мои проекты                      [▶4 running][🔔2][ru▾][a▾]│
├──────────────────────────────────────────────────────────────────────────────┤
│  🔍 поиск проекта…                                          [ + Новый проект ]  │
│  ● Payments      ▶2  обновлён 3м назад           открыть →                      │
│  ● KYC           ▶0  обновлён вчера               открыть →                      │
│  ⚠ Withdrawals   ▶1 🔔 обновлён 1ч назад          открыть →                      │
│  Аккаунт:  Профиль · Пользователи · Система · Аудит      (без project-рельса)   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Компоненты дизайн-системы

| Компонент | Назначение | Замена сегодняшнего |
|---|---|---|
| **Badge** | статус прогона/credential (`●set`/`○ not set`, `passed`/`failed`/`error`), бейдж проекта | секрет в DOM (`html.ts:459-460`) → write-only бейдж |
| **Card** | проект, виджет Dashboard | плоские ссылки (`html.ts:147-150`) |
| **Table** | списки runs/credentials/pools, bulk-bar по чекбоксам | строка с 5 кнопками (`html.ts:727-731`) |
| **Timeline** | под-фазы прогона с таймингами | `describeRunProgress` (последняя строка лога) |
| **Modal** | создание/редактирование, опасное действие с масштабом | голый `confirm()` |
| **Wizard** | Run-config Scope→Data→Execution | полотно (`html.ts:1175-1462`), дубль (`html.ts:1236` vs `2760`) |
| **AppShell** | рельс + шапка + switcher | `page(title, body)` без рельса (`html.ts:4182`) |

### 4.3 Плотность и прогрессивное раскрытие

- **Одна primary-CTA на экран** + overflow `⋯`.
- **Что прятать:** `parallel batch / stage / amount / timeout` → под `Advanced`; bulk-операции → bulk-bar по чекбоксам; `stdout/stderr/artifacts` → вкладки, не кнопки.
- **Навигационно:** частые разделы (`scenarios`, `runs`) — сверху рельса; редкие (`environments`, `variables`, `settings`) — нижняя отделённая группа.
- **Чистота:** бейдж «configured/not set» вместо значения секрета; опасное действие — диалог с масштабом и именем проекта.

### 4.4 Токены

- Цвет проекта: `hash(projectId)` → стабильная палитра (полоса switcher, акцент шапки).
- Семантика статусов: `passed` зелёный ✔, `failed` красный ✖ «тест упал (assertion)», `error` янтарный ⚠ «инфраструктура», `timeout`/`stopped`/`interrupted` — серый/янтарный с под-причиной.
- Плотность: компактные строки таблиц, sticky-дерево с сохранением раскрытия.

### 4.5 Сравнение с монолитом

| Аспект | Сейчас | Стало |
|---|---|---|
| Навигация | плоские ссылки + тулбар на странице | постоянный рельс (2 уровня) + switcher |
| «Текущий проект» | не виден нигде | switcher + цвет + крошки + title |
| server_* данные | глобальный `/cabinet` | project-scoped разделы `/p/:pid` |
| Кнопок в тулбаре | 7-8 | 2 (`+ New ▾`, `▶ Run`) |
| Дубли модалок | run-модалка ×2 | один `<RunConfig>` |
| Обновление прогона | poll + `location.reload()` | SSE + точечный патч DOM |

---

## 5. Real-time статусы

### 5.1 Две оси: `status` (контракт) × `phase` (под-статус)

Базовое исследование выводит под-фазы из текста лог-строк (`describeRunProgress`, `html.ts:3527-3540`) — хрупко: смена текста или локализация ломает UI. Решение — **явное серверное поле `phase` поверх неизменного `status`**.

| Ось | Значения | Источник | Назначение |
|---|---|---|---|
| `status` (есть) | `queued·running·passed·failed·error` (`schemas.ts:169`) | `finalizeExecution` (`execute.ts:570`) | контракт, `result.json`, восстановление |
| `phase` (новое) | `queued·prepare·pull_image·create_container·execute·collecting·done` | точки кода в `execute.ts` | Timeline, тайминги, «где висим» |
| `outcome` (новое, надстройка) | `passed·failed·error·timeout·stopped·interrupted` | finalize/recover | детализация для UI, не ломает `RunStatusSchema` |

> **Важно про природу `phase` (честный контракт, не «дублирование существующего»).** Лог-строки уже идут через единую воронку `appendRunLog` (`app.ts:1991`), и `run.log` действительно дублирует уже существующий поток. Но **типизированного `phase`-сигнала в коде нет**: фазовые переходы сегодня выводятся как обычные сообщения через `on_log → appendRunLog` из точек `execute.ts` (81/98/414/479/567). Поэтому `run.phase` — это **новый контракт**, который надо ввести: в раннере добавить типизированный `on_phase(phase, meta)` рядом с `on_log`, эмитить его в тех же точках, а не парсить текст. Ниже маппинг показывает, к каким точкам кода привязать новые эмиты.

Маппинг `phase` на **существующие** точки (типизируем, не выдумываем фазы):

| `phase` | Точка сегодня | Условие |
|---|---|---|
| `queued` | `createQueuedRunLogEntry` (`run-planner.ts:1253-1262`) | при планировании |
| `prepare` | «Preparing isolated workspace…» (`execute.ts:81`) + drift (`:84-91`) | всегда |
| `pull_image` | «Pulling Docker image…» (`execute.ts:479`) | **только если** `image inspect` промахнулся (`:463-484`); иначе **SKIPPED** (серый «from cache», `:469-472`) |
| `create_container` | «Starting Playwright container» (`execute.ts:98`) / `docker create` (`:340`) | всегда |
| `execute` | первый chunk stdout (`execute.ts:414`) | всегда |
| `collecting` | `collectPlaywrightArtifacts`/`mergeStdoutOutputs` (`execute.ts:567-568`) | всегда |
| `done` | `finalizeExecution` (`execute.ts:557-585`) | терминал |

### 5.2 Машина состояний прогона (ASCII)

```
   prepareScenarioRunPlan │  status=queued · phase=QUEUED                          │
   (run-planner.ts:278)   │  UI: позиция в очереди, стадия, "ждёт стадию N-1", ETA │
                          └───────────────┬───────────────────────────────────────┘
       worker берёт job (executeRunJob, app.ts:1666; сейчас queueMicrotask 1641/1657)
       ПРИ СТАРТЕ: регистрируем runId в РЕЕСТРЕ ПРОЦЕССОВ (§6.7) {child,container,abort}
                                          ▼  status → running (app.ts:1688)
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ status=running ── НОВОЕ поле phase ──                                          │
   │ PREPARE ─► PULL_IMAGE ─► CREATE_CONTAINER ─► EXECUTE ─► COLLECTING             │
   │ (e:81)    (e:479; ТОЛЬКО  (e:98/create e:340)  (1й stdout (e:567 collect       │
   │ workspace  если не в кеше,                       chunk e:414) artifacts)       │
   │ +drift     иначе SKIPPED gray)                                                 │
   │   │ docker daemon  │ pull failed   │ create/start  │ test       │ cp           │
   │   │ unavailable    │ (e:486)       │ failed        │ timeout(e:431)│ fail       │
   │   │                │               │               │            │              │
   │   │   STOP (юзер): abort.signal → child.kill() + docker rm -f <container> ─────┤
   │   ▼════════════ любой бросок → catch (e:132) → finalizeExecution ═══════════►  │
   └───────────────────────────────────┬────────────────────────────────────────────┘
       ПРИ ФИНИШЕ/ОШИБКЕ/STOP: снимаем runId из реестра процессов (§6.7)
                                        ▼ finalizeExecution (e:557-585, 570)
   ┌─────────┬──────────┬────────────┬──────────┬───────────┬──────────────────┐
   ▼         ▼          ▼            ▼          ▼           ▼                  ▼
 PASSED   FAILED     ERROR        TIMEOUT    STOPPED    INTERRUPTED
 exit==0  exit!=0    error thrown kill по    отмена     recover из rerun
 (570)    (assert)   (docker/pull) timeout   юзером     (app.ts:1625)
   │         │          │           (e:431)   (§6.7)     "сервер перезапускался"
   │  failed=✖красный   error=⚠янтарный                  ⚠ + кнопка Retry
   ▼  "тест"            "инфраструктура"                  ▼
 applyPoolFetchResults / applyPoolAutoImports          Retry → новый run
 (app.ts:1751-1754, ТОЛЬКО passed)                     (retry_of_run_id, run-planner.ts:291)
```

`timeout` и `stopped` — **новые терминальные исходы** через `outcome`-надстройку (не ломают `RunStatusSchema`):
- **`timeout`** — `spawnProcess` ставит `setTimeout(child.kill())` и бросает «Process timed out» (`execute.ts:407-412,431`). Сейчас тонет в общем `error`. Различаем в `finalizeExecution` → `outcome="timeout"`.
- **`stopped`** — **сегодня отмены нет вообще** (`queueMicrotask` не прерывается, нет ссылки на дочерний процесс). Полная механика — в §6.7 (реестр процессов + `AbortSignal` + именование контейнера в обоих режимах).
- **`interrupted`** — из `recoverInterruptedRuns` (`app.ts:1625`): в Timeline показывается как `error · interrupted` с пояснением «сервер перезапускался» и кнопкой Retry.

### 5.3 Данные UI по состояниям

| Состояние | Бейдж | Главное на экране | Действия |
|---|---|---|---|
| `queued` | серый | позиция в очереди, `execution_stage`, «ждёт стадию N-1», ETA | **Stop**, Open batch |
| `running·prepare` | синий пульс | «готовим workspace», drift-результат | Stop |
| `running·pull_image` | синий+прогресс | имя образа, «первый pull ~1.5 ГБ», live-хвост pull | Stop |
| `running·create_container` | синий | «запускаем контейнер», транспорт (bind/copy) | Stop |
| `running·execute` | синий live | live-консоль, таймер фазы | Stop |
| `running·collecting` | синий | «собираем trace/video/outputs» | (Stop поздно) |
| `passed` | зелёный ✔ | длительность, trace/video/screenshot, outputs, добавленные в пул | Retry, Trace, Download |
| `failed` | красный ✖ | exit_code, assertion из stderr, screenshot_on_fail | **Retry**, Trace, Logs |
| `error` | янтарный ⚠ | `summary.error`, фаза падения, «Runner host Docker unavailable» | **Retry**, проверить Docker/стенд |
| `timeout` | янтарный ⚠ | лимит `APP_RUN_TIMEOUT_MS`, фаза в момент kill | Retry, увеличить таймаут |
| `stopped` | серый ⏹ | кто/когда остановил | Retry |
| `interrupted` | янтарный ⚠ | «сервер перезапускался во время прогона» | Retry |

### 5.4 SSE-транспорт: эндпоинты, события, авторизация, бэкпрешер

Почему SSE, а не WS/poll: поток однонаправленный (сервер→клиент), работает поверх HTTP/HTTPS через Caddy без апгрейда, авто-reconnect в `EventSource` с `Last-Event-ID`. Команды (run/stop/retry) — обычным `POST`. Воронка лог-событий уже есть: `appendRunLog` (`app.ts:1971-1998`) — единая точка всех **лог**-событий; после записи в state (`:1991`) дублируем `run.log` в in-process `EventEmitter` по `runId`. **Фазовые события `run.phase` — новый эмит** (`on_phase`, §5.1), а не дублирование существующих логов.

**Авторизация и scope SSE-стримов (закрытие IDOR на стримах — обязательно).** `EventSource` не умеет слать кастомные заголовки, поэтому стримы авторизуются так же, как обычные роуты:
- **Аутентификация — по сессионной cookie** (`HttpOnly; Secure; SameSite=Lax`), которая идёт автоматически на same-origin GET. `EventSource(url, { withCredentials: true })`.
- **Тот же `preHandler`-гард изоляции, что и для роутов** (§3.2): резолв User из сессии → извлечение `:pid`/сущности из URL → `effectiveRole` → проверка `entity.project_id == :pid`. Без гарда любой залогиненный пользователь подписался бы на стрим чужого проекта по `run_id` (тот самый IDOR, что §3.2/§9.4 закрывают для роутов). В логах — маркеры 2FA и имена credential, поэтому утечка стрима ломает и изоляцию, и 2FA-прозрачность.
- **Лог-эмиттер привязан к проверке доступа на этапе подписки**, а не на этапе `appendRunLog`: подписка на `EventEmitter[runId]` создаётся только после успешного гарда; `appendRunLog` остаётся «глупой» воронкой и не знает про доступ.

**Бэкпрешер и лимиты:**
- На один `runId` — **лимит активных подписчиков** (по умолчанию 20); сверх лимита — `429` с заголовком `Retry-After`.
- Медленный клиент: если буфер записи в сокет превышает порог (отстал от потока) — сервер **дропает промежуточные `run.log`** для этого клиента, оставляя `run.phase`/`run.status` (терминальные/фазовые важнее построчного хвоста), и шлёт маркер `run.log {dropped:N}`; клиент при желании до-тянет лог через `GET /api/runs/:id/log?after=<id>`.
- **Heartbeat** `:\n\n` каждые 15с (держит соединение через Caddy/прокси, детектит мёртвых клиентов).
- Idle-таймаут стрима на терминальном статусе: сервер шлёт `run.status {terminal:true}` и закрывает соединение.

| Эндпоинт | События | Привязка | Гард |
|---|---|---|---|
| `GET /api/runs/:id/stream` | `run.phase`, `run.log`, `run.status`, `run.artifact` | `appendRunLog` (`app.ts:1991`) + `on_phase`-эмиты; на connect — снапшот `log_entries` | run.project_id == доступный проект |
| `GET /api/stream/execution` | `queue.update`, `worker.update`, `run.status` | `executeRunJob` старт/финиш (`app.ts:1688,1732`), enqueue (`:1640-1664`) | scope по проекту в query `?pid=`; admin → cross-project |
| `GET /api/stream/health` | `execution.health` (docker/cache/disk), `clock.sync` | `ensureDockerReady`-лайт (`execute.ts:439-460`) + NTP | любой залогиненный (хост-уровень, без секретов) |
| `GET /api/batches/:id/stream` | `batch.progress`, `stage.update`, `run.status` | агрегат по `batch_id` | batch.project_id == доступный проект |
| `POST /api/environments/:id/reachability` | `stand.availability` | новый, §5.9 | environment.project_id == :pid |

Структура события — типизированная, метка строится на клиенте по `phase`+i18n-ключу (не парсится из `message`):
```
event: run.phase
id: <monotonic>
data: {"run_id":"…","phase":"pull_image","cached":false,"image":"mcr…:v1.52.0-jammy",
       "prev_phase":"prepare","prev_duration_ms":1100}
```

**Fallback:** `EventSource` недоступен → деградация к поллингу `GET /api/runs/:id` раз в 3-5с, **но без `location.reload()`** — точечный патч DOM (статус-бейдж, дописать строки), скролл и раскрытые блоки сохраняются. На терминале сервер шлёт `run.status {terminal:true}` и закрывает стрим — клиент показывает финальный экран без перезагрузки.

### 5.5 Run Timeline

Источник — `phase` + `phase_timings` (`Record<phase,{started_at,duration_ms,status:active|done|skipped|failed}>`):
```
✔Queued─✔Prepare─⊘Pull(cached)─✔Container─⟳Execute─○Collect
 0.2s     1.1s     —             2.1s        0:42…    —
```
- `⊘` = skipped (образ в кеше) — иначе непонятно, почему «быстрый» прогон короче.
- активная фаза пульсирует + живой таймер (вместо «This page refreshes automatically», `html.ts:3537`).
- клик по сегменту → скролл консоли к началу фазы (логи тегируются `phase`).

### 5.6 Live-консоль

- источник — `run.log` SSE + чанки stdout/stderr (`spawnProcess` уже пишет построчно, `execute.ts:414-415` — дублировать в подписку);
- **follow-режим**: автоскролл у дна; проскроллил вверх → пауза + плашка «⏸ paused · N new lines · [к концу]»;
- вкладки `Live console / stdout / stderr / Outputs / Artifacts` — без reload, состояние вкладки/скролла сохраняется;
- виртуализация длинных логов (`trace:on/video:on` дают гигантский stdout);
- при дропе строк бэкпрешером (§5.4) — плашка «N строк опущено · [подгрузить]».

### 5.7 Dashboard Execution-виджет, индикаторы здоровья

> **Прямая зависимость от персистентной очереди (см. §5.8 DDL и §10).** Источник данных Execution-виджета (Workers busy/idle/total, Concurrency, позиция, ETA) **сегодня в коде не существует**: очередь — `queueMicrotask` без лимита, реестра воркеров и счётчика concurrency нет (`app.ts:1640-1664`). Виджет наполняется честно **только после** введения таблиц `run_queue`/`workers` (§5.8) и счётчика `max_concurrent_runs`. До этого виджет показывает деградированный вид (running по факту + «очередь: in-memory, без позиций»), а не выдуманные числа.

**Execution** (`GET /api/stream/execution`): Workers `busy/idle/total`, Concurrency `▓▓▓▓ 4/4`, Running/Queued, список RUNNING NOW с **фазой** (`deposit-card ⟳ pull 0:50` — видна pull, снимает «выглядит как зависание»).

**Health** (`GET /api/stream/health`, механика `ensureDockerReady`, `execute.ts:439-493`):
- Docker: `docker version` (`:446`) → `● ready v27` / `✖ unavailable` (текст «Runner host Docker daemon unavailable», не «Start Docker Desktop», `:682`);
- Image cache: `docker image inspect` (`:463`) → `● present 1.52` / `⟳ pulling` / `○ absent`;
- Диск `/data`: `▓▓▓ 61%`, алерт >80% (`trace:on/video:on` → быстрый рост);
- **Clock(NTP)**: offset → `● in sync 12ms` / `⚠ drift 1.4s` — критично, дрейф ломает 2FA стендов **молча** (тест `failed`, не `error`).

### 5.8 Прозрачность очереди (+ DDL персистентной очереди и воркеров)

Сегодня очередь — `queueMicrotask` (`app.ts:1641,1657`), невидимая, без лимита, теряется при рестарте. Чтобы виджет §5.7 и завершаемость §6.4 были наполняемы и переживали рестарт, очередь и воркеры **материализуются** (это и есть «персистентная очередь Фаза 3.2», спроектированная здесь, а не только упомянутая):

```sql
-- Персистентная очередь job'ов (заменяет невидимый queueMicrotask)
CREATE TABLE run_queue (
  run_id          TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id        TEXT,
  execution_stage INTEGER NOT NULL DEFAULT 1,
  state           TEXT NOT NULL DEFAULT 'waiting'
                    CHECK (state IN ('waiting','waiting_stage','leased','done','cancelled')),
  -- waiting        — ждёт свободного воркера
  -- waiting_stage  — ждёт завершения предыдущей стадии батча (≠ ждёт воркера)
  -- leased         — взят воркером (см. worker_id/lease_expires_at)
  priority        INTEGER NOT NULL DEFAULT 0,
  worker_id       TEXT REFERENCES workers(id) ON DELETE SET NULL,
  lease_expires_at TEXT,                 -- TTL-лиз: «завис» воркер → job возвращается в waiting
  enqueued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at      TEXT
);
CREATE INDEX idx_queue_state ON run_queue(state, priority, enqueued_at);

-- Реестр воркеров (источник Workers busy/idle/total)
CREATE TABLE workers (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','busy','draining','dead')),
  current_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  heartbeat_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

`max_concurrent_runs` — конфиг инсталляции (env `APP_MAX_CONCURRENT_RUNS`), пул воркеров создаётся по нему. Диспетчер вместо `queueMicrotask`: лизит `waiting`-job с истёкшим/свободным воркером, ставит `leased`, по завершении — `done` + освобождает воркер; «зависший» лиз (по `lease_expires_at`) возвращается в `waiting` (это и даёт честное дозавершение после рестарта, §6.4.2). Состояния job (`waiting/waiting_stage/leased/done/cancelled`) — то, чего раньше в документе не было.

Показываем три уровня:
- **(a) Позиция** — «3-й в очереди · перед вами 2 · ETA ~4 мин» (по средней `phase_timings.execute.duration_ms`; позиция = порядок `waiting` по `(priority, enqueued_at)`);
- **(b) Лимит** — `running / max_concurrent_runs`; при `running==max` — «ждёт свободного воркера» (`state=waiting`);
- **(c) Ждёт стадию** — `state=waiting_stage` (явно отличать от «ждёт воркера»).

`queue.update` (полный снапшот с позициями) шлётся при каждом enqueue/lease/done.

### 5.9 Панель «Проверить доступность стенда»

Прямое требование владельца. Новый бэкенд `POST /api/environments/:id/reachability` (грепы по `reachab/curl/health` в `apps/server/src` пусты — эндпоинта нет; `base_url` живёт на environment, `store.ts:103`, `app.ts:1704`). **Project-scoped:** гард `environment.project_id == :pid` (environment принадлежит проекту — тот же anti-IDOR, что и везде).

**Механика:** проверка **из той же среды, что и реальный прогон** — `docker run --rm <runner-image> curl -sS -o /dev/null -w '%{http_code} %{time_total}' <BASE_URL>`, плюс параллельно **с хоста** (Node-fetch). Не только `fetch` из Node — важна достижимость из контейнера (rootless/slirp4netns, `--add-host`, `--network` могут отличаться).

**Параметры устойчивости проверки (раньше не были заданы):**
- **Таймаут** на источник — `8s` (хост) / `12s` (контейнер, +накладные docker run); конфиг `APP_REACHABILITY_TIMEOUT_MS`.
- **Ретраи** — 2 попытки с backoff `0.5s/1.5s` на каждый источник; в историю пишется худший/последний результат с числом попыток.
- **Различение «стенд недоступен» vs «Docker недоступен» (критично):** перед контейнерной веткой выполняется лёгкий `ensureDockerReady` (`execute.ts:439-460`). Если Docker сам недоступен — контейнерная ветка **не запускается** и помечается отдельным статусом `ⓘ Docker недоступен — проверка из контейнера невозможна` (а не ложным `✖ unreachable`). Это ровно тот сценарий, который пользователь и хочет диагностировать: без различения панель соврала бы «стенд недоступен» именно тогда, когда нужна правда.
  - Если Docker недоступен, но хост-проверка прошла → вывод: «Стенд отвечает с хоста; достижимость из раннера не проверена (Docker недоступен)».
  - Если Docker недоступен и хост-проверка не прошла → «Стенд недоступен с хоста; раннер-проверка невозможна (Docker недоступен)».

Результат стримится `stand.availability`: `● reachable (200, 340ms)` / `⚠ slow(>1s)` / `✖ unreachable (timeout)` / `ⓧ TLS error` / `ⓘ Docker недоступен`.

**Три точки встройки:** (1) Run-wizard шаг 1 (авто-проверка перед `▶ Запустить`, не блокирует жёстко); (2) Dashboard/Environments (компактный чип + полная панель); (3) страница прогона `error` («Стенд был недоступен? [Проверить сейчас]»). Project-scoped — по каждому проекту свои окружения.

---

## 6. Завершаемость и повторяемость флоу

### 6.1 Пять фактов-инвариантов (фундамент)

1. **Единственное персистентное состояние флоу — `status`** (`queued|running|passed|failed|error`, `run-planner.ts:297`). Отдельных машин состояний для батча/fetch/import/записи **нет**.
2. **Очередь не персистентна** (`queueMicrotask`, `app.ts:1640-1664`). `RunRecord` пишутся в стейт ДО постановки в очередь (`:1138-1141`), поэтому `queued`-запись при рестарте останется, но исполнение исчезнет. (Решается материализацией очереди, §5.8.)
3. **Единственное восстановление — `recoverInterruptedRuns`** (`app.ts:85,1591-1638`): не перезапускает, а **финализирует** (читает `result.json` или ставит `error`).
4. **Идемпотентность retry — на `runtime_snapshot`** (`app.ts:804`): новый `run.id`, но trace_id/pool-значения из снимка не регенерируются.
5. **Побочные эффекты привязаны к `status==='passed'`** (`app.ts:1751-1754`, `applyPoolAutoImports` выходит при `!== "passed"`, `:2033`).

### 6.2 Таблица всех флоу

| Флоу | Завершение (явное) | Прерывание | Возобновление | Повтор (idempotency) |
|---|---|---|---|---|
| **Запись (агент)** | upload c `scenario_ulid` | `state.runtime` потерян (память агента) | **нет сегодня** → скан tempDir по ULID, «продолжить Review» | **не идемпотентно сегодня** → upsert по `scenario_ulid` |
| **Одиночный run** | `passed/failed/error` | recover → `error·interrupted` | persistent-очередь автостарт (§5.8); до неё — кнопка Retry | `run.id`+`runtime_snapshot`; риск двойного применения эффектов (§6.5) |
| **Батч/стадии** | агрегат `done/partial/failed` (новый) | **стадии K+1 не доезжают** | batch-aware recover → дозаполнить незавершённые стадии | **«retry только упавшее»** (новый эндпоинт) |
| **Retry** | новый run, `retry_of_run_id` | как одиночный | recover | эталон: снимок, trace/pool не регенерятся |
| **Stop (run/батч)** | `outcome=stopped` | n/a (само прерывание) | — | повторный Stop — no-op (идемпотентен) |
| **Fetch info** | `passed` + `last_fetched_at` | apply не довыполняется | переиграть apply из `pool_fetch`-снимка | по `item.id`/`value` (перезапись) |
| **Import/add-to-pool** | синхронный ответ | n/a (атомарно в `store.update`) | — | `pool.dedupe` |
| **Регистрация/логин/2FA** | сессия / `users` / `enabled` | промежут. `pending_2fa` / draft-секрет | возобновить с шага TOTP / показать тот же QR | `login UNIQUE` / повтор кода того же секрета |
| **CRUD cred/merchant/pool** | строка + `version` | n/a (атомарно) | — | `UNIQUE(project_id,…)` |

### 6.3 Запись в агенте (детально)

Состояние сегодня — только в памяти Electron (`state.runtime`, `state.dirty`, `renderer.js:185-192`) + файл на диске оператора; на сервере до upload нет ничего. Машина: `recording → recorded(local) → reviewed(local) → uploaded(server)`. Только `→uploaded` пересекает границу клиент/сервер.

- **`scenario_ulid` на этапе Stop, локально** (в `metadata.json`). Тогда: resume после краша агента (скан tempDir → «Незавершённая запись — продолжить/отбросить»); идемпотентный upload (**upsert по ULID**, `renderer.js:267-277` сейчас без ключа дедупликации → дубли).
- Финальное состояние записи = успешный upload с `scenario_ulid`.

### 6.4 Батч со стадиями — центральная дыра завершаемости

Механика стадий (факт): один `batch_id` (`run-planner.ts:359`), стадия = `baseStage + floor(index/parallelBatchSize)` (`:392`); стадии идут **последовательно** через `await`, внутри стадии — **неограниченный `Promise.all`** (`app.ts:1657-1662`). При рестарте посреди батча стадии K+1 не доезжают, «retry только упавшего» на уровне батча нет.

**6.4.1 Агрегат `Batch` как явная сущность** (сегодня — фантом-группировка):
```
batch: { id, account_id, project_id, scope, total, stages_total,
         status: planning|running|partial|done|failed|cancelled, created_at, finished_at }
```
Производный статус, но **материализуется** для resumability: `done` (все passed) / `partial` (терминальны, есть и passed, и failed) / `failed` (ни одного passed) / `running` / `cancelled`.

**6.4.2 Дозавершение прерванного батча (resume):** расширить `recoverInterruptedRuns` до batch-aware: финализировать строки как сейчас; затем для каждого `batch_id` найти незапущенные стадии (порядок восстановим из персистентного `execution_stage`, `run-planner.ts:293`) и **повторно поставить в очередь незавершённые стадии** через `run_queue` (§5.8). Без персистентной очереди дозавершение умрёт при следующем рестарте — поэтому §5.8 является пред-условием.

**6.4.3 «Повторить только упавшее»** — `POST /api/batches/:id/retry-failed`: выбрать `failed/error` батча, для каждого retry с тем же `runtime_snapshot` и **тем же `batch_id`** (сейчас retry создаёт run без `batch_id`, `app.ts:792-811` — исправить), сохраняя исходную `execution_stage` (брать `run.execution_stage`, не пересчитывать). Идемпотентность: повторный retry не дублирует passed-прогоны.

### 6.5 Идемпотентность побочных эффектов

Сегодня после восстановления-в-passed (`recoverInterruptedRuns` читает `result.json`) эффекты `applyPoolFetchResults`/`applyPoolAutoImports` **не переигрываются** (`app.ts:1751-1754`). Плюс retry passed-прогона при `pool.dedupe=false` импортирует значения второй раз.

**Решение:** флаг `effects_applied: true` в `runtime_snapshot`, проверять перед повторным применением; в recover — переигрывать эффекты для восстановленных-в-passed прогонов с `pool_fetch`/auto-import снимком. Для пулов-источников run_output форсить `dedupe=true` по умолчанию (`upsertPoolItem` уже дедуплицирует при `dedupe=true`, `app.ts:1468-1480`).

### 6.6 Три системных вывода

1. **Единственная нерешённая дыра логики — батч на стадиях:** агрегат `Batch` (6.4.1) + batch-aware recover (6.4.2) + retry-failed с привязкой к `batch_id` (6.4.3). Всё опирается на персистентную очередь (§5.8) — без неё дозавершение умрёт при следующем рестарте.
2. **Побочные эффекты не довыполняются после recover:** флаг `effects_applied` + переигрывание (6.5).
3. **Запись в агенте без серверного состояния и idempotency-ключа:** `scenario_ulid` как ключ upsert + локальный индекс черновиков (6.3).

### 6.7 Механика Stop: реестр процессов, AbortSignal, именование контейнера

Это — архитектурный фундамент Столпа 2 («завершаемость ЛЮБОГО флоу»). Без него `Stop` — нереализуемое требование, замаскированное под решённое: сегодня `executeRunJob` (`app.ts:1666`) не сохраняет ссылку на дочерний процесс, а `runScenarioInDocker` (`execute.ts`) инкапсулирует `spawn` внутри себя, поэтому серверный обработчик `POST /api/runs/:id/stop` **физически не имеет** чем убить процесс/контейнер.

**(1) Разделяемый реестр процессов** — in-memory `Map<runId, RunHandle>`, живёт в процессе сервера рядом с диспетчером очереди:
```ts
type RunHandle = {
  child: ChildProcess;          // ссылка на spawn раннера (проброшена из execute.ts)
  containerName: string;        // детерминированное имя контейнера (см. п.3)
  abort: AbortController;       // прокидывается в раннер как AbortSignal
  transport: 'bind' | 'copy';
};
const runRegistry = new Map<string, RunHandle>();
```
- **Регистрация — при старте job** (`executeRunJob`, точка `app.ts:1688`, статус→running): кладём `RunHandle` в реестр по `runId`.
- **Снятие — в `finally`** финализации (любой исход, включая Stop/timeout/error): `runRegistry.delete(runId)`.
- Реестр in-memory сознательно: после рестарта сервера исполняющихся процессов уже нет (их убил рестарт), а «висящие» строки подберёт `recoverInterruptedRuns` → `interrupted`. Stop актуален только для процессов текущего инстанса.

**(2) Проброс `AbortSignal` в раннер.** `runScenarioInDocker`/`spawnProcess` (`execute.ts:340,407`) принимают `signal: AbortSignal` и:
- при `signal.aborted` — `child.kill('SIGTERM')`, через grace 5с → `SIGKILL`;
- возвращают `child` наружу (или вызывают `onSpawn(child)` callback), чтобы сервер положил ссылку в реестр **до** того, как процесс мог завершиться.

**(3) Детерминированное имя контейнера в ОБОИХ режимах (критично).** Сегодня контейнер именуется только в copy-режиме (`execute.ts:339`); в bind-режиме имя неизвестно, поэтому `docker rm -f` нечего адресовать. Правка: **всегда** задавать `--name ts-playwright-run-<runId>` (детерминированно из `runId`), независимо от транспорта. Тогда `docker rm -f ts-playwright-run-<runId>` работает в обоих режимах, и реестр хранит это имя как `containerName`.

**(4) Обработчик `POST /api/runs/:id/stop`** (project-scoped гард, как все роуты):
```
1. гард: run.project_id доступен пользователю (иначе 404)
2. handle = runRegistry.get(runId)
3. если handle:
     handle.abort.abort()                         // раннер сам пошлёт SIGTERM→SIGKILL
     docker rm -f handle.containerName             // подстраховка, если процесс уже оторвался
4. если НЕТ handle, но run.status=='queued':
     run_queue.state := 'cancelled'                // ещё не стартовал — просто снять из очереди
5. finalizeExecution(run, outcome='stopped')       // идемпотентно: повторный Stop — no-op
```

**(5) Stop батча** (`POST /api/batches/:id/stop`): для всех `running` runs батча — шаг (3); для всех `queued` (`run_queue.state IN waiting/waiting_stage`) — `cancelled`; агрегат → `cancelled`. Кнопка «Stop remaining» на экране батча (§7.5).

С этим механика `stopped` из §5.2 становится реализуемой: реестр даёт ссылку, `AbortSignal` прерывает уже-исполняющийся `spawn`, детерминированное имя контейнера даёт `docker rm -f` в любом транспорте.

---

## 7. Ключевые экраны

### 7.1 Мои проекты

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright  [ Проект: Payments ▾ ]            [▶3][🔔1][🌐RU][anna ▾]   │
├──────────────────────────────────────────────────────────────────────────────┤
│  Мои проекты                                            [ + Новый проект ]     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                           │
│  │ Payments    ⋯│ │ KYC         ⋯│ │ Withdrawals ⋯│                           │
│  │ ● 3 running   │ │ ● idle        │ │ ⚠ 2 failed    │                           │
│  │ 42 сценария   │ │ 11 сценариев  │ │ 7 сценариев   │                           │
│  │ 5 creds·3 mrch│ │ 2 creds       │ │ 1 cred        │                           │
│  │ env: stg,prod │ │ env: stg      │ │ env: prod     │                           │
│  │ посл.: 12:01✔ │ │ посл.: вчера✔ │ │ посл.: 11:48✖ │                           │
│  └──────────────┘ └──────────────┘ └──────────────┘                           │
└──────────────────────────────────────────────────────────────────────────────┘
```
- Карточка кликабельна → Дашборд проекта + установка активного проекта (источник истины — URL `/p/:pid`).
- Счётчики creds/merchants/env **доказывают изоляцию** по проекту.
- `⋯`: Открыть · Переименовать · Дублировать настройки (без секретов) · Архивировать · Участники.
- Создание (модалка): обязательно только **Название**; «Скопировать настройки» (Advanced) копирует структуру env/merchants/pool-шаблоны, **никогда секреты**.

### 7.2 Дашборд проекта

```
┌───────────┬──────────────────────────────────────────────────────────────────┐
│ Dashboard◀│  Payments · Дашборд                                               │
│           │  ┌─ EXECUTION (этот проект) ──┐  ┌─ HEALTH (раннер-хост) ───────┐ │
│           │  │ Workers 4 · busy 3 · idle 1│  │ Server      ● up   12d        │ │
│           │  │ Concurrency ▓▓▓▓ 4/4       │  │ Docker      ● ready v27       │ │
│           │  │ Running 3 · Queued 12      │  │ Image cache ● present 1.52    │ │
│           │  └────────────────────────────┘  │ Disk /data  ▓▓▓░ 61%         │ │
│           │  ┌─ STANDS этого проекта ─────┐  │ Clock(NTP)  ● in sync 12ms   │ │
│           │  │ stg  ● 200  84ms [Проверить]│ └──────────────────────────────┘ │
│           │  │ prod ● 200 120ms [Проверить]│                                  │
│           │  └────────────────────────────┘                                   │
│           │  ┌─ RUNNING NOW ────────────────────────────────────────────────┐ │
│           │  │ ● withdraw-flow  executing 0:42  anna  payouts        [open]→ │ │
│           │  │ ● deposit-card   ⟳ pull 0:50     anna  deposits       [open]→ │ │
│           │  │ ● kyc·3          queued (pos 4)  bot   kyc            [open]→ │ │
│           │  └────────────────────────────────────────────────────────────────┘ │
│           │  ┌─ RECENT FAILURES ────────────────────────────────────────────┐ │
│           │  │ ✖ deposit·2  failed (assertion)   12:01 [Trace][Retry][open]→ │ │
│           │  │ ⚠ kyc-flow   error (docker pull)  11:48 [Logs ][Retry][open]→ │ │
│           │  └────────────────────────────────────────────────────────────────┘ │
└───────────┴──────────────────────────────────────────────────────────────────┘
```
Всё real-time через SSE (заменяет poll+reload). Execution-виджет наполняется из `run_queue`/`workers` (§5.8). Пустой проект → чек-лист онбординга (cred → env → сценарий).

### 7.3 Дерево сценариев

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Payments ▸ payments ▸ payouts          [ + New ▾ ]            [ ▶ Run ]        │
├──────────────────────────────┬───────────────────────────────────────────────┤
│ ДЕРЕВО                        │  payouts/  (12 сценариев · env: stg,prod)      │
│ ▾ 📁 payments                 │  ☐ выбрать всё            [bulk: ▶Run·Move·🗑]│
│   ▾ 📁 payouts        ◀здесь  │  ┌──────────────────────────────────────────┐ │
│       📄 withdraw-flow ●pass  │  │☐ 📄 withdraw-flow  stg  ●pass 12:01 [▶][⋯]│ │
│       📄 payout-batch  ✖fail  │  │☐ 📄 payout-batch   prod ✖fail 09:12 [▶][⋯]│ │
│     ▸ 📁 deposits             │  │☐ 📄 refund-flow    stg  —     never [▶][⋯]│ │
│   ▸ 📁 kyc                    │  └──────────────────────────────────────────┘ │
└──────────────────────────────┴───────────────────────────────────────────────┘
```
- `▶ Run` в хедере: scope из крошек ИЛИ чекбоксов (схлопывает три старых Run-кнопки, `html.ts:727-731`).
- `⋯` строки: Открыть · История · Код · Переместить · Переименовать · Скачать zip · Удалить (диалог масштаба). **Переместить** учитывает инвариант §2.6: при наличии незавершённых runs — блок с подсказкой; исторические runs остаются в исходном проекте.
- Чекбоксы → bulk-bar; `+ New ▾` = Folder / Upload (инлайн-ввод, без двухшагового флоу); sticky-дерево с сохранением раскрытия.

### 7.4 Прогон LIVE

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ withdraw-flow ▸ r_5c1a            ⟳ RUNNING          [ Stop ][ Retry ][⋯]│
│ Batch b_8f3a · Stage 2 of 3 · ждёт стадию 1 → [open batch]                     │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐ │
│ │ ✔Queued─✔Prepare─⊘Pull(cached)─⟳Container─○Execute─○Artifacts              │ │
│ │  0.2s    1.1s     —             0:06 starting…   тек.фаза: container       │ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
│ META  scenario withdraw-flow · env stg · iteration 1/1 · timeout 900000ms      │
│       cred stand-admin → user a***n  pwd ●set  2FA ●set   merchant ACME        │
│       triggered_by anna · 12:04:01 · retry_of r_4b… (если retry)               │
│       🔐 2FA подставлен 12:04:25 · действ. 24с                                  │
│ [ Live console ]·[ stdout ]·[ stderr ]·[ Outputs ]·[ Artifacts ]   ← вкладки   │
│ ┌─ Live console ───────────────────────────────────── [⏸ autoscroll][⤓ wrap]─┐ │
│ │ 12:04:23  ✓ withdraw form opened                                          │ │
│ │ 12:04:25  ⟳ waiting for #confirm …                                        │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```
- Timeline по `phase`+`phase_timings`; SSE без reload (сохраняет скролл/вкладку/раскрытые блоки), авторизован сессией + scope-гардом (§5.4).
- **`Stop`** виден на всех нетерминальных состояниях — бьёт через реестр процессов (§6.7).
- META: project-scoped credential по ссылке, секреты `●set` (write-only). Маркер 🔐 2FA — момент подстановки без раскрытия кода (§8).
- Вкладки (виды, не кнопки): Outputs с `Add to pool` на строку; Artifacts стримом (не `readFileSync`).
- `Retry` idempotent (trace_id не регенерится). `⋯`: Delete run · Download artifacts · Copy id · Open scenario.

### 7.5 Батч

```
┌─ BATCH b_8f3a · Run folder /payouts · started by anna · 12:04 ────[ ⋯ ]──────┐
│ Progress ▓▓▓▓▓▓▓▓░░░░░░  7/12 done · 2 running · 3 queued · 1 failed           │
│ Состояние: ⟳ выполняется   (или: ✔ завершён · ⚠ прерван · ⏸ остановлен)        │
│──────────────────────────────────────────────────────────────────────────────│
│ STAGE 1  ✔ done (4/4)   ✔ withdraw·1  ✔ withdraw·2  ✔ deposit·1  ✖ deposit·2  │
│ STAGE 2  ⟳ running      ⟳ kyc·1(exec) ⟳ kyc·2(pull) ⋯ kyc·3(queued)  ◀ здесь  │
│ STAGE 3  ○ waiting for stage 2                                                 │
│──────────────────────────────────────────────────────────────────────────────│
│ [ Retry failed (1) ]   [ Stop remaining ]   [ Open as table ]                 │
│ ⚠ если сервер был перезапущен: [ Дозавершить незавершённые (3) ]  ← resumable │
└────────────────────────────────────────────────────────────────────────────────┘
```
- Группировка по `execution_stage`, маркер «◀ здесь» = активная стадия. Чипы кликабельны → 7.4.
- `Retry failed (N)` — только упавшие, тем же снапшотом, тот же `batch_id`. `Stop remaining` — `queued`→`cancelled`, `running`→kill (§6.7 п.5). `Дозавершить` — появляется при незавершённых стадиях после рестарта (6.4.2), требует персистентной очереди (§5.8).

### 7.6 Run-wizard (Scope → Data → Execution)

**Шаг 1 — Scope:**
```
┌─ RUN · payments / payouts ───────────────── Step 1 of 3 · Scope ──────────────┐
│ Окружение*   ( ● stg [200 84ms] )  ( ○ prod [проверить] )   ← из 7.8          │
│ Сценарии к запуску (12 из 12)       [Выбрать все][Снять]                       │
│  ☑ withdraw-flow  ☑ payout-batch  ☐ refund-flow                              │
│                                           [ Отмена ]  [ Далее: Data → ]        │
└────────────────────────────────────────────────────────────────────────────────┘
```
**Шаг 2 — Data (project-scoped server_* + предпросмотр):**
```
┌─ RUN · payments / payouts ───────────────── Step 2 of 3 · Data ───────────────┐
│ STAND CREDENTIAL [ stand-admin ▾ ]→ user a***n  pwd ●set  2FA ●set            │
│    (список = credentials ЭТОГО проекта; источник {server_username/password/2faotp})│
│ MERCHANT         [ ACME ▾ ]  → {server_merchant}=ACME                          │
│ ▸ Переопределить вручную (Advanced)                                            │
│ SHARED INPUTS  amount[100]  currency[USDT▾]                                    │
│ POOLS          address [ eth-addr ▾ · auto ]  (412 свободно)                   │
│ ┌─ ПРЕДПРОСМОТР ПОДСТАНОВКИ ──────────────────────────────────────────────┐   │
│ │ {server_username} → a***n     (cred stand-admin, project Payments)       │   │
│ │ {server_password} → ●set      {server_2faotp} → on-demand код at run      │   │
│ │ {server_merchant} → ACME      {address} → 0x9f…(auto, 412 free)           │   │
│ └──────────────────────────────────────────────────────────────────────────┘   │
│                              [ ← Назад ]  [ Далее: Execution → ]               │
└────────────────────────────────────────────────────────────────────────────────┘
```
**Шаг 3 — Execution:**
```
┌─ RUN · payments / payouts ──────────────── Step 3 of 3 · Execution ───────────┐
│ Повторов [ 1 ]    ☑ Require valid {address} in pool  ⓘ                         │
│ ▸ Advanced:  Execution stage [1]  Parallel batch [off]  Default timeout [—]    │
│ ⚠ 4 контейнера разом · оценка ~3 мин · workers свободно: 1                     │
│                              [ ← Назад ]  [ ▶ Запустить ]                      │
└────────────────────────────────────────────────────────────────────────────────┘
```
- **Один `<RunConfig>`** для проекта и сценария (устраняет дубль `html.ts:1236` vs `2760`). Для одиночного сценария Scope сворачивается.
- **Project-scoped резолв**: списки cred/merchant/pools — только активного проекта. `{server_2faotp}` из `totp_secret_enc` выбранного credential, в предпросмотре «on-demand код at run» (секрет не показывается).
- **Предпросмотр подстановки** — маскированные значения, источник, число свободных items. Resumable-черновик (перенос `captureRunModalDraft`, `html.ts:1466`). Advanced скрывает редкое.

### 7.7 Кабинет проекта (Credentials/Merchants/Pools/Environments/Variables)

**7.7a Credentials (дом слоя 2FA-(a)):**
```
┌─ Payments · Credentials ──────────────────────────────[ + Добавить ]──────────┐
│  Учётки тестируемых стендов для {server_username/password/2faotp}              │
│  Имя         │ Login │ Password │ TOTP/2FA │ Обновлён │             │           │
│  stand-admin │ a***n │ ●set     │ ●set     │ 12:01    │ [Код][⋯]    │           │
│  stand-ops   │ o***s │ ●set     │ ○ not set│ вчера    │ [Код][⋯]    │           │
└────────────────────────────────────────────────────────────────────────────────┘

Модалка credential:
┌─ Credential ─────────────────────────────────────────────┐
│ Имя*        [ stand-admin              ]                  │
│ Login*      [ admin@stand              ]  → {server_username}│
│ Password    [ ●●●●●●●● ] [ Заменить ]    (write-only)     │
│ TOTP secret [ ○ not set ] [ Задать… ]    → {server_2faotp}│
│   ▸ Источник 2FA (Advanced):                              │
│     ◉ TOTP-секрет (file-based, генерим код at run)        │
│     ○ On-demand код через API при запуске                 │
│     ○ Ввод кода вручную в Run-wizard ({{INPUT:2fa_otp}})  │
│ [ Проверить TOTP сейчас ]  → показывает 6-значный код 30с │
│                            [ Отмена ]  [ Сохранить ]      │
└──────────────────────────────────────────────────────────┘
```
- Бейдж `●set`/`○ not set` вместо значения; write-only (чинит `html.ts:459-460`). Хранение AES-256-GCM (`totp_secret_enc`).
- `[Код]` — on-demand TOTP, admin-only, audit `credential.totp_code_issued`.
- Источник 2FA собирает все способы в один выбор. `Проверить TOTP сейчас` ловит дрейф часов.

**7.7b-e:**
```
[ Credentials ]·[ Merchants ]·[ Pools ]·[ Environments ]·[ Project Variables ]

Merchants:  Name → {server_merchant} · Linked credential (источник 2FA) · Envs  [+ Merchant]
            (admin_login сегодня null у всех — ссылку на credential проставляют здесь вручную, §9.3)
Pools:      Name · Kind · Strategy · Free/Used  [+ Pool][Bulk import ⤓]
            ⋯: Items… · Fetch info · Auto-import rules · Delete
Environments: Name · base_url · [Проверить] (7.8)  [+ Environment]
Variables:  server_* и произвольные переменные  key=value  [+ Variable]
            server_region │ eu-central        │ [⋯]
            server_token  │ ●set (secret)      │ [⋯]
```
Всё project-scoped. Merchant.`admin_credential_id` → ссылка на project-credential. Bulk import — явная кнопка (поднят `import-run-outputs`). Редактирование — явное `⋯ → Edit`, не скрытый клик по строке (чинит `html.ts:455-461`).

### 7.8 Панель «Проверить доступность стенда»

```
┌─ Проверка доступности стенда · env: prod ────────────────────────[ ✕ ]───────┐
│ BASE_URL  https://prod.stand.internal           [ ▶ Проверить ]               │
│──────────────────────────────────────────────────────────────────────────────│
│ С ХОСТА (Ubuntu-ПК)        ● 200 OK   латентность 84 ms    TLS ✔ valid        │
│ ИЗ КОНТЕЙНЕРА (как раннер) ● 200 OK   латентность 121 ms   DNS ✔  ← важно     │
│   образ playwright:v1.52  ·  network=bridge  ·  через тот же DOCKER_HOST       │
│──────────────────────────────────────────────────────────────────────────────│
│ ⚠ если Docker недоступен:  ⓘ проверка из контейнера невозможна (хост-результат │
│    показан; различаем «стенд недоступен» и «Docker недоступен», §5.9)          │
│ ▸ Детали (Advanced):  response headers · redirect chain · IP · cert expiry    │
│ История:  12:00 ●200(84/121) · 11:30 ●200 · 10:05 ✖ timeout (из контейнера)   │
│ Статусы:  ● reachable   ⚠ slow(>1s)   ✖ unreachable   ⓧ TLS error  ⓘ Docker↓  │
└────────────────────────────────────────────────────────────────────────────────┘
```
- **Два источника** — с хоста и из контейнера (как раннер). Расхождение «хост ✔ / контейнер ✖» немедленно диагностирует блокер сети. Показывает HTTP-код, латентность, TLS, DNS.
- **Деградация при недоступном Docker** не выдаёт ложный `✖ unreachable`: отдельный статус `ⓘ Docker недоступен` (§5.9), таймаут/ретраи заданы.
- Idempotent, результат кэшируется как last-known для чипов Dashboard/wizard. Гард `environment.project_id == :pid`.

### 7.9 Login / Register / 2FA-настройка

```
9a Login                          9b Login — шаг 2FA              9c Self-Register
┌──────────────────────┐          ┌─────────────────────────┐    ┌────────────────────┐
│ ts-playwright   🌐RU/EN│        │ Введите 6-значный код    │    │ Внутренний инструм. │
│ Вход                  │          │  [ _ _ _  _ _ _ ]       │    │ Email/Login*[…]     │
│ Email/Login [anna@team]│        │ ☐ Доверять устройству 30д│    │ Пароль* [….] ▓▓▓ ok │
│ Пароль [●●●●●●] [👁]  │          │      [ Подтвердить ]     │    │ Повтор* [….]        │
│ [ Войти ]             │          │ [ Использовать backup ] │    │ [ Создать аккаунт ] │
│ Нет аккаунта? [Регистр]│        └─────────────────────────┘    └────────────────────┘
└──────────────────────┘
```
```
9d Настройка 2FA входа (Профиль → Безопасность):
┌─ Двухфакторная аутентификация (вход в инструмент) ──────────┐
│ Статус: ○ выключена                                          │
│ 1) QR ▒▒▒▒▒▒▒  или ключ: JBSW Y3DP EHPK 3PXP [копировать]   │
│ 2) Введите код для проверки  [ _ _ _ _ _ _ ]  [ Проверить ] │
│ 3) ✔ Код верный → 2FA включена                              │
│    Backup-коды: 8 шт. [Скачать][Перегенерить]               │
│                              [ Включить 2FA ]  [ Выключить ] │
└──────────────────────────────────────────────────────────────┘
```
- Сессии — серверные opaque, `HttpOnly; Secure; SameSite=Lax`; пароль Argon2id; rate-limit на `/login` (устраняет фейковый вход `store.ts:29`).
- 2FA входа **опциональна и отдельна** от 2FA стендов (другая иконка, другой раздел). Нельзя включить непроверенный секрет (confirm-enrollment) — защита от самоблокировки; backup-коды обязательны.

**Онбординг и владение аккаунтом (замыкаем путь регистрация → первый рабочий проект, без тупика):**
- **Bootstrap-admin** (`APP_BOOTSTRAP_ADMIN`) при первом запуске становится владельцем `account_default` (`memberships.role='admin'`, account-wide) — §9.3.
- **Гонка/пустая система:** саморегистрация **атомарна** относительно владения аккаунтом. Если `APP_BOOTSTRAP_ADMIN` не задан и система пуста — **первый успешно зарегистрировавшийся пользователь становится `admin` `account_default`** (одноразовый «claim» под транзакцией: проверка `NOT EXISTS membership account-wide admin` → вставка). Это закрывает кейс «зарегистрировался не-bootstrap первым».
- **Модель онбординга для не-первого пользователя — `self-register создаёт собственный account`.** Каждый самозарегистрированный пользователь, не попавший под claim выше, получает **свой `account_<userId>`** (он — `admin` в нём) и **дефолтный пустой проект** в нём. Это устраняет тупик «0 проектов, создать нельзя»: пользователь сразу admin своего аккаунта и может создать проект. Приглашение в чужой аккаунт (роль `viewer/operator`) — отдельный флоу через `/account/users` существующего admin.
  - DDL-следствие: при self-register создаются строки `accounts` + `memberships(account-wide, admin)` + первый `projects` (см. §9.3 п.0).
- После первого входа: если у пользователя 0 проектов и он admin своего аккаунта → `/projects` с активным CTA «Создать проект»; если он viewer в чужом аккаунте без проектов → экран «Ждите, пока администратор добавит вас в проект» (без мёртвой кнопки).

---

## 8. 2FA

### 8.1 Карта текущих механизмов (что СОХРАНЯЕМ как контракт)

Единая точка резолва — `input(name)` в рантайме контейнера (`runtime-template.ts:561-579`), самый load-bearing фрагмент. `liveTotp` (`:528-546`) — генерация с NTP-коррекцией и окном валидности (ждёт ≥20с в окне).

| Путь | Сегодня | СОХРАНЯЕМ |
|---|---|---|
| (a) `{{INPUT:2fa_otp}}` | `injectInputCalls` → `await input("2fa_otp")` (`process-source.ts:228-240`); `autoReplaceOtpFills` (`:78-144`) | имя `2fa_otp`, автозамену |
| (b) `{server_2faotp}` | `resolveSelectedBaseData` (`run-planner.ts:1018`) → если base32 → `otp_secrets` → `TOTP_SECRET_server_2faotp` (`execute.ts:552`) | имя `server_2faotp`, env-контракт |
| (c) on-demand код | `POST /api/accounts/code` → `generateTotpCodeSafeDetails` (`app.ts:343-368`, `otp.ts:54-88`) | формат ответа (без секрета) |
| (d) file-based TOTP | `resolveTotpSecretFromFile` (`runtime-template.ts:469-494`) | для локального нон-докер запуска |

**НЕЛЬЗЯ сломать (контракт):** сигнатуру `input(name)` и имена `2fa_otp`/`server_2faotp`; полиморфизм значения (код | TOTP-секрет | логин-для-файла); NTP-коррекцию `liveTotp` + `TOTP_CLOCK_DRIFT`; окно ≥20с; reuse `auth_state.json`.

### 8.2 Четыре новые находки сверх базы (что УЛУЧШАЕМ)

1. **🔴 `TOTP_SECRETS_FILE` не пробрасывается в Docker** (grep по `execute.ts` — 0 совпадений; `buildInputEnvArgs` кладёт только `INPUT_*`/`TOTP_SECRET_*`, `:546-555`). **Подтвердить отсутствие иного пути проброса:** в коде запуска контейнера нет volume-mount файла секретов (`docker run`/`create` монтируют только workspace/artefacts), поэтому file-based TOTP работает **только в локальном** запуске. **Решение:** в серверном/мультипроектном режиме — БД-резолв из `totp_secret_enc`, файл деприоритизировать (пометить «не для прод-сервера»); явно зафиксировать запрет volume-mount файла секретов в контейнер.
2. **🔴 On-demand-эндпоинт без NTP-коррекции** (`otp.ts:72` берёт `Date.now()` сервера), в отличие от рантайма (корректируется через `liveTotp`). При дрейфе сервера ручная проверка кода врёт, хотя run-путь работает. **Решение:** свести оба часовых домена к одному `queryNtpDrift`+кэш.
3. **🔴 Резолв 2FA завязан на глобальный строковый `login`** (`run-planner.ts:996`, `app.ts:352`) — прямой блокер мультипроекта. **Решение:** ключ `login` → `(project_id, credential_id)`.
4. **🔴 Plaintext `-e TOTP_SECRET_*`** виден в `docker inspect` (`execute.ts:551-552`). **Решение:** расшифровать в момент запуска → временный `--env-file` (chmod 600, удаляется в finally).

### 8.3 Слой (a) — TOTP стендов (ядро, project-scoped)

Целиком переезжает в `stand_credentials.totp_secret_enc` **внутри проекта**:

| Путь | В новой модели |
|---|---|
| `{{INPUT:2fa_otp}}` | без изменений в контейнере; секрет из project-scoped credential |
| `{server_2faotp}` | из `totp_secret_enc` выбранного в run credential этого проекта (§9.2), envelope-дешифровка |
| on-demand API | `POST /api/projects/:pid/credentials/:cid/code`; scope-гард; только admin; audit `credential.totp_code_issued` с `project_id` |
| file-based | без изменений (локально); на сервере — БД-резолв |

**Усиление:** секрет зашифрован (не plaintext `storage/accounts.json:5`); в run — `stand_credential_id`+`credential_version`, не сам секрет; retry перечитывает секрет по версии; on-demand нельзя вызвать на чужой проект.

### 8.4 Слой (b) — опциональная 2FA входа (account-scoped)

Терминология жёстко разведена: **Stand 2FA** (стенды, `server_2faotp`) vs **Login MFA** (вход, `users.totp_secret_enc`).

**Flow включения (на готовом `otp.ts`):** генерация секрета (**добавить `generateTotpSecret()`** — в `otp.ts` сегодня есть только `normalize`/`generate-code`/`queryNtpDrift`/`decodeBase32`, генератора секрета НЕТ, это честно помечено как «добавить»; base32-декодер уже есть, `otp.ts:186-201`) → QR + секрет один раз → **confirm-enrollment** (ввести код, проверка ±1 шаг) → только тогда сохранить и активировать. На логине: после пароля — шаг TOTP.

**Recovery-коды (нет в базе):** 8-10 одноразовых, показать один раз, хранить **хеши** (sha256), таблица `user_recovery_codes`; использование → audit `login.recovery_used` + предложение перенастроить.

### 8.5 Прозрачность 2FA в Timeline

- **Маркер генерации без секрета:** рантайм после `liveTotp` пишет структурную строку `[2fa] code for "server_2faotp" generated, valid 24s (cred: stand-admin)` → в Timeline маркер `🔐 2FA подставлен 12:04:25 · действ. 24с`. **Никогда не логировать код/секрет.**
- **Бейдж валидности секрета** при настройке (синхронный `normalizeTotpSecret`, `otp.ts:9-20`): `● валидный` / `✖ не base32` — вместо `alert(сырой текст)`.
- **Кнопка «тестовый код»** — `generateTotpCodeSafeDetails` через project-scoped эндпоинт; показать только `code`+`expires_in_sec`, секрет в ответе отсутствует (`app.ts:361-368`).
- **Индикатор дрейфа** на странице run: если `|drift| > 1 шаг` — предупреждение в маркере.

### 8.6 Безопасное хранение (envelope AES-256-GCM) + жизненный цикл KEK

- **Формат записи:** `enc:v1:<key_id>:<nonce>:<ciphertext+tag>`. DEK-on-record не нужен — шифруем напрямую KEK с **независимым nonce на каждую запись**; `key_id` идентифицирует версию KEK.
- **Где хранится KEK (явно, а не «один на инсталляцию»):** приоритет источников —
  1. внешний KMS/секрет-менеджер (`APP_KEK_PROVIDER=kms`, ARN/URI ключа) — рекомендуемо для прод;
  2. файл `APP_KEK_FILE` (chmod 600, вне репозитория, вне volume контейнеров) — дефолт для self-hosted;
  3. env `APP_KEK` — только dev.
  KEK **никогда** не пишется в БД и не монтируется в раннер-контейнеры (там только расшифрованные значения через `--env-file`, §8.2).
- **Ротация `key_id` (процедура, ранее отсутствовала):** новый KEK получает `key_id=v2`; фоновая задача `rekey` читает все `*_enc` со старым `key_id`, дешифрует старым, шифрует новым, переписывает запись (атомарно per-row, `version`-инкремент не требуется — значение то же). Старый KEK держится до завершения миграции, затем выводится. `enc:vN:key_id` позволяет старым и новым записям сосуществовать во время ротации. `credential_version` в `runs` версионирует **значение** секрета, а `key_id` — **ключ**; это две независимые оси.
- **Потеря KEK (план восстановления, а не «катастрофа»):** KEK — единственная точка отказа для всех стенд-секретов, поэтому:
  - **Бэкап KEK обязателен** и описан в runbook (вне БД-бэкапа, иначе бэкап БД содержит и шифртекст, и ключ — теряется смысл): хранить копию KEK в офлайн/KMS-бэкапе.
  - При безвозвратной потере KEK секреты нечитаемы → процедура восстановления: пометить все `*_enc` как `needs_reentry`, UI показывает `⚠ секрет требует повторного ввода` на затронутых credential/merchant, владелец перевводит значения. Прогоны до перевода падают честным `error` с кодом `secret_kek_lost`, а не молча.
  - Это переносит риск из «тихая невосстановимость» в «явный, заранее описанный re-entry», что и есть усиление относительно plaintext (где потеря файла = потеря данных без всякого плана).
- **Write-only:** API/DOM возвращают только `has_totp`/`has_password`.
- **Доставка в контейнер:** `-e TOTP_SECRET_*` → `--env-file` chmod 600 (правка `buildInputEnvArgs`, `execute.ts:546-555`), удаляется в `finally`.
- **Retry** перечитывает секрет заново из credential по версии — plaintext в истории run не остаётся.

---

## 9. Модель данных под мультипроект

### 9.1 Расширенный DDL (продолжение research 6.6.2: `team_id` → `account_id` + `project_id` scope-якорь)

```sql
-- A. Аккаунт (заменяет teams)
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- B. Проекты (team_id → account_id; id — стабильный ULID)
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, name)
);
CREATE INDEX idx_projects_account ON projects(account_id);

-- C. Membership двухуровневый (project_id NULL = account-wide)
--    Составной UNIQUE НЕ используем: NULL не участвует в UNIQUE (SQLite) → дубль account-wide.
--    Вместо него — два ЧАСТИЧНЫХ уникальных индекса (§2.6).
CREATE TABLE memberships (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('viewer','operator','admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX uq_membership_account_wide ON memberships(user_id, account_id)
  WHERE project_id IS NULL;        -- ≤1 account-wide членство на (user,account)
CREATE UNIQUE INDEX uq_membership_project ON memberships(user_id, project_id)
  WHERE project_id IS NOT NULL;    -- ≤1 членство на (user,project)
CREATE INDEX idx_memberships_user    ON memberships(user_id);
CREATE INDEX idx_memberships_project ON memberships(project_id);

-- D. Учётки стендов — project-scoped (бывш. AccountSchema, schemas.ts:77-83)
CREATE TABLE stand_credentials (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  login           TEXT NOT NULL,                  -- {server_username}
  password_enc    TEXT,                           -- enc:v1:<key_id>:... → {server_password}
  totp_secret_enc TEXT,                           -- enc:v1:<key_id>:... → {server_2faotp}
  needs_reentry   INTEGER NOT NULL DEFAULT 0,     -- 1 при потере KEK (§8.6)
  version         INTEGER NOT NULL DEFAULT 1,     -- credential_version в runs (версия ЗНАЧЕНИЯ)
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, login)                      -- login уникален В ПРЕДЕЛАХ проекта
);
CREATE INDEX idx_credentials_project ON stand_credentials(project_id);

-- E. Мерчанты — project-scoped; admin того же проекта (триггер: SQLite не умеет условный FK)
CREATE TABLE merchants (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,              -- {server_merchant}
  admin_credential_id TEXT REFERENCES stand_credentials(id) ON DELETE SET NULL,  -- сегодня null, см. §9.3
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, name)
);
CREATE INDEX idx_merchants_project ON merchants(project_id);
CREATE TRIGGER trg_merchant_admin_same_project
BEFORE INSERT ON merchants
WHEN NEW.admin_credential_id IS NOT NULL
  AND (SELECT project_id FROM stand_credentials WHERE id = NEW.admin_credential_id) <> NEW.project_id
BEGIN SELECT RAISE(ABORT, 'admin_credential must belong to the same project'); END;

CREATE TABLE merchant_environments (
  merchant_id    TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  PRIMARY KEY (merchant_id, environment_id)
);

-- F. Окружения — project-scoped (уже было корректно)
CREATE TABLE environments (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  base_url   TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  UNIQUE (project_id, name)
);

-- G. НОВАЯ: дефолты server_* проекта + произвольные server_*
CREATE TABLE project_server_vars (
  project_id                  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  default_stand_credential_id TEXT REFERENCES stand_credentials(id) ON DELETE SET NULL,
  default_merchant_id         TEXT REFERENCES merchants(id) ON DELETE SET NULL,
  extra_vars_json             TEXT NOT NULL DEFAULT '{}',  -- {"server_region":"eu",...}
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Секретные extra_vars хранятся как enc:v1:<key_id>:... ВНУТРИ json (тот же KEK); несекретные — открыто.

-- H. Пулы — project_id СТАЛ NOT NULL (было nullable=все проекты, schemas.ts:116)
CREATE TABLE pools (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('deposit_address','payout_address','trace_id','custom')),
  allocation_strategy     TEXT NOT NULL DEFAULT 'manual',
  template                TEXT,
  dedupe                  INTEGER NOT NULL DEFAULT 1,
  fetch_scenario_id       TEXT REFERENCES scenarios(id) ON DELETE SET NULL,
  auto_import_scenario_id TEXT REFERENCES scenarios(id) ON DELETE SET NULL,
  UNIQUE (project_id, name)
);
CREATE INDEX idx_pools_project ON pools(project_id);

-- I. Сценарии — стабильный ULID-якорь (research 6.6.3)
CREATE TABLE scenarios (
  id           TEXT PRIMARY KEY,                  -- СТАБИЛЬНЫЙ ULID (metadata.scenario_ulid)
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_path  TEXT NOT NULL,
  slug         TEXT NOT NULL,
  package_path TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, folder_path)
);
CREATE INDEX idx_scenarios_project ON scenarios(project_id);

-- J. Runs — ссылка на credential вместо plaintext + phase/outcome/batch
--    project_id денормализован для scope; ИММУТАБЕЛЕН после вставки (инвариант §2.6).
CREATE TABLE runs (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- = scenario.project_id на момент планирования
  scenario_id          TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  environment_id       TEXT REFERENCES environments(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','passed','failed','error')),
  phase                TEXT,                       -- queued|prepare|pull_image|create_container|execute|collecting|done
  outcome              TEXT,                       -- passed|failed|error|timeout|stopped|interrupted
  phase_timings_json   TEXT,                       -- {phase:{started_at,duration_ms,status}}
  stand_credential_id  TEXT REFERENCES stand_credentials(id) ON DELETE SET NULL,  -- НЕ password/2faotp
  credential_version   INTEGER,
  merchant_id          TEXT REFERENCES merchants(id) ON DELETE SET NULL,
  triggered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  batch_id             TEXT,
  execution_stage      INTEGER NOT NULL DEFAULT 1,
  retry_of_run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  runtime_snapshot     TEXT,                       -- адреса/trace_id + effects_applied, БЕЗ паролей
  artifacts_path TEXT, stdout_path TEXT, stderr_path TEXT, summary_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX idx_runs_project  ON runs(project_id);
CREATE INDEX idx_runs_scenario ON runs(scenario_id);
CREATE INDEX idx_runs_batch    ON runs(batch_id);
-- Инвариант §2.6(а): project_id иммутабелен
CREATE TRIGGER trg_runs_project_immutable
BEFORE UPDATE OF project_id ON runs
WHEN NEW.project_id <> OLD.project_id
BEGIN SELECT RAISE(ABORT, 'runs.project_id is immutable'); END;

-- K. НОВАЯ: агрегат батча (§6.4.1)
CREATE TABLE batches (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_json   TEXT,
  total        INTEGER NOT NULL,
  stages_total INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'planning'
                 CHECK (status IN ('planning','running','partial','done','failed','cancelled')),
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT
);

-- L. НОВАЯ: recovery-коды входа (§8.4)
CREATE TABLE user_recovery_codes (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   TEXT,
  PRIMARY KEY (user_id, code_hash)
);

-- M. НОВЫЕ: персистентная очередь + воркеры (§5.8) — см. полный DDL в §5.8
--    run_queue(run_id, project_id, batch_id, execution_stage, state, priority,
--              worker_id, lease_expires_at, enqueued_at, started_at)
--    workers(id, status, current_run_id, heartbeat_at)
```

### 9.2 Резолв `server_*` на примере (с честным разделением «конкретный сегодня» vs «после миграции»)

`resolveSelectedBaseData` получает `projectId` и фильтрует scope (псевдокод поверх `run-planner.ts:978-1021`):

```ts
function resolveSelectedBaseData(db, projectId, selection) {
  const psv = db.projectServerVars(projectId);
  const credId  = selection.stand_credential_id ?? psv.default_stand_credential_id;
  const merchId = selection.merchant_id        ?? psv.default_merchant_id;
  const cred     = credId  ? db.standCredential(projectId, credId)  : null; // WHERE project_id=? AND id=?
  const merchant = merchId ? db.merchant(projectId, merchId)        : null;
  if (credId && !cred)      throw new Error("Credential not in this project");
  // admin мерчанта — ТОЛЬКО в том же проекте (было глобально, run-planner.ts:1001-1002)
  const merchantAdmin = merchant?.admin_credential_id
    ? db.standCredential(projectId, merchant.admin_credential_id) : null;
  const resolved = cred ?? merchantAdmin;
  const password   = selection.server_password ?? (resolved ? decrypt(resolved.password_enc) : "");
  const totpSecret = selection.server_2faotp   ?? (resolved ? decrypt(resolved.totp_secret_enc) : "");
  return {
    project_id: projectId,
    stand_credential_id: resolved?.id ?? null,
    credential_version:  resolved?.version ?? null,   // снимок ВЕРСИИ в run, не значение
    server_username: selection.server_username ?? resolved?.login ?? psv.extra_vars.server_username ?? "",
    server_password: password,
    server_2faotp:   totpSecret,                      // секрет; код генерится в контейнере
    server_merchant: selection.server_merchant ?? merchant?.name ?? psv.extra_vars.server_merchant ?? "",
    extra_vars: psv.extra_vars                         // произвольные server_*
  };
}
```

**Пример A — РЕАЛЬНЫЕ данные сегодня (честный «конкретный run», без вымысла).**
В текущем хранилище: `storage/accounts.json` — одна учётка `botuser1` (пароль `botuser1`, 2FA-секрет `PNYTA2LU…J2KFZ2A`); `storage/merchants.json` — три мерчанта (`botmerch1205 (1205)`, `merchantbot (b001)`, `MaxMerchStage (Max)`), у **всех трёх `admin_login=null`**. Значит цепочки `merchant → admin-credential` сейчас **не существует** — её нечем пройти. Единственный рабочий резолв сегодня — **прямой выбор credential** (без мерчанта):
```
вход:   { project_id:"project_default", stand_credential_id:"cred_botuser1" }
        // merchant_id можно выбрать (напр. merch_max), но admin_credential_id=NULL →
        // merchantAdmin=null, на резолв credential не влияет
scope:  standCredential(project_default, cred_botuser1)   // тот же проект — ок
        merchant(project_default, merch_max) → admin_credential_id = NULL → merchantAdmin = null
        resolved = cred ?? merchantAdmin = cred_botuser1
дешифр: password_enc → "botuser1";  totp_secret_enc → "PNYTA2LU…J2KFZ2A"
итог:   server_username=botuser1; server_password=botuser1;
        server_2faotp=PNYTA2LU… (валидный base32 → otp_secrets);
        server_merchant=MaxMerchStage (Max)   // ИМЯ мерчанта берётся, а credential — НЕ от мерчанта
        extra_vars={server_region:"eu"}        // если заданы в ProjectServerVars
бинды:  INPUT_server_username=botuser1; INPUT_server_password=botuser1;
        --env-file: TOTP_SECRET_server_2faotp=PNYTA2LU… (chmod 600, не -e);
        INPUT_server_merchant=MaxMerchStage (Max); INPUT_server_region=eu (новое из extra_vars)
в run:  stand_credential_id=cred_botuser1, credential_version=1  (НЕ password/2faotp plaintext)
```
Здесь имя мерчанта `{server_merchant}` подставляется, а сам credential выбран **напрямую**, потому что у мерчанта нет привязанного admin. Это полностью соответствует данным.

**Пример B — ГИПОТЕТИЧЕСКИЙ (после ручной пост-сегрегации, §9.3 п.4).**
Когда оператор вручную проставит `MaxMerchStage.admin_credential_id = cred_botuser1` (в UI Merchants, §7.7), заработает цепочка merchant→admin:
```
вход:   { project_id:"project_default", merchant_id:"merch_max" }   // credential НЕ выбран явно
scope:  merchant(project_default, merch_max) → admin_credential_id = cred_botuser1 (проставлен вручную)
        standCredential(project_default, cred_botuser1)             // тот же проект — ок
        resolved = cred(null) ?? merchantAdmin(cred_botuser1) = cred_botuser1
итог:   тот же server_username/password/2faotp, что в примере A, но credential получен ЧЕРЕЗ мерчанта.
```
Пример B помечен гипотетическим намеренно: **пока `admin_login`/`admin_credential_id` не проставлен, ветка merchant→admin даёт `merchantAdmin=null`**, и без явного `stand_credential_id` резолв вернёт пустые `server_username/password` (см. ветку `resolved=null` в коде). Поэтому в продакшене после миграции (§9.3) обязателен шаг ручной привязки admin к мерчантам.

**Изоляция (общая для A и B).** Если в другом проекте `proj_deposits` есть credential с login `botuser1` другим паролем — резолв `project_default` его **не увидит** (фильтр `WHERE project_id`). Межпроектная утечка секрета невозможна на уровне выборки.

`buildServerInputBindings` (`run-planner.ts:1023-1046`) и `resolveServerValueTemplate` (`:1057-1086`) меняются минимально: цикл по `extra_vars` для произвольных `{server_*}`-токенов (сегодня жёстко 4 имени, `:1060-1082`). Контейнерная часть (`execute.ts:546-554`) не меняется — `TOTP_SECRET_*`/`INPUT_*` остаются контрактом.

### 9.3 Миграция глобальных данных в project-scoped

Ключевая проблема: `storage/accounts.json` (1 запись `botuser1`), `storage/merchants.json` (3 мерчанта, **у всех `admin_login=null`**) — глобальные, без `project_id`. Сценарии **уже** несут `metadata.project_id` (`schemas.ts:39`; seed `proj_demo`). Какому проекту принадлежит `botuser1` — из данных не выводится, поэтому механически раскидать нельзя.

**Решение — единый приёмник + ручная пост-сегрегация:**
0. **Self-register / онбординг (новое, §7.9):** на каждого нового пользователя при саморегистрации создаются `accounts(account_<userId>)` + `memberships(account-wide, admin)` + первый пустой `projects`. Это замыкает путь регистрация→рабочий проект для не-первых пользователей и не пересекается с миграцией исторических данных (она идёт в `account_default`).
1. **Bootstrap:** `account_default` (owner = bootstrap-admin, либо первый зарегистрировавшийся под claim, §7.9) + `project_default`. Для каждого уникального `metadata.project_id` (включая `proj_demo`) — строка `projects` с этим id как ULID (id сохраняется, чтобы сценарии резолвились).
2. **Сценарии:** сгенерировать ULID, записать `scenario_ulid` в `metadata.json`, построить карту `old_sha1_id → new_ulid` (`old` = `buildStableScenarioId`, `store.ts:528-531`). Снимает риск «переименование папки ломает id».
3. **Credentials:** `accounts.json` → `stand_credentials` с `project_id=project_default`, шифрование `password`/`2fa_otp` → `*_enc` под текущим `key_id`, `version=1`. Всё сперва в `project_default` — потерять нельзя.
4. **Merchants:** `merchants.json` → `merchants` с `project_id=project_default`; **`admin_login` сейчас `null` у всех трёх**, поэтому `admin_credential_id` мигрирует как `NULL`. **Привязку admin к мерчанту оператор проставляет вручную** в UI Merchants после миграции (без неё ветка merchant→admin даёт пустые `server_*`, см. §9.2 пример B). Это явный, а не подразумеваемый шаг.
5. **Pools/PoolItems:** `null → project_default` (теперь NOT NULL); `fetch_scenario_id`/`auto_import_scenario_id` перемапить через карту old→new.
6. **Runs:** `triggered_by` → `triggered_by_user_id` (резолв по login, иначе NULL); `scenario_id` через карту; `project_id` := `scenario.project_id` (инвариант §2.6); plaintext `server_password`/`server_2faotp` **не переносятся** — вместо них `stand_credential_id`+`credential_version`.
7. **Пост-сегрегация (ручная, в UI):** «Переместить credential/merchant в проект X» + «Привязать admin-credential к мерчанту» — автоматика принадлежность не угадает. `cabinet_users` не переносятся.

Откат: удалить БД, вернуть `.migrated`, `scenario_ulid` игнорируется старым кодом.

### 9.4 Изоляция

Видимые проекты — одним запросом по двухуровневому членству:
```sql
SELECT p.* FROM projects p
WHERE p.account_id IN (SELECT account_id FROM memberships WHERE user_id=:uid AND project_id IS NULL)
   OR p.id        IN (SELECT project_id FROM memberships WHERE user_id=:uid AND project_id IS NOT NULL);
```
Гард-`preHandler` (заменяет проверку cabinet-cookie, `app.ts:117-124`): резолвит User из сессии → извлекает `:project_id` → `effectiveRole(user,project)` (project-level, иначе account-wide); `null` → **404**; для подчинённых сущностей — `entity.project_id == :project_id` (anti-IDOR). **Тот же гард обязателен для SSE-стримов и POST-команд** (§5.4): стримы авторизуются сессионной cookie (`withCredentials`), без чего возникал бы IDOR на стримах. Главная утечка бизнес-логики (`run-planner.ts:996,999,1002`) закрывается scope-фильтром (§9.2). Superadmin видит всё (bootstrap/аудит).

---

## 10. Влияние на дорожную карту

Эталон — фазы research (Фаза 0 агент, Фаза 1 безопасность/auth, Фаза 2 данные SQLite, Фаза 3 UI SPA + персистентная очередь). Ниже — дельта под мультипроект, real-time и завершаемость.

### Фаза 2 (данные) — новые под-эпики

| Под-эпик | Дельта к research | Грубая оценка |
|---|---|---|
| 2.M1 `account/project` scope-якорь | `team_id` → `account_id`+`project_id` на всех рабочих таблицах; `memberships` двухуровневые + **частичные уникальные индексы** (§2.6) | M |
| 2.M2 StandCredential/Merchant/Pool project-scoped | +`project_id`, `UNIQUE(project_id,…)`, триггер admin-same-project, `pools.project_id` NOT NULL | M |
| 2.M3 `ProjectServerVars` + произвольные `server_*` | новая таблица G; цикл `extra_vars` в резолвере | S-M |
| 2.M4 Резолв `server_*` project-scoped | переписать `resolveSelectedBaseData` с `WHERE project_id` (§9.2); закрыть `run-planner.ts:996,999,1002` | M |
| 2.M5 Миграция в `project_default` + пост-сегрегация | единый приёмник, карта old→new ULID, UI «переместить в проект» + «привязать admin к мерчанту» | M |
| 2.M6 Run без plaintext-секрета + инвариант project_id | `stand_credential_id`+`credential_version`; иммутабельный `runs.project_id` (триггер, §2.6); retry перечитывает по версии | S-M |
| 2.M7 2FA at-rest + KEK lifecycle + доставка | `totp_secret_enc`; KEK-хранение/ротация/потеря (§8.6); `-e` → `--env-file` chmod 600; деприоритет file-based | M |
| 2.M8 Поля `phase/outcome/phase_timings`, `batches`, `effects_applied` | новые колонки + агрегат батча + флаг идемпотентности эффектов | M |
| 2.M9 Персистентная очередь + воркеры | `run_queue`/`workers` (§5.8), диспетчер с лизами вместо `queueMicrotask`; **блокирующая зависимость для 3.M3/3.M5** | M-L |

### Фаза 3 (UI) — новые под-эпики

| Под-эпик | Дельта к research | Грубая оценка |
|---|---|---|
| 3.M1 Двухуровневая навигация + project switcher | рельс расщеплён account/project; switcher, URL-первичность, cookie `last_project`, 5 механизмов изоляции | L |
| 3.M2 Переезд Credentials/Merchants/Pools/Variables в `/p/:pid/*` | + экран `/p/:pid/variables` (матрица разрешимости) | M |
| 3.M3 Real-time SSE | `/runs/:id/stream`, `/stream/execution`, `/stream/health`, `/batches/:id/stream`; **авторизация стримов сессией + scope-гард + бэкпрешер** (§5.4); отказ от poll+reload; Timeline по `phase`; live-консоль follow | L |
| 3.M4 Run-wizard `<RunConfig>` | 3 шага, project-scoped резолв, предпросмотр подстановки, единый компонент (устранить дубль `html.ts:1236`/`2760`) | M-L |
| 3.M5 Экран батча + завершаемость | `/p/:pid/batches/:bid`, Retry failed, Stop remaining, «Дозавершить» | M |
| 3.M6 Панель доступности стенда | `POST /api/environments/:id/reachability` (хост+контейнер, таймаут/ретраи, различение «стенд↓ vs Docker↓», §5.9) | M |
| 3.M7 Login/Register/2FA-настройка + онбординг | заменить cabinet-выбор; confirm-enrollment, backup-коды, маркер 🔐; self-register создаёт свой account, claim первого admin (§7.9) | M |
| 3.M8 RU/ENG + серверные ошибки | словарь `{ru,en}` + `t()`, переключатель, линт-правило, **каталог кодов error.*** (§3.3) | S-M |
| 3.M9 Завершаемость флоу + Stop-механика | реестр процессов + `AbortSignal` + детерминированное имя контейнера (§6.7); `Stop` (run/батч), `effects_applied`, batch-aware recover; `scenario_ulid` upsert-upload + resume записи | M-L |

### Зависимости и порядок

- **3.M3 (real-time), 3.M5 (батч-завершаемость), 5.7-5.8 (виджет/очередь) опираются на 2.M9 (персистентная очередь)** — без неё Execution-виджет нечем наполнить честно, а дозавершение умрёт при рестарте. Это блокирующая зависимость, и теперь она спроектирована (DDL `run_queue`/`workers`, §5.8), а не только упомянута.
- **3.M9 (Stop) опирается на реестр процессов и проброс `AbortSignal` в раннер** (§6.7) — без них Stop архитектурно недостижим (нет ссылки на `child`/контейнер). Требует правки `execute.ts` (возврат `child`, `signal`, детерминированный `--name` в bind+copy).
- **3.M1-M2 опираются на 2.M1-M2** (scope-якорь): без `project_id` на таблицах рельс показывать нечего.
- **3.M4/wizard опирается на 2.M4** (резолв project-scoped): предпросмотр подстановки требует корректного источника.
- **8.x (2FA) проходит через 2.M6/2.M7** (ссылка на credential + at-rest + KEK lifecycle) и 3.M7 (UI).

**Суммарная дельта сверх research:** ~9 под-эпиков данных (с одним M-L: персистентная очередь) + ~9 под-эпиков UI (с тремя L/M-L: навигация-мультипроект, real-time SSE, Stop-механика+завершаемость). Самостоятельные новые блоки, отсутствовавшие в базе целиком: project switcher с изоляцией, экран `/variables`, агрегат `batches` + batch-aware recover, **персистентная очередь+воркеры (`run_queue`/`workers`)**, **реестр процессов для Stop**, панель доступности стенда (с различением Docker↓), project-scoped on-demand 2FA, **KEK-lifecycle**, RU/ENG-словарь с каталогом серверных ошибок.
