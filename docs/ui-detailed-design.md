# Детальный дизайн интерфейса ts-playwright (экраны, сценарии, ASCII-моки)

> Рабочий документ для реализации UI. Дополняет docs/ui-redesign-spec.md (утверждённая UI-спецификация) и docs/ui-deploy-research.md (базовое исследование) детальными макетами каждого экрана и пользовательского сценария — сервер и агент. Главные критерии: ПРОЗРАЧНОСТЬ, ПОНЯТНОСТЬ, REAL-TIME статусы. Все макеты используют единую дизайн-систему (раздел 2).

## 1. Как читать документ

- Раздел 2 — общая дизайн-система и стек (токены, компоненты, конвенции). Все моки ниже опираются на неё.
- Разделы 3-8 — экраны по областям (сервер и агент), каждый экран с моками всех значимых состояний.
- Раздел 9 — сквозные end-to-end сценарии, связывающие экраны.
- Раздел 10 — дополнения и исправления по итогам ревью полноты.

---

## 2. Дизайн-система и стек


---


> Эталонный контракт. На него опираются все дизайнеры экранов. Привязан к `docs/ui-redesign-spec.md` (раздел 1 «Принципы», раздел 4 «Дизайн-язык», раздел 5 «Real-time») и `docs/ui-deploy-research.md` (раздел 4.6 «SSR vs SPA»). Все ссылки на код проверены.

### 0. Что заменяем (исходная точка)

Текущий UI — один файл `apps/server/src/html.ts` (4297 строк), где CSS = константа `BASE_CSS` (`html.ts:20-136`), а JS живёт строками внутри TS-шаблонов. Что конкретно уходит:

- `BASE_CSS` с 7 цветами в `:root` (`html.ts:21-29`), без тёмной темы, без семантики статусов (`badge-failed` и `badge-error` слиты в один красный — `html.ts:57`). → токены §2.
- `page(title, body, script)` без рельса и шапки (`html.ts:4182-4195`). → `AppShell` §3.
- Секрет в DOM: `input.value = account.password` / `account["2fa_otp"]` (`html.ts:458-460`). → write-only `SecretField` §3, конвенция §4.6.
- `describeRunProgress(run)` парсит текст последней лог-строки и возвращает «This page refreshes automatically» (`html.ts:3527-3540`). → `PhaseTimeline` §3 на типизированном `phase`.
- ~17 вызовов `location.reload()` (`html.ts:470,478,...,3616`) + `setInterval(refreshRun, 2000)`. → SSE + точечный патч §5.
- Голый `confirm()` / `alert(сырой_текст)`. → `ConfirmDialog` + `Toast` §3.
- `.filter-grid` на 7 колонок, run-модалка-полотно. → `Table` с фильтр-чипами + `Wizard` §3.

Фактический контракт статусов, который НЕЛЬЗЯ ломать: `RunStatusSchema = ["queued","running","passed","failed","error"]` (`schemas.ts:169`). `timeout/stopped/interrupted` — надстройка `outcome` (spec §5.1), а не новые значения `status`. Дизайн-система визуализирует **обе оси**.

---

### 1. ТЕХНОЛОГИЧЕСКИЙ СТЕК

### 1.1 Сводная таблица (рекомендация + обоснование)

| Слой | Выбор | Обоснование под этот продукт |
|---|---|---|
| Язык/сборка | **TypeScript 5.8 + Vite 5** | TS уже в монорепо (`package.json:23`); Vite — мгновенный HMR для stateful-интерактива (timeline, wizard), tree-shaking, нативный ESM. Подтверждает research 4.6. |
| UI-фреймворк | **React 18** | Нужен stateful интерактив с живыми данными (research 4.6 явно отвергает htmx как целевую). Concurrent-рендер сглаживает поток SSE-логов. |
| Роутинг | **React Router 6 (data router)** | URL — источник истины для проекта (`/p/:pid/*`, spec §2.3). `loader`/`useParams` дают project-scope из пути; `404` от гарда (spec §3.2) ложится на `errorElement`. |
| Server-state | **TanStack Query 5** | Кэш + дедупликация + поллинг-фолбэк, когда `EventSource` недоступен (spec §5.4). `queryClient.setQueryData` — точечный патч из SSE без рефетча. Инвалидация по `runId`/`projectId`. |
| Real-time | **Своя обёртка `useEventSource` над нативным `EventSource`** | SSE выбран в spec §5.4 (однонаправленный, поверх Caddy без апгрейда, авто-reconnect с `Last-Event-ID`). Обёртка: типизированные события (`run.phase`/`run.log`/`run.status`/`run.artifact`), `withCredentials:true` (сессионная cookie, spec §5.4), бэкпрешер-маркер `{dropped:N}`, фолбэк на `useQuery` poll 3-5с. Команды (run/stop/retry) — обычный POST через Query-mutations. |
| Формы | **React Hook Form 7 + `@hookform/resolvers/zod`** | RHF — неконтролируемые поля, минимум ре-рендеров (важно для wizard с десятками полей, spec §4.3). |
| Валидация/схемы | **Переиспользование Zod-схем из `@ts-playwright/shared`** | `RunCreateBodySchema`, `FolderRunCreateBodySchema`, `AccountUpsertBodySchema` и т.д. уже есть (`schemas.ts:231,242,275`). Один контракт сервер↔клиент. Zod 3.25 уже в дереве. **Новые `*_enc`/secret-поля валидируются как write-only** (см. §4.6). |
| Стилизация | **Свои CSS-токены (CSS custom properties) + утилитарные классы; БЕЗ Tailwind** | См. §1.2 — обоснование. |
| Примитивы поведения | **Radix UI primitives** (Dialog, Popover, Tabs, Tooltip, Toast, DropdownMenu, Checkbox) | См. §1.2. Берём поведение и a11y, рисуем своими токенами. |
| Иконки | **Lucide React** | Тонкие 1.5px-штрихи под «ненагруженный» дизайн; tree-shakeable (импорт по иконке); закрывает весь набор статусов §4.1. |
| Графики (дашборд) | **Recharts** (или uPlot для тяжёлых лог-метрик) | Декларативный, React-нативный, лёгкий. Дашборду нужны спарклайны длительностей и бары concurrency (spec §5.7) — не тяжёлая аналитика. uPlot — резерв, если понадобится рендер тысяч точек drift/NTP. |
| i18n | **Свой `t(key)` + плоский словарь `{ru,en}`; БЕЗ i18next** | Прямое требование spec §3.3: «плоский словарь, без i18n-фреймворка». ~180-240 ключей. См. §1.3. |
| Тесты | **Vitest** (юнит/компоненты, уже в монорепо `package.json:17,24`) + **@testing-library/react** + **Playwright** (e2e — уже основной инструмент проекта) + **MSW** (мок API/SSE) | Один тест-раннер с сервером. Storybook (опц.) для визуальной регрессии каталога компонентов §3. |
| Backend под UI | **Fastify 5 остаётся** как чистый JSON+SSE API + раздача бандла | Research 4.6: «Fastify остаётся как чистый JSON+SSE API и статика бандла». Уже `fastify@5.2.1` (`apps/server/package.json:15`). |

### 1.2 Библиотека компонентов: строим свою на Radix-примитивах (НЕ Tailwind, НЕ готовый kit)

**Рекомендация: гибрид — поведение из Radix UI primitives, визуал полностью свой на CSS-токенах. shadcn-подход (копируем компонент в репозиторий, не зависим от версии kit), но БЕЗ Tailwind.**

Почему так, а не иначе:

1. **Почему не «полностью своя с нуля».** Доступный модальный фокус-трап, `aria`-роли табов, позиционирование тултипа/поповера, управление фокусом в меню — это месяцы работы и источник багов. Radix решает именно *поведение и a11y*, не навязывая визуал. Каталог §3 (Modal, Tabs, Tooltip, DropdownMenu, Toast, Popover) ложится на Radix 1:1.

2. **Почему не Tailwind.** Продукт «ненагруженный» и **плотный** (spec §1 столп 3, §4.3) — ключевая ось дизайна это *семантика статусов* и *плотность*, выражаемые токенами, а не утилитами. Tailwind-классы в плотном статус-ориентированном UI дают длинные нечитаемые `className` и размывают семантику (`text-emerald-700` вместо `--status-passed-fg`). Семантический токен `--status-running` переживает смену темы и редизайн; утилита `text-blue-600` — нет. CSS custom properties уже знакомы команде (`BASE_CSS` это `:root`-переменные, `html.ts:21-28`) — эволюция, не революция.

3. **Почему не готовый kit (MUI/Ant/Chakra).** Они несут собственный «голос» дизайна и вес рантайма, противоречат «без шума» и плотности. Их темизация — борьба с дефолтами.

4. **Почему shadcn-подход к владению кодом.** Компоненты §3 копируются в `packages/ui` монорепо (исходники, не зависимость), версионируются вместе с продуктом, правятся под наши токены. Никакой блокировки версией внешнего kit.

**Итог стека UI-библиотеки:** `packages/ui` = Radix primitives (поведение) + наши `tokens.css` + тонкие React-обёртки (`<Button>`, `<StatusBadge>`, `<Table>` …) + Lucide иконки. Импортируется и сервером (для редких SSR-страниц логина), и SPA.

### 1.3 i18n: контракт `t()` и словарь

Реализация ровно по spec §3.3 (плоский словарь, fallback `ru → en → key`, ~30 строк хука):

```
packages/shared/locales/ru.ts   // Record<string,string>
packages/shared/locales/en.ts
packages/ui/i18n/I18nProvider.tsx + useT()
```

Ключи структурированы префиксами: `nav.*`, `run.*`, `status.*`, `phase.*`, `error.*`, `action.*`, `field.*`. **Серверные ошибки — через каталог кодов** (spec §3.3): API отдаёт `{code, params, message_en}`, клиент мапит `t("error."+code, params)`, `message_en` — fallback. Каталог `error.*` живёт в тех же файлах (~30-40 кодов: валидация резолва, Docker, OTP). Переключатель `🌐 RU/EN` — в `[user ▾]` + на Login/Register, пишет cookie `lang` (server-side), мгновенный ре-рендер. Литералы в JSX запрещены линт-правилом `eslint-plugin-i18next/no-literal-string`. **НЕ переводим:** имена проектов/логины, `{server_*}`-плейсхолдеры, `trace_id`/`TOTP`, лог-строки контейнера.

### 1.4 Структура пакетов

```
packages/
  shared/    Zod-схемы (есть) + locales/{ru,en}.ts + типы событий SSE
  ui/        tokens.css · primitives (Radix-обёртки) · компоненты §3 · i18n · icons
apps/
  server/    Fastify: JSON+SSE API, раздача бандла, SSR только /login,/register (page() §0 переживает до конца миграции)
  web/        НОВЫЙ: React+TS+Vite SPA, монтируется на /app/* (strangler, research 4.6 шаг 2)
```

Strangler-миграция (research 4.6): SPA на `/app/*`, легаси `html.ts` живёт параллельно; мигрируем по ценности (прогон+timeline+live-логи → дашборд/очередь → дерево → кабинет → users/settings), в конце удаляем `html.ts`.

---

### 2. ДИЗАЙН-ТОКЕНЫ

Единственный источник правды — `packages/ui/tokens.css`. Имена семантические, не «цветовые». Светлая/тёмная темы через `[data-theme]`. Цвет проекта — отдельная ось (`hash(projectId)`, spec §2.4.1), накладывается поверх нейтралей, не путается со статусами.

### 2.1 Палитра — нейтральные (база «без шума»)

```
            LIGHT (data-theme=light)      DARK (data-theme=dark)
--bg          #f6f7f9  (как сейчас)        #0e1116
--surface     #ffffff                      #161b22   (карты, таблицы)
--surface-2   #fbfbfb  (как сейчас .card)  #1c222b   (вложенные)
--overlay     rgba(13,17,23,.55)           rgba(0,0,0,.65)   (modal backdrop)
--text        #1f2937  (как сейчас)        #e6edf3
--text-muted  #6b7280  (как сейчас)        #8b949e
--text-faint  #9ca3af                      #6e7681
--border      #e5e7eb  (как сейчас)        #2d333b
--border-strong #d1d5db                    #3d444d
--focus-ring  #2563eb  (2px, всегда видим) #4493f8
```

### 2.2 Акцент (один, нейтральный — primary-CTA)

```
--accent        #2563eb (как сейчас --accent)   dark: #4493f8
--accent-hover  #1d4ed8                          dark: #58a6ff
--accent-fg     #ffffff                          dark: #0e1116
--accent-subtle #eff6ff  (фон выделения строки)  dark: #122031
```

### 2.3 СЕМАНТИКА СТАТУСОВ (ядро системы) — по spec §4.4 и §5.3

Каждый статус = тройка `{--status-X (основной), --status-X-bg (плашка badge), --status-X-fg (текст на плашке)}` + закреплённый глиф и иконка (см. §4.1). Чинит слияние `failed`/`error` в один красный (`html.ts:57`).

```
STATUS          ЦВЕТ      LIGHT bg / fg              DARK bg / fg            ГЛИФ  СМЫСЛ
queued          серый     #eef2ff / #3730a3          #1c2333 / #a3b3d6       ⋯    ждёт воркера/стадию
running          синий     #e0f2fe / #075985 (пульс)  #0d2b3e / #79c0ff       ⟳    исполняется (анимация §6)
passed          зелёный   #dcfce7 / #166534          #0f2e1a / #56d364       ✔    тест прошёл
failed          красный   #fee2e2 / #991b1b          #3a1518 / #ff7b72       ✖    assertion упал (ТЕСТ)
error           янтарный  #fef3c7 / #92400e          #3a2c0a / #e3b341       ⚠    инфраструктура (Docker/pull)
timeout         янтарный  #fef3c7 / #92400e          #3a2c0a / #e3b341       ⚠    kill по таймауту
stopped         серый     #f3f4f6 / #4b5563          #21262d / #8b949e       ⏹    остановлен юзером
interrupted     янтарный  #fef3c7 / #92400e          #3a2c0a / #e3b341       ⚠    сервер перезапускался
2fa             фиолетовый #ede9fe / #6d28d9          #251a3d / #b794f6       🔐   момент подстановки 2FA
```

**Дизайн-инвариант (spec §4.4, §5.3):** `failed` (красный, «тест») и `error/timeout/interrupted` (янтарный, «инфраструктура») — РАЗНЫЕ цвета. Это главное смысловое различие всей системы. `error/timeout/interrupted` делят янтарный, но различаются глифом+подписью (`⚠ timeout` vs `⚠ interrupted`).

Вспомогательные семантические (для reachability §5.9, health §5.7):
```
--reach-ok      = --status-passed     ● reachable
--reach-slow    = --status-error      ⚠ slow >1s
--reach-fail    = --status-failed     ✖ unreachable
--reach-tls     #b45309 / янтарный    ⓧ TLS error
--reach-docker  --text-muted          ⓘ Docker недоступен (НЕ ложный fail, spec §5.9)
```

### 2.4 Типографика

```
--font-ui    "Inter", "Segoe UI", system-ui, sans-serif   (заменяет голый Segoe UI, html.ts:31)
--font-mono  "JetBrains Mono", Consolas, "SF Mono", monospace  (логи/код/id/латентность)

РОЛИ (mono ОБЯЗАТЕЛЕН для): trace_id, run.id, container name, лог-строки,
   латентность (84ms), drift (12ms), TOTP-код, base32-секрет, exit_code.

ШКАЛА (компактная, плотный продукт):
--text-xs   11px / 16   (бейджи, метки колонок, th uppercase — как html.ts:50)
--text-sm   12px / 18   (таблицы, метаданные — плотность по умолчанию)
--text-base 13px / 20   (основной body — плотнее текущих 16px)
--text-md   15px / 22   (заголовки карт, h2)
--text-lg   20px / 28   (h1 страницы — было 24px, html.ts:36)
--text-xl   24px / 32   (редко: дашборд-числа)
--weight: 400 / 500 (medium, акценты) / 600 (semibold, заголовки) / 700 (badge level)
```

### 2.5 Отступы, радиусы, тени

```
ШКАЛА ОТСТУПОВ (4px-сетка):
--space-1 4px  --space-2 8px  --space-3 12px  --space-4 16px
--space-5 20px --space-6 24px --space-8 32px  --space-12 48px

РАДИУСЫ:
--radius-sm 4px   (inputs/кнопки — как html.ts:42)
--radius-md 6px   (карты, поповеры — как html.ts:42 .btn)
--radius-lg 8px   (модалки, секции)
--radius-pill 999px (badge — как html.ts:55)

ТЕНИ (сдержанные, «без шума»):
--shadow-1  0 1px 2px rgba(0,0,0,.05)          (карта в покое)
--shadow-2  0 2px 10px rgba(0,0,0,.06)         (как html.ts:34 .container)
--shadow-3  0 4px 24px rgba(0,0,0,.18)         (модалка — как html.ts:62)
--shadow-pop 0 6px 16px rgba(0,0,0,.12)        (dropdown/tooltip)
   dark: тени глубже + 1px светлый внутренний кант border-strong
```

### 2.6 Плотность (компактный режим)

```
--density: comfortable | compact   (атрибут на <body data-density>)

                       comfortable     compact (по умолчанию для таблиц/дерева)
--row-h               40px            32px
--cell-pad-y          10px (html.ts:49) 6px
--control-h           34px            28px
--tree-indent         16px            14px
```
Компактный режим — дефолт для плотных поверхностей (таблицы runs/credentials, дерево сценариев); comfortable — для форм/визардов. Переключатель в `[user ▾]`.

### 2.7 Z-уровни (единая лестница — чинит хаос `z-index:100` html.ts:60)

```
--z-base        0
--z-sticky      10    (sticky-шапки таблиц, th)
--z-rail        20    (левый рельс / switcher dropdown)
--z-header      30    (верхняя шапка с глоб. индикаторами)
--z-overflow    40    (dropdown ⋯, поповеры, тултипы)
--z-modal-bg    50    (overlay)
--z-modal       60    (modal box)
--z-toast       70    (NotificationCenter поверх всего)
```

### 2.8 Цвет проекта (отдельная ось, НЕ статус)

`hash(projectId) → индекс` по фиксированной палитре из 8 спокойных оттенков (teal, indigo, amber, rose, violet, cyan, lime, slate). Используется ТОЛЬКО как: полоса слева от switcher, тонкий акцент-кант шапки, точка перед именем проекта в крошках (spec §2.4). Намеренно приглушённые тона, чтобы не конкурировать с семантикой статусов. Токены: `--project-accent` (вычисляется на лету, задаётся inline-стилем на `AppShell`).

---

### 3. КАТАЛОГ КОМПОНЕНТОВ

Каждый компонент: назначение + что заменяет в `html.ts` + ASCII всех состояний.

### 3.1 StatusBadge

**Назначение:** единое визуальное представление статуса/исхода прогона и состояния секрета. Принимает `status | outcome` (ось spec §5.1) ИЛИ `secret: set|notset`. Заменяет `.badge-*` (`html.ts:55-58`, где failed=error) и секрет в DOM (`html.ts:459`).

```
RUN-СТАТУСЫ (глиф + текст + цвет §2.3):
 ⋯ queued      синий-серый плашка
 ⟳ running     синяя плашка, глиф пульсирует (§6)
 ✔ passed      зелёная
 ✖ failed      красная        ("тест упал · assertion")
 ⚠ error       янтарная       ("инфраструктура")
 ⚠ timeout     янтарная       ("по таймауту")
 ⏹ stopped     серая          ("остановлен · anna")
 ⚠ interrupted янтарная       ("сервер перезапускался")
 🔐 2fa        фиолетовая     (маркер, не статус run)

SECRET-БЕЙДЖ (write-only, §4.6):
 ● set          зелёная точка     "задан"
 ○ not set      пустая серая      "не задан"
 ⚠ needs re-entry янтарная        (потеря KEK, spec §8.6)

РАЗМЕРЫ:  [sm] в таблицах  ·  [md] в шапке прогона
СОСТОЯНИЕ hover → Tooltip с расшифровкой (failed→"exit≠0, assertion"; error→"Docker unavailable")
```

### 3.2 PhaseTimeline

**Назначение:** под-фазы прогона с таймингами по `phase`+`phase_timings` (spec §5.1, §5.5). Заменяет `describeRunProgress` (текст последней лог-строки, `html.ts:3527-3540`). Источник — типизированный `run.phase` SSE, НЕ парсинг.

```
СЕГМЕНТЫ (7 фаз spec §5.1):  ✔done  ⟳active(пульс)  ○pending  ⊘skipped  ✖failed

Все фазы пройдены (passed):
  ✔Queued─✔Prepare─⊘Pull(cached)─✔Container─✔Execute─✔Collect─✔Done
   0.2s    1.1s     —             2.1s       0:42      0.8s

Активная фаза (running, pull НЕ из кеша):
  ✔Queued─✔Prepare─⟳Pull──────────○Container─○Execute─○Collect
   0.2s    1.1s     2:18 ▓▓░ 1.5GB  —          —        —
                    └ активная: пульсирует + живой таймер (§6)

Образ из кеша (⊘ объясняет, почему прогон короче — spec §5.5):
  ✔Queued─✔Prepare─⊘Pull(cached)─⟳Container─○Execute─○Collect
   0.2s    1.1s     —             0:06        —        —

Падение на фазе:
  ✔Queued─✔Prepare─✔Pull─✔Container─✖Execute─○Collect
   0.2s    1.1s    2.1s   2.1s       0:42 FAIL  —
                                     └ красный, клик → консоль к началу фазы (spec §5.5)

Инфра-сбой:
  ✔Queued─✔Prepare─⚠Pull(failed)
   0.2s    1.1s     timeout → error (янтарный)

Клик по сегменту → скролл LiveLogConsole к началу фазы (логи тегируются phase).
```

### 3.3 LiveLogConsole

**Назначение:** живой поток `run.log` (SSE) с follow/paused. Заменяет polling+`location.reload()` (`html.ts:3615-3616`) и `.log-preview` (`html.ts:127`). Виртуализация длинных логов (spec §5.6).

```
FOLLOW (автоскролл у дна):
┌─ Live console ─────────────────────── [⏸ autoscroll][⤓ wrap][⧉ copy]─┐
│ 12:04:23  ✓ withdraw form opened                                     │
│ 12:04:25  ⟳ waiting for #confirm …                                   │  ← дописывается,
│ ▏                                                                    │     скролл следует
└──────────────────────────────────────────── following · 1240 lines ─┘

PAUSED (проскроллил вверх — spec §5.6):
┌─ Live console ─────────────────────────── [▶ resume][⤓ wrap][⧉ copy]─┐
│ 12:04:11  ✓ login ok                                                 │
│ 12:04:14  ✓ navigated /payouts                                       │
│ ┌────────────────────────────────────────────────────────────────┐  │
│ │  ⏸ paused · 18 new lines below   [ к концу ↓ ]                   │  │ ← плашка
│ └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘

БЭКПРЕШЕР (дроп строк, spec §5.4/§5.6):
│  ⚠ 240 строк опущено сервером (медленный клиент)  [ подгрузить ]      │

ПУСТО / ТЕРМИНАЛ:
│  (queued) ещё нет вывода — ждём старта контейнера                     │
│  (passed) поток завершён · 1240 строк · [скачать stdout]              │
```

### 3.4 Table (+ bulk-bar, чекбоксы)

**Назначение:** списки runs/credentials/pools с выбором и bulk-операциями. Заменяет строку с 5 кнопками (`html.ts:727-731`) и `Open`-кнопку (строка кликабельна — spec §4.4). Компактная плотность по умолчанию (§2.6).

```
БАЗОВАЯ (строка кликабельна, primary ▶ + overflow ⋯ — spec §7.3):
┌────────────────────────────────────────────────────────────────────┐
│ ☐ │ Сценарий       │ Env  │ Статус       │ Время  │            │
│───┼────────────────┼──────┼──────────────┼────────┼────────────│
│ ☐ │ withdraw-flow  │ stg  │ ✔ passed     │ 12:01  │ [▶] [⋯]    │ ← вся строка → деталь
│ ☐ │ payout-batch   │ prod │ ✖ failed     │ 09:12  │ [▶] [⋯]    │
│ ☐ │ refund-flow    │ stg  │ — never      │ —      │ [▶] [⋯]    │
└────────────────────────────────────────────────────────────────────┘
   th: uppercase 11px muted, клик → сортировка (наследует .column-sort-btn html.ts:51)

BULK-BAR (появляется при ≥1 чекбоксе — заменяет цикл POST spec §4.4):
┌────────────────────────────────────────────────────────────────────┐
│ ☑ выбрано 3   [▶ Run] [Retry] [Move] [🗑 Delete]      [снять выбор] │ ← sticky сверху
├────────────────────────────────────────────────────────────────────┤
│ ☑ │ withdraw-flow … (выделена --accent-subtle)                     │
└────────────────────────────────────────────────────────────────────┘

ФИЛЬТРЫ (status-chips + поиск + даты — заменяют 7-колоночный .filter-grid html.ts:113):
[ ⋯queued ][ ⟳running ][ ✔passed ][ ✖failed ][ ⚠error ]  🔍[поиск…]  📅[период]

СОСТОЯНИЯ: loading → Skeleton-строки §3.11 · empty → EmptyState · error → ErrorState
```

### 3.5 Card

**Назначение:** проект (spec §7.1), виджет дашборда (Execution/Health). Заменяет плоские ссылки (`html.ts:147-150`) и `.card` (`html.ts:54`).

```
ПРОЕКТ (кликабельна, ⋯ overflow — spec §7.1):
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Payments    ⋯│  │ KYC         ⋯│  │ Withdrawals ⋯│ ← ⋯: Открыть·Переименовать·
│ ● 3 running   │  │ ● idle        │  │ ⚠ 2 failed    │    Дублировать(без секретов)·
│ 42 сценария   │  │ 11 сценариев  │  │ 7 сценариев   │    Архивировать·Участники
│ 5 creds·3 mrch│  │ 2 creds       │  │ 1 cred        │ ← счётчики ДОКАЗЫВАЮТ изоляцию
│ env: stg,prod │  │ env: stg      │  │ env: prod     │
│ посл.: 12:01✔ │  │ посл.: вчера✔ │  │ посл.: 11:48✖ │
└──────────────┘  └──────────────┘  └──────────────┘
  слева тонкая полоса --project-accent (§2.8)

ВИДЖЕТ ДАШБОРДА (заголовок + тело):
┌─ EXECUTION (этот проект) ──┐  ┌─ HEALTH (раннер-хост) ───────┐
│ Workers 4 · busy 3 · idle 1│  │ Docker   ● ready v27          │
│ Concurrency ▓▓▓▓ 4/4       │  │ Clock    ● in sync 12ms       │
└────────────────────────────┘  └───────────────────────────────┘

hover → --shadow-2 поднятие · focus → --focus-ring
```

### 3.6 Modal

**Назначение:** создание/редактирование. На Radix Dialog (фокус-трап, Esc, scroll-lock). Заменяет `.modal-overlay/.modal-box` (`html.ts:60-63`) с хардкод `z-index:100`.

```
┌─────────────────────────────────────────────┐  ← overlay --overlay (z-modal-bg)
│  Credential                            [ ✕ ] │  box --shadow-3 (z-modal)
│─────────────────────────────────────────────│
│  Имя*        [ stand-admin            ]       │
│  Login*      [ admin@stand            ]       │  ← scroll при переполнении (.modal-scroll)
│  Password    [ ●set ] [ Заменить ]            │
│─────────────────────────────────────────────│
│                       [ Отмена ] [ Сохранить ]│  ← footer sticky, primary справа
└─────────────────────────────────────────────┘
размеры: sm(380) · md(480, как html.ts:62) · wide(820, как .modal-wide html.ts:63)
Esc/клик-вне → Отмена · фокус возвращается на триггер
```

### 3.7 Wizard (шаги)

**Назначение:** Run-config Scope→Data→Execution (spec §7.6). Заменяет полотно-модалку (`html.ts:1175-1462`) и дубль (`html.ts:1236` vs `2760`) — единый `<RunConfig>`.

```
ШАГ-ИНДИКАТОР (всегда виден):
  ①Scope ───── ②Data ───── ③Execution
  ✔ done    ● current   ○ pending

┌─ RUN · payments / payouts ─────────── Step 2 of 3 · Data ──────────┐
│  ①Scope ───●②Data───── ③Execution                                  │
│  STAND CREDENTIAL [ stand-admin ▾ ]→ user a***n  pwd ●set 2FA ●set  │
│  MERCHANT         [ ACME ▾ ] → {server_merchant}=ACME               │
│  ▸ Переопределить вручную (Advanced)        ← прогрессивное раскрытие│
│  ┌─ ПРЕДПРОСМОТР ПОДСТАНОВКИ ──────────────────────────────────┐    │
│  │ {server_username} → a***n   {server_2faotp} → on-demand at run│   │
│  └──────────────────────────────────────────────────────────────┘   │
│                            [ ← Назад ]   [ Далее: Execution → ]      │
└─────────────────────────────────────────────────────────────────────┘

ВАЛИДАЦИЯ: шаг не пускает дальше с ошибкой (RHF+Zod §1) — поле подсвечено, Далее disabled
ЧЕРНОВИК: resumable (перенос captureRunModalDraft html.ts:1466) — закрыл/вернулся, поля целы
ПОСЛЕДНИЙ ШАГ: [ ▶ Запустить ] primary + предупреждение масштаба (4 контейнера ~3 мин)
```

### 3.8 Toast / NotificationCenter

**Назначение:** неблокирующая обратная связь. На Radix Toast. Заменяет `alert(сырой_текст)` (`html.ts:471,1136`). Тосты vs модалки — конвенция §4.4.

```
ТОСТ (правый верх, авто-исчезает 4с, z-toast):
┌────────────────────────────────────┐
│ ✔ Прогон запущен · withdraw-flow  ✕│  success (зелёный кант)
└────────────────────────────────────┘
┌────────────────────────────────────┐
│ ✖ Не удалось: server_username_required│ error (красный) — копируемый текст
│   [ подробнее ]                    ✕│   мапит code→t() (spec §3.3)
└────────────────────────────────────┘

NOTIFICATION CENTER (колокол 🔔 в шапке — глобальный, spec §4.2):
[🔔3]→┌─ Уведомления ──────────────────┐
      │ ✖ deposit·2 failed   12:01  → │  ← клик → к прогону
      │ ⚠ kyc error (docker) 11:48  → │
      │ ✔ batch b_8f3 done   11:30  → │
      │ ──────────────  [отметить все]│
      └────────────────────────────────┘
один SSE-канал /api/stream/execution (spec §4.2)
```

### 3.9 Tabs

**Назначение:** виды (не кнопки) — Live console/stdout/stderr/Outputs/Artifacts на прогоне (spec §7.4); Credentials/Merchants/Pools/Environments/Variables в кабинете (spec §7.7). На Radix Tabs. Состояние вкладки/скролла сохраняется без reload (spec §5.6).

```
[ Live console ]·[ stdout ]·[ stderr ]·[ Outputs ]·[ Artifacts ]
  ▔▔▔▔▔▔▔▔▔▔▔▔ active (--accent кант снизу)
с бейджем-счётчиком:  [ Outputs ② ]   [ Artifacts ④ ]
```

### 3.10 ProjectSwitcher

**Назначение:** постоянный контекст проекта (spec §2.3) — главная защита от «в каком я проекте?». Радикс DropdownMenu + поиск.

```
СВЁРНУТ (верх рельса, полоса --project-accent слева):
┌───────────┐
│▸Payments ▾│
└───────────┘

РАЗВЁРНУТ (spec §2.3):
┌─────────────────────────────────┐
│ 🔍 [ поиск проекта…            ] │
│ ● Payments    ▶2 running  ✓     │ ← активный, --project-accent
│   KYC         idle              │
│ ⚠ Withdrawals ▶1 🔔             │ ← есть падения
│ ─────────────────────────────── │
│ + Новый проект…                 │
│ ↪ Все проекты (/projects)       │
└─────────────────────────────────┘
переключение = смена URL с сохранением подраздела: /p/A/runs → /p/B/runs (spec §2.3)
```

### 3.11 HealthIndicator

**Назначение:** здоровье хоста (Docker/cache/disk/NTP) на дашборде (spec §5.7). Глиф+цвет из §2.3.

```
● ready    зелёный   Docker v27
⟳ pulling  синий     Image cache (пульс)
○ absent   серый     Image cache
⚠ drift    янтарный  Clock(NTP) 1.4s   ← критично: ломает 2FA молча (spec §5.7)
✖ unavail  красный   Docker daemon unavailable
▓▓▓░ 61%   bar       Disk /data (алерт >80% — кант янтарный)
```

### 3.12 Skeleton / EmptyState / ErrorState

**Назначение:** паттерны loading/empty/error (конвенция §4.5). Сегодня — пустые колонки без объяснения (spec 3.1 «пустые колонки для failed без объяснения»).

```
SKELETON (loading — пульсирующие плашки, форма = будущий контент):
│ ▦▦▦▦▦▦  ▦▦▦  ▦▦▦▦▦   │
│ ▦▦▦▦    ▦▦   ▦▦▦▦▦   │   (shimmer §6)

EMPTY (нет данных + следующий шаг):
┌──────────────────────────────────────┐
│            ⊙                          │
│   Пока нет прогонов                   │
│   Запустите сценарий, чтобы начать    │
│            [ ▶ Run ]                  │ ← ведёт к действию, не тупик
└──────────────────────────────────────┘
(пустой проект → чек-лист онбординга cred→env→сценарий, spec §7.2)

ERROR (загрузка не удалась):
┌──────────────────────────────────────┐
│   ⚠ Не удалось загрузить прогоны       │
│   server_unreachable                   │ ← code→t() (spec §3.3)
│   [ Повторить ]   [ подробнее ]        │
└──────────────────────────────────────┘
```

### 3.13 Button (primary/secondary/danger/overflow)

**Назначение:** один primary-CTA на экран + overflow (spec §1 столп 3, §4.3). Заменяет 7-8 кнопок тулбара (`html.ts:634-2533`) и `.btn/.btn-danger` (`html.ts:42-44`).

```
PRIMARY    [ ▶ Run · Payments ]   --accent fg, бейдж проекта на запускающих (spec §2.4)
SECONDARY  [ Отмена ]              --surface, --border
DANGER     [ 🗑 Удалить ]          --status-failed-fg, кант красный (как .btn-danger)
OVERFLOW   [ ⋯ ]                   иконка-кнопка → DropdownMenu редких действий
ICON       [ ⧉ ] [ ⤓ ]            квадратные, в тулбарах консоли
СОСТОЯНИЯ: default · hover(--accent-hover) · :focus-visible(--focus-ring) ·
          disabled(opacity .5, cursor not-allowed) · loading([⟳ …] спиннер, блокирует повтор)
РАЗМЕРЫ: sm(28px compact) · md(34px)   (наследует .btn-sm html.ts:43)
```

### 3.14 FormField (+ write-only SecretField)

**Назначение:** поле формы с label/desc/error (наследует `.modal-field` html.ts:65-68). SecretField — ключевой: НИКОГДА не показывает значение секрета (чинит `html.ts:459-460`, spec §4.6).

```
ОБЫЧНОЕ:
  Имя*                        ← label, * = required
  [ stand-admin            ]  ← input
  Уникально в пределах проекта ← field-desc (muted 12px)
  ⚠ Уже занято               ← error (--status-failed-fg) при невалидности

SECRET (write-only — set):
  Password
  [ ●●●●●●●●  ●set ]  [ Заменить ]   ← значение НЕ загружается; "Заменить" → пустое поле
  → {server_password}                ← показывает целевой плейсхолдер

SECRET (not set):
  TOTP secret
  [ ○ not set ]  [ Задать… ]   → {server_2faotp}

SECRET (needs re-entry — потеря KEK spec §8.6):
  Password
  [ ⚠ требует повторного ввода ]  [ Ввести ]

ВАЛИДАЦИЯ: онлайн через Zod-resolver (§1); base32 для TOTP → "● валидный / ✖ не base32"
          вместо alert(сырой текст) (spec §8.5)
```

### 3.15 Breadcrumbs

**Назначение:** путь с именем проекта в каждой крошке (spec §2.4). Расширяет `renderFolderBreadcrumbs` (`html.ts:4197-4212`) — добавляет проект-сегмент.

```
● Payments ▸ Scenarios ▸ payouts ▸ withdraw-flow
└ точка --project-accent (§2.8) — проект в КАЖДОЙ крошке (защита от путаницы spec §2.4)
каждый сегмент — ссылка; последний — текущий (не ссылка, --text)
```

### 3.16 ProgressBar

**Назначение:** прогресс батча/pull/concurrency/disk (spec §5.5, §5.7, §7.5).

```
ОПРЕДЕЛЁННЫЙ (батч spec §7.5):
  ▓▓▓▓▓▓▓▓░░░░░░  7/12 done · 2 running · 3 queued · 1 failed
  └ сегменты раскрашены по статусу §2.3 (passed зелёный/failed красный/running синий)

CONCURRENCY (spec §5.7):  ▓▓▓▓ 4/4   (при ==max → подпись "ждёт воркера")
DISK:                     ▓▓▓░ 61%   (>80% → янтарный кант)
PULL (неопределённый размер):  ▓▓░ 1.5GB · 2:18   (полоса течёт §6)
```

### 3.17 Tooltip

**Назначение:** расшифровка глифов/статусов/маскированных значений. На Radix Tooltip (a11y, задержка). Заменяет «галку без пояснения» (spec 3.1 `ensure right address`).

```
hover на [⚠ error] →  ┌────────────────────────────┐
                       │ Инфраструктура: Docker pull │
                       │ failed (не падение теста)   │
                       └────────────────────────────┘
задержка 400ms · стрелка к триггеру · z-overflow · в Tooltip НИКОГДА не секрет (§4.6)
```

### 3.18 ConfirmDialog

**Назначение:** опасное действие с масштабом последствий + именем проекта (spec §4.3, §2.4). Заменяет голый `confirm()` (`html.ts` множество мест). На Radix AlertDialog.

```
┌─────────────────────────────────────────────┐
│  ⚠ Удалить пул в проекте Payments?           │ ← имя проекта (spec §2.4 механизм 3)
│─────────────────────────────────────────────│
│  Пул «eth-addr» · 412 свободных значений     │ ← МАСШТАБ последствий
│  Будет удалено безвозвратно.                 │
│  Затронутые сценарии: 3                       │
│─────────────────────────────────────────────│
│  Для подтверждения введите имя:              │ ← для НЕОБРАТИМОГО — ввод имени
│  [ eth-addr            ]                      │
│                  [ Отмена ]  [ 🗑 Удалить ]   │ ← danger справа, disabled пока имя≠
└─────────────────────────────────────────────┘
лёгкое подтверждение (Stop, не необратимо) → без ввода имени, только две кнопки
```

---

### 4. КОНВЕНЦИИ

### 4.1 Единый язык иконок-статусов (закреплён жёстко)

Каждый статус = ОДИН глиф + ОДНА Lucide-иконка + ОДИН цвет (§2.3). Не смешивать. ASCII-глиф = текстовый фолбэк, Lucide = в реальном UI.

```
СТАТУС/ИСХОД   ГЛИФ  Lucide              ЦВЕТ §2.3
queued         ⋯     MoreHorizontal      серый
running        ⟳     Loader (spin)       синий (пульс)
passed         ✔     CheckCircle2        зелёный
failed         ✖     XCircle             красный
error          ⚠     AlertTriangle       янтарный
timeout        ⚠     Timer/AlertTriangle янтарный
stopped        ⏹     Square              серый
interrupted    ⚠     Unplug              янтарный
2fa            🔐    ShieldCheck/KeyRound фиолетовый
secret set     ●     наполненная точка   зелёный
secret notset  ○     пустая точка        серый
reachable      ●     Wifi                зелёный
unreachable    ✖     WifiOff             красный
docker n/a     ⓘ     Info                muted (НЕ красный — spec §5.9)

POOL KIND (schemas.ts:101): deposit_address/payout_address → Wallet,
   trace_id → Hash, custom → Braces
СУЩНОСТИ: проект Folder · сценарий FileCode · credential KeyRound ·
   merchant Store · pool Database · environment Globe
```

### 4.2 Как показываем real-time (spec §5, столп 1)

- **Пульс активной фазы** — фаза `running` в PhaseTimeline и StatusBadge `⟳` пульсируют (§6). Сигнал «живо, не зависло».
- **Живые таймеры** — `0:42…` тикает на клиенте (requestAnimationFrame, не SSE) от `started_at` фазы. Pull показывает live-хвост (spec §5.3).
- **Переходы без reload** — SSE-событие → `queryClient.setQueryData` точечно патчит бейдж/дописывает строки. Скролл, раскрытые блоки, активная вкладка сохраняются (spec §5.4, §5.6). НИКОГДА `location.reload()`.
- **Глобальные индикаторы** в шапке (`[▶3 running][🔔1]`) — один SSE-канал `/api/stream/execution`, видны с любой страницы (spec §4.2).
- **Фолбэк** — нет `EventSource` → poll `GET /api/runs/:id` 3-5с, тоже точечный патч, БЕЗ reload (spec §5.4).
- **Снапшот на connect** — стрим отдаёт текущее состояние (log_entries, phase_timings), потом дельты — нет «пустого экрана при подписке».

### 4.3 Overflow / Advanced / прогрессивное раскрытие (spec §4.3)

- **Один primary-CTA на экран** + overflow `⋯`. Частотное на виду, редкое в `⋯` (Move/Rename/Download/Delete).
- **Три Run-кнопки → один `▶ Run`**, scope из крошек/чекбоксов (spec §4.4).
- **Advanced** скрывает редкое: `parallel batch / stage / amount / timeout` → под `▸ Advanced` (spec §4.3).
- **Виды → вкладки, не кнопки**: stdout/stderr/artifacts (spec §4.4).
- **Навигация**: частое сверху рельса (scenarios, runs), редкое снизу отделённой группой (environments, variables, settings) (spec §4.3).

### 4.4 Тосты vs модалки (когда что)

```
ТОСТ (Toast §3.8) — неблокирующий, авто-исчезает:
  ✓ успех действия (запущен, сохранён, удалён)
  ✓ фоновое событие (прогон упал — в NotificationCenter)
  ✓ ошибка операции, не требующая решения (показать code→t(), копируемо)

МОДАЛКА/ДИАЛОГ — блокирующий, требует решения:
  ✓ форма создания/редактирования (Modal §3.6)
  ✓ опасное необратимое действие (ConfirmDialog §3.18, с масштабом+именем проекта)
  ✓ wizard (многошаговый ввод)

НИКОГДА: alert()/confirm() (чинит html.ts:471,1136,2417 — блокирующие, текст некопируем)
```

### 4.5 Паттерны empty / loading / error (единые, §3.12)

- **loading** → Skeleton формы будущего контента (не спиннер по центру). TanStack Query `isPending`.
- **empty** → EmptyState с иконкой + следующим шагом (CTA, не тупик). Пустой проект → онбординг-чеклист (spec §7.2).
- **error** → ErrorState с `code→t()` + [Повторить]. Сетевые ошибки не роняют весь экран — деградация по виджетам.

### 4.6 Как НИКОГДА не показываем секреты (spec §4.2, §6.5, §8.6)

- **Write-only везде**: API/DOM возвращают только `has_password`/`has_totp` (булев), не значение. SecretField (§3.14) показывает `●set`/`○ not set`, не строку.
- **Удалить `input.value = account.password`** (`html.ts:459-460`) — корневой источник утечки в DOM.
- **В предпросмотре wizard** — маскировка `a***n`, `{server_password}→●set`, `{server_2faotp}→on-demand at run` (spec §7.6).
- **2FA-код** — только on-demand через project-scoped эндпоинт, показывается код+TTL, секрет в ответе ОТСУТСТВУЕТ; admin-only; audit (spec §8.3, §8.5).
- **В логах/Timeline** — маркер `🔐 2FA подставлен 12:04:25 · действ. 24с`, НИКОГДА код/секрет (spec §8.5).
- **В Tooltip/Toast/clipboard** секрет не попадает никогда.

### 4.7 Клавиатура / доступность

- **Фокус всегда виден** — `--focus-ring` 2px на `:focus-visible` (не убирать outline).
- **Radix-примитивы** дают из коробки: Esc закрывает модалку/поповер, Tab-trap в модалке, стрелки в меню/табах, `aria-*` роли, возврат фокуса на триггер.
- **Таблица**: строка фокусируема (`tabindex`), Enter = открыть, Space = чекбокс.
- **Хоткеи** (минимально): `/` — поиск, `g p` — проекты, `g r` — runs, `n` — primary-CTA, `?` — список хоткеев.
- **Контраст** AA: пары bg/fg статусов §2.3 проверены ≥4.5:1 для текста.
- **prefers-reduced-motion** → пульс/shimmer заменяются статикой (§6).
- **Screen reader**: статус-бейдж несёт `aria-label` (текст статуса), live-консоль — `aria-live="polite"` с дросселем.

### 4.8 Минимальная ширина / адаптивность

```
ЦЕЛЬ: десктоп-инструмент (QA за рабочей машиной). Не мобильный-first.
--min-app-width: 1024px   (ниже — горизонтальный скролл, не ломаем верстку)
БРЕЙКПОИНТЫ:
  ≥1280  полный: рельс развёрнут + контент
  1024–1279  рельс сворачивается в иконки ([≡] раскрывает), как html.ts:130 @media
  <1024   рельс → off-canvas (бургер), таблицы → карточный fallback строк
          (наследует html.ts:131-134: log-entry/grid → 1 колонка)
АДАПТИВНОСТЬ ВНУТРИ: Table узкая → второстепенные колонки прячутся в строку-деталь;
          PhaseTimeline узкая → горизонтальный скролл сегментов, активный всегда видим
```

---

### 5. ДВИЖЕНИЕ / АНИМАЦИЯ (сдержанно, для прозрачности)

Принцип: анимация = **сигнал состояния**, не украшение (столп 1 + столп 3). Всё уважает `prefers-reduced-motion` (§4.7).

### 5.1 Токены длительности/кривых

```
--motion-fast    120ms   (hover, focus, появление тултипа)
--motion-base    180ms   (вкладки, dropdown, патч строки)
--motion-slow    280ms   (открытие модалки, переход шага wizard)
--ease-standard  cubic-bezier(.2,0,.2,1)    (вход)
--ease-exit      cubic-bezier(.4,0,1,1)     (выход)
--pulse-period   1.4s    (дыхание активной фазы)
--spin-period    0.8s    (⟳ running)
```

### 5.2 Что пульсирует (живо, не зависло)

- **`⟳ running` StatusBadge** — медленный spin иконки (`--spin-period`).
- **Активная фаза PhaseTimeline** — «дыхание» opacity 1↔0.55 (`--pulse-period`), синий §2.3. Главный сигнал «идёт, не повисло» (заменяет статичное «This page refreshes automatically» html.ts:3537).
- **`⟳ pulling` HealthIndicator** — тот же пульс.
- **Точка running в switcher/крошках** — лёгкое дыхание.

### 5.3 Что плавно перетекает

- **ProgressBar** — ширина транзишн `--motion-base ease-standard` (батч/concurrency/disk). Pull (неизвестный размер) — бесконечная «течь» (shimmer слева-направо).
- **Завершение фазы** — сегмент Timeline `⟳→✔` кросс-фейд `--motion-base`, таймер фиксируется (мягко, не скачком).
- **Дописывание строки лога** — новая строка fade-in `--motion-fast` снизу (в follow-режиме). При дропе-бэкпрешере — без анимации (поток быстрый).
- **Патч статус-бейджа по SSE** — цвет/глиф кросс-фейд `--motion-base`, без «прыжка».
- **Вкладки/шаги wizard** — контент fade `--motion-base`; индикатор шага скользит.

### 5.4 Микро-движение

- **Skeleton** — shimmer-градиент проходит слева-направо, `--pulse-period` (§3.12).
- **Toast** — вход справа slide+fade `--motion-base ease-standard`, выход fade `--ease-exit`.
- **Modal** — overlay fade + box scale 0.98→1 `--motion-slow`.
- **Dropdown/Tooltip/Popover** — fade+scale 0.96→1 `--motion-fast` от триггера.
- **BulkBar** — выезжает сверху таблицы `--motion-base` при первом чекбоксе.
- **Hover карты/строки** — `--shadow` и `--accent-subtle` за `--motion-fast`.

### 5.5 Чего НЕ делаем (сдержанность, столп 3)

- Нет параллакса, bounce/elastic, декоративных переходов страниц, иконок-«праздников».
- Нет анимации цифр-счётчиков (число меняется мгновенно — это данные).
- Нет автоскролл-«рывков»: follow-режим скроллит плавно, пауза мгновенна.
- Длительности ≤280ms — интерфейс ощущается мгновенным, не «играющим».

---

### Сводка эталонных файлов

- Спецификация (источник): `e:\rabota\playwright project\tests_projec\docs\ui-redesign-spec.md` — §1 принципы, §4 дизайн-язык, §5 real-time, §7 экраны, §8 2FA.
- Исследование (источник): `e:\rabota\playwright project\tests_projec\docs\ui-deploy-research.md` — §4.6 SSR→SPA вердикт и стек.
- Заменяемый код: `e:\rabota\playwright project\tests_projec\apps\server\src\html.ts` — `BASE_CSS` (`:20-136`), `page()` (`:4182`), секрет в DOM (`:458-460`), `describeRunProgress` (`:3527-3540`), `location.reload()` (×17), `renderFolderBreadcrumbs` (`:4197`).
- Контракт статусов: `e:\rabota\playwright project\tests_projec\packages\shared\src\schemas.ts` — `RunStatusSchema` (`:169`), переиспользуемые `*BodySchema` (`:231-350`).
- Создаваемые артефакты дизайн-системы: `packages/ui/tokens.css` (§2), `packages/ui/` (компоненты §3), `packages/shared/locales/{ru,en}.ts` + `packages/ui/i18n/` (§1.3), новый `apps/web/` (SPA-каркас, §1.4).

Все токены §2, каталог §3 (18 компонентов с ASCII-состояниями), конвенции §4 и движение §5 — обязательный контракт для дизайнеров отдельных экранов.

---

## 3. Аутентификация и онбординг

I now have a complete, code-grounded picture. I have everything required to write the section. I'll produce the final design specification with detailed ASCII mockups for all auth and onboarding screens, all states, using the design system tokens/components/icons consistently.

---

### 1. Терминология: Login MFA против Stand 2FA (читать первым)

Прежде чем экраны — жёсткое разведение двух слоёв 2FA. Их **нельзя** перепутать ни визуально, ни навигационно (spec §8.4 `ui-redesign-spec.md:893-895`, §1 столп «2FA-first» `:23`). Эта таблица — контракт для всех моков ниже.

```
                  ┌─ LOGIN MFA (слой «b») ──────────┐  ┌─ STAND 2FA (слой «a») ────────────┐
НАЗНАЧЕНИЕ        │ вход пользователя в ИНСТРУМЕНТ   │  │ TOTP тестируемого СТЕНДА          │
ЧТО ЗАЩИЩАЕТ      │ аккаунт ts-playwright            │  │ бизнес-логику сценария            │
SCOPE            │ account-scoped (на пользователя) │  │ project-scoped (на credential)    │
ХРАНИЛИЩЕ        │ users.totp_secret_enc            │  │ stand_credentials.totp_secret_enc │
                 │ (spec §8.4 :895)                 │  │ (spec §8.3 :882)                  │
ПЛЕЙСХОЛДЕР      │ — (не подставляется в сценарий)  │  │ {server_2faotp} / {{INPUT:2fa_otp}}│
ИКОНКА (§4.1)    │ 🛡 ShieldCheck, акцент --accent  │  │ 🔐 KeyRound, --status-2fa фиолет   │
ЦВЕТ-КОД         │ нейтральный синий (вход)         │  │ --status-2fa #ede9fe/#6d28d9      │
ГДЕ В UI         │ Профиль → Безопасность           │  │ /p/:pid/credentials/:cid          │
                 │ (/account/profile, §3.1 :132)    │  │ (project-рельс, §3.1 :144)        │
RECOVERY         │ recovery-коды входа (§8.4 :899)  │  │ нет (секрет хранится у владельца) │
МОМ. В TIMELINE  │ не светится в run-логе           │  │ 🔐 маркер "2FA подставлен" (§8.5)  │
```

Правило для дизайнера: **на экранах входа/профиля используем только 🛡 (Login MFA, синий).** Глиф 🔐 и фиолетовый `--status-2fa` зарезервированы исключительно за стендовой 2FA внутри проекта — на экранах этого раздела он не появляется НИКОГДА. Это та самая защита «нельзя перепутать».

---

### 2. Карта экранов и переходов раздела

Маршруты — из sitemap (spec §3.2 `:155-185`). Текущая точка, которую мы заменяем: `/cabinet` рендерит `renderCabinetLoginPage` с выпадашкой фейковых `cabinet_user_N` (`app.ts:116-124`, `app.ts:136-155`, `store.ts:285-296`) — без пароля, без email, без 2FA. Это и есть «фейковый вход `store.ts:29`», который spec §7.9 (`:846`) сносит.

```
                       PUBLIC / AUTH (SSR-страницы, без рельса — §1.4)
   ┌─────────┐  пароль OK,    ┌──────────────┐  код OK / recovery OK   ┌──────────────────────┐
   │ /login  │──MFA не вкл.──►│              │────────────────────────►│ / (redirect)          │
   │  (1)    │  MFA вкл.─────►│ /login/2fa   │                          │ → /p/:lastProject     │
   │         │               │  (1.MFA)     │  "использовать backup"   │ → /projects (§3.2:163)│
   └────┬────┘               └──────┬───────┘◄──────┐                  └──────────┬───────────┘
        │ "нет аккаунта?"           │ recovery       │                            │
        ▼                          ▼ /login/recovery │                            │ 0 проектов +
   ┌─────────┐  success            (1.REC) ──────────┘                            │ admin своего акк.
   │/register│──(claim/own acc)──► авто-login ──────────────────────────────────► ▼
   │  (2)    │                                                          ┌──────────────────────┐
   └─────────┘                                                          │ /projects  ИЛИ        │
                                                                        │ ONBOARDING (5)        │
   ACCOUNT-LEVEL (рельса проекта НЕТ — §4.1 :217)                       │ пустой акк. → чеклист │
   ┌──────────────────────┐    "Безопасность"     ┌──────────────────┐ └──────────────────────┘
   │ /account/profile (6) │◄────────────────────► │ enroll Login MFA │
   │  профиль, язык, выход │   "Включить 2FA"      │  (3) внутри (6)  │
   │  активные сессии      │◄────────────────────► │ recovery-коды(3) │
   └──────────────────────┘   "Перенастроить"     │ восстановление(4)│
                                                   └──────────────────┘
```

Все экраны раздела используют дизайн-систему: токены §2, компоненты §3 (`Button`, `FormField`/`SecretField`, `Modal`, `Toast`, `Skeleton`/`EmptyState`/`ErrorState`, `StatusBadge`, `ProgressBar`), конвенции §4 (один primary-CTA, write-only секреты §4.6, тосты-vs-модалки §4.4, доступность §4.7), движение §5.

---

### 3. Экран 1 — Login (`/login`)

**Назначение:** аутентификация пользователя по email/login + пароль (Argon2id, серверная opaque-сессия `HttpOnly; Secure; SameSite=Lax`), заменяет выбор `cabinet_user` из выпадашки (`app.ts:136-155`). Primary-CTA: **`[ Войти ]`**. Overflow: нет (минимальный экран). Advanced: нет. RU/EN-переключатель — в шапке формы (spec §3.3 `:200`, доступен до входа). Данные: `POST /login {login,password}` → ответ `{next:"home"|"mfa"}` или ошибка-код (каталог `error.*`, §3.3 `:203`).

**3.1 — default**

```
                         ┌──────────────────────────────────────────┐
                         │  ts-playwright                  🌐 RU ▾   │  ← язык, cookie lang (§3.3)
                         │                                            │
                         │  Вход                                      │  --text-lg semibold
                         │  ─────────────────────────────────────    │
                         │                                            │
                         │  Email или логин                           │  FormField §3.14
                         │  [ anna@team                          ]    │  --control-h 34 (comfortable)
                         │                                            │
                         │  Пароль                                    │
                         │  [ ●●●●●●●●●                       ] [👁] │  кнопка-глаз = показать
                         │                                            │
                         │  [          ▶ Войти                  ]    │  PRIMARY --accent, full-width
                         │                                            │
                         │  Нет аккаунта?  Зарегистрироваться →       │  ← link → /register
                         └──────────────────────────────────────────┘
                            центрированная карта --surface --shadow-2
                            фокус на «Email» при загрузке (§4.7)
```

**3.2 — loading** (после нажатия «Войти», блокируем повтор-сабмит — Button loading-state §3.13)

```
                         ┌──────────────────────────────────────────┐
                         │  ts-playwright                  🌐 RU ▾   │
                         │  Вход                                      │
                         │  ─────────────────────────────────────    │
                         │  Email или логин                           │
                         │  [ anna@team                          ]    │  поля disabled (opacity .5)
                         │  Пароль                                    │
                         │  [ ●●●●●●●●●                            ]  │
                         │  [        ⟳ Проверяем…                ]    │  спиннер ⟳ (--spin-period),
                         │  Нет аккаунта?  Зарегистрироваться →       │  кнопка disabled, повтор заблокирован
                         └──────────────────────────────────────────┘
```

**3.3 — ошибка пароля** (`401 invalid_credentials`; намеренно НЕ раскрываем, что именно неверно — login или пароль)

```
                         ┌──────────────────────────────────────────┐
                         │  ts-playwright                  🌐 RU ▾   │
                         │  Вход                                      │
                         │  ─────────────────────────────────────    │
                         │  Email или логин                           │
                         │  [ anna@team                          ]    │
                         │  Пароль                                    │
                         │  [ ●●●●●                          ] [👁] │  ← кант поля --status-failed-fg
                         │  ✖ Неверный логин или пароль               │  ← error, code→t("error.invalid_credentials")
                         │  [          ▶ Войти                  ]    │  фокус возвращается на «Пароль»
                         │  Нет аккаунта?  Зарегистрироваться →       │
                         └──────────────────────────────────────────┘
                            ошибка инлайн в форме (НЕ alert — §4.4), копируемый текст
```

**3.4 — заблокирован** (rate-limit на `/login`, spec §7.9 `:846`; `429 too_many_attempts` с `retry_after`)

```
                         ┌──────────────────────────────────────────┐
                         │  ts-playwright                  🌐 RU ▾   │
                         │  Вход                                      │
                         │  ─────────────────────────────────────    │
                         │  ┌────────────────────────────────────┐   │
                         │  │ ⚠ Слишком много попыток входа       │   │  ← ErrorState-блок,
                         │  │   Повторите через 0:48              │   │     --status-error янтарный,
                         │  │   ▓▓▓▓▓▓▓▓░░░░  обратный отсчёт      │   │     таймер тикает на клиенте (§4.2)
                         │  └────────────────────────────────────┘   │
                         │  Email или логин                           │
                         │  [ anna@team                          ]    │  поля и кнопка disabled
                         │  Пароль                                    │     до конца отсчёта
                         │  [                                    ]    │
                         │  [          ▶ Войти                  ]    │  ← disabled, разблокируется по 0:00
                         └──────────────────────────────────────────┘
```

**3.5 — шаг MFA после пароля** (`/login/2fa`, переход когда `next:"mfa"`; Login MFA — слой «b», 🛡 синий, spec §8.4 `:897`)

```
                         ┌──────────────────────────────────────────┐
                         │  ts-playwright                  🌐 RU ▾   │
                         │  🛡 Двухфакторный вход                     │  ← 🛡 ShieldCheck, НЕ 🔐 (см. §1)
                         │  ─────────────────────────────────────    │
                         │  Введите 6-значный код из приложения       │  --text-muted
                         │  для anna@team                             │
                         │                                            │
                         │      [_] [_] [_]   [_] [_] [_]             │  6 mono-ячеек --font-mono,
                         │                                            │  автопереход между ячейками,
                         │  ☐ Доверять этому устройству 30 дней        │  paste 6 цифр → разложить
                         │                                            │
                         │  [        ▶ Подтвердить               ]    │  PRIMARY, активна при 6 цифрах
                         │                                            │
                         │  Использовать резервный код →              │  ← link → /login/recovery (3.7)
                         │  ← Назад ко входу                          │  ← link → /login
                         └──────────────────────────────────────────┘
                            фокус в 1-й ячейке; Enter при заполненных → submit
```

**3.6 — MFA loading / ошибка кода** (проверка `POST /login/2fa {code, trust}`; проверка ±1 шаг, spec §8.4 `:897`)

```
   LOADING:                                       ОШИБКА КОДА (401 invalid_totp):
  ┌──────────────────────────────────┐           ┌──────────────────────────────────┐
  │  🛡 Двухфакторный вход            │           │  🛡 Двухфакторный вход            │
  │  ──────────────────────────────  │           │  ──────────────────────────────  │
  │  Введите 6-значный код …          │           │  Введите 6-значный код …          │
  │   [4][8][1] [2][0][5]             │           │   [4][8][1] [2][0][3]             │ ← ячейки --status-failed
  │  ☐ Доверять устройству 30 дней    │           │  ✖ Неверный код, попробуйте ещё   │ ← error, code→t()
  │  [     ⟳ Проверяем…          ]    │           │  ☐ Доверять устройству 30 дней    │
  │                                   │           │  [     ▶ Подтвердить         ]    │ ← ячейки очищены, фокус в 1-й
  └──────────────────────────────────┘           │  Использовать резервный код →     │
                                                  └──────────────────────────────────┘
                                                  3 неверных подряд → плашка rate-limit (как 3.4)
```

**3.7 — ввод recovery-кода** (`/login/recovery`; одноразовый код, хеш sha256 в `user_recovery_codes`, spec §8.4 `:899`, DDL `:1102-1108`)

```
                         ┌──────────────────────────────────────────┐
                         │  ts-playwright                  🌐 RU ▾   │
                         │  🛡 Резервный код входа                    │
                         │  ─────────────────────────────────────    │
                         │  Если нет доступа к приложению —            │  --text-muted
                         │  введите один из резервных кодов.          │
                         │                                            │
                         │  [ a1b2-c3d4-e5f6                      ]    │  --font-mono, формат с дефисами
                         │  Код одноразовый и сгорит после входа.     │  ← field-desc (muted 12px)
                         │                                            │
                         │  [        ▶ Войти по коду             ]    │  PRIMARY
                         │                                            │
                         │  ← Вернуться к вводу кода                   │  ← link → /login/2fa (3.5)
                         └──────────────────────────────────────────┘

   УСПЕХ → авто-login + Toast (§3.8) поверх /account/profile:
   ┌────────────────────────────────────────────────────────┐
   │ ⚠ Вы вошли по резервному коду. Осталось 4 из 8.        │ ← --status-error янтарный
   │   Рекомендуем перенастроить 2FA.  [ Перенастроить → ]  │   ведёт к экрану 4
   └────────────────────────────────────────────────────────┘
   audit login.recovery_used (spec §8.4 :899)

   ОШИБКА (код использован/неверен — 401 recovery_invalid):
   │ ✖ Код неверен или уже использован                      │ ← инлайн error в форме
```

Переходы экрана 1: успех без MFA → `/` → redirect `/p/:lastProject` или `/projects` (§3.2 `:163`); успех с MFA → `/login/2fa`; «нет аккаунта» → `/register`; «резервный код» → `/login/recovery`.

---

### 4. Экран 2 — Self-Register (`/register`)

**Назначение:** саморегистрация (внутренний инструмент — разрешено, spec §3.2 `:159`). Создаёт `User` (Argon2id), и — ключевое — **собственный `account_<userId>` + дефолтный пустой проект** (spec §7.9 `:852-853`), либо одноразовый **claim первого admin** для `account_default`, если система пуста и `APP_BOOTSTRAP_ADMIN` не задан (spec §7.9 `:851`). Primary-CTA: **`[ Создать аккаунт ]`**. Данные: `POST /register {login,email,password}` → создаёт строки `accounts` + `memberships(account-wide, admin)` + первый `projects` (DDL-следствие §7.9 `:853`).

**Что значит «создаёт свой Account» (показываем пользователю явно, чтобы не было тупика «0 проектов»):**

```
   Кейс A — система ПУСТА, APP_BOOTSTRAP_ADMIN не задан:
     первый зарегистрировавшийся → claim → admin в account_default (§7.9 :851).
     Транзакция: NOT EXISTS(membership account-wide admin) → INSERT.  Показ-плашка ниже (4.5).

   Кейс B — обычный (система не пуста):
     User → свой account_<userId> (он admin) + 1 пустой проект → НЕ тупик (§7.9 :852).
     После входа: 0 проектов + admin → /projects с активным CTA «Создать проект».

   Кейс C — приглашён в чужой аккаунт (viewer/operator) — ЭТО НЕ /register,
     а отдельный флоу /account/users существующего admin (§7.9 :852).
```

**4.1 — default**

```
                         ┌──────────────────────────────────────────┐
                         │  ts-playwright                  🌐 RU ▾   │
                         │  Регистрация                               │  --text-lg semibold
                         │  Внутренний инструмент QA                   │  --text-muted
                         │  ─────────────────────────────────────    │
                         │  Логин                                     │  field*  (required)
                         │  [ anna                               ]    │
                         │  Email                                     │
                         │  [ anna@team.io                       ]    │
                         │  Пароль                                    │
                         │  [ ●●●●●●●●                        ] [👁] │
                         │  ░░░░░░░░░░  слабый                         │  ← индикатор силы (нейтральный, не блок)
                         │  Повтор пароля                             │
                         │  [ ●●●●●●●●                            ]   │
                         │                                            │
                         │  [        Создать аккаунт            ]    │  PRIMARY, disabled пока невалидно
                         │  Уже есть аккаунт?  Войти →                 │  ← link → /login
                         └──────────────────────────────────────────┘
                            валидация онлайн через Zod-resolver (§1, RHF+zod)
```

**4.2 — валидация (RHF + Zod, инлайн, без alert — §4.6)**

```
                         ┌──────────────────────────────────────────┐
                         │  Логин                                     │
                         │  [ an                                 ]    │ ← кант --status-failed
                         │  ✖ Минимум 3 символа                       │
                         │  Email                                     │
                         │  [ anna@                              ]    │ ← кант --status-failed
                         │  ✖ Некорректный email                      │
                         │  Пароль                                    │
                         │  [ ●●●●                            ] [👁] │
                         │  ▓▓░░░░░░░░  слишком короткий               │ ✖ Минимум 8 символов
                         │  Повтор пароля                             │
                         │  [ ●●●●●●●●                            ]   │ ✖ Пароли не совпадают
                         │  [        Создать аккаунт            ]    │ ← disabled, пока есть ошибки
                         └──────────────────────────────────────────┘
```

**4.3 — занятый login** (`409 login_taken` от сервера; уникальность `users.login`)

```
                         ┌──────────────────────────────────────────┐
                         │  Логин                                     │
                         │  [ anna                               ]    │ ← кант --status-failed
                         │  ✖ Логин «anna» уже занят                  │ ← code→t("error.login_taken",{login})
                         │  Email                                     │   login НЕ переводим (§3.3 :206)
                         │  [ anna@team.io                       ]    │
                         │  …                                         │
                         │  [        Создать аккаунт            ]    │ кнопка снова активна после правки
                         └──────────────────────────────────────────┘
   loading-вариант сабмита: [ ⟳ Создаём аккаунт… ] (как 3.2)
```

**4.4 — успех (кейс B — свой account)** → авто-login, Toast + переход на онбординг (экран 5)

```
   Toast (§3.8, success, зелёный кант, авто 4с):
   ┌────────────────────────────────────────────────────────┐
   │ ✔ Аккаунт создан · добро пожаловать, anna             ✕│
   └────────────────────────────────────────────────────────┘
   → редирект на ONBOARDING (5): 0 проектов, admin → чек-лист.
     Создан account_<userId> + 1 пустой проект (§7.9 :852-853).
```

**4.5 — успех (кейс A — claim первого admin)** → подсветка особого статуса

```
   После регистрации в ПУСТОЙ системе:
   ┌──────────────────────────────────────────────────────────────┐
   │  ✔ Аккаунт создан                                            │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │ 🛡 Вы — первый пользователь.                             │  │ ← 🛡 (Login-домен), --accent-subtle
   │  │    Вы стали администратором аккаунта по умолчанию.      │  │   claim одноразовый (§7.9 :851)
   │  │    Рекомендуем включить 2FA входа.  [ Настроить → ]     │  │   ведёт к экрану 3 (enroll)
   │  └────────────────────────────────────────────────────────┘  │
   │  [ Перейти к проектам → ]                                     │
   └──────────────────────────────────────────────────────────────┘
```

Переходы экрана 2: успех → авто-login → онбординг (5) / `/projects`; «уже есть аккаунт» → `/login`.

---

### 5. Экран 3 — Настройка Login MFA / enroll (внутри `/account/profile → Безопасность`)

**Назначение:** включение 2FA входа (Login MFA, слой «b», account-scoped). Критично: **нельзя включить непроверенный секрет** (confirm-enrollment, защита от самоблокировки, spec §8.4 `:897`, §7.9 `:847`); **recovery-коды обязательны**. Реализуется поверх `otp.ts` (есть `normalizeTotpSecret` `:9`, `generateTotpCodeSafeDetails` `:54`, `decodeBase32` `:186`; **`generateTotpSecret()` надо добавить** — честно помечено в spec §8.4 `:897`). Wizard §3.7 из 3 шагов. Primary-CTA меняется по шагу. Это 🛡-домен (синий), НЕ 🔐 (§1).

**5.1 — Step 1: показ QR + секрета (ОДИН РАЗ)** (`POST /account/mfa/enroll` → `{qr_svg, secret_base32, otpauth_uri}`)

```
   /account/profile ▸ Безопасность ▸ Включение 2FA
   ┌─ 🛡 Двухфакторная аутентификация (вход в инструмент) ───────────────┐
   │  ①Сканировать ──── ②Подтвердить ──── ③Резервные коды                 │  Wizard-индикатор §3.7
   │  ● current        ○ pending         ○ pending                       │
   │ ──────────────────────────────────────────────────────────────────  │
   │  Отсканируйте QR в Google Authenticator / 1Password / Authy:         │
   │                                                                      │
   │     ┌───────────────┐    Или введите ключ вручную:                   │
   │     │ ▒▒░▒▒░░▒▒░▒▒▒ │    [ JBSW Y3DP EHPK 3PXP ]  [⧉ копировать]     │  ← base32 mono, секрет
   │     │ ░▒▒░▒░▒▒░▒░▒░ │    ● валидный base32                           │    показан 1 раз; бейдж
   │     │ ▒░▒▒░▒▒░░▒▒░▒ │                                                │    валидности (norm §8.5 :904)
   │     └───────────────┘    ⚠ Секрет показывается один раз. Не закрывайте│
   │                            окно, пока не подтвердите код.            │  ← --status-error предупр.
   │                                                                      │
   │                                       [ Отмена ]  [ Далее → ]        │  PRIMARY=Далее
   └──────────────────────────────────────────────────────────────────────┘
   секрет НИКОГДА не в Tooltip/Toast/clipboard-лог (§4.6); копирование — только явное по кнопке
```

**5.2 — Step 1: loading / error генерации**

```
   LOADING (генерация секрета на сервере):          ERROR (500 mfa_enroll_failed):
   ┌─ 🛡 Двухфакторная аутентификация ─────┐        ┌─ 🛡 Двухфакторная аутентификация ─────┐
   │  ①Сканировать ── ②… ── ③…             │        │  ⚠ Не удалось начать настройку 2FA   │ ErrorState §3.12
   │  ┌─────────────┐                      │        │     mfa_enroll_failed                 │ code→t()
   │  │ ▦▦▦▦▦▦▦▦▦▦▦ │  Skeleton §3.12      │        │  [ Повторить ]   [ подробнее ]        │
   │  │ ▦▦▦▦▦▦▦▦▦▦▦ │  (shimmer)           │        └───────────────────────────────────────┘
   │  └─────────────┘  [ ▦▦▦▦▦▦ ]          │
   └───────────────────────────────────────┘
```

**5.3 — Step 2: confirm-enrollment (ввод кода ±1 шаг)** (`POST /account/mfa/confirm {code}`; проверка ±1 шаг, spec §8.4 `:897`)

```
   ┌─ 🛡 Двухфакторная аутентификация (вход в инструмент) ───────────────┐
   │  ①Сканировать ──── ②Подтвердить ──── ③Резервные коды                 │
   │  ✔ done            ● current        ○ pending                       │
   │ ──────────────────────────────────────────────────────────────────  │
   │  Введите 6-значный код из приложения — проверим, что секрет верный.  │
   │                                                                      │
   │      [_] [_] [_]   [_] [_] [_]                                       │  6 mono-ячеек
   │                                                                      │
   │  Принимается текущий код и соседний шаг (±30с).                      │  ← field-desc, отражает ±1 шаг
   │                                                                      │
   │                                       [ ← Назад ]  [ Подтвердить ]   │  PRIMARY, активна при 6 цифрах
   └──────────────────────────────────────────────────────────────────────┘
```

**5.4 — Step 2: состояния проверки**

```
   LOADING:                          ОШИБКА КОДА (invalid_totp):           ДРЕЙФ ЧАСОВ (clock_drift, §8.2:876):
  ┌──────────────────────────┐      ┌──────────────────────────┐         ┌──────────────────────────────────┐
  │ [4][8][1] [2][0][5]      │      │ [4][8][1] [2][0][3]      │←failed  │ [4][8][1] [2][0][5]              │
  │ [   ⟳ Проверяем…     ]   │      │ ✖ Код не подошёл.        │         │ ⚠ Код верный, но часы сервера    │
  └──────────────────────────┘      │   Проверьте время на     │         │   расходятся на 47с. 2FA может   │
                                     │   телефоне и повторите.  │         │   сбоить. Свяжитесь с админом.   │
                                     │ [ ← Назад ][ Подтвердить]│         │ [ Всё равно включить ][Отмена]   │
                                     └──────────────────────────┘         └──────────────────────────────────┘
   3 ошибки подряд → secret сбрасывается, возврат на Step 1 (защита от перебора)
```

**5.5 — Step 3: recovery-коды (показ ОДИН РАЗ)** (`POST /account/mfa/confirm` успех → `{recovery_codes:[...]}`; хранятся хеши sha256 §8.4 `:899`)

```
   ┌─ 🛡 Двухфакторная аутентификация (вход в инструмент) ───────────────┐
   │  ①Сканировать ──── ②Подтвердить ──── ③Резервные коды                 │
   │  ✔ done            ✔ done           ● current                       │
   │ ──────────────────────────────────────────────────────────────────  │
   │  ✔ 2FA подтверждена. Сохраните резервные коды — они показываются     │  --status-passed
   │    ОДИН раз. Каждый код одноразовый.                                 │
   │  ┌────────────────────────────────────────────────────────────┐     │
   │  │  a1b2-c3d4   e5f6-7a8b   c9d0-e1f2   3a4b-5c6d              │     │  8 кодов mono, в рамке
   │  │  7e8f-9a0b   1c2d-3e4f   5a6b-7c8d   9e0f-1a2b              │     │  --surface-2
   │  └────────────────────────────────────────────────────────────┘     │
   │  [ ⧉ Скопировать ]  [ ⤓ Скачать .txt ]                              │  icon-buttons §3.13
   │                                                                      │
   │  ☐ Я сохранил резервные коды в надёжном месте                        │  ← чек обязателен
   │                                       [ Готово · Включить 2FA ]      │  PRIMARY, disabled пока чек снят
   └──────────────────────────────────────────────────────────────────────┘
   при закрытии без подтверждения чека → ConfirmDialog §3.18 «Коды больше не покажем. Выйти?»
```

**5.6 — после включения: статус в Безопасности (default включённого состояния)**

```
   ┌─ 🛡 Двухфакторная аутентификация (вход в инструмент) ───────────────┐
   │  Статус:  ✔ включена                          включена 28.06.2026   │  StatusBadge §3.1 passed
   │  Резервные коды:  ● 8 из 8 не использовано                          │  secret-бейдж стиль
   │ ──────────────────────────────────────────────────────────────────  │
   │  [ Перегенерировать резервные коды ]   [ Выключить 2FA ]            │  danger §3.13
   └──────────────────────────────────────────────────────────────────────┘
   «Выключить 2FA» → ConfirmDialog §3.18 (требует текущий пароль; danger справа)
```

**5.7 — выключена (исходное состояние до enroll)**

```
   ┌─ 🛡 Двухфакторная аутентификация (вход в инструмент) ───────────────┐
   │  Статус:  ○ выключена                                                │  StatusBadge notset (серый)
   │  Защитите вход в инструмент одноразовыми кодами из приложения.       │  --text-muted
   │                                          [ Включить 2FA ]            │  PRIMARY → запускает Wizard (5.1)
   └──────────────────────────────────────────────────────────────────────┘
```

Переходы экрана 3: «Включить 2FA» → Step1→2→3 → 5.6; «Выключить»/«Перегенерировать» → ConfirmDialog; отмена на любом шаге → возврат в Безопасность (5.7), секрет аннулируется на сервере.

---

### 6. Экран 4 — Восстановление доступа / перенастройка 2FA

**Назначение:** два сценария — (a) вход по recovery-коду при потере телефона (уже показан как 3.7/экран 1), и (b) перенастройка 2FA после использования recovery-кода (audit `login.recovery_used` + предложение перенастроить, spec §8.4 `:899`). Это account-scoped, 🛡-домен.

**6.1 — точка входа в перенастройку** (баннер после входа по recovery, ведёт из 3.7-success)

```
   /account/profile ▸ Безопасность (после входа по резервному коду):
   ┌──────────────────────────────────────────────────────────────────┐
   │ ⚠ Вы вошли по резервному коду. Осталось 4 из 8.                   │  --status-error янтарный
   │   Лучше перенастроить 2FA: старый секрет мог быть скомпрометирован.│
   │                            [ Перенастроить 2FA → ]                 │  PRIMARY
   └──────────────────────────────────────────────────────────────────┘
```

**6.2 — перенастройка = re-enroll (требует подтверждение паролем)** (`POST /account/mfa/reset {password}` → новый enroll)

```
   ┌─ 🛡 Перенастройка 2FA входа ────────────────────────────────────────┐
   │  Это отзовёт текущий секрет и резервные коды. Подтвердите паролем.   │
   │  Текущий пароль                                                      │
   │  [ ●●●●●●●●                                                 ] [👁]   │
   │                                       [ Отмена ]  [ Продолжить → ]   │  PRIMARY
   └──────────────────────────────────────────────────────────────────────┘
       успех → запускается Wizard enroll заново (5.1 → 5.5), старые коды аннулированы.

   ОШИБКА ПАРОЛЯ (401 invalid_password):
   │ [ ●●●●●  ] ✖ Неверный пароль                                        │ инлайн error
```

**6.3 — пользователь потерял И телефон, И recovery-коды (тупик → эскалация к admin)**

```
   На /login/recovery, ссылка «Нет резервных кодов?»:
   ┌──────────────────────────────────────────────────────────────────┐
   │  🛡 Доступ потерян                                                 │
   │  ──────────────────────────────────────────────────────────────  │
   │  Если нет ни приложения, ни резервных кодов — сбросить 2FA может   │
   │  только администратор аккаунта.                                   │  --text-muted
   │  Обратитесь к: admin@team.io                                       │  email admin (не переводим §3.3)
   │  [ ← Назад ко входу ]                                              │
   └──────────────────────────────────────────────────────────────────┘
   (admin сбрасывает Login MFA пользователя в /account/users → audit)
```

Переходы экрана 4: баннер 6.1 → 6.2 → enroll-wizard (5.1); recovery-deadend 6.3 → `/login`.

---

### 7. Экран 5 — Первый онбординг (пустой аккаунт)

**Назначение:** замкнуть путь «регистрация → первый рабочий проект» без тупика (spec §7.9 `:849`). Пустой проект → чек-лист онбординга (spec §7.2 `:650`, §3.12 EmptyState). Шаги: создай проект → окружение → credential + Stand 2FA → запиши сценарий (агент) → запусти. Primary-CTA — текущий незавершённый шаг. Прогресс-чеклист — `ProgressBar` §3.16 (определённый) сверху. Терминологическая точность: на шаге credential включается **Stand 2FA (🔐, project-scoped)** — НЕ Login MFA; это единственное место раздела, где появляется 🔐, и мы явно подписываем разницу.

**7.1 — экран-приветствие (сразу после регистрации, кейс B)**

```
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ ts-playwright                                          [🌐RU][anna ▾]          │  ← account-уровень, рельса НЕТ
   ├──────────────────────────────────────────────────────────────────────────────┤
   │                                                                                │
   │                          ⊙   Добро пожаловать, anna                            │  EmptyState §3.12, центр
   │                                                                                │
   │          Вы — администратор своего аккаунта. Осталось 5 шагов до               │  --text-muted
   │          первого прогона. Это займёт ~10 минут.                                │
   │                                                                                │
   │                       [ ▶ Начать настройку ]                                   │  PRIMARY → 7.2
   │                       Пропустить и перейти к проектам →                         │  ← link → /projects
   └──────────────────────────────────────────────────────────────────────────────┘
```

**7.2 — чек-лист онбординга: default (шаг 1 активен)** (данные о выполненности — из наличия строк: projects/environments/credentials/scenarios/runs проекта)

```
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ ts-playwright                                          [🌐RU][anna ▾]          │
   ├──────────────────────────────────────────────────────────────────────────────┤
   │  Настройка первого проекта                                                     │  --text-lg
   │  ▓▓░░░░░░░░░░░░░░░░░░░░  0 из 5 готово                                          │  ProgressBar §3.16
   │  ┌──────────────────────────────────────────────────────────────────────────┐ │
   │  │ ● 1. Создать проект              ⟳ сейчас      [ Создать проект → ]        │ │  ● current --accent
   │  │   ○ 2. Добавить окружение (base_url)            ─                          │ │  ○ pending --text-faint
   │  │   ○ 3. Credential + 🔐 Stand 2FA  (TOTP стенда) ─                          │ │  ← 🔐 project-scoped (§1)
   │  │   ○ 4. Записать сценарий (агент)                ─                          │ │
   │  │   ○ 5. Запустить первый прогон                  ─                          │ │
   │  └──────────────────────────────────────────────────────────────────────────┘ │
   │  Шаг 3 включает 🔐 Stand 2FA — это 2FA тестируемого стенда, НЕ вход в           │  ← пояснение разницы,
   │  инструмент (вход защищается отдельно в Профиле 🛡).                            │     --text-muted
   └──────────────────────────────────────────────────────────────────────────────┘
   каждый «○ pending» шаг disabled, пока не выполнен предыдущий (последовательно)
```

**7.3 — чек-лист: середина (шаги 1-2 done, шаг 3 активен)**

```
   │  Настройка первого проекта                                                     │
   │  ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░  2 из 5 готово                                          │
   │  ┌──────────────────────────────────────────────────────────────────────────┐ │
   │  │ ✔ 1. Создать проект              Payments создан                          │ │  ✔ passed зелёный
   │  │ ✔ 2. Добавить окружение          stg · https://stg.acme.io               │ │  (base_url не переводим)
   │  │ ● 3. Credential + 🔐 Stand 2FA   ⟳ сейчас  [ Добавить credential → ]      │ │  ● current → /p/:pid/credentials
   │  │   ○ 4. Записать сценарий (агент)              ─                            │ │
   │  │   ○ 5. Запустить первый прогон                ─                            │ │
   │  └──────────────────────────────────────────────────────────────────────────┘ │
```

**7.4 — шаг 4 (агент): real-time запись сценария** (агент пишет сценарий; показываем живой статус — столп real-time §4.2)

```
   │  │ ✔ 3. Credential + 🔐 Stand 2FA   stand-admin · ●pwd ●2FA                  │ │  ●set секрет-бейджи §3.1
   │  │ ● 4. Записать сценарий (агент)   ⟳ агент записывает…                      │ │  ← running, пульс ⟳ (§5.2)
   │  │      ┌────────────────────────────────────────────────────────────────┐  │ │
   │  │      │ ⟳ Шаги записано: 7   последний: «клик #withdraw»               │  │ │  LiveLogConsole-стиль,
   │  │      │   ▏ ожидание следующего действия…                              │  │ │  SSE-поток (§4.2)
   │  │      └────────────────────────────────────────────────────────────────┘  │ │
   │  │   ○ 5. Запустить первый прогон                ─                            │ │
```

**7.5 — шаг 5 (real-time прогон): queued → running-фаза → passed/failed** (это кульминация онбординга; статусы и фазы из §5.1-5.2, `PhaseTimeline` §3.2)

```
   QUEUED:
   │ ● 5. Запустить первый прогон   ⋯ queued (поз. 1)   [ ▶ Запустить ]            │  ⋯ queued серый

   RUNNING (фаза pull, живой таймер + пульс — §4.2, §5.5):
   │ ● 5. Запустить первый прогон   ⟳ running                                      │  ⟳ синий пульс
   │   ✔Queued─✔Prepare─⟳Pull──────────○Container─○Execute─○Collect                │  PhaseTimeline §3.2
   │    0.2s    1.1s     0:18 ▓▓░ 1.5GB  —          —        —                      │  таймер тикает (rAF)

   PASSED (терминал — онбординг завершён):
   │ ✔ 5. Запустить первый прогон   ✔ passed 0:48                                  │  ✔ зелёный
   │   ✔Queued─✔Prepare─⊘Pull─✔Container─✔Execute─✔Collect─✔Done                   │  ⊘ cached серый

   FAILED (assertion — тест, красный):                ERROR (docker — инфра, янтарный):
   │ ⚠ 5. Запустить первый прогон   ✖ failed          │ ⚠ 5. …   ⚠ error (docker pull)
   │   …✖Execute  [ Trace ][ Retry ]                  │   …⚠Pull(failed)  [ Logs ][ Retry ]
   └ failed≠error: красный «тест» vs янтарный «инфра» (§2.3 инвариант, §4.1)
```

**7.6 — онбординг завершён**

```
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  5 из 5 готово  ✔                                         │  ProgressBar полный
   │                        🎉  Первый прогон прошёл                                │  (без анимации-«праздника», §5.5)
   │              Проект Payments готов к работе.                                   │
   │              [ Перейти к проекту → ]   [ Запустить ещё → ]                     │  PRIMARY → /p/:pid
   └──────────────────────────────────────────────────────────────────────────────┘
```

**7.7 — особый случай: viewer в чужом аккаунте без проектов** (НЕ admin — мёртвой кнопки быть не должно, spec §7.9 `:854`)

```
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │                          ⊙   Пока нет доступных проектов                       │  EmptyState §3.12
   │          Вы добавлены в аккаунт «ACME» как наблюдатель.                        │  --text-muted
   │          Подождите, пока администратор добавит вас в проект.                   │
   │          Администратор: admin@team.io                                          │  (НЕТ кнопки «создать» — §7.9 :854)
   └──────────────────────────────────────────────────────────────────────────────┘
```

Переходы экрана 5: приветствие 7.1 → чек-лист 7.2; каждый шаг ведёт в соответствующий project-раздел (`/p/:pid/environments`, `/p/:pid/credentials`, агент-запись, `/p/:pid/runs/:rid`) и возвращает с обновлённым прогрессом; завершение 7.6 → `/p/:pid` (дашборд).

---

### 8. Экран 6 — Профиль пользователя (`/account/profile`)

**Назначение:** управление собственным аккаунтом — смена пароля, язык RU/EN, выход, активные сессии, вход в Безопасность (Login MFA, экран 3). Account-уровень → **рельса проекта НЕТ** (spec §4.1 `:217` — отсутствие рельса само сигналит «ты вне проекта»). Primary-CTA на под-формах локальный. Overflow: нет. Доступ к языку дублирует переключатель `[anna ▾]` шапки (§3.3 `:200`).

**8.1 — default**

```
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ ts-playwright                                          [🌐RU][anna ▾]          │  ← рельса проекта НЕТ
   ├──────────────────────────────────────────────────────────────────────────────┤
   │  Профиль                                                                       │  --text-lg
   │  [ Профиль ]·[ Безопасность ]·[ Сессии ]                                       │  Tabs §3.9
   │  ▔▔▔▔▔▔▔▔▔                                                                      │
   │  ┌─ Профиль ────────────────────────────────────────────────────────────────┐ │
   │  │ Логин      anna            (нельзя изменить)                              │ │  --text-faint
   │  │ Email      [ anna@team.io                                ]                │ │  FormField §3.14
   │  │ Аккаунт    account_a3f9 · вы admin                                        │ │  доказывает владение (§7.9)
   │  │ Язык       ( ● RU )( ○ EN )                                              │ │  → cookie lang (§3.3), мгнов. ре-рендер
   │  │                                                          [ Сохранить ]    │ │  PRIMARY локально
   │  └──────────────────────────────────────────────────────────────────────────┘ │
   │  ┌─ Смена пароля ──────────────────────────────────────────────────────────┐  │
   │  │ Текущий пароль  [ ●●●●●●●●                          ] [👁]               │  │
   │  │ Новый пароль    [ ●●●●●●●●                          ] [👁]  ▓▓▓ норм      │  │  индикатор силы
   │  │ Повтор          [ ●●●●●●●●                          ]                     │  │
   │  │                                                       [ Сменить пароль ]  │  │  PRIMARY локально
   │  └──────────────────────────────────────────────────────────────────────────┘ │
   │  [ Выйти ]                                                                      │  secondary §3.13 → /logout
   └──────────────────────────────────────────────────────────────────────────────┘
```

**8.2 — смена пароля: success / error**

```
   SUCCESS → Toast (§3.8):                          ERROR (текущий пароль неверен):
   ┌──────────────────────────────────────┐         │ Текущий пароль [ ●●●●● ] ✖ Неверный пароль  │
   │ ✔ Пароль изменён. Другие сессии       │         │ (code→t("error.invalid_password"))          │
   │   завершены.                         ✕│         ── ИЛИ совпадение нового со старым:
   └──────────────────────────────────────┘         │ Новый [ ●●●●●●●● ] ✖ Новый пароль совпадает  │
   смена пароля инвалидирует прочие сессии           │   с текущим                                  │
   (видно во вкладке Сессии 8.4)
```

**8.3 — вкладка Безопасность (точка входа в Login MFA, экран 3)**

```
   │  [ Профиль ]·[ Безопасность ]·[ Сессии ]                                       │
   │              ▔▔▔▔▔▔▔▔▔▔▔▔▔                                                      │
   │  ┌─ 🛡 Двухфакторная аутентификация (вход в инструмент) ──────────────────────┐ │
   │  │  Статус:  ✔ включена · резервных кодов 8/8                                 │ │  (см. 5.6 / 5.7)
   │  │  [ Перегенерировать резервные коды ]   [ Выключить 2FA ]                  │ │
   │  └──────────────────────────────────────────────────────────────────────────┘ │
   │  ┌─ Подсказка ───────────────────────────────────────────────────────────────┐│
   │  │ 🔐 2FA тестируемых стендов настраивается отдельно — в каждом проекте,      ││  ← разводим Stand 2FA,
   │  │    в разделе Credentials.  (это НЕ вход в инструмент)                      ││     уводим в project-раздел
   │  └──────────────────────────────────────────────────────────────────────────┘│
```

**8.4 — вкладка Сессии (активные сессии)** (`GET /account/sessions` → серверные opaque-сессии)

```
   │  [ Профиль ]·[ Безопасность ]·[ Сессии ]                                       │
   │                              ▔▔▔▔▔▔▔▔                                          │
   │  ┌─ Активные сессии ───────────────────────────────────────────────────────┐  │
   │  │ Устройство / IP              Вход        Активность     │                │  │  Table §3.4
   │  │ ─────────────────────────────────────────────────────────────────────── │  │
   │  │ ● Chrome · Windows 10.0.0.4  сегодня     только что  ●эта  │ —           │  │  ●эта сессия (без kill)
   │  │   Firefox · macOS 10.0.0.9   вчера       2ч назад        │ [ Завершить ] │  │  danger-link §3.13
   │  │   CLI token 10.0.0.7         3д назад    1д назад        │ [ Завершить ] │  │
   │  │ ─────────────────────────────────────────────────────────────────────── │  │
   │  │                                          [ Завершить все, кроме этой ]    │  │  danger → ConfirmDialog §3.18
   │  └──────────────────────────────────────────────────────────────────────────┘ │

   LOADING: Skeleton-строки §3.12   ·   EMPTY (только текущая): "Других активных сессий нет"
   «Завершить все» → ConfirmDialog §3.18: «Завершить N сессий? Их придётся войти заново.»
```

**8.5 — выход** (`[ Выйти ]` → `/logout`; заменяет `cabinet/logout` `app.ts:157-160`)

```
   [ Выйти ] → ConfirmDialog §3.18 (лёгкое подтверждение, без ввода имени):
   ┌─────────────────────────────────────────────┐
   │  Выйти из ts-playwright?                      │
   │─────────────────────────────────────────────│
   │  Текущая сессия будет завершена.             │
   │                  [ Отмена ]  [ Выйти ]        │  → POST /logout → /login
   └─────────────────────────────────────────────┘
   серверная opaque-сессия аннулируется; cookie сбрасывается (как app.ts:158)
```

Переходы экрана 6: «Безопасность» → enroll/disable Login MFA (экран 3); «Перенастроить» → экран 4; «Выйти» → ConfirmDialog → `/login`; язык RU/EN → cookie `lang` + мгновенный ре-рендер.

---

### 9. Сводка привязок к коду и спецификации (для ревью)

```
ЭКРАН / ЭЛЕМЕНТ                ИСТОЧНИК (spec)                  КОД (заменяем/опираемся)
Login default/error/locked     §7.9 :825-833, :846             app.ts:136-155 (cabinet-выбор → снести)
Login MFA шаг                  §7.9 :827-832, §8.4 :893-897    новый /login/2fa
recovery-код                  §8.4 :899, DDL :1102-1108        user_recovery_codes (хеши sha256)
Self-Register + claim/own acc §7.9 :849-854                    нет (новый); создаёт accounts+memberships+projects
enroll Login MFA (QR/secret)  §8.4 :897, §7.9 :836-844         otp.ts:54 (есть), generateTotpSecret() ДОБАВИТЬ §8.4
confirm-enrollment ±1 шаг     §7.9 :847, §8.4 :897             otp.ts:9 normalizeTotpSecret (бейдж валидности §8.5:904)
бейдж "● валидный/✖ не base32"§8.5 :904                        otp.ts:186 decodeBase32 (синхр. проверка)
recovery-коды показ 1 раз     §8.4 :899                        sha256-хеши, user_recovery_codes
дрейф часов при проверке      §8.2 :876                        otp.ts:139 queryNtpDrift (свести часы)
Онбординг-чеклист (пустой акк)§7.2 :650, §7.9 :849-854         EmptyState; наличие строк projects/env/cred/scenario/run
Stand 2FA на шаге 3 (🔐)       §8.3 :880-891, §1 :23           stand_credentials.totp_secret_enc (project-scoped)
real-time прогон в онбординге §5.1-5.2 :295-357                phase/outcome оси, PhaseTimeline §3.2
Профиль / язык / выход        §3.1 :132, §3.3 :200, §4.1 :217  app.ts:157 cabinet/logout → /logout
активные сессии               §7.9 :846 (opaque-сессии)        новые серверные сессии
Login MFA vs Stand 2FA развод §8.4 :893-895, §1 :23            🛡 (--accent) vs 🔐 (--status-2fa)
```

Дизайн-система применена единообразно: токены §2 (`--accent`, `--status-*`, `--font-mono` для кодов/секретов/base32, `--control-h` comfortable для форм), компоненты §3 (`FormField`/`SecretField` write-only §3.14, `Modal`/`ConfirmDialog` вместо `alert`/`confirm` §4.4, `Wizard` §3.7 для enroll/онбординга, `ProgressBar` §3.16, `StatusBadge`/`PhaseTimeline` для real-time §3.1-3.2, `Toast` §3.8, `Skeleton`/`EmptyState`/`ErrorState` §3.12, `Tabs` §3.9, `Table` §3.4), конвенции §4 (один primary-CTA, секреты никогда в DOM/Tooltip/Toast §4.6, доступность/фокус §4.7, коды ошибок `error.*`→`t()` §3.3), движение §5 (пульс ⟳ активной фазы/проверки, обратный отсчёт rate-limit на клиенте, без «праздников» §5.5). Терминологический инвариант соблюдён во всех моках: вход в инструмент — **🛡 Login MFA** (синий, account-scoped, Профиль); стенд — **🔐 Stand 2FA** (фиолетовый, project-scoped, Credentials), и он появляется только на шаге 3 онбординга с явной подписью различия.

---

## 4. Уровень аккаунта и управление проектами

I now have all the grounding I need: the design system (tokens §2, components §3, conventions §4), spec sections 2.3-2.6, 3.1-3.2, 4.1-4.3, 7.1, 10, the DDL (accounts/projects/memberships/audit), research 6.3 role matrix and 6.7 audit. Let me write the section.

I have everything required. Producing the final design specification section now.

---

### 1. Глобальный навигационный каркас (AppShell): уровни «аккаунт» vs «проект»

**Назначение:** единый каркас, который в каждый момент кричит «в каком ты проекте» (или «ты вне проекта»). Заменяет `page(title, body)` без рельса и шапки (`apps/server/src/html.ts:4182`). Компонент — `AppShell` (дизайн-система §4.2 spec, §3 каталога).

**Главный инвариант изоляции (spec §3.1, §4.1):** account-уровень рендерится **без project-рельса** — само отсутствие рельса сигналит «ты вышел из проекта». Project-уровень всегда несёт switcher + цветовую полосу `--project-accent` (§2.8) + имя проекта в каждой крошке (spec §2.4, механизм 2).

#### 1.1 Каркас целиком — PROJECT-уровень (`/p/:pid/*`), состояние default

Шапка (`--z-header`): слева `[≡]` + продукт; центр — крошки с точкой проекта; справа — глобальные real-time индикаторы (один SSE-канал `/api/stream/execution`, spec §4.2), язык, меню пользователя. Тонкий цветной кант шапки = `--project-accent` (§2.8).

```
┌════════════════════════════════════════════════════════════════════════════════┐ ◀ кант --project-accent (teal)
│ [≡] ts-playwright   ● Payments ▸ Runs            [▶3 running][🔔1][🌐RU▾][anna▾] │  z-header
├───────────────┬────────────────────────────────────────────────────────────────┤
│ ┃┌──────────┐ │  ┌─ RUNS · Payments ───────────────────────[ ▶ Run · Payments ]┐│  ◀ primary-CTA несёт
│ ┃│●Payments▾│ │  │ ⟳ withdraw-flow  running 0:42  anna  payouts              → ││    имя проекта (§2.4 мех.3)
│ ┃└──────────┘ │  │ ✖ deposit·2      failed        12:01 [Trace][Retry]       → ││
│ ┃ ◀switcher   │  │ ✔ refund-flow    passed        11:58                      → ││
│ ┃ полоса      │  └────────────────────────────────────────────────────────────┘│
│ ПРОЕКТ        │                                                                  │
│ ▸ Обзор       │   Левый рельс (--z-rail): ЧАСТОЕ сверху, РЕДКОЕ снизу            │
│   Сценарии    │   отделённой группой (spec §4.3).                                │
│   Прогоны     │                                                                  │
│ ДАННЫЕ СТЕНДА │   Цветовая полоса ┃ слева = --project-accent (§2.8),             │
│   Credentials │   дублирует switcher → «в каком я проекте» видно периферией.     │
│   Merchants   │                                                                  │
│   Pools       │                                                                  │
│   Окружения • │                                                                  │
│   Переменные  │                                                                  │
│ ────────────  │                                                                  │
│   Настройки   │   • = есть «Проверить доступность стенда» (spec §7.8)            │
└───────────────┴────────────────────────────────────────────────────────────────┘
  иконки рельса (Lucide §4.1): Обзор LayoutDashboard · Сценарии FileCode · Прогоны ListChecks
  Credentials KeyRound · Merchants Store · Pools Database · Окружения Globe · Настройки Settings
```

- **Primary-CTA:** `[ ▶ Run · Payments ]` — один на экран, несёт имя проекта (spec §2.4 мех.3, §4.3).
- **Overflow (шапка):** `[anna ▾]` → Профиль · Мои проекты · Плотность (compact/comfortable §2.6) · Тема (light/dark §2.1) · 🌐 RU/EN · Выйти.
- **Advanced:** нет на каркасе (каркас — это рамка).
- **Данные/откуда:** индикатор `[▶3 running]` и `[🔔1]` — из SSE `/api/stream/execution` (spec §4.2, §5.8, наполняется `run_queue`/`workers`); крошки — из URL `/p/:pid/*` (spec §2.3, URL первичен); список разделов рельса — статический sitemap (spec §3.2), пункты гасятся по роли (RBAC §5.6 ниже).
- **Переходы:** клик по пункту рельса → `/p/:pid/<section>` (project сохраняется); `● Payments ▸ Runs` — каждый сегмент крошки кликабелен (Breadcrumbs §3.15); `[🔔]` → NotificationCenter (§3.8); switcher → §3 ниже.

#### 1.2 Каркас — ACCOUNT-уровень (`/projects`, `/account/*`), default

Рельса проекта **нет** (spec §3.1, §4.1). Вместо switcher — горизонтальный account-навбар. Нет цветовой полосы проекта (ты вне проекта — нейтральная шапка).

```
┌────────────────────────────────────────────────────────────────────────────────┐ ◀ нейтральный кант (НЕ project-accent)
│ [≡] ts-playwright   Аккаунт ▸ Мои проекты        [▶4 running][🔔2][🌐RU▾][anna▾] │  z-header
├────────────────────────────────────────────────────────────────────────────────┤
│  [ Мои проекты ]  Пользователи   Система   Аудит   Профиль        ← account-навбар │  ◀ табы, НЕ рельс
│  ▔▔▔▔▔▔▔▔▔▔▔▔ active (--accent кант снизу)   ↑только admin видит 3 средних       │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   (контент account-уровня — без рельса слева; широкая рабочая область)           │
│                                                                                  │
└────────────────────────────────────────────────────────────────────────────────┘
  Отсутствие рельса = сигнал «ты вышел из проекта» (spec §3.1).
```

- **Account-навбар** (Tabs §3.9): «Мои проекты» (все), «Пользователи»/«Система»/«Аудит» (только admin, spec §3.1), «Профиль» (сам). Маршруты — `/projects`, `/account/users`, `/account/system`, `/account/audit`, `/account/profile` (spec §3.2).
- **Данные/откуда:** видимость admin-табов — RBAC (`hasPermission(role,...)`, research §6.3); индикаторы — тот же глобальный SSE.

#### 1.3 Каркас — состояние LOADING (skeleton каркаса, первый рендер до данных)

Каркас рисуется сразу (URL → проект известен), наполнение — skeleton (§3.12, TanStack Query `isPending`).

```
┌════════════════════════════════════════════════════════════════════════════════┐
│ [≡] ts-playwright   ● ▦▦▦▦▦▦ ▸ ▦▦▦              [▦▦▦▦][🔔·][🌐··▾][▦▦▦▦▾]        │  ◀ индикаторы — shimmer
├───────────────┬────────────────────────────────────────────────────────────────┤
│ ┃┌──────────┐ │  ▦▦▦▦▦▦▦▦▦   ▦▦▦   ▦▦▦▦▦                       [ ▦▦▦▦▦▦▦▦ ]     │
│ ┃│●▦▦▦▦▦▦ ▾│ │  ▦▦▦▦▦▦     ▦▦    ▦▦▦▦▦                                          │
│ ┃└──────────┘ │  ▦▦▦▦▦▦▦▦   ▦▦▦   ▦▦▦▦▦       ← shimmer-строки (форма таблицы)   │
│ ▸ ▦▦▦▦▦       │  ▦▦▦▦       ▦▦    ▦▦▦▦▦                                          │
│   ▦▦▦▦▦▦      │                                                                  │
│   ▦▦▦▦▦▦      │  Рельс показывает РЕАЛЬНЫЕ названия (статический sitemap),        │
│   …           │  shimmer только там, где ждём API (switcher-имя, контент).        │
└───────────────┴────────────────────────────────────────────────────────────────┘
  shimmer §6 (--pulse-period); prefers-reduced-motion → статичные плашки (§4.7).
```

#### 1.4 Каркас — состояние ERROR (проект недоступен / нет доступа)

Гард `/p/:pid/*` отдаёт **404, не 403** (не раскрываем существование чужого проекта — spec §3.2). Каркас деградирует до account-уровня (рельс убран — ты не в проекте) + ErrorState (§3.12).

```
┌────────────────────────────────────────────────────────────────────────────────┐  ◀ рельс УБРАН (нет доступа = ты вне проекта)
│ [≡] ts-playwright   Аккаунт                       [▶4 running][🔔2][🌐RU▾][anna▾]│
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│                          ⚠  Проект не найден                                     │
│              Такого проекта нет или у вас нет к нему доступа.                     │  ◀ code→t() (spec §3.3)
│                          error.project_not_found                                 │
│                                                                                  │
│                  [ ← К моим проектам ]   [ Сменить аккаунт ]                      │
└────────────────────────────────────────────────────────────────────────────────┘
  Намеренно НЕ говорим «нет прав на проект X» — не подтверждаем существование (spec §3.2).
```

#### 1.5 Cross-project баннер (перешёл по чужой ссылке — spec §2.4 мех.5)

Когда пользователь попал в проект через ссылку, отличный от `last_project` cookie — поверх контента показывается дисмиссируемый баннер (защита «в каком я проекте»).

```
├───────────────┬────────────────────────────────────────────────────────────────┤
│ ┃│●Withdraw▾│ │ ┌────────────────────────────────────────────────────────────┐ │  ◀ кант --project-accent (rose)
│ ┃└──────────┘ │ │ ⓘ Вы в проекте Withdrawals (перешли по ссылке)        [✕] │ │
│ …             │ └────────────────────────────────────────────────────────────┘ │
```

#### 1.6 Адаптив каркаса (§4.8)

```
≥1280   рельс развёрнут (иконка+подпись) + switcher-чип
1024-79 [≡] сворачивает рельс в иконки (подпись в Tooltip §3.17); switcher → только цв.точка+▾
<1024   рельс off-canvas (бургер [≡] выдвигает поверх --z-rail); контент во всю ширину
```

---

### 2. Экран «Мои проекты» (`/projects`)

**Назначение:** точка входа account-уровня — выбрать проект и увидеть живую активность по каждому (spec §7.1). Счётчики creds/merchants/env **доказывают изоляцию** (spec §7.1, §2.4).

- **Primary-CTA:** `[ + Новый проект ]` (§4 ниже).
- **Overflow карточки `⋯`:** Открыть · Переименовать · Дублировать настройки (без секретов) · Архивировать · Участники (spec §7.1).
- **Advanced:** в модалке создания — «Скопировать настройки» (структура env/merchants/pool-шаблоны, **никогда секреты** — spec §7.1).
- **Данные/откуда:** карточки — `GET /api/projects` (текущий `ProjectSchema`, `packages/shared/src/schemas.ts:63`, расширяется агрегатами счётчиков `scenarios/credentials/merchants/env` и последним run); живые бейджи running/idle — SSE `/api/stream/execution` (spec §4.2, §5.8), точечный патч бейджа без reload (§4.2).
- **Переходы:** карточка (или «открыть →») → `/p/:pid` (Дашборд) + установка `last_project` cookie (spec §2.3). Источник истины активного проекта — URL.

#### 2.1 Default (сетка карточек, живые бейджи)

Cards §3.5, цветовая полоса слева `--project-accent` (§2.8). Бейджи статуса — StatusBadge §3.1 (глифы §4.1).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright   Аккаунт ▸ Мои проекты        [▶4 running][🔔2][🌐RU▾][anna▾] │
├────────────────────────────────────────────────────────────────────────────────┤
│  [ Мои проекты ]  Пользователи  Система  Аудит  Профиль                          │
├────────────────────────────────────────────────────────────────────────────────┤
│  Мои проекты  ·  3 проекта                                  [ + Новый проект ]   │
│                                                                                  │
│  ┃┌──────────────┐  ┃┌──────────────┐  ┃┌──────────────┐                        │
│  ┃│ Payments    ⋯│  ┃│ KYC         ⋯│  ┃│ Withdrawals ⋯│   ┃ = --project-accent  │
│  ┃│ ⟳ 3 running   │  ┃│ ● idle        │  ┃│ ⚠ 2 failed    │   (teal/indigo/rose)  │
│  ┃│ 42 сценария   │  ┃│ 11 сценариев  │  ┃│ 7 сценариев   │                        │
│  ┃│ 5 creds·3 mrch│  ┃│ 2 creds·1 mrch│  ┃│ 1 cred ·1 mrch│ ◀ счётчики ДОКАЗЫВАЮТ │
│  ┃│ env: stg,prod │  ┃│ env: stg      │  ┃│ env: prod     │    изоляцию (§2.4)     │
│  ┃│ посл.: 12:01✔ │  ┃│ посл.: вчера✔ │  ┃│ посл.: 11:48✖ │                        │
│  ┃└──────────────┘  ┃└──────────────┘  ┃└──────────────┘                        │
│      hover→--shadow-2 поднятие · focus→--focus-ring · вся карточка кликабельна    │
└────────────────────────────────────────────────────────────────────────────────┘
  бейдж активности: ⟳ N running (синий, пульс §6) · ● idle (серый) · ⚠ N failed (янтарный/красный)
```

#### 2.2 Real-time варианты бейджа карточки (queued / running / passed / failed)

Бейдж патчится по SSE без перезагрузки карточки (§4.2). Все варианты — отдельно:

```
⟳ 3 running    синий, глиф пульсирует (§6) — идёт прямо сейчас
⋯ 2 queued     серо-синий — ждут воркера (queue depth, §5.8)
● idle          серый — нет активности
✔ всё прошло   зелёный кант последнего run — посл.: 12:01✔
⚠ 2 failed     красный (assertion) / янтарный кант если последний был error(docker)
```

#### 2.3 Loading — skeleton сетки

```
│  Мои проекты                                               [ + Новый проект ]    │
│  ┃┌──────────────┐  ┃┌──────────────┐  ┃┌──────────────┐                        │
│  ┃│ ▦▦▦▦▦▦▦▦    ·│  ┃│ ▦▦▦▦▦▦      ·│  ┃│ ▦▦▦▦▦▦▦▦    ·│                        │
│  ┃│ ▦▦ ▦▦▦▦▦      │  ┃│ ▦▦ ▦▦▦▦       │  ┃│ ▦▦ ▦▦▦▦▦      │  ◀ shimmer §6          │
│  ┃│ ▦▦▦▦▦         │  ┃│ ▦▦▦▦▦         │  ┃│ ▦▦▦▦▦         │                        │
│  ┃│ ▦▦▦▦▦▦▦       │  ┃│ ▦▦▦▦▦▦▦       │  ┃│ ▦▦▦▦▦▦▦       │                        │
│  ┃└──────────────┘  ┃└──────────────┘  ┃└──────────────┘                        │
   полоса --project-accent НЕ shimmer (цвет проекта стабилен из hash(id)).
```

#### 2.4 Empty — нет проектов (онбординг, не тупик — §3.12, §4.5)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Мои проекты                                                                     │
│                                                                                  │
│                                   📁                                              │
│                        У вас пока нет проектов                                   │
│         Проект изолирует учётки, мерчантов, пулы и сценарии стенда.              │
│                                                                                  │
│                        [ + Создать первый проект ]                               │  ◀ ведёт к действию
│                                                                                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 2.5 Error — список не загрузился (§3.12)

```
│                              ⚠ Не удалось загрузить проекты                       │
│                              error.server_unreachable          ← code→t() §3.3    │
│                              [ Повторить ]    [ подробнее ]                       │
```

#### 2.6 Много проектов — поиск/фильтр + переключение вида

При >~8 проектах появляется панель управления списком (поиск `/`-хоткей §4.7, фильтр статуса, сорт, тумблер сетка/список).

```
│  Мои проекты · 24 проекта                                  [ + Новый проект ]    │
│  🔍 [ поиск проекта…           ]  [⟳active][⚠failed][архивные]   сорт:[активность▾]  [▦сетка|≣список]│
│  ────────────────────────────────────────────────────────────────────────────── │
│  ┃ ● Payments      ⟳ 3 running   42 сцен · 5 cr · stg,prod   12:01✔   открыть → │  ◀ компактный список
│  ┃ ● KYC           ● idle        11 сцен · 2 cr · stg        вчера✔   открыть → │
│  ┃ ⚠ Withdrawals   ⚠ 2 failed     7 сцен · 1 cr · prod        11:48✖   открыть → │
│  ┃ ▢ Legacy-2023   ⌗ архивный     —                          —        открыть → │  ◀ архивный приглушён
│  …                                                                               │
   список наследует --row-h compact (§2.6); чип-фильтры = status-chips (§3.4).
```

---

### 3. Project Switcher

**Назначение:** постоянный контекст проекта в шапке рельса — **главная защита от «в каком я проекте?»** (spec §2.3, §2.4). Компонент ProjectSwitcher §3.10 (Radix DropdownMenu + поиск).

- **Primary-действие:** выбор проекта = смена URL с **сохранением подраздела** (`/p/A/runs` → `/p/B/runs`, не сброс на обзор — spec §2.3).
- **Overflow в меню:** `+ Новый проект…` · `↪ Все проекты (/projects)`.
- **Данные/откуда:** список — `GET /api/projects` + per-проект live-активность из SSE `/api/stream/execution` (бейджи `▶N`, 🔔); активный — из URL `:pid` (spec §2.3 URL первичен); цвет — `hash(projectId)` (§2.8).

#### 3.1 Закрыт — контекст-чип (default)

Полоса `--project-accent` слева (§2.8) + точка цвета проекта. Это «якорь» периферийного зрения.

```
┌──────────┐
│┃●Payments▾│   ┃ = полоса --project-accent · ● = точка цвета проекта · ▾ = раскрыть
└──────────┘
   при running в проекте: ●→⟳ (точка пульсирует §6) — «здесь что-то идёт прямо сейчас»
```

#### 3.2 Открыт — поиск, цветовые токены, живые бейджи активности

```
┌──────────┐
│┃●Payments▾│
└─┬────────┘
  ▼
┌─────────────────────────────────────┐  z-rail
│ 🔍 [ поиск проекта…              ]   │  ◀ автофокус, хоткей "/"
│─────────────────────────────────────│
│ ┃● Payments      ⟳ 2 running    ✓   │  ◀ активный: фон --accent-subtle, галка ✓
│ ┃  KYC           idle               │     ┃ = цветовая точка проекта (--project-accent)
│ ┃⚠ Withdrawals   ⟳ 1  🔔            │  ◀ есть падения → 🔔 (из SSE)
│ ┃  Deposits      ⋯ 4 queued         │  ◀ очередь (§5.8)
│─────────────────────────────────────│
│ + Новый проект…                     │  ◀ overflow
│ ↪ Все проекты (/projects)           │
└─────────────────────────────────────┘
  каждая строка: ┃цв.точка · имя · бейдж активности (StatusBadge §3.1, глифы §4.1)
```

#### 3.3 Открыт — поиск с вводом (фильтрация)

```
┌─────────────────────────────────────┐
│ 🔍 [ with|                       ]   │
│─────────────────────────────────────│
│ ┃⚠ Withdrawals   ⟳ 1  🔔            │  ◀ подсветка совпадения: Withdrawals
│─────────────────────────────────────│
│ (1 из 24)                            │
└─────────────────────────────────────┘
```

#### 3.4 Открыт — loading (проекты ещё грузятся)

```
┌─────────────────────────────────────┐
│ 🔍 [ поиск проекта…              ]   │
│─────────────────────────────────────│
│ ┃▦▦▦▦▦▦▦▦      ▦▦▦▦▦                │  ◀ shimmer §6, активный
│ ┃▦▦▦▦▦         ▦▦▦                  │
│ ┃▦▦▦▦▦▦▦▦▦     ▦▦▦▦▦                │
└─────────────────────────────────────┘
```

#### 3.5 Открыт — empty (поиск без результата)

```
┌─────────────────────────────────────┐
│ 🔍 [ zzz|                        ]   │
│─────────────────────────────────────│
│        Ничего не найдено             │
│        [ + Создать «zzz» ]           │  ◀ не тупик: предложить создание
└─────────────────────────────────────┘
```

#### 3.6 Переключение с сохранением подраздела (поведение, не отдельный экран)

```
Был:  /p/PAY/credentials   ──выбор «Withdrawals» в switcher──►   /p/WDR/credentials
                                                                  ▲ тот же подраздел, не /p/WDR обзор (spec §2.3)
Сразу после:  крошки → ●Withdrawals ▸ Credentials · кант шапки → rose · полоса рельса → rose
              + cross-project баннер если переход «из чужой ссылки» (§1.5)
              cookie last_project ← WDR (для редиректа с голого "/", spec §2.3)
```

---

### 4. Создание / редактирование проекта

**Назначение:** завести проект (имя + цвет-токен + болванки окружений) или отредактировать (spec §7.1). Компонент — Modal §3.6 (создание — лёгкая форма; редактирование — та же модалка с заполненными полями). Wizard не нужен: обязательно только **Название** (spec §7.1), остальное — Advanced.

- **Primary-CTA:** `[ Создать ]` / `[ Сохранить ]` (footer справа, §3.6).
- **Overflow:** нет (одна форма).
- **Advanced (прогрессивное раскрытие §4.3):** «Скопировать настройки из проекта» — копирует структуру env/merchants/pool-шаблоны, **никогда секреты** (spec §7.1, мера write-only §4.6); болванки окружений (stg/prod).
- **Данные/откуда:** `POST /api/projects` / `PATCH /api/projects/:pid`; валидация — Zod-resolver (`ProjectSchema` `schemas.ts:63`, расширяется `color_token`), `UNIQUE(account_id, name)` (DDL §9.1 spec) → ошибка «имя занято»; цвет — палитра §2.8 (`hash` по умолчанию, можно переопределить).

#### 4.1 Создание — default

```
┌──────────────────────────────────────────────────────────┐  overlay --overlay
│  Новый проект                                       [ ✕ ] │  box --shadow-3 (z-modal)
│──────────────────────────────────────────────────────────│
│  Название*                                                │
│  [ Payouts EU                       ]                     │
│  Уникально в пределах аккаунта                            │  ◀ field-desc (muted)
│                                                           │
│  Цвет проекта                                             │  ◀ ось §2.8, НЕ статус
│  ( ●teal )( ○indigo )( ○amber )( ○rose )( ○violet )       │
│  ( ○cyan )( ○lime )( ○slate )      ◀ 8 спокойных оттенков │
│                                                           │
│  ▸ Скопировать настройки (Advanced)                       │  ◀ свёрнуто
│  ▸ Окружения-болванки (Advanced)                          │
│──────────────────────────────────────────────────────────│
│                                  [ Отмена ]  [ Создать ]  │  ◀ primary справа
└──────────────────────────────────────────────────────────┘
```

#### 4.2 Создание — Advanced раскрыт (копирование настроек + болванки окружений)

```
│  ▾ Скопировать настройки (Advanced)                       │
│    Из проекта: [ Payments ▾ ]                             │
│    ☑ Окружения (stg, prod)   ☑ Мерчанты-шаблоны          │
│    ☑ Структура пулов         ☐ Переменные server_*       │
│    ⓘ Секреты (пароли, TOTP) НЕ копируются никогда         │  ◀ write-only §4.6, spec §7.1
│                                                           │
│  ▾ Окружения-болванки (Advanced)                          │
│    [ stg  ] base_url [ https://stg.stand.internal      ] [✕]│
│    [ prod ] base_url [ https://prod.stand.internal     ] [✕]│
│    [ + окружение ]                                        │
```

#### 4.3 Создание — валидация (имя занято)

Онлайн через Zod-resolver (§1, §3.14). Кнопка `Создать` disabled пока есть ошибка.

```
│  Название*                                                │
│  [ Payments                         ]                     │
│  ⚠ Проект с таким именем уже есть в аккаунте              │  ◀ --status-failed-fg
│                                  [ Отмена ]  [ Создать ]✗ │  ◀ disabled
```

#### 4.4 Создание — submitting (loading)

```
│                                  [ Отмена ]  [ ⟳ Создание… ]│  ◀ спиннер, блокирует повтор (§3.13)
```

#### 4.5 Создание — error (сервер отклонил)

Тост (§3.8, конвенция §4.4 — ошибка операции = Toast, не блокирующая модалка):

```
┌────────────────────────────────────────┐
│ ✖ Не удалось создать проект           ✕│  красный кант
│   error.project_name_conflict           │  ◀ code→t() §3.3
│   [ подробнее ]                         │
└────────────────────────────────────────┘
```

#### 4.6 Редактирование (`⋯ → Переименовать` / Настройки проекта)

Та же модалка, поля заполнены. Название + цвет редактируемы; смена цвета сразу перекрашивает `--project-accent` по всему каркасу.

```
┌──────────────────────────────────────────────────────────┐
│  Проект · Payments                                  [ ✕ ] │
│──────────────────────────────────────────────────────────│
│  Название*   [ Payments                  ]                │
│  Цвет        ( ●teal )( ○indigo )…                        │  ◀ смена → перекраска каркаса
│  Статус      ◉ active   ○ archived                        │  ◀ архив (DDL status §9.1)
│──────────────────────────────────────────────────────────│
│                                  [ Отмена ]  [ Сохранить ]│
└──────────────────────────────────────────────────────────┘
```

#### 4.7 Архивирование / удаление (ConfirmDialog §3.18 — масштаб + имя проекта)

```
┌─────────────────────────────────────────────┐
│  ⚠ Удалить проект Payments?                  │  ◀ имя проекта (spec §2.4 мех.3)
│─────────────────────────────────────────────│
│  Будет удалено безвозвратно:                 │  ◀ МАСШТАБ последствий
│  · 42 сценария  · 128 прогонов               │
│  · 5 credentials (с секретами) · 3 мерчанта  │
│  · 4 пула (831 значение)                     │
│─────────────────────────────────────────────│
│  Для подтверждения введите имя проекта:      │  ◀ необратимое → ввод имени
│  [ Payments              ]                   │
│              [ Отмена ]  [ 🗑 Удалить ]✗      │  ◀ disabled пока имя≠
└─────────────────────────────────────────────┘
  Архивирование (обратимо) → лёгкое подтверждение, БЕЗ ввода имени, две кнопки.
```

---

### 5. Участники (Users / Members) и матрица прав

Две поверхности: **account-уровень** `/account/users` (люди аккаунта, account-wide роли — spec §3.1, admin-only) и **project-уровень** `/p/:pid/settings → Участники` (доступ к конкретному проекту — spec §7.1 `⋯→Участники`). Модель ролей: `viewer / operator / admin` + `is_superadmin` (research §6.3); двухуровневый membership (`project_id NULL` = account-wide, DDL таблица C §9.1).

- **Primary-CTA:** `[ + Пригласить ]` (account) / `[ + Добавить участника ]` (project).
- **Overflow строки `⋯`:** Изменить роль · Деактивировать · Убрать из проекта · (account) Сбросить сессии.
- **Advanced:** на приглашении — «Создать как account-wide admin» (claim первого admin при self-register — spec §7.9 / 3.M7); срок действия инвайта.
- **Данные/откуда:** `GET /api/account/users` (users + memberships, DDL A/C §9.1); роли — `memberships.role`; изменение — `PATCH /api/memberships/:id {role}` (audit `role.change`, research §6.7); приглашение — `POST /api/account/invites`; удаление из проекта — `DELETE /api/memberships/:id` (audit `team.member.*`). Все действия — admin-only (RBAC research §6.3), пишут audit_log в той же транзакции (research §6.7).

#### 5.1 Account Users — default (Table §3.4)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright   Аккаунт ▸ Пользователи        [▶4][🔔2][🌐RU▾][anna▾]        │
├────────────────────────────────────────────────────────────────────────────────┤
│  Мои проекты  [ Пользователи ]  Система  Аудит  Профиль                          │
├────────────────────────────────────────────────────────────────────────────────┤
│  Пользователи аккаунта · 5                  🔍[поиск…]        [ + Пригласить ]   │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ Пользователь        │ Роль (account) │ Проекты │ 2FA │ Активность │       │  │
│  │─────────────────────┼────────────────┼─────────┼─────┼────────────┼───────│  │
│  │ anna@acme  (вы)     │ ⬡ admin ★super │ все      │ ●on │ сейчас     │ [⋯]   │  │  ◀ ★super = is_superadmin
│  │ ops@acme            │ ⬡ operator     │ 3        │ ●on │ 5м назад   │ [⋯]   │  │
│  │ bot@acme            │ ⬡ operator     │ 2        │ ○off│ 12:01      │ [⋯]   │  │
│  │ viewer@acme         │ ⬡ viewer       │ все      │ ○off│ вчера      │ [⋯]   │  │
│  │ left@acme           │ ⊘ deactivated  │ —        │ —   │ 14 дн назад│ [⋯]   │  │  ◀ приглушён
│  └──────────────────────────────────────────────────────────────────────────┘  │
│  Роли: ⬡ admin (управление) · ⬡ operator (запуск/CRUD) · ⬡ viewer (только чтение)│
└────────────────────────────────────────────────────────────────────────────────┘
  строка кликабельна → карточка пользователя; роль-чип цветной (admin=violet, operator=accent, viewer=muted)
```

#### 5.2 Project Members — default (`/p/:pid/settings → Участники`)

```
┌─ Payments · Настройки ▸ Участники ─────────────────────────[ + Добавить ]───────┐
│  Кто имеет доступ к проекту Payments                                            │  ◀ имя проекта (§2.4)
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ Пользователь     │ Роль в проекте │ Источник доступа        │            │  │
│  │──────────────────┼────────────────┼─────────────────────────┼────────────│  │
│  │ anna@acme  (вы)  │ ⬡ admin        │ account-wide            │ [⋯]        │  │  ◀ унаследовано
│  │ ops@acme         │ ⬡ operator     │ project-level           │ [⋯]        │  │  ◀ точечно выдан
│  │ bot@acme         │ ⬡ viewer       │ project-level           │ [⋯]        │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│  ⓘ account-wide участников нельзя убрать здесь — только в Аккаунт ▸ Пользователи │  ◀ изоляция уровней
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.3 Приглашение / добавление (Modal §3.6)

Account-инвайт (по email) vs project-добавление (выбор существующего пользователя аккаунта).

```
┌─ Пригласить в аккаунт ───────────────────────────────────┐     ┌─ Добавить в проект Payments ──────────────┐
│  Email*    [ new@acme.com           ]                    │     │  Пользователь* [ выбрать… ▾ ]             │
│  Роль*     ◉ viewer  ○ operator  ○ admin                 │     │     ops@acme · bot@acme · viewer@acme     │
│            ⓘ admin может управлять людьми и секретами     │     │  Роль*  ◉ viewer ○ operator ○ admin       │
│  ▸ Advanced: account-wide admin · срок инвайта 7 дн      │     │  ⓘ доступ только к этому проекту           │
│                          [ Отмена ]  [ Отправить инвайт ]│     │              [ Отмена ]  [ Добавить ]     │
└──────────────────────────────────────────────────────────┘     └────────────────────────────────────────────┘
```

#### 5.4 Изменение роли (`⋯ → Изменить роль`) — inline-поповер

```
│ ops@acme  │ ⬡ operator ▾│ …  →  ┌─────────────────────────────┐
                                  │ ○ viewer    только чтение    │
                                  │ ◉ operator  запуск/CRUD      │
                                  │ ○ admin     +люди/секреты    │  ◀ при выборе admin → ConfirmDialog
                                  └─────────────────────────────┘    («дать доступ к секретам?»)
   успех → Toast «✔ Роль обновлена: operator → admin» + audit role.change (research §6.7)
```

#### 5.5 Удаление участника (ConfirmDialog §3.18, лёгкое — обратимо)

```
┌─────────────────────────────────────────────┐
│  ⚠ Убрать ops@acme из проекта Payments?      │  ◀ имя проекта
│─────────────────────────────────────────────│
│  Потеряет доступ к 42 сценариям и прогонам   │  ◀ масштаб
│  проекта. Историю прогонов это не удаляет.   │
│              [ Отмена ]  [ Убрать ]          │  ◀ без ввода имени (обратимо)
└─────────────────────────────────────────────┘
  Защита: нельзя убрать последнего admin аккаунта → кнопка disabled + Tooltip «нужен ≥1 admin».
```

#### 5.6 Матрица прав (визуально) — раздел в `/account/users` и подсказка по ролям

Прямая визуализация research §6.3. Колонки — роли, строки — действия; ✓/— из `hasPermission(role, permission)`.

```
┌─ Что может каждая роль ─────────────────────────────────────────────────────────┐
│  Действие                                            viewer  operator  admin     │
│  ──────────────────────────────────────────────────────────────────────────────│
│  👁 Смотреть проекты/прогоны/логи/артефакты            ✓        ✓        ✓       │
│  ▶ Запуск / folder-run / retry                        —        ✓        ✓       │
│  ⤓ Upload / move / delete сценариев и папок            —        ✓        ✓       │
│  ▦ CRUD пулов, import-run-outputs                      —        ✓        ✓       │
│  ⬡ Выбрать Credential/Merchant (по имени, без значений)—        ✓        ✓       │
│  🔑 CRUD StandCredential (СЕКРЕТЫ)                      —        —        ✓       │
│  🔐 Получить TOTP-код /credentials/:id/code            —        —        ✓       │
│  ⚙ CRUD пользователей/ролей, ротация ключа, экспорт    —        —        ✓ super │
│  ──────────────────────────────────────────────────────────────────────────────│
│  Глифы §4.1 · ✓=--status-passed · —=--text-faint · «super» = is_superadmin       │
└────────────────────────────────────────────────────────────────────────────────┘
  Эта же матрица — в Tooltip §3.17 при выборе роли (§5.3/5.4): «admin → +строки секретов».
```

#### 5.7 Состояния списка участников

```
LOADING (skeleton строк таблицы §3.4/§3.12):
│ ▦▦▦▦▦▦▦▦▦  ▦▦▦▦▦▦  ▦▦▦  ▦▦  ▦▦▦▦▦▦   │
│ ▦▦▦▦▦▦     ▦▦▦▦▦▦  ▦▦   ▦▦  ▦▦▦▦     │

EMPTY (проект без участников кроме владельца):
│        👥 Пока только вы                 │
│  Добавьте операторов и наблюдателей      │
│        [ + Добавить участника ]          │

ERROR:
│  ⚠ Не удалось загрузить участников        │
│  error.server_unreachable    [ Повторить ]│

NO-PERMISSION (operator/viewer открыл /account/users напрямую):
│  🔒 Управление пользователями — только для admin                                  │
│  Ваша роль: operator. Обратитесь к администратору аккаунта.                       │  ◀ не 404 (раздел существует), а 403-экран по роли
```

---

### 6. Настройки аккаунта и аудит-лог (`/account/audit`)

**Назначение:** просмотр append-only журнала действий с фильтрами и экспортом — прозрачность «кто/что/когда/в каком проекте» (research §6.7, spec §3.1 admin-only). Настройки аккаунта (`/account/profile`, `/account/system`) — соседние табы; здесь фокус на аудите по заданию.

- **Primary-CTA:** `[ ⤓ Экспорт ]` (CSV/JSON) — только super (research §6.7).
- **Overflow строки `⋯`:** Открыть связанный объект · Копировать `trace_id` · Показать metadata.
- **Advanced:** фильтр по `trace_id`/`session`/IP; hash-chain проверка целостности (research §6.7 tamper-evidence).
- **Данные/откуда:** `GET /api/audit?project_id=&user_id=&action=&from=&to=` (research §6.7, фильтры по проекту/пользователю/действию); строки append-only `audit_log` (`account_id`+`project_id`, spec таблица §2.2 строка 60); экспорт — super-only. **Никаких секретов** в metadata (research §6.7). Чтение — admin/super.
- **Переходы:** клик по строке/объекту → соответствующий экран (run → `/p/:pid/runs/:rid`; credential → `/p/:pid/credentials/:cid`); фильтр «по проекту» → подмешивает `project_id`.

#### 6.1 Audit — default (Table §3.4 с фильтр-чипами)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright   Аккаунт ▸ Аудит               [▶4][🔔2][🌐RU▾][anna▾]        │
├────────────────────────────────────────────────────────────────────────────────┤
│  Мои проекты  Пользователи  Система  [ Аудит ]  Профиль                          │
├────────────────────────────────────────────────────────────────────────────────┤
│  Аудит-журнал                                                       [ ⤓ Экспорт ]│  ◀ primary, super-only
│  Проект:[ все ▾] Пользователь:[ все ▾] Действие:[ все ▾]  📅[ 28.06 — 28.06 ] 🔍[…]│  ◀ фильтры (research §6.7)
│  [run.start][run.delete][credential.update][role.change][login.failure]  ←чипы   │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ Время        │ Пользователь│ Действие              │ Проект     │ Объект    │  │
│  │──────────────┼─────────────┼───────────────────────┼────────────┼───────────│  │
│  │ 12:04:23 ▸   │ anna@acme   │ ▶ run.start           │ ●Payments  │ withdraw… │  │  ◀ строка → объект
│  │ 12:03:51     │ anna@acme   │ 🔐 credential.totp_code_issued │ ●Payments │ stand-adm │  │
│  │ 12:01:09     │ ops@acme    │ ✖ run.delete          │ ●Payments  │ deposit·2 │  │
│  │ 11:58:30     │ anna@acme   │ ⬡ role.change op→adm  │ —account   │ bot@acme  │  │  ◀ account-уровень
│  │ 11:50:12     │ —           │ 🔒 login.failure      │ —          │ ip 10.0.. │  │
│  │ 11:48:02     │ bot@acme    │ ⚠ pool.delete         │ ●Withdraw  │ eth-addr  │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│  append-only · никаких секретов в metadata (research §6.7)        стр. 1 из 38 ▸ │
└────────────────────────────────────────────────────────────────────────────────┘
  колонка «Проект» несёт цв.точку ● --project-accent (§2.8) — изоляция видна построчно;
  «—account»/«—» = событие вне проекта (account-уровень / анонимный login).
```

#### 6.2 Audit — раскрытая строка (детали, `trace_id`, metadata mono)

```
│ 12:04:23 ▾   │ anna@acme   │ ▶ run.start           │ ●Payments  │ withdraw… │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ trace_id    01J8F3K9ZQ…           ◀ mono §2.4   [⧉ copy]              │    │
│  │ session     sess_3f… · IP 10.0.4.12 · agent Electron/1.2              │    │
│  │ metadata    { scenario_ulid: "01J…", env: "stg", workers: 4 }         │    │  ◀ НЕТ секретов
│  │ → Открыть прогон  /p/Payments/runs/r_8f3                              │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
```

#### 6.3 Audit — фильтр применён (по проекту + действию)

```
│  Проект:[ ●Payments ▾] Пользователь:[ все ▾] Действие:[ credential.* ✕]  📅[7 дн]│
│  [credential.create][credential.update][credential.delete][totp_code_issued]    │  ◀ активные чипы --accent-subtle
│  ────────────────────────────────────────────────────────────────────────────  │
│  12:03:51  anna@acme  🔐 credential.totp_code_issued  ●Payments  stand-admin     │
│  09:12:40  anna@acme  🔑 credential.update            ●Payments  stand-ops       │
│  Найдено 2 события · фильтр активен            [ сбросить фильтры ]               │
```

#### 6.4 Audit — loading (skeleton таблицы)

```
│  Проект:[ … ▾]  Пользователь:[ … ▾]  Действие:[ … ▾]   📅[ … ]                    │
│  ▦▦▦▦▦▦▦▦  ▦▦▦▦▦▦▦  ▦▦▦▦▦▦▦▦▦▦▦  ▦▦▦▦▦▦  ▦▦▦▦▦▦                                  │
│  ▦▦▦▦▦▦▦▦  ▦▦▦▦▦▦▦  ▦▦▦▦▦▦▦▦      ▦▦▦▦▦▦  ▦▦▦▦▦▦      ◀ shimmer §6                 │
│  ▦▦▦▦▦▦▦▦  ▦▦▦▦      ▦▦▦▦▦▦▦▦▦▦    ▦▦▦▦▦▦  ▦▦▦▦▦▦                                  │
```

#### 6.5 Audit — empty (фильтр без результата)

```
│                              ⊙ Событий не найдено                                │
│                  Под выбранные фильтры ничего не подходит.                       │
│                          [ сбросить фильтры ]                                    │
```

#### 6.6 Audit — error

```
│                          ⚠ Не удалось загрузить аудит                            │
│                          error.server_unreachable                               │
│                          [ Повторить ]   [ подробнее ]                           │
```

#### 6.7 Audit — экспорт (диалог, super-only)

```
┌─ Экспорт аудита ─────────────────────────────────────────┐
│  Формат   ◉ CSV   ○ JSON                                  │
│  Объём    ◉ текущий фильтр (2 154 строки)  ○ весь журнал  │
│  Период   28.06.2026 — 28.06.2026                         │
│  ⓘ Экспорт доступен только суперадмину · действие audit'ится (audit.export)│
│                          [ Отмена ]  [ ⤓ Скачать CSV ]    │
└──────────────────────────────────────────────────────────┘
  не-super → кнопка [⤓ Экспорт] скрыта; при прямом вызове API → 403.
```

#### 6.8 Настройки аккаунта (`/account/profile`) — контекст соседних табов (кратко)

```
┌─ Аккаунт ▸ Профиль ────────────────────────────────────────────────────────────┐
│  Имя [ anna ]  Email [ ai@morphosisblocks.com ]            [ Сохранить ]         │
│  Безопасность:  Сменить пароль…   2FA входа: ●on [ Перенастроить ]               │  ◀ secret write-only §4.6
│  Интерфейс:     Тема ◉light ○dark · Плотность ◉compact ○comfortable · 🌐RU/EN     │
└────────────────────────────────────────────────────────────────────────────────┘
  (Система /account/system — Docker/NTP/disk/image-cache, HealthIndicator §3.11 — отдельный раздел спеца.)
```

---

#### Сквозные гарантии раздела (изоляция и «в каком я проекте»)

- **Уровень всегда читается мгновенно:** project-уровень = есть рельс + switcher-чип + цв.полоса `--project-accent` + имя проекта в крошке (spec §2.4 мех.1,2); account-уровень = рельса нет, нейтральный кант (spec §3.1, §4.1).
- **Переключение проекта сохраняет подраздел** и не теряет контекст (spec §2.3); cross-project переход по ссылке всегда даёт баннер (spec §2.4 мех.5, §1.5 выше).
- **Гард 404 (не 403)** на чужой проект — не раскрываем существование (spec §3.2, §1.4 выше); admin-разделы по роли дают role-экран (§5.7), т.к. сам раздел существует.
- **Секреты никогда не в UI/DOM/clipboard/audit** (§4.6, research §6.7) — участники видят роли и факт `●set`, не значения.
- **Real-time везде, где есть активность:** живые бейджи проектов/switcher патчатся по SSE `/api/stream/execution` без reload (§4.2), глиф `⟳` пульсирует (§6).

**Эталонные источники:** `e:\rabota\playwright project\tests_projec\docs\ui-redesign-spec.md` (§2.3-2.6 switcher/изоляция, §3.1-3.2 навигация/sitemap, §4.1-4.3 рельс/плотность, §7.1 Мои проекты, §10 роадмап ролей), `docs\ui-deploy-research.md` (§6.3 матрица ролей, §6.7 аудит), DDL аккаунтов/проектов/memberships — spec §9.1 (таблицы A/B/C/D). Привязки к коду: `apps\server\src\html.ts:4182` (`page()` без рельса), `:459-460` (секрет в DOM), `:4197` (`renderFolderBreadcrumbs`); `packages\shared\src\schemas.ts:63` (`ProjectSchema`), `:77-91` (`AccountSchema`/`MerchantSchema` — нет `project_id`, мигрируют). Дизайн-система: токены §2, компоненты §3, конвенции §4, движение §5 — применены единообразно во всех моках.

---

## 5. Рабочее пространство проекта: дашборд, дерево сценариев, список прогонов

I now have a thorough grounding in the spec, the design system, and the real code. I have everything needed to write the detailed design specification for the project workspace screens. Let me produce the final document section.


---

### 1. Дашборд проекта `/p/:pid` (real-time)

**Назначение:** живой пульс одного проекта — кто исполняется прямо сейчас и на какой фазе, здоров ли раннер-хост, что недавно упало; единственная точка, где видны очередь и concurrency проекта без перехода в Runs.

**Primary-CTA:** `[ ▶ Run · Payments ]` в шапке (открывает `<RunConfig>`-wizard, §3.7 ДС, scope = весь проект). **Overflow `⋯`** карточки проекта в крошке: Переименовать · Дублировать настройки (без секретов) · Архивировать · Участники · Настройки. **Advanced** на дашборде нет — это монитор, не форма; «тяжёлое» (полная health-панель, история drift) раскрывается из виджета Health по `▸ Подробнее`.

**Данные / источники:**
- Виджет **Execution** — SSE `GET /api/stream/execution?pid=:pid` (события `worker.update`, `queue.update`, `run.status`); наполняется из таблиц `run_queue` / `workers` (spec §5.8). Поля `Workers busy/idle/total`, `Concurrency running/max`, список RUNNING NOW c `phase` (spec §5.7). Сегодня источника нет (`queueMicrotask` без реестра, `app.ts:1640-1664`) — до §5.8 виджет показывает деградированный вид.
- Список **RUNNING NOW** — `run.phase` каждого активного run (новый типизированный эмит `on_phase`, spec §5.1), живой таймер от `phase_timings[phase].started_at` (клиентский `requestAnimationFrame`, §4.2 ДС).
- Виджет **Health** — SSE `GET /api/stream/health` (`execution.health`, `clock.sync`): Docker `docker version` (`execute.ts:446`), image cache `docker image inspect` (`:463`), диск `/data`, NTP-offset. HealthIndicator §3.11 ДС.
- **STANDS** (доступность) — last-known `stand.availability` по окружениям проекта (`POST /api/environments/:id/reachability`, spec §5.9), reach-токены §2.3 ДС.
- **RECENT FAILURES** — `runs WHERE project_id=:pid AND status IN(failed,error) ORDER BY finished_at DESC LIMIT 5`.

**Переходы:** карточка/строка RUNNING NOW → `/p/:pid/runs/:rid` (Прогон LIVE, spec §7.4); RECENT FAILURE `[Trace]`→tab Artifacts прогона, `[Retry]`→POST retry + toast; `[Проверить]` у стенда → панель §7.8; пустой проект → онбординг-чеклист.

#### Состояние 1 — default / всё спокойно (idle)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright  ● Payments ▸ Дашборд            [▶0 running][🔔0][🌐RU][anna ▾]      │
├───────────────┬────────────────────────────────────────────────────────────────────────┤
│ ┌───────────┐ │  ● Payments · Дашборд                              [ ▶ Run · Payments ] │
│ │▸Payments ▾│ │                                                                          │
│ └───────────┘ │  ┌─ EXECUTION (этот проект) ───────┐  ┌─ HEALTH (раннер-хост) ────────┐ │
│ ПРОЕКТ         │  │ Workers 4 · busy 0 · idle 4      │  │ Docker      ● ready v27       │ │
│ ▸ Обзор   ◀    │  │ Concurrency ░░░░ 0/4             │  │ Image cache ● present 1.52    │ │
│   Сценарии     │  │ Running 0 · Queued 0             │  │ Disk /data  ▓▓▓░ 61%          │ │
│   Прогоны      │  │ ⊙ очередь пуста — всё свободно   │  │ Clock(NTP)  ● in sync · 12ms  │ │
│ ДАННЫЕ СТЕНДА  │  └──────────────────────────────────┘  └────────────────[▸ Подробнее]─┘ │
│   Credentials  │  ┌─ STANDS этого проекта ──────────┐                                     │
│   Merchants    │  │ stg  ● 200 · 84ms   [Проверить]  │  ┌─ RUNNING NOW ────────────────┐ │
│   Pools        │  │ prod ● 200 · 120ms  [Проверить]  │  │                              │ │
│   Окружения •  │  └──────────────────────────────────┘  │   ⊙ сейчас ничего не бежит    │ │
│   Переменные   │  ┌─ RECENT FAILURES ───────────────────────────────────────────────┐  │ │
│ ────────────   │  │ ✔ за последние 24 ч падений нет                                   │  │ │
│   Настройки    │  └──────────────────────────────────────────────────────────────────┘  │ │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
  глобальный индикатор [▶0] серый · полоса слева у switcher = --project-accent (§2.8)
```

#### Состояние 2 — loading / skeleton (первый коннект SSE, до снапшота)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright  ● Payments ▸ Дашборд            [▶· running][🔔·][🌐RU][anna ▾]      │
├───────────────┬────────────────────────────────────────────────────────────────────────┤
│ │▸Payments ▾│ │  ● Payments · Дашборд                              [ ▶ Run · Payments ] │
│               │  ┌─ EXECUTION ─────────────────────┐  ┌─ HEALTH ──────────────────────┐ │
│  Обзор   ◀    │  │ Workers ▦▦▦▦  ·  ▦▦▦▦▦▦          │  │ Docker      ▦▦▦▦▦▦▦▦           │ │
│               │  │ Concurrency ▦▦▦▦▦▦▦▦▦▦           │  │ Image cache ▦▦▦▦▦▦             │ │
│               │  │ ▦▦▦▦▦▦▦▦▦▦  ·  ▦▦▦▦▦             │  │ Disk /data  ▦▦▦▦▦▦▦▦           │ │
│               │  └──────────────────────────────────┘  │ Clock(NTP)  ▦▦▦▦▦▦▦▦           │ │
│               │  ┌─ RUNNING NOW ────────────────────────└───────────────────────────────┘ │
│               │  │ ▦▦▦▦▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦   ▦▦▦   ▦▦▦▦▦▦▦▦▦▦                              │ │
│               │  │ ▦▦▦▦▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦   ▦▦▦   ▦▦▦▦▦▦▦▦▦▦                              │ │
│               │  └────────────────────────────────────────────────────────────────────┘ │
│               │   подключение к потоку…  (Skeleton §3.12 ДС · shimmer §5.4, не спиннер)   │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
   глобальные индикаторы показывают «·» пока нет снапшота · TanStack Query isPending
```

#### Состояние 3 — empty / новый проект (онбординг-чеклист, spec §7.2)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright  ● NewProj ▸ Дашборд             [▶0][🔔0][🌐RU][anna ▾]              │
├───────────────┬────────────────────────────────────────────────────────────────────────┤
│ │▸NewProj  ▾│ │  ● NewProj · Дашборд                                                    │
│  Обзор   ◀    │  ┌──────────────────────────────────────────────────────────────────┐  │
│  Сценарии     │  │                          ⊙                                        │  │
│  …            │  │            Проект пуст — сделаем его рабочим за 3 шага             │  │
│               │  │                                                                    │  │
│               │  │   ☐ 1. Добавить учётку стенда (Credential)        [ + Credential ] │  │
│               │  │   ☐ 2. Создать окружение с base_url               [ + Окружение ]  │  │
│               │  │   ☐ 3. Загрузить первый сценарий (из агента)      [ Как записать? ]│  │
│               │  │                                                                    │  │
│               │  │   После шага 3 здесь появятся Execution / Health / Running now.    │  │
│               │  └──────────────────────────────────────────────────────────────────┘  │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
   EmptyState §3.12 ДС: иконка + следующий шаг (CTA, не тупик) · галочки проставляются по факту
```

#### Состояние 4 — активное исполнение (несколько running на разных фазах + очередь)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright  ● Payments ▸ Дашборд            [▶3 running][🔔0][🌐RU][anna ▾]      │
├───────────────┬────────────────────────────────────────────────────────────────────────┤
│ │▸Payments ▾│ │  ● Payments · Дашборд                              [ ▶ Run · Payments ] │
│  Обзор ⟳ ◀    │  ┌─ EXECUTION (этот проект) ───────┐  ┌─ HEALTH (раннер-хост) ────────┐ │
│               │  │ Workers 4 · busy 3 · idle 1      │  │ Docker      ● ready v27       │ │
│               │  │ Concurrency ▓▓▓░ 3/4             │  │ Image cache ● present 1.52    │ │
│               │  │ Running 3 · Queued 12            │  │ Disk /data  ▓▓▓▓ 78%  ⚠ rising│ │
│               │  └──────────────────────────────────┘  │ Clock(NTP)  ● in sync · 12ms  │ │
│               │  ┌─ RUNNING NOW ───────────────────────└───────────────────────────────┘ │
│               │  │ ⟳ withdraw-flow  ⟳execute   0:42  ▓▓▓▓▓▓░░  anna  payouts   [open]→ │ │
│               │  │ ⟳ deposit-card   ⟳pull 1.5GB 0:50  ▓▓▓░░░░░  anna  deposits  [open]→ │ │
│               │  │ ⟳ kyc-verify     ⟳collect   0:08            bot   kyc       [open]→ │ │
│               │  │ ⋯ kyc·3          queued · поз.4 · ETA ~4м    bot   kyc       [open]→ │ │
│               │  └────────────────────────────────────────────────────────────────────┘ │
│               │  ┌─ RECENT FAILURES ───────────────────────────────────────────────┐    │
│               │  │ ✖ deposit·2  failed (assertion)   12:01  [Trace][Retry][open]→   │    │
│               │  └──────────────────────────────────────────────────────────────────┘    │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
  ⟳ = пульс (§5.2 ДС) · таймеры тикают клиентом · pull показывает live-хвост 1.5GB · бар concurrency
  ⟳execute синий · ⟳pull синий+прогресс · строки патчатся через setQueryData по SSE, БЕЗ reload
```

**Real-time переход строки (без reload, spec §5.4):** `deposit-card` фаза `pull → create_container → execute` — глиф и подпись кросс-фейдят `--motion-base`, таймер фазы сбрасывается на новый `started_at`; при `done` строка уезжает из RUNNING NOW, в EXECUTION `busy 3→2`, бар `3/4→2/4`; если `failed/error` — параллельно появляется строка в RECENT FAILURES, `[🔔]` инкрементится.

#### Состояние 5 — деградация (Docker недоступен, дрейф NTP, очередь in-memory, диск)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright  ● Payments ▸ Дашборд            [▶0][🔔2][🌐RU][anna ▾]              │
├───────────────┬────────────────────────────────────────────────────────────────────────┤
│ │▸Payments ▾│ │  ● Payments · Дашборд                              [ ▶ Run · Payments ] │
│  Обзор   ◀    │  ┌─ EXECUTION (этот проект) ───────┐  ┌─ HEALTH (раннер-хост) ────────┐ │
│               │  │ Workers — · busy — · idle —      │  │ Docker      ✖ unavailable     │ │
│               │  │ Concurrency ▒▒▒▒ n/a             │  │  └ Runner host Docker daemon  │ │
│               │  │ ⚠ очередь: in-memory, без позиций│  │     unavailable               │ │
│               │  │   (run_queue не активна, §5.8)   │  │ Image cache ⓘ неизвестно      │ │
│               │  └──────────────────────────────────┘  │ Disk /data  ▓▓▓▓▓ 92%  ✖ alert│ │
│               │  ┌─ STANDS этого проекта ──────────┐   │ Clock(NTP)  ⚠ drift 1.4s      │ │
│               │  │ stg  ⓘ Docker недоступен —      │   │  └ ломает 2FA стендов МОЛЧА   │ │
│               │  │      проверка из контейнера ✕    │   └────────────────[▸ Подробнее]─┘ │
│               │  │      хост: ● 200 · 84ms          │                                     │
│               │  └──────────────────────────────────┘                                     │
│               │  ┌─ RECENT FAILURES ───────────────────────────────────────────────┐    │
│               │  │ ⚠ kyc-flow   error (docker pull)  11:48  [Logs ][Retry][open]→   │    │
│               │  │ ⚠ batch b_8f  error (interrupted) 11:30  [Logs ][Retry][open]→   │    │
│               │  └──────────────────────────────────────────────────────────────────┘    │
│               │  ┌─ ⚠ Деградация хоста ────────────────────────────────────────────┐    │
│               │  │ Docker недоступен → новые прогоны упадут error, не failed.        │    │
│               │  │ NTP-дрейф 1.4s → 2FA-коды стендов могут отклоняться. [Что делать?]│    │
│               │  └──────────────────────────────────────────────────────────────────┘    │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
  Docker ✖ красный (spec §5.7) · drift ⚠ янтарный · диск 92% ✖ красный кант · stand ⓘ Docker↓
  (НЕ ложный ✖ unreachable, §5.9) · виджеты деградируют поштучно, экран не падает (§4.5 ДС)
```

#### Состояние 6 — error (загрузка дашборда не удалась, сервер недостижим)

```
┌───────────────┬────────────────────────────────────────────────────────────────────────┐
│ │▸Payments ▾│ │  ● Payments · Дашборд                                                    │
│  Обзор   ◀    │  ┌──────────────────────────────────────────────────────────────────┐  │
│               │  │                          ⚠                                        │  │
│               │  │            Не удалось загрузить дашборд проекта                    │  │
│               │  │            server_unreachable                                     │  │
│               │  │            (поток событий закрыт · переподключение через 3с…)      │  │
│               │  │                  [ Повторить ]   [ подробнее ]                     │  │
│               │  └──────────────────────────────────────────────────────────────────┘  │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
   ErrorState §3.12 ДС · code→t() (spec §3.3) · EventSource авто-reconnect с Last-Event-ID (§5.4)
```

---

### 2. Дерево сценариев/папок `/p/:pid/scenarios`

**Назначение:** навигация по папкам/сценариям проекта с минимумом кнопок — выбрать scope (путь или чекбоксы) и запустить; всё редкое — в overflow.

**Primary-CTA:** `[ ▶ Run ]` в шапке (схлопывает три старых Run-кнопки `Run current folder`/`Run project root`/`Run selected`, `html.ts:760-790`; scope = текущая папка из крошек ИЛИ отмеченные чекбоксы). **`+ New ▾`** = Folder / Upload (инлайн-ввод, без двухшагового `New folder`+`Create folder`, `html.ts:712/730`). **Overflow `⋯` строки:** Открыть · История · Код · Переместить · Переименовать · Скачать zip · Удалить. **Advanced:** в дереве нет — параметры запуска уезжают в wizard.

**Данные / источники:** дерево — `scenarios.folder_path` + `slug` (spec §9.1 I; модель `discoverScenariosFromStorage`/`buildStableScenarioId`, `store.ts:511,528`); статус-чип строки = последний run сценария (`runs WHERE scenario_id=… ORDER BY finished_at DESC LIMIT 1`), StatusBadge §3.1 ДС. Контекст «Run scope = путь» берётся из `renderFolderBreadcrumbs` (`html.ts:4197`), расширенного project-сегментом (Breadcrumbs §3.15 ДС). Перемещение учитывает инвариант `runs.project_id == scenario.project_id` (spec §2.6): Move заблокирован при незавершённых runs.

**Переходы:** строка/`Открыть` → `/p/:pid/scenarios/:sid` (просмотр сценария, раздел 3); `[▶]` строки → wizard с одним сценарием; `Код` → `/p/:pid/scenarios/:sid/code`; bulk `Move` → ConfirmDialog с предупреждением об исторических runs.

#### Состояние 1 — default (папка с сценариями)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright  ● Payments ▸ Сценарии ▸ payments ▸ payouts   [▶3][🔔0][🌐RU][anna ▾]│
├───────────────┬────────────────────────────────────────────────────────────────────────┤
│ │▸Payments ▾│ │ ● Payments ▸ payments ▸ payouts        [ + New ▾ ]          [ ▶ Run ]   │
│ ПРОЕКТ         ├──────────────────────────────┬────────────────────────────────────────┤
│  Обзор         │ ДЕРЕВО                        │ payouts/  · 3 сценария · env: stg,prod │
│  Сценарии ◀    │ ▾ 📁 payments                 │ ☐ выбрать всё                          │
│  Прогоны       │   ▾ 📁 payouts        ◀здесь  │ ┌────────────────────────────────────┐ │
│ ДАННЫЕ СТЕНДА  │       📄 withdraw-flow ✔pass  │ │☐ 📄 withdraw-flow stg ✔passed 12:01 │ │
│  Credentials   │       📄 payout-batch  ✖fail  │ │                          [▶] [⋯]    │ │
│  Merchants     │       📄 refund-flow   ⋯never │ │☐ 📄 payout-batch  prod ✖failed 09:12│ │
│  Pools         │     ▸ 📁 deposits             │ │                          [▶] [⋯]    │ │
│  Окружения •   │   ▸ 📁 kyc                    │ │☐ 📄 refund-flow   stg  — never      │ │
│  Переменные    │                               │ │                          [▶] [⋯]    │ │
│ ────────────   │                               │ └────────────────────────────────────┘ │
│  Настройки     │  (sticky · раскрытие сохр.)   │  строка кликабельна → сценарий (§4.4 ДС)│
└───────────────┴──────────────────────────────┴────────────────────────────────────────┘
  Run scope = крошки (payouts/) пока чекбоксы пусты · ✔passed зелёный/✖failed красный/⋯never серый
  ⋯ строки: Открыть·История·Код·Переместить·Переименовать·Скачать zip·Удалить (§3.13 ДС)
```

#### Состояние 2 — loading / skeleton

```
┌───────────────┬──────────────────────────────┬────────────────────────────────────────┐
│ │▸Payments ▾│ │ ● Payments ▸ Сценарии         [ + New ▾ ]          [ ▶ Run ]            │
│  Сценарии ◀    ├──────────────────────────────┬────────────────────────────────────────┤
│               │ ДЕРЕВО                        │ ▦▦▦▦▦▦▦  · ▦▦ сценария · ▦▦▦▦           │
│               │ ▾ ▦▦▦▦▦▦▦▦                     │ ┌────────────────────────────────────┐ │
│               │   ▾ ▦▦▦▦▦▦▦                    │ │▦ ▦▦ ▦▦▦▦▦▦▦▦▦▦  ▦▦▦  ▦▦▦▦▦  ▦▦▦▦▦   │ │
│               │       ▦▦▦▦▦▦▦▦▦▦               │ │▦ ▦▦ ▦▦▦▦▦▦▦▦▦▦  ▦▦▦  ▦▦▦▦▦  ▦▦▦▦▦   │ │
│               │       ▦▦▦▦▦▦▦▦▦▦               │ │▦ ▦▦ ▦▦▦▦▦▦▦▦▦▦  ▦▦▦  ▦▦▦▦▦  ▦▦▦▦▦   │ │
│               │     ▸ ▦▦▦▦▦▦▦▦                 │ └────────────────────────────────────┘ │
│               │  загрузка дерева…              │  Skeleton §3.12 (форма будущих строк)   │
└───────────────┴──────────────────────────────┴────────────────────────────────────────┘
```

#### Состояние 3 — empty (в папке/проекте нет сценариев)

```
┌───────────────┬──────────────────────────────┬────────────────────────────────────────┐
│ │▸Payments ▾│ │ ● Payments ▸ Сценарии         [ + New ▾ ]          [ ▶ Run ]  (disabled)│
│  Сценарии ◀    ├──────────────────────────────┬────────────────────────────────────────┤
│               │ ДЕРЕВО                        │ payments/  · 0 сценариев               │
│               │ ▾ 📁 payments        ◀здесь   │ ┌──────────────────────────────────┐   │
│               │   (пусто)                     │ │              ⊙                    │   │
│               │                               │ │   В этой папке пока нет сценариев  │   │
│               │                               │ │   Запишите сценарий в агенте и     │   │
│               │                               │ │   загрузите его сюда.              │   │
│               │                               │ │   [ + Папку ]   [ Как записать? ] │   │
│               │                               │ └──────────────────────────────────┘   │
└───────────────┴──────────────────────────────┴────────────────────────────────────────┘
  EmptyState §3.12 ДС · ▶ Run disabled (нечего запускать, scope пуст) · CTA ведут к действию
```

#### Состояние 4 — выбор нескольких (чекбоксы + bulk-bar, scope = выбор)

```
┌───────────────┬──────────────────────────────┬────────────────────────────────────────┐
│ │▸Payments ▾│ │ ● Payments ▸ payments ▸ payouts   [ + New ▾ ]      [ ▶ Run · 2 ]        │
│  Сценарии ◀    ├──────────────────────────────┬────────────────────────────────────────┤
│               │ ДЕРЕВО                        │ ┌──────────────────────────────────────┐│
│               │ ▾ 📁 payments                 │ │ ☑ выбрано 2  [▶Run][Move][🗑Delete]   ││ ← bulk-bar
│               │   ▾ 📁 payouts        ◀здесь  │ │                        [снять выбор]  ││   sticky,
│               │       📄 withdraw-flow ✔pass  │ ├──────────────────────────────────────┤│   §3.4 ДС
│               │       📄 payout-batch  ✖fail  │ │☑ 📄 withdraw-flow stg ✔passed 12:01   ││ ← --accent-
│               │       📄 refund-flow   ⋯never │ │                          [▶] [⋯]      ││   subtle
│               │                               │ │☑ 📄 payout-batch  prod ✖failed 09:12  ││
│               │                               │ │                          [▶] [⋯]      ││
│               │                               │ │☐ 📄 refund-flow   stg  — never        ││
│               │                               │ └──────────────────────────────────────┘│
└───────────────┴──────────────────────────────┴────────────────────────────────────────┘
  scope переключился крошки→чекбоксы: CTA стал [▶ Run · 2] · bulk Run = ОДИН запрос, не цикл POST
  (заменяет цикл POST «Run selected folders», §4.4 ДС) · bulk Delete → ConfirmDialog с масштабом
```

#### Состояние 5 — Move через overflow / drag-move (перемещение со связью к инварианту §2.6)

```
Вариант A — Move-диалог (из ⋯ строки или bulk Move):
┌─────────────────────────────────────────────────────────────┐
│  Переместить «payout-batch» в проекте Payments        [ ✕ ] │ ← имя проекта (§2.4)
│─────────────────────────────────────────────────────────────│
│  Куда:  [ payments / deposits           ▾ ]   (дерево папок) │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ⚠ У сценария 1 незавершённый прогон (running).           │ │ ← инвариант §2.6:
│  │   Перемещение между папками — ок; смена ПРОЕКТА           │ │   Move между
│  │   заблокирована, пока есть queued/running.               │ │   проектами блок
│  │   Исторические прогоны (12) останутся в проекте Payments. │ │
│  └─────────────────────────────────────────────────────────┘ │
│                              [ Отмена ]  [ Переместить ]      │ ← disabled пока блок активен
└─────────────────────────────────────────────────────────────┘

Вариант B — drag-move внутри дерева (живой drop-target):
│ ▾ 📁 payments                 │   тащим 📄 payout-batch …
│   ▾ 📁 payouts        ◀здесь  │   ┌╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴┐
│       📄 withdraw-flow ✔pass  │   ┊ 📄 payout-batch ✖fail ┊ ← «призрак» под курсором
│     ▾ 📁 deposits  ▓▓▓▓◀ drop │   └╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴┘
│       (отпустить сюда)        │   подсветка цели --accent-subtle, рамка --focus-ring
│   ▸ 📁 kyc  ⊘ нельзя (другой  │   ⊘ запрещённые цели затемнены + tooltip причины
│            проект, §2.6)      │
```

---

### 3. Просмотр сценария `/p/:pid/scenarios/:sid` (+ `/code`)

**Назначение:** карточка одного сценария — что это, его inputs/outputs, read-only код `.spec.ts`, история его прогонов; точка запуска именно этого сценария.

**Primary-CTA:** `[ ▶ Run ]` (wizard с предзаполненным single-scope, Scope-шаг свёрнут, spec §7.6). **Overflow `⋯`:** Переместить · Переименовать · Скачать zip · Архивировать · Удалить · Copy id. **Вкладки (виды, не кнопки, §3.9 ДС):** Overview · Code · Inputs/Outputs · История прогонов. **Advanced:** на вкладке Overview под `▸ Метаданные записи` (browser/locale/timezone/viewport из `ScenarioMetadataSchema`, `schemas.ts:49-58`) — редко нужное.

**Данные / источники:** метаданные — `scenarios` + `ScenarioMetadataSchema` (`schemas.ts:35-61`): `env_id`, `folder_path`, `recorded_by/_at`, `requires_auth`, `inputs[]`, `outputs[]`. Код — read-only `scenario.spec.ts` из `package.zip` (`scenario.package_path`, `store.ts:519`), отдаётся стримом, рендерится с подсветкой (CodeMirror read-only, заменяет голый `<pre>` `html.ts:4155`). История — `runs WHERE scenario_id=:sid`, StatusBadge §3.1 + строки live-патчатся как в Runs.

**Переходы:** строка истории → `/p/:pid/runs/:rid`; `[▶]` строки истории = Retry; вкладка Code ↔ `/p/:pid/scenarios/:sid/code` (deep-link). Live: если у сценария есть активный run, его строка в истории пульсирует и патчится по SSE без reload.

#### Состояние 1 — default (вкладка Overview)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright  ● Payments ▸ Сценарии ▸ payouts ▸ withdraw-flow   [▶3][🔔0][🌐RU][a▾]│
├───────────────┬────────────────────────────────────────────────────────────────────────┤
│ │▸Payments ▾│ │ ● Payments ▸ payouts ▸ withdraw-flow                       [ ▶ Run ][⋯] │
│  Сценарии ◀    │ [ Overview ]·[ Code ]·[ Inputs/Outputs ② ]·[ История ⑤ ]   ← вкладки   │
│               │ ┌────────────────────────────────────────────────────────────────────┐ │
│               │ │ 📄 withdraw-flow                          последний: ✔ passed 12:01 │ │
│               │ │ env stg · папка payments/payouts · requires_auth ✔ · 5 прогонов     │ │
│               │ │ записал anna · 2026-06-20 · recorded_base_url stg.stand.internal    │ │
│               │ │ ▸ Метаданные записи (Advanced): chromium · ru-RU · UTC · 1280×720   │ │
│               │ │──────────────────────────────────────────────────────────────────  │ │
│               │ │ INPUTS (2)        amount: number · currency: enum[USDT,USD]         │ │
│               │ │ OUTPUTS (2)       trace_id → pool · receipt_url                     │ │
│               │ └────────────────────────────────────────────────────────────────────┘ │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
  вкладки с бейджем-счётчиком (§3.9 ДС) · ⋯ overflow: Переместить·…·Удалить (диалог масштаба)
```

#### Состояние 2 — вкладка Code (read-only .spec.ts)

```
┌───────────────┬────────────────────────────────────────────────────────────────────────┐
│ │▸Payments ▾│ │ ● Payments ▸ payouts ▸ withdraw-flow                       [ ▶ Run ][⋯] │
│  Сценарии ◀    │ [ Overview ]·[ Code ]·[ Inputs/Outputs ]·[ История ]                    │
│               │ ┌─ scenario.spec.ts · read-only ─────────────── [⧉ copy][⤓ download]──┐ │
│               │ │  1 │ import { test, expect } from '@playwright/test';               │ │
│               │ │  2 │                                                                │ │
│               │ │  3 │ test('withdraw-flow', async ({ page }) => {                    │ │
│               │ │  4 │   await page.goto('{run_base_url}/payouts');                   │ │
│               │ │  5 │   await page.fill('#user', '{server_username}');   ← плейсхолдер│ │
│               │ │  6 │   await input('2fa_otp');                          ← 2FA контракт│ │
│               │ │  7 │   await page.fill('#amount', '{{INPUT:amount}}');              │ │
│               │ │  8 │   await expect(page.locator('#done')).toBeVisible();           │ │
│               │ │  9 │ });                                                            │ │
│               │ └──────────────────────────────────────────────────── 42 строки ──────┘ │
│               │  плейсхолдеры {server_*}/{{INPUT}}/input() подсвечены · значения НЕ видны │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
  CodeMirror read-only (заменяет <pre> html.ts:4155) · моно --font-mono · в коде секрета нет (§4.6)
```

#### Состояние 3 — вкладка История прогонов (live)

```
┌───────────────┬────────────────────────────────────────────────────────────────────────┐
│ │▸Payments ▾│ │ ● Payments ▸ payouts ▸ withdraw-flow                       [ ▶ Run ][⋯] │
│  Сценарии ◀    │ [ Overview ]·[ Code ]·[ Inputs/Outputs ]·[ История ⑤ ]                  │
│               │ ┌────────────────────────────────────────────────────────────────────┐ │
│               │ │ Статус        │ Запущен   │ Длит.  │ Trigger │              │       │ │
│               │ │───────────────┼───────────┼────────┼─────────┼──────────────────────│ │
│               │ │ ⟳ running     │ 12:08:01  │ 0:42…  │ anna    │ [Stop][open]→        │ │ ← пульс,
│               │ │ ✔ passed      │ 12:01:11  │ 1:38   │ anna    │ [Trace][▶][open]→    │ │   live-таймер
│               │ │ ✖ failed      │ 09:12:40  │ 0:55   │ anna    │ [Trace][▶][open]→    │ │
│               │ │ ⚠ error       │ вчера     │ 0:12   │ bot     │ [Logs][▶][open]→     │ │
│               │ │ ⏹ stopped     │ вчера     │ 0:30   │ anna    │ [▶][open]→           │ │
│               │ └────────────────────────────────────────────────────────────────────┘ │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
  верхняя строка ⟳ патчится по run.status SSE → станет ✔/✖ без reload · [▶]=Retry idempotent
```

#### Состояние 4 — loading / 5 — empty (нет прогонов) / 6 — error

```
LOADING (Overview):                         EMPTY (История, сценарий ещё не запускали):
┌──────────────────────────────────┐        ┌──────────────────────────────────┐
│ ▦▦▦▦▦▦▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦ ✔▦▦▦▦     │        │              ⊙                    │
│ ▦▦▦ ▦▦ · ▦▦▦▦▦▦▦ · ▦▦▦▦▦          │        │   Сценарий ещё не запускался      │
│ ▦▦▦▦▦▦ ▦▦▦▦ · ▦▦▦▦▦▦▦▦▦▦          │        │   Запустите, чтобы увидеть прогон │
│ ──────────────────────────────── │        │            [ ▶ Run ]             │
│ INPUTS  ▦▦▦▦▦▦   OUTPUTS ▦▦▦▦▦    │        └──────────────────────────────────┘
└──────────────────────────────────┘
ERROR (код/метаданные не прочитались):
┌──────────────────────────────────────────────┐
│  ⚠ Не удалось загрузить сценарий               │
│  scenario_package_unreadable                   │ ← code→t() (§3.3) · напр. битый package.zip
│  [ Повторить ]  [ Скачать zip ]  [ подробнее ] │
└──────────────────────────────────────────────┘
```

---

### 4. Список прогонов проекта `/p/:pid/runs` (Runs)

**Назначение:** журнал всех прогонов проекта с фильтрами и live-обновлением статусов в строках; bulk Retry/Delete над выбранными.

**Primary-CTA:** строка кликабельна (нет кнопки `Open`, spec §4.4) → деталь прогона; в шапке `[ ▶ Run ]` (project-scope wizard). **Bulk-bar** (по чекбоксам): `Retry` · `🗑 Delete`. **Overflow `⋯` строки:** Open · Retry · Download artifacts · Copy id · Open scenario · Delete. **Фильтры (структурированные, заменяют 7 текстовых полей `.filter-grid` `html.ts:3653-3682`):** status-chips + поиск + диапазон дат (Table §3.4 ДС). **Advanced:** `▸ Ещё фильтры` (env, trigger, batch, trace_id) — раскрытие редкого.

**Данные / источники:** `runs WHERE project_id=:pid` (денормализованный `runs.project_id`, иммутабельный, spec §2.6/§9.1 J); status-чипы = `RunStatusSchema` (`schemas.ts:169`) + outcome-ось (`timeout/stopped/interrupted`, spec §5.1) — StatusBadge §3.1 ДС по семантике §2.3. Live — SSE `GET /api/stream/execution?pid=:pid` (`run.status`) → `queryClient.setQueryData` патчит ровно изменившуюся строку, без reload (заменяет `setInterval(refreshRun,2000)`+`location.reload()` `html.ts:3597,3615`). Пагинация — виртуализация/infinite-scroll (наследует `RECENT_RUNS_BATCH_SIZE`/sentinel `html.ts:3700,3704`).

**Переходы:** строка → `/p/:pid/runs/:rid`; `[Trace]` → tab Artifacts прогона; `[Retry]` / bulk Retry → POST + новые `queued`-строки появляются сверху live; `Open scenario` → раздел 3.

#### Состояние 1 — default (смешанные статусы, live)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright  ● Payments ▸ Прогоны              [▶3 running][🔔0][🌐RU][anna ▾]    │
├───────────────┬────────────────────────────────────────────────────────────────────────┤
│ │▸Payments ▾│ │ ● Payments ▸ Прогоны                                       [ ▶ Run ]    │
│ ПРОЕКТ         │ [⋯queued①][⟳running③][✔passed][✖failed②][⚠error①][⏹stopped] 🔍[поиск]  │
│  Обзор         │ 📅 [ 28.06 — 28.06 ▾ ]                              ▸ Ещё фильтры        │
│  Прогоны ◀     ├────────────────────────────────────────────────────────────────────────┤
│ ДАННЫЕ СТЕНДА  │ ☐│ Статус       │ Сценарий      │Env │ Запущен │ Длит. │            │   │
│  Credentials   │──┼──────────────┼───────────────┼────┼─────────┼───────┼────────────│   │
│  …             │ ☐│ ⟳ running    │ withdraw-flow │stg │ 12:08   │ 0:42… │ [Stop][⋯]  │   │ ← пульс+таймер
│  Настройки     │ ☐│ ⟳ pull 1.5GB │ deposit-card  │stg │ 12:07   │ 0:50… │ [Stop][⋯]  │   │
│               │ ☐│ ⋯ queued·4   │ kyc·3         │stg │ 12:09   │ —     │ [Stop][⋯]  │   │
│               │ ☐│ ✔ passed     │ withdraw-flow │stg │ 12:01   │ 1:38  │ [Trace][⋯] │   │
│               │ ☐│ ✖ failed     │ payout-batch  │prod│ 09:12   │ 0:55  │ [Trace][⋯] │   │
│               │ ☐│ ⚠ error·intr │ batch b_8f    │stg │ 11:30   │ 0:12  │ [Logs][⋯]  │   │
│               │ ☐│ ⏹ stopped·an │ refund-flow   │stg │ вчера   │ 0:30  │ [▶][⋯]     │   │
│               │  ⤓ больше строк подгружается при скролле (виртуализация)                 │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
  чипы с счётчиком · ⟳синий пульс · ✔зелёный · ✖красный(тест) · ⚠янтарный(инфра, §2.3 ДС)
  ⏹stopped·an = кто остановил · error·intr = interrupted (сервер перезапускался)
```

#### Состояние 2 — real-time обновление строки без reload (демонстрация перехода)

```
       T0 (running)                          T1 (через SSE run.status, БЕЗ reload)
┌──────────────────────────────────┐   →   ┌──────────────────────────────────┐
│ ☐│ ⟳ running   │ withdraw │ 0:42… │       │ ☐│ ✔ passed   │ withdraw │ 1:38  │ ← глиф+цвет
│ ☐│ ⟳ pull 1.5GB│ deposit  │ 0:50… │       │ ☐│ ⟳ execute  │ deposit  │ 1:04… │   кросс-фейд
│ ☐│ ⋯ queued·4  │ kyc·3    │  —    │       │ ☐│ ⟳ running  │ kyc·3    │ 0:03… │   --motion-base
└──────────────────────────────────┘       └──────────────────────────────────┘
  патч точечный (setQueryData по run_id) · скролл/выбор/раскрытые фильтры сохраняются (§4.2 ДС)
  чип-счётчики вверху тоже инкрементятся: [⟳running③→②][✔passed→+1] · НИКОГДА location.reload()
```

#### Состояние 3 — выбор нескольких (bulk-bar Retry/Delete)

```
┌───────────────┬────────────────────────────────────────────────────────────────────────┐
│ │▸Payments ▾│ │ ● Payments ▸ Прогоны                                       [ ▶ Run ]    │
│  Прогоны ◀     │ ┌────────────────────────────────────────────────────────────────────┐ │
│               │ │ ☑ выбрано 2   [⟳ Retry] [🗑 Delete]                  [снять выбор]   │ │ ← bulk-bar
│               │ ├────────────────────────────────────────────────────────────────────┤ │   sticky §3.4
│               │ │ ☑│ ✖ failed   │ payout-batch  │prod│ 09:12 │ 0:55 │ [Trace][⋯]      │ │ ← --accent-
│               │ │ ☐│ ✔ passed   │ withdraw-flow │stg │ 12:01 │ 1:38 │ [Trace][⋯]      │ │   subtle
│               │ │ ☑│ ⚠ error    │ kyc-flow      │stg │ 11:48 │ 0:12 │ [Logs][⋯]       │ │
│               │ └────────────────────────────────────────────────────────────────────┘ │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
  bulk Retry = idempotent (trace_id/pool не регенерятся, §3.7 ДС) · bulk Delete → ConfirmDialog
  с масштабом («удалить 2 прогона и их артефакты») · Retry порождает queued-строки сверху live
```

#### Состояние 4 — только падения (фильтр failed+error активен)

```
┌───────────────┬────────────────────────────────────────────────────────────────────────┐
│ │▸Payments ▾│ │ ● Payments ▸ Прогоны                                       [ ▶ Run ]    │
│               │ [⋯queued][⟳running][✔passed][✖failed②◉][⚠error①◉][⏹stopped] 🔍[      ]  │ ← чипы
│  Прогоны ◀     │ 📅 [ 21.06 — 28.06 ▾ ]   фильтр: failed + error · найдено 3             │   активны ◉
│               ├────────────────────────────────────────────────────────────────────────┤
│               │ ☐│ ✖ failed     │ payout-batch │prod│ 09:12 │ 0:55 │ assertion · exit 1 │
│               │ ☐│ ✖ failed     │ deposit·2    │stg │ 12:01 │ 0:40 │ assertion          │
│               │ ☐│ ⚠ error      │ kyc-flow     │stg │ 11:48 │ 0:12 │ docker pull failed │ ← инфра ≠ тест
│               │  failed (красный) и error (янтарный) визуально разделены — главное смысл.│
│               │  различие системы (§2.3 ДС). Колонка причины поясняет, не «пустая» (§3.1)│
└───────────────┴────────────────────────────────────────────────────────────────────────┘
```

#### Состояние 5 — empty (нет прогонов / фильтр ничего не нашёл) + loading + error

```
EMPTY (проект ещё ничего не запускал):       EMPTY (фильтр пуст):
┌──────────────────────────────────┐         ┌──────────────────────────────────┐
│              ⊙                    │         │   Под фильтр ничего не подошло    │
│   Пока нет прогонов               │         │   failed+error · 21.06–28.06      │
│   Запустите сценарий, чтобы начать│         │   [ Сбросить фильтры ]            │
│            [ ▶ Run ]             │         └──────────────────────────────────┘
└──────────────────────────────────┘
LOADING (skeleton-строки):                    ERROR:
│ ☐│ ▦▦▦▦▦▦ │ ▦▦▦▦▦▦▦▦ │▦▦│ ▦▦▦▦ │▦▦│        ┌────────────────────────────────────────┐
│ ☐│ ▦▦▦▦▦▦ │ ▦▦▦▦▦▦▦▦ │▦▦│ ▦▦▦▦ │▦▦│        │ ⚠ Не удалось загрузить прогоны          │
│ ☐│ ▦▦▦▦▦▦ │ ▦▦▦▦▦▦▦▦ │▦▦│ ▦▦▦▦ │▦▦│        │ server_unreachable · поток закрыт       │
   (shimmer §5.4 · форма будущих строк)        │ [ Повторить ]  [ подробнее ]            │
                                               └────────────────────────────────────────┘
  EmptyState/Skeleton/ErrorState §3.12 ДС · code→t() (§3.3) · сетевая ошибка не роняет рельс (§4.5)
```

---

### Сводка привязок этого раздела

- **Источники (spec):** `docs/ui-redesign-spec.md` §7.2 (дашборд), §7.3 (дерево), §7.4 (прогон-LIVE для бейджей), §5.1-5.3 (оси status/phase/outcome), §5.7 (Execution/Health), §5.4 (SSE/патч без reload), §2.4/§2.6 (изоляция, инвариант `runs.project_id`), §9.1 (DDL `runs/scenarios/run_queue/workers`).
- **Источники (research):** `docs/ui-deploy-research.md` §3.1 (инвентарь экранов/кнопок), §4.4 (сокращение кнопок 7-8→2, строка→ссылка), §4.6 (SSE без reload).
- **Заменяемый код:** `apps/server/src/html.ts` — тулбар проекта/строка из 5 кнопок (`:700-740`, особ. `:727-731`), 7-полевой `.filter-grid` Recent runs (`:3653-3682`), `badge-{status}` (`:3758`), `<pre>`-код (`:4155`), `setInterval(refreshRun,2000)`+`location.reload()` (`:3597,3615`), sentinel/batch-size (`:3700,3704`); `apps/server/src/store.ts` — модель дерева `discoverScenariosFromStorage`/`folder_path` (`:506-522`), `buildStableScenarioId` (`:528`).
- **Контракт схем:** `packages/shared/src/schemas.ts` — `RunStatusSchema` (`:169`), `ScenarioMetadataSchema` inputs/outputs (`:35-61`), `RunSchema.batch_id/execution_stage/phase`-надстройка (`:179-208`).
- **Дизайн-система (единообразно во всех моках):** StatusBadge §3.1, PhaseTimeline §3.2, Table+bulk-bar §3.4, Card §3.5, Breadcrumbs §3.15, ProgressBar §3.16, HealthIndicator §3.11, Skeleton/EmptyState/ErrorState §3.12, ConfirmDialog §3.18; токены статусов §2.3, плотность compact §2.6; конвенции real-time §4.2, overflow/Advanced §4.3, empty/loading/error §4.5, write-only секреты §4.6; движение (пульс/shimmer/кросс-фейд) §5.2-5.4.

---

## 6. Опыт прогона: запуск, LIVE-страница, батч, real-time


Замечу load-bearing факт из кода для retry-флоу: в `prepareScenarioRunPlan` при retry `runtime_snapshot` берётся из `options.runtime_snapshot ?? {...}` (`run-planner.ts:306`) — то есть передаётся целиком существующий снимок, поэтому `pools` (с `value`/`item_id`/`trace_id`) и `server` не перегенерируются. `retry_of_run_id` (`:291`) и `batch_id` (`:292`) — отдельные поля.

---

### 5.A. Назначение и сквозные правила раздела

Раздел «Опыт прогона» — главный полигон real-time прозрачности (spec §1 столп 1). Все экраны ниже подчинены трём инвариантам:

- **Две оси состояния всегда видны раздельно** (spec §5.1): `status` (контракт `queued·running·passed·failed·error`, `schemas.ts:169`) рисуется бейджем §3.1, а `phase` (`queued·prepare·pull_image·create_container·execute·collecting·done`) — Timeline §3.2. `outcome` (`timeout·stopped·interrupted`) — надстройка над `status`, отдельный глиф+цвет §2.3, НЕ новое значение `status`.
- **Никаких `location.reload()`** — только SSE-патч (spec §5.4, §4.2). Скролл консоли, активная вкладка, раскрытые блоки переживают любой переход статуса.
- **Все живые сигналы из §4.2**: пульс активной фазы (§5.2 движения), клиентские таймеры от `started_at` фазы, маркеры дропа бэкпрешера.

Источники данных (привязка к коду) для всего раздела:
- `phase`-эмиты — новые `on_phase` рядом с `on_log`, привязка к точкам `execute.ts:81` (prepare), `:479` (pull, только при промахе `image inspect` `:463-469`, иначе SKIPPED), `:98/:340` (create), `:414` (первый stdout-chunk = execute), `:567` (collecting), `finalizeExecution :557-585` (done).
- drift — `queryNtpDrift()` (`execute.ts:84`), пишется в `drift.log` (`:85`), env `TOTP_CLOCK_DRIFT` (`:254`).
- транспорт bind/copy — `normalizeWorkspaceTransport` (`execute.ts:372-378`); имя контейнера для Stop — `ts-playwright-run-<runId>` (spec §6.7 п.3, заменяет `Date.now()`-имя `execute.ts:339`).
- очередь/позиция/воркеры — `run_queue`/`workers` (spec §5.8), вместо `queueMicrotask`.
- retry-снимок — `runtime_snapshot` (`run-planner.ts:306`), `retry_of_run_id` (`:291`), `batch_id` (`:292`).

Легенда глифов (из §2.3/§4.1, единые во всех моках): `⋯`queued `⟳`running `✔`passed `✖`failed(тест) `⚠`error/timeout/interrupted(инфра) `⏹`stopped `⊘`skipped `○`pending `🔐`2fa `●`set `○`not set.

---

### 5.B. Run-wizard (Scope → Data → Execution)

Назначение: один `<RunConfig>` для проекта и сценария (устраняет дубль `html.ts:1236` vs `2760`), 3 шага с project-scoped предпросмотром подстановки `server_*` и пулов. Primary-CTA — на последнем шаге `▶ Запустить`; навигация шагов через RHF+Zod (§1), шаг не пускает дальше с ошибкой. Черновик resumable (перенос `captureRunModalDraft`, `html.ts:1466`).

#### 5.B.1 Шаг 1 — Scope (валидно, с авто-reachability)

Данные: окружения проекта (`environments.project_id`), дерево сценариев (`scenarios.project_id`). Reachability-чип — last-known из §7.8 (`stand.availability`), авто-проверка не блокирует жёстко (spec §5.9).

```
┌─ RUN · Payments / payouts ───────────────────── Step 1 of 3 · Scope ───────────┐
│  ①Scope ●─────── ②Data ○─────── ③Execution ○                                   │
│                                                                                 │
│  ОКРУЖЕНИЕ*                                                                      │
│   ◉ stg   ● reachable  200 · 84ms          ← чип из 7.8 (last-known)            │
│   ○ prod  ⚠ slow       200 · 1.4s  [Проверить сейчас]                          │
│                                                                                 │
│  СЦЕНАРИИ К ЗАПУСКУ                         выбрано 2 из 12   [все][снять]       │
│   ┌─────────────────────────────────────────────────────────────────────────┐ │
│   │ ☑ withdraw-flow   stg   ● passed 12:01                                   │ │
│   │ ☑ payout-batch    prod  ✖ failed 09:12                                   │ │
│   │ ☐ refund-flow     stg   — never                                          │ │
│   └─────────────────────────────────────────────────────────────────────────┘ │
│                                          [ Отмена ]   [ Далее: Data → ]         │
└─────────────────────────────────────────────────────────────────────────────────┘
   (одиночный сценарий → блок «Сценарии» свёрнут, шаг показывает только Окружение)
```

#### 5.B.2 Шаг 2 — Data (предпросмотр подстановки, валидно)

Данные: `STAND CREDENTIAL` — список `stand_credentials.project_id` активного проекта; источник `{server_username/password/2faotp}` через `resolveSelectedBaseData` (которую правим на project-scope, `run-planner.ts:995-1004`). `MERCHANT` → `{server_merchant}`. Пулы → `pools.project_id`, число свободных = enabled `pool_items`. Предпросмотр маскирует секреты (§4.6): пароль `●set`, TOTP `on-demand код at run` (значение НЕ загружается).

```
┌─ RUN · Payments / payouts ───────────────────── Step 2 of 3 · Data ────────────┐
│  ①Scope ✔─────── ②Data ●─────── ③Execution ○                                   │
│                                                                                 │
│  STAND CREDENTIAL  [ stand-admin ▾ ]  → user a***n   pwd ●set   🔐 2FA ●set     │
│        (список = credentials проекта Payments; источник server_username/…)      │
│  MERCHANT          [ ACME ▾ ]         → {server_merchant} = ACME                │
│  ▸ Переопределить вручную (Advanced)         ← прогрессивное раскрытие          │
│                                                                                 │
│  SHARED INPUTS     amount [ 100 ]    currency [ USDT ▾ ]                        │
│  POOLS             address [ eth-addr ▾ · auto ]   ● 412 свободно               │
│                                                                                 │
│  ┌─ ПРЕДПРОСМОТР ПОДСТАНОВКИ ────────────────────────────────────────────────┐ │
│  │ {server_username} → a***n          (cred stand-admin · project Payments)  │ │
│  │ {server_password} → ●set            {server_2faotp} → 🔐 on-demand at run   │ │
│  │ {server_merchant} → ACME            {address} → 0x9f…ae3  (auto · 412 free) │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                       [ ← Назад ]   [ Далее: Execution → ]      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.B.3 Шаг 2 — состояние «credential не задан» (валидация блокирует)

Триггер: у выбранного credential `totp_secret_enc` пуст ИЛИ `{server_2faotp}` используется сценарием, но 2FA `○ not set`. Соответствует серверной ошибке `server_2fa_required` (каталог §3.3; в коде — бросок `run-planner.ts:1074` «Set server 2FA/TOTP…»). Поле подсвечено, `Далее` disabled.

```
┌─ RUN · Payments / payouts ───────────────────── Step 2 of 3 · Data ────────────┐
│  STAND CREDENTIAL  [ stand-ops ▾ ]   → user o***s   pwd ●set   🔐 2FA ○ not set │
│                                                          ▲                       │
│  ⚠ Сценарий использует {server_2faotp}, но у stand-ops 2FA не задан.            │
│     error.server_2fa_required · cred stand-ops · project Payments               │
│     [ Открыть credential → ]   или выберите другой credential                   │
│                                                                                 │
│  ┌─ ПРЕДПРОСМОТР ПОДСТАНОВКИ ────────────────────────────────────────────────┐ │
│  │ {server_username} → o***s           {server_password} → ●set               │ │
│  │ {server_2faotp}   → ✖ не задан      {server_merchant} → ACME               │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                       [ ← Назад ]   [ Далее: Execution → ] (✕)  │
│                                                       └ disabled, пока 2FA ○     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.B.4 Шаг 3 — Execution (Advanced + предупреждение ёмкости, валидно)

Данные: `Повторов` → `amount_times_to_run` (`run-planner.ts:275`); `Execution stage` → `execution_stage` (`:274`); `Parallel batch` → `parallel_batch_size` (`prepareFolderRunPlans :377,392`); `Default timeout` → `default_timeout_ms` (`:277`). Предупреждение ёмкости: `parallel_batch_size` контейнеров разом vs `idle` воркеров из `workers` (§5.8). Advanced скрывает редкое (§4.3).

```
┌─ RUN · Payments / payouts ──────────────────── Step 3 of 3 · Execution ────────┐
│  ①Scope ✔─────── ②Data ✔─────── ③Execution ●                                   │
│                                                                                 │
│  Повторов каждого  [ 1 ]                                                         │
│  ☑ Require valid {address} in pool  ⓘ   (ensure_right_address_to_run)           │
│                                                                                 │
│  ▾ Advanced                                                                     │
│     Execution stage     [ 1 ]                                                    │
│     Parallel batch      [ 4 ]   ← одновременно в стадии                         │
│     Default timeout     [ — ]   (по умолчанию APP_RUN_TIMEOUT_MS)               │
│                                                                                 │
│  ┌────────────────────────────────────────────────────────────────────────────┐│
│  │ ⚠ ЁМКОСТЬ: 4 контейнера разом · оценка ~3 мин · workers свободно: 1         ││
│  │   3 из 4 встанут в очередь (state=waiting) — стартуют по мере освобождения  ││
│  └────────────────────────────────────────────────────────────────────────────┘│
│                                       [ ← Назад ]   [ ▶ Запустить · Payments ]  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.B.5 Шаг 3 — состояние «пул исчерпан» (валидация блокирует)

Триггер: для `Повторов × сценариев` нужно больше уникальных адресов, чем enabled `pool_items` свободно, при `auto`-стратегии и `Require valid address`. Соответствует броску «Pool … does not have an enabled … address» (`run-planner.ts:524`) / «does not have an enabled item» (`:541`). Код `error.pool_exhausted`.

```
┌─ RUN · Payments / payouts ──────────────────── Step 3 of 3 · Execution ────────┐
│  Повторов каждого  [ 6 ]                                                         │
│                                                                                 │
│  POOLS  address [ eth-addr ▾ · auto ]   ✖ исчерпан: нужно 12, свободно 4        │
│  ┌────────────────────────────────────────────────────────────────────────────┐│
│  │ ✖ ЁМКОСТЬ ПУЛА: запросили 12 значений (6 повт. × 2 сценария),               ││
│  │   в пуле eth-addr свободно 4 (412 всего, 408 заняты прошлыми прогонами).     ││
│  │   error.pool_exhausted · pool eth-addr · project Payments                   ││
│  │   [ Bulk import ⤓ в пул ]   [ Снять «Require valid» ]   [ Уменьшить повторы ]││
│  └────────────────────────────────────────────────────────────────────────────┘│
│                                       [ ← Назад ]   [ ▶ Запустить ] (✕ disabled)│
└─────────────────────────────────────────────────────────────────────────────────┘
```

Переходы wizard: `▶ Запустить` → `POST /api/.../runs` (или folder-run) → редирект на §5.C (одиночный) или §5.E (батч). Отмена → назад в дерево §7.3.

---

### 5.C. Страница прогона LIVE — по одной фазе на мок

Общий каркас (повторяется во всех фазах ниже; меняются только Timeline, бейдж, META-строки и активная вкладка): шапка с двумя осями, строка батча (если `batch_id`), Timeline §3.2, META, вкладки §3.9, тело активной вкладки. Все обновления — `GET /api/runs/:id/stream` (`run.phase`/`run.log`/`run.status`/`run.artifact`), авторизация сессией + scope-гард `run.project_id == :pid` (spec §5.4). На connect — снапшот `log_entries`+`phase_timings`, затем дельты.

#### 5.C.1 phase=queued (позиция в очереди / «ждёт стадию»)

Данные: позиция = порядок `waiting` по `(priority, enqueued_at)` (§5.8); `state=waiting` (ждёт воркера) vs `waiting_stage` (ждёт предыдущую стадию). ETA — по средней `phase_timings.execute.duration_ms`. Лог-строка `queued` — `createQueuedRunLogEntry` (`run-planner.ts:1253-1262`).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ withdraw-flow ▸ r_5c1a       ⋯ QUEUED            [ Stop ][ Retry✕ ][ ⋯ ] │
│ Batch b_8f3a · Stage 2 of 3 · ждёт стадию 1 → [open batch]                      │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ⋯Queued─○Prepare─○Pull─○Container─○Execute─○Collect─○Done                  │  │
│ │  pos 3                                                                      │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ ОЧЕРЕДЬ  3-й в очереди · перед вами 2 · ETA ~4 мин                              │
│          state=waiting_stage — ждёт завершения стадии 1 (НЕ ждёт воркера)       │
│ META  scenario withdraw-flow · env stg · iteration 1/1 · timeout 900000ms       │
│       cred stand-admin → user a***n  pwd ●set  🔐 2FA ●set   merchant ACME      │
│       triggered_by anna · 12:04:01                                              │
│ [ Live console ]·[ stdout ]·[ stderr ]·[ Outputs ]·[ Artifacts ]                │
│ ┌─ Live console ─────────────────────────────────────────────────────────────┐ │
│ │  (queued) ещё нет вывода — ждём старта контейнера                           │ │
│ │  12:04:01  ⋯ Run queued in stage 2. Стартует после стадии 1.               │ │
│ └──────────────────────────────────────────────── following · 1 line ────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
   Stop: доступен (run ещё не стартовал → run_queue.state := 'cancelled', §6.7 п.4)
```

#### 5.C.2 phase=running·prepare (drift-результат)

Данные: лог `prepare` (`execute.ts:81`), drift из `queryNtpDrift` (`:84`, пишется `drift.log` `:85`). Дрейф критичен: ломает 2FA молча (spec §5.7) — показываем сразу.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ withdraw-flow ▸ r_5c1a       ⟳ RUNNING           [ Stop ][ Retry✕ ][ ⋯ ] │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─⟳Prepare─○Pull─○Container─○Execute─○Collect─○Done                  │  │
│ │  0.2s    0:01 ░     —    —          —        —                              │  │
│ │          └ активная (пульс) · готовим isolated workspace                    │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ PREPARE  workspace готовится · NTP drift: ● 12 ms (в норме)                     │
│ META  cred stand-admin → user a***n  pwd ●set  🔐 2FA ●set   merchant ACME      │
│ ┌─ Live console ─────────────────────────────────── [⏸ autoscroll][⤓ wrap][⧉]─┐ │
│ │ 12:04:01  ⋯ Run queued. Waiting to start Docker execution.                  │ │
│ │ 12:04:02  ⟳ Preparing isolated workspace for Docker execution.             │ │
│ │ 12:04:03  ✓ Calculated local clock drift against NTP: 0.012 seconds.       │ │
│ └──────────────────────────────────────────── following · 3 lines ───────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘

Вариант drift-предупреждения (|drift|>1 шаг, §8.5):
│ PREPARE  workspace готовится · NTP drift: ⚠ 1.4 s — TOTP стенда может не сойтись │
```

#### 5.C.3 phase=running·pull_image (живой хвост pull, «~1.5 ГБ»)

Данные: фаза эмитится ТОЛЬКО если `docker image inspect` промахнулся (`execute.ts:463-469`); иначе SKIPPED (`⊘ from cache`, см. §5.C.4). Лог `pull` (`:479`), хвост `docker pull` идёт построчно в stdout (`spawnProcess` `:480`). Размер «~1.5 ГБ» — из прогресса слоёв pull. Полоса неопределённая (§3.16, shimmer).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ deposit-card ▸ r_7d20        ⟳ RUNNING           [ Stop ][ Retry✕ ][ ⋯ ] │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⟳Pull───────────○Container─○Execute─○Collect              │  │
│ │  0.2s    1.1s     2:18 ▓▓▓░ ~1.5GB  —         —        —                    │  │
│ │                   └ активная (пульс) · образ не в кеше, первый pull         │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ PULL  mcr.microsoft.com/playwright:v1.52.0-jammy · ~1.5 ГБ · чистый ПК — мин.   │
│       ▓▓▓▓▓▓▓▓░░░░░░░  слой 6/14 · 1.5 GB · 2:18                                │
│ ┌─ Live console ─────────────────────────────────── [⏸ autoscroll][⤓ wrap][⧉]─┐ │
│ │ 12:04:14  ⚠ Image not cached locally. First run may take a few minutes.     │ │
│ │ 12:04:14  ⟳ Pulling Docker image mcr…playwright:v1.52.0-jammy.              │ │
│ │ 12:05:02  a3f9c1: Pull complete                                             │ │
│ │ 12:05:31  e7b22a: Downloading  812MB/1.21GB                                 │ │
│ └──────────────────────────────────────────── following · 41 lines ──────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.4 phase=running·create_container (транспорт bind/copy, Pull из кеша = ⊘)

Данные: транспорт из `normalizeWorkspaceTransport` (`execute.ts:372-378`) — `bind` (`docker run -v`, `:304-322`) или `copy` (`docker create`+`cp`, `:325-369`). Имя контейнера детерминированное `ts-playwright-run-<runId>` (spec §6.7). `⊘Pull(cached)` объясняет, почему прогон короче (spec §5.5).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ withdraw-flow ▸ r_5c1a       ⟳ RUNNING           [ Stop ][ Retry✕ ][ ⋯ ] │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⊘Pull(cached)─⟳Container─○Execute─○Collect─○Done          │  │
│ │  0.2s    1.1s     —             0:06 ░      —        —                      │  │
│ │                   └ образ в кеше (потому быстро)  └ активная (пульс)         │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ CONTAINER  запускаем · транспорт: copy (docker create + cp)                     │
│            name ts-playwright-run-r_5c1a   image …playwright:v1.52.0-jammy      │
│ ┌─ Live console ─────────────────────────────────── [⏸ autoscroll][⤓ wrap][⧉]─┐ │
│ │ 12:04:03  ✓ Docker image …playwright:v1.52.0-jammy is already available.    │ │
│ │ 12:04:03  ⟳ Starting Playwright container.                                  │ │
│ │ 12:04:08  ⟳ docker cp workspace → ts-playwright-run-r_5c1a:/work            │ │
│ └──────────────────────────────────────────── following · 14 lines ──────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
   (bind-режим: строка CONTAINER → «транспорт: bind (docker run -v /work)»)
```

#### 5.C.5 phase=running·execute (live-консоль + таймер, follow)

Данные: фаза от первого stdout-chunk (`execute.ts:414`). Таймер фазы тикает на клиенте от `started_at` (§4.2, requestAnimationFrame, не SSE). Маркер 🔐 2FA — структурная строка рантайма (spec §8.5), код НЕ показывается. Follow-режим (§3.3).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ withdraw-flow ▸ r_5c1a       ⟳ RUNNING           [ Stop ][ Retry✕ ][ ⋯ ] │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⊘Pull(cached)─✔Container─⟳Execute─○Collect─○Done          │  │
│ │  0.2s    1.1s     —             2.1s       0:42 ░    —                      │  │
│ │                                            └ активная (пульс) · живой таймер │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ META  scenario withdraw-flow · env stg · iteration 1/1 · timeout 900000ms       │
│       cred stand-admin → user a***n  pwd ●set  🔐 2FA ●set   merchant ACME      │
│       🔐 2FA подставлен 12:04:25 · действ. 24с   (код не логируется)            │
│ [ Live console ]·[ stdout ]·[ stderr ]·[ Outputs ]·[ Artifacts ]                │
│ ┌─ Live console ─────────────────────────────────── [⏸ autoscroll][⤓ wrap][⧉]─┐ │
│ │ 12:04:21  ✓ login ok                                                        │ │
│ │ 12:04:23  ✓ withdraw form opened                                            │ │
│ │ 12:04:25  🔐 2fa code for "server_2faotp" generated, valid 24s (stand-admin)│ │
│ │ 12:04:27  ⟳ waiting for #confirm …                                          │ │
│ │ ▏                                                                           │ │
│ └────────────────────────────── following · 1240 lines ──────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.6 phase=running·execute — консоль paused (проскроллил вверх)

То же состояние run, но пользователь проскроллил вверх → follow приостановлен, плашка «N новых строк ниже» (spec §5.6). Поток продолжает дописываться, скролл НЕ дёргается.

```
│ [ Live console ]·[ stdout ]·[ stderr ]·[ Outputs ]·[ Artifacts ]                │
│ ┌─ Live console ─────────────────────────────────── [▶ resume][⤓ wrap][⧉ copy]─┐│
│ │ 12:04:11  ✓ navigated /payouts                                              ││
│ │ 12:04:14  ✓ select merchant ACME                                            ││
│ │ 12:04:17  ✓ amount 100 USDT                                                 ││
│ │ ┌────────────────────────────────────────────────────────────────────────┐ ││
│ │ │  ⏸ paused · 18 новых строк ниже            [ к концу ↓ ]                 │ ││
│ │ └────────────────────────────────────────────────────────────────────────┘ ││
│ └───────────────────────────────────────────────── paused · 1258 lines ──────┘│
```

#### 5.C.7 phase=running·collecting (Stop поздно)

Данные: фаза от `collectPlaywrightArtifacts`/`mergeStdoutOutputs` (`execute.ts:567-568`). Контейнер уже отработал — Stop помечается «поздно» (артефакты почти собраны). `run.artifact`-события заполняют вкладку Artifacts по мере копирования (`:587-611`).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ withdraw-flow ▸ r_5c1a       ⟳ RUNNING           [ Stop ⓘ ][ Retry✕ ][⋯] │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⊘Pull(cached)─✔Container─✔Execute─⟳Collect─○Done          │  │
│ │  0.2s    1.1s     —             2.1s       0:48      0:01 ░                 │  │
│ │                                                     └ собираем trace/video  │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ COLLECTING  trace.zip · screenshot · videos · outputs.json (PW_OUTPUT)          │
│ [ Live console ]·[ stdout ]·[ stderr ]·[ Outputs ]·[ Artifacts ⟳ ]              │
│ ┌─ Live console ─────────────────────────────────── [⏸ autoscroll][⤓ wrap][⧉]─┐ │
│ │ 12:04:49  ✓ Playwright container finished successfully.                     │ │
│ │ 12:04:49  ⟳ collecting artifacts: trace.zip                                 │ │
│ │ 12:04:50  ⟳ collecting artifacts: videos/ (1)                               │ │
│ └──────────────────────────────────────────── following · 1262 lines ────────┘ │
│  ⓘ Stop сейчас уже не остановит тест (контейнер отработал, идёт сбор)           │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.8 Терминал passed

Данные: `status=passed`, `exit_code==0` (`finalizeExecution :570`). Артефакты из `collectPlaywrightArtifacts` (`:587-611`); Outputs из `outputs.json` (`mergeStdoutOutputs :613-633`) с `Add to pool` на строку (spec §7.4). Эффекты пула применены ТОЛЬКО при passed (`app.ts:1751-1754`).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ withdraw-flow ▸ r_5c1a       ✔ PASSED            [ Retry ][ Trace ][ ⋯ ] │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⊘Pull(cached)─✔Container─✔Execute─✔Collect─✔Done          │  │
│ │  0.2s    1.1s     —             2.1s       0:48      0.8s    total 0:53     │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ META  ✔ exit 0 · длительность 0:53 · 12:04:01 → 12:04:54                        │
│       🔐 2FA подставлен 12:04:25 · действ. 24с                                  │
│ [ Live console ]·[ stdout ]·[ stderr ]·[ Outputs ② ]·[ Artifacts ④ ]            │
│ ┌─ Outputs ──────────────────────────────────────────────────────────────────┐ │
│ │ withdraw_id   = wd_5c1a99             [ ⧉ copy ]  [ + Add to pool ]          │ │
│ │ tx_hash       = 0x9f…ae3              [ ⧉ copy ]  [ + Add to pool ]          │ │
│ └──────────────────────────────────────────────────────────────────────────────┘│
│ Artifacts: trace.zip · screenshot.png · videos/1.webm · result.json [скачать]   │
│ ✚ Добавлено в пул eth-addr: 1 значение (effects_applied)                        │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.9 Терминал failed (тест, красный)

Данные: `status=failed`, `exit_code!=0`, assertion из `stderr.log` (`finalizeExecution :570`, `screenshot_on_fail.png` `:599`). Клик по `✖Execute` Timeline → консоль к началу фазы execute (логи тегируются phase, spec §5.5). Primary-CTA = `Retry`.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ payout-batch ▸ r_4b2c        ✖ FAILED           [ Retry ][ Trace ][ ⋯ ] │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⊘Pull(cached)─✔Container─✖Execute─✔Collect─✔Done          │  │
│ │  0.2s    1.1s     —             2.1s       0:42 FAIL  0.8s                  │  │
│ │                                            └ клик → консоль к началу фазы    │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ ОТКАЗ ТЕСТА (assertion)  exit 1                                                  │
│   expect(page.locator('#balance')).toHaveText('0.00')                           │
│   Received: '100.00'   at scenario.spec.ts:48                                    │
│ [ Live console ]·[ stdout ]·[ stderr ◀ ]·[ Outputs ]·[ Artifacts ③ ]            │
│ ┌─ stderr ───────────────────────────────────────────────────────────────────┐ │
│ │ 12:04:42  ✖ 1) withdraw-flow › confirms balance                            │ │
│ │ 12:04:42    Error: expect(locator).toHaveText('0.00')                      │ │
│ │ 12:04:42    Timeout 5000ms exceeded.                                        │ │
│ └──────────────────────────────────────────────────────────────────────────────┘│
│ Artifacts: trace.zip[Trace ▶] · screenshot_on_fail.png · videos/1.webm          │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.10 Терминал error (инфраструктура, янтарный)

Данные: `status=error` (`finalizeExecution :570`, ветка `error`), `summary.error` (`:575`), фаза падения. Примеры: pull failed (`execute.ts:487`), docker unavailable (`:682`). Цвет янтарный — НЕ красный (spec §4.4: инфра ≠ тест). CTA: Retry + диагностика стенда/Docker.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ kyc-flow ▸ r_9a01            ⚠ ERROR            [ Retry ][ Logs ][ ⋯ ]   │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⚠Pull(failed)─○Container─○Execute─○Collect                │  │
│ │  0.2s    1.1s     timeout        —          —        —                      │  │
│ │                   └ янтарный · фаза падения: pull_image                      │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ ИНФРАСТРУКТУРА (не падение теста)                                                │
│   summary.error: Docker failed to pull image …playwright:v1.52.0-jammy.         │
│   Проверьте Docker Desktop, доступ к registry, сеть.                             │
│   [ Проверить доступность стенда → ]   [ Проверить Docker (Система) → ]          │
│ [ Live console ◀ ]·[ stdout ]·[ stderr ]·[ Outputs ]·[ Artifacts ]              │
│ ┌─ Live console ─────────────────────────────────────────────────────────────┐ │
│ │ 12:04:14  ⟳ Pulling Docker image …playwright:v1.52.0-jammy.                 │ │
│ │ 12:06:14  ✖ Docker run failed: Docker failed to pull image …               │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.11 Терминал timeout (янтарный)

Данные: `outcome=timeout` — `spawnProcess` ставит `setTimeout(child.kill())` и бросает «Process timed out after …ms» (`execute.ts:407-412,431`), различается в `finalizeExecution` (spec §5.2). Timeline показывает фазу в момент kill.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ withdraw-flow ▸ r_5c1a       ⚠ TIMEOUT          [ Retry ][ Trace ][ ⋯ ] │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⊘Pull(cached)─✔Container─⚠Execute─○Collect                │  │
│ │  0.2s    1.1s     —             2.1s       15:00 KILL  —                    │  │
│ │                                            └ убит по таймауту в фазе execute │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ ТАЙМАУТ  лимит 900000 ms (APP_RUN_TIMEOUT_MS) · убит на фазе execute            │
│   Process timed out after 900000ms — контейнер остановлен (SIGTERM→SIGKILL)     │
│   [ Retry ]   [ Увеличить Default timeout в Run-wizard → ]                       │
│ ┌─ Live console ─────────────────────────────────────────────────────────────┐ │
│ │ 12:19:01  ⟳ waiting for #confirm …  (последняя строка перед kill)           │ │
│ │ 12:19:01  ✖ Process timed out after 900000ms                               │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.12 Терминал stopped (серый)

Данные: `outcome=stopped` — через реестр процессов + `AbortSignal` + `docker rm -f ts-playwright-run-<runId>` (spec §6.7). Кто/когда остановил — `triggered_by`/время Stop. CTA: Retry.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ deposit-card ▸ r_7d20        ⏹ STOPPED          [ Retry ][ Trace ][ ⋯ ] │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⊘Pull(cached)─✔Container─⏹Execute─○Collect                │  │
│ │  0.2s    1.1s     —             2.1s       0:31 STOP  —                     │  │
│ │                                            └ остановлен пользователем         │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ ОСТАНОВЛЕН  anna · 12:04:34 · SIGTERM→SIGKILL отправлен, контейнер удалён        │
│   [ Retry ]   (повторит тем же runtime_snapshot, §5.F)                           │
│ ┌─ Live console ─────────────────────────────────────────────────────────────┐ │
│ │ 12:04:33  ⟳ waiting for #confirm …                                          │ │
│ │ 12:04:34  ⏹ Stop requested by anna — terminating container.                 │ │
│ │ 12:04:35  ⏹ Container ts-playwright-run-r_7d20 removed.                      │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.13 Терминал interrupted (янтарный, «сервер перезапускался»)

Данные: `outcome=interrupted` — из `recoverInterruptedRuns` (`app.ts:1625`): сервер не перезапускает, а финализирует. Реестр процессов in-memory утрачен при рестарте (spec §6.7) → «висящая» строка подобрана recover. CTA: Retry (новый run).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ kyc-2 ▸ r_3f7e               ⚠ INTERRUPTED      [ Retry ][ Logs ][ ⋯ ]   │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⊘Pull(cached)─✔Container─⚠Execute─◌Collect                │  │
│ │  0.2s    1.1s     —             2.1s       ? (прервано)  —                  │  │
│ │                                            └ восстановлено как interrupted    │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ ПРЕРВАНО  сервер перезапускался во время прогона — исполнение не сохранилось     │
│   Состояние восстановлено из result.json/recover; точная длительность неизвестна │
│   [ Retry ]   (idempotent: trace_id/pool из снимка не регенерятся, §5.F)         │
│ ┌─ Live console ─────────────────────────────────────────────────────────────┐ │
│ │ 12:04:30  ⟳ waiting for #confirm …                                          │ │
│ │ —— поток оборван (рестарт сервера) ——                                       │ │
│ │ 12:09:12  ⚠ Run recovered as interrupted by server restart.                 │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.14 Состояние loading/skeleton (первый рендер до снапшота)

Пока `GET /api/runs/:id/stream` не отдал снапшот (или фолбэк `GET /api/runs/:id` грузится): Skeleton §3.12, форма повторяет будущий контент.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ ▦▦▦▦▦▦▦▦ ▸ ▦▦▦▦         ▦▦▦▦▦▦                  [ ▦▦▦▦ ][ ▦▦▦▦ ][ ⋯ ] │
│ ┌─ TIMELINE ───────────────────────────────────────────────────────────────┐  │
│ │ ▦▦▦▦▦▦─▦▦▦▦▦▦─▦▦▦▦─▦▦▦▦▦▦▦─▦▦▦▦▦─▦▦▦▦▦▦   (shimmer)                        │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ META  ▦▦▦▦▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦   ▦▦▦▦▦▦▦▦▦▦                                       │
│ ┌─ Live console ─────────────────────────────────────────────────────────────┐ │
│ │ ▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦                                                 │ │
│ │ ▦▦▦▦▦▦▦▦▦▦▦▦                                                               │ │
│ └────────────────────────────── загрузка прогона… ───────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.15 Состояние error загрузки страницы (стрим/фолбэк недоступны)

`EventSource` упал И фолбэк-poll `GET /api/runs/:id` не отвечает (`server_unreachable`). ErrorState §3.12, экран не пустой, есть [Повторить]. Деградация по виджетам: Timeline остаётся из последнего снапшота, обновляется красная плашка.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Runs ▸ withdraw-flow ▸ r_5c1a       ⟳ RUNNING (last-known)        [ Stop ][ ⋯ ] │
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │  ⚠ Соединение с сервером потеряно — обновления приостановлены               │ │
│ │     error.server_unreachable · переподключение через 3с…                    │ │
│ │     [ Повторить сейчас ]   [ подробнее ]                                     │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ TIMELINE (last-known 12:04:27) ─────────────────────────────────────────┐  │
│ │ ✔Queued─✔Prepare─⊘Pull(cached)─✔Container─⟳Execute─○Collect               │  │
│ │  0.2s    1.1s     —             2.1s       0:42 (заморожен)                 │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│ ┌─ Live console ───────────────────── ⏸ поток на паузе (нет соединения) ──────┐ │
│ │ 12:04:27  ⟳ waiting for #confirm …  (последняя полученная строка)           │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.C.16 Бэкпрешер в консоли (дроп строк медленному клиенту)

`run.log {dropped:N}` (spec §5.4): сервер дропает промежуточные log-строки, оставляя phase/status; клиент дотягивает через `GET /api/runs/:id/log?after=<id>`.

```
│ ┌─ Live console ─────────────────────────────────── [⏸ autoscroll][⤓ wrap][⧉]─┐ │
│ │ 12:04:25  ✓ withdraw form opened                                            │ │
│ │ ⚠ 240 строк опущено сервером (медленный клиент)        [ подгрузить ]        │ │
│ │ 12:04:41  ⟳ waiting for #confirm …                                          │ │
│ └──────────────────────────── following · 1480 lines (−240 dropped) ──────────┘ │
```

---

### 5.D. Кнопка/механика Stop (доступность по фазам, подтверждение)

Назначение: единая Stop-механика (spec §6.7) — реестр процессов `Map<runId, RunHandle>`, `AbortSignal`→SIGTERM→SIGKILL, `docker rm -f ts-playwright-run-<runId>` в обоих транспортах. `POST /api/runs/:id/stop`, project-scoped гард. Доступность кнопки по фазе:

```
МАТРИЦА ДОСТУПНОСТИ Stop (по phase/status):
  phase=queued (status=queued)        [ Stop ]  активна → run_queue.state='cancelled' (§6.7 п.4)
  running·prepare                      [ Stop ]  активна → abort + (контейнера ещё нет)
  running·pull_image                   [ Stop ]  активна → abort прерывает docker pull
  running·create_container             [ Stop ]  активна → abort + docker rm -f <name>
  running·execute                      [ Stop ]  активна → abort (SIGTERM→SIGKILL) + rm -f
  running·collecting                   [ Stop ⓘ] видна, но «поздно»: контейнер отработал
  passed/failed/error/timeout/         [ Stop ]  СКРЫТА (терминал) → на её месте [ Retry ]
    stopped/interrupted
```

Подтверждение (ConfirmDialog §3.18 — лёгкое, обратимое, без ввода имени; имя проекта показано, spec §2.4):

```
┌─────────────────────────────────────────────────────────────┐
│  ⏹ Остановить прогон в проекте Payments?                     │
│─────────────────────────────────────────────────────────────│
│  withdraw-flow · r_5c1a · сейчас фаза execute (0:42)         │
│  Контейнеру будет послан SIGTERM, через 5с — SIGKILL.        │
│  Прогон завершится со статусом ⏹ stopped (можно Retry).      │
│─────────────────────────────────────────────────────────────│
│                          [ Отмена ]   [ ⏹ Остановить ]       │
└─────────────────────────────────────────────────────────────┘

Состояние «Stop отправлен» (между POST и терминалом stopped):
  [ ⟳ Останавливаю… ]  ← кнопка в loading (§3.13), повторный клик заблокирован
                          (повторный Stop идемпотентен — no-op, §6.7 п.5)
```

Переход: после подтверждения → бейдж патчится `⟳ running` → `⏹ stopped` по `run.status` (кросс-фейд, без reload), экран = §5.C.12.

---

### 5.E. Экран батча

Назначение: агрегат `Batch` (spec §6.4.1) — прогресс по стадиям, частичные сбои, дозавершение после рестарта. Данные: группировка runs по `execution_stage` (`run-planner.ts:392`), один `batch_id` (`:359`), `state` из `run_queue` (§5.8). Real-time — `GET /api/batches/:id/stream` (`batch.progress`/`stage.update`/`run.status`). Primary действия: `Retry failed`, `Stop remaining`, `Дозавершить`.

#### 5.E.1 Батч идёт по стадиям (default/running)

```
┌─ BATCH b_8f3a · Run folder /payouts · started by anna · 12:04 ───────────[ ⋯ ]─┐
│ Progress ▓▓▓▓▓▓▓▓░░░░░░  7/12 done · 2 running · 3 queued · 0 failed             │
│ Состояние: ⟳ выполняется   ·   стадий 3   ·   ETA ~6 мин                        │
│────────────────────────────────────────────────────────────────────────────────│
│ STAGE 1  ✔ done (4/4)                                                            │
│   ✔ withdraw·1   ✔ withdraw·2   ✔ deposit·1   ✔ deposit·2                       │
│ STAGE 2  ⟳ running (2/4)                                            ◀ здесь      │
│   ⟳ kyc·1 (execute 0:31)   ⟳ kyc·2 (pull 0:48)   ⋯ kyc·3 (queued pos1)          │
│   ⋯ kyc·4 (waiting · workers свободно: 0)                                        │
│ STAGE 3  ○ waiting for stage 2                                                   │
│   ○ refund·1   ○ refund·2   ○ refund·3   ○ refund·4                             │
│────────────────────────────────────────────────────────────────────────────────│
│ [ Retry failed (0) ✕ ]   [ ⏹ Stop remaining ]   [ Open as table ]              │
└──────────────────────────────────────────────────────────────────────────────────┘
   Каждый чип кликабелен → страница прогона §5.C соответствующей фазы.
   «◀ здесь» = активная стадия; sub-фаза каждого running-чипа из run.phase.
```

#### 5.E.2 Батч частично упал (partial)

Данные: терминальные стадии с миксом passed/failed → агрегат `partial` (spec §6.4.1). `Retry failed (N)` активна: выбирает `failed/error`, retry тем же `runtime_snapshot` и тем же `batch_id`, сохраняя `execution_stage` (spec §6.4.3; чинит `app.ts:792-811`, где retry терял `batch_id`).

```
┌─ BATCH b_8f3a · Run folder /payouts · started by anna · 12:04 ───────────[ ⋯ ]─┐
│ Progress ▓▓▓▓▓▓▓▓▓▓▓░  11/12 терм. · 9 ✔ · 1 ✖ · 1 ⚠                            │
│ Состояние: ⚠ частично упал   (есть passed и failed — partial)                   │
│────────────────────────────────────────────────────────────────────────────────│
│ STAGE 1  ✔ done (4/4)    ✔ withdraw·1 ✔ withdraw·2 ✔ deposit·1 ✔ deposit·2     │
│ STAGE 2  ⚠ partial (3/4) ✔ kyc·1  ✖ kyc·2 (assertion)  ✔ kyc·3  ⚠ kyc·4(docker)│
│   └ ✖ kyc·2: failed · exit 1 · [open →]      ⚠ kyc·4: error · docker [open →]   │
│ STAGE 3  ⟳ running (1/4) ⟳ refund·1 (execute)  ⋯ refund·2  ⋯ refund·3  ⋯ refund·4│
│────────────────────────────────────────────────────────────────────────────────│
│ [ Retry failed (2) ]   [ ⏹ Stop remaining ]   [ Open as table ]                │
│   Retry failed → 2 новых run, тот же batch_id b_8f3a, snapshot переиспользован  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.E.3 Батч восстановлен после рестарта (resume / «Дозавершить»)

Данные: batch-aware `recoverInterruptedRuns` (spec §6.4.2): висящие строки финализированы как `interrupted`, незапущенные стадии K+1 не доехали. Кнопка `Дозавершить незавершённые (N)` ставит их обратно в `run_queue` (требует персистентной очереди §5.8).

```
┌─ BATCH b_8f3a · Run folder /payouts · started by anna · 12:04 ───────────[ ⋯ ]─┐
│ Progress ▓▓▓▓▓▓░░░░░░░  6/12 терм. · 5 ✔ · 1 ⚠ interrupted · 6 не стартовали    │
│ Состояние: ⚠ прерван перезапуском сервера   (resumable)                         │
│────────────────────────────────────────────────────────────────────────────────│
│ STAGE 1  ✔ done (4/4)         ✔ withdraw·1 ✔ withdraw·2 ✔ deposit·1 ✔ deposit·2│
│ STAGE 2  ⚠ interrupted (1/4)  ✔ kyc·1  ⚠ kyc·2(interrupted)  ◌ kyc·3  ◌ kyc·4  │
│   └ ◌ kyc·3, kyc·4 — не стартовали (сервер перезапускался)                       │
│ STAGE 3  ◌ не стартовала (0/4) — стадия не доехала                              │
│────────────────────────────────────────────────────────────────────────────────│
│ ┌──────────────────────────────────────────────────────────────────────────────┐│
│ │ ⚠ Сервер был перезапущен. 6 прогонов в 2 стадиях не завершены.                ││
│ │   [ ▶ Дозавершить незавершённые (6) ]   ← повторно ставит в очередь (§6.4.2)  ││
│ └──────────────────────────────────────────────────────────────────────────────┘│
│ [ Retry failed (1) ]   [ ⏹ Stop remaining ]   [ Open as table ]                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.E.4 Батч loading / empty / завершён / остановлен

```
LOADING (skeleton до batch.progress):
┌─ BATCH ▦▦▦▦▦ · ▦▦▦▦▦▦▦▦▦▦ ───────────────────────────────────────────[ ⋯ ]─┐
│ Progress ▦▦▦▦▦▦▦▦▦▦▦▦▦▦  ▦/▦▦  (shimmer)                                       │
│ STAGE 1  ▦▦▦▦▦▦   ▦▦▦▦ ▦▦▦▦ ▦▦▦▦                                              │
│ STAGE 2  ▦▦▦▦▦▦   ▦▦▦▦ ▦▦▦▦                                                   │
└──────────────────────────────────────────────────────────────────────────────────┘

ЗАВЕРШЁН (done, все passed):
│ Progress ▓▓▓▓▓▓▓▓▓▓▓▓  12/12 done · 12 ✔ · 0 ✖                                  │
│ Состояние: ✔ завершён · 12/12 · общее время 6:12                               │
│ [ Retry failed (0) ✕ ]   [ Open as table ]   (Stop remaining скрыт — нечего)   │

ОСТАНОВЛЕН (cancelled, после Stop remaining):
│ Progress ▓▓▓▓▓░░░░░░░░  5 ✔ · 7 ⏹ cancelled                                    │
│ Состояние: ⏹ остановлен · anna · 12:09   (queued→cancelled, running→killed)    │
│ [ Retry failed (0) ✕ ]   [ Open as table ]                                     │
```

Stop remaining (ConfirmDialog §3.18, масштаб): «Остановить оставшиеся 7 прогонов батча в проекте Payments? Идущие — kill, в очереди — отмена.» (spec §6.7 п.5).

---

### 5.F. Retry-флоу и его прозрачность

Назначение: показать, что именно переиспользуется. Load-bearing факт из кода: `prepareScenarioRunPlan` принимает `runtime_snapshot` и кладёт его целиком (`run-planner.ts:306`: `options.runtime_snapshot ?? {...}`), `retry_of_run_id` (`:291`), `batch_id` (`:292`) — отдельные поля. Значит при retry `pools` (с `value`, `item_id`, trace_id) и `server` (account_login/merchant_name) НЕ перегенерируются. Новый `run.id` (`:280`), но trace_id из снимка тот же (spec §6.1 факт 4). CTA = `▶ Запустить retry`.

#### 5.F.1 Diff «что повторяем» (default)

```
┌─ RETRY · withdraw-flow · из r_5c1a (✖ failed) ─────────────────────[ ✕ ]───────┐
│  Повтор тем же снимком runtime_snapshot — НЕ перегенерируем недетерминир. данные│
│────────────────────────────────────────────────────────────────────────────────│
│  ПЕРЕИСПОЛЬЗУЕМ (из runtime_snapshot, без изменений)                            │
│   = trace_id            0x…ae3  (тот же — НЕ регенерится)                        │
│   = {address}           0x9f…ae3  pool eth-addr · item itm_77 (тот же item)     │
│   = server.account_login stand-admin     = server.merchant_name ACME           │
│   = pool_selections     address → eth-addr (auto зафиксирован в item_77)        │
│   = inputs              amount 100 · currency USDT                               │
│────────────────────────────────────────────────────────────────────────────────│
│  НОВОЕ (создаётся для retry)                                                     │
│   + run.id              r_5c1a → r_8e44 (новый)                                  │
│   + retry_of_run_id     r_5c1a                                                   │
│   + batch_id            b_8f3a (тот же — остаётся в батче, §6.4.3)               │
│   + 🔐 server_2faotp    перечитан из credential по version (свежий код at run)  │
│   + статус/таймлайн     с нуля                                                   │
│────────────────────────────────────────────────────────────────────────────────│
│  ⓘ Секрет берётся заново из credential stand-admin (credential_version 1),      │
│     plaintext в истории старого run не используется (§8.6).                      │
│                                  [ Отмена ]   [ ▶ Запустить retry ]             │
└──────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.F.2 Retry — состояние «credential изменился с момента оригинала»

Если `stand_credentials.version` вырос (значение секрета перевводилось) — честно показываем, что код будет от новой версии. Не ошибка, но прозрачность.

```
│  НОВОЕ (создаётся для retry)                                                     │
│   + 🔐 server_2faotp    ⚠ credential_version 1 → 2 (секрет перевводился после   │
│                            оригинала) — retry возьмёт текущую версию             │
│   = trace_id / {address} / inputs  — без изменений                              │
```

#### 5.F.3 Retry — состояние «секрет требует повторного ввода» (потеря KEK, блок)

`stand_credentials.needs_reentry=1` (spec §8.6): retry невозможен честным образом, код `secret_kek_lost`.

```
┌─ RETRY · withdraw-flow · из r_5c1a ────────────────────────────────[ ✕ ]───────┐
│  ✖ Невозможно повторить: secret_kek_lost                                         │
│     credential stand-admin помечен ⚠ «требует повторного ввода» (потеря KEK).    │
│     {server_password}/{server_2faotp} нечитаемы — перевведите значения.          │
│     [ Открыть credential stand-admin → ]                                         │
│                                  [ Закрыть ]   [ ▶ Запустить retry ] (✕ disabled)│
└──────────────────────────────────────────────────────────────────────────────────┘
```

Переход: `▶ Запустить retry` → `POST /api/runs/:id/retry` → новый run → §5.C (queued). На батче — §5.E.2 `Retry failed (N)` запускает 5.F-логику пакетно (без диалога на каждый, сводка одним тостом).

---

### 5.G. NotificationCenter / счётчик running в шапке

Назначение: глобальные real-time индикаторы, видны с любой страницы (spec §4.2). Один SSE-канал `GET /api/stream/execution` (`queue.update`/`worker.update`/`run.status`). Счётчик `[▶N running]` патчится без reload; `[🔔M]` — терминальные/упавшие события.

#### 5.G.1 Свёрнут (в шапке)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright   Payments ▸ Runs           [ ▶3 running ][ 🔔2 ][ 🌐RU ][anna▾]│
└──────────────────────────────────────────────────────────────────────────────────┘
   [▶3 running] — живой счётчик из workers/run_queue (§5.8); клик → §7.2 RUNNING NOW
   [🔔2] — непрочитанные события (failed/error/done); пульс точки при новом событии
```

#### 5.G.2 Развёрнут (список событий)

Данные: события из `run.status {terminal}` по проектам, доступным пользователю (scope-гард `?pid=`; admin — cross-project, spec §5.4). Клик по событию → §5.C соответствующего run.

```
[🔔2]→┌─ Уведомления ──────────────────────────────────────────────┐
      │ ⏵ Сейчас идут (3)                                           │
      │   ⟳ withdraw-flow  execute 0:42   Payments        [open →] │
      │   ⟳ deposit-card   pull 0:50      Payments        [open →] │
      │   ⟳ kyc·1          queued pos1    Withdrawals     [open →] │
      │ ───────────────────────────────────────────────────────── │
      │ ⏺ События                                                  │
      │ ● ✖ deposit·2      failed (assertion)  12:01  Pay  [open →]│ непрочит.
      │ ● ⚠ kyc-flow       error (docker pull) 11:48  Pay  [open →]│ непрочит.
      │   ✔ batch b_8f3a   done 12/12          11:30  Pay  [open →]│
      │ ───────────────────────────────────────────────────────── │
      │                                     [ отметить все прочит. ]│
      └────────────────────────────────────────────────────────────┘
```

#### 5.G.3 Состояния NotificationCenter (loading / empty / disconnected)

```
LOADING (до первого снапшота execution-стрима):
[🔔]→┌─ Уведомления ──────────────────┐
     │ ⏵ Сейчас идут                   │
     │   ▦▦▦▦▦▦▦▦▦▦▦  ▦▦▦▦             │ (shimmer)
     │   ▦▦▦▦▦▦▦      ▦▦▦▦             │
     └─────────────────────────────────┘

EMPTY (ничего не идёт, событий нет):
[🔔]→┌─ Уведомления ──────────────────┐
     │            ⊙                    │
     │   Пока тихо — нет активных       │
     │   прогонов и новых событий       │
     │   [ ▶ Запустить сценарий ]       │ ← CTA, не тупик (§4.5)
     └─────────────────────────────────┘

DISCONNECTED (execution-стрим оборван):
[🔔⚠]→┌─ Уведомления ─────────────────┐
      │ ⚠ нет связи — счётчики могли    │
      │   устареть · переподключение…   │
      │   last-known: ▶3 · 🔔2          │
      │   [ переподключить ]            │
      └────────────────────────────────┘
```

Счётчик `[▶N]` при обрыве показывает last-known с маркером `⚠` рядом (не обнуляется молча). Фолбэк — poll `/api/stream/execution`-эквивалент 3-5с (spec §5.4), тоже точечный патч.

---

### Сводка привязок этого раздела к коду

- Фазы/Timeline: `execute.ts:81` (prepare+drift `:84-91`), `:463-484` (pull, SKIPPED при кеше `:469-472`), `:98/:340` (create, транспорт `:372-378`), `:414` (execute), `:567-568` (collecting), `:557-585` (finalize/done).
- Статус-контракт: `finalizeExecution` (`execute.ts:570`); timeout — `:407-412,431`; error-сообщения — `:487`, `:682`, `:691`.
- Очередь/позиция/воркеры/`Дозавершить`: `run_queue`/`workers` (spec §5.8), вместо `queueMicrotask`.
- Stop: реестр процессов + `AbortSignal` + `ts-playwright-run-<runId>` (spec §6.7; заменяет `Date.now()`-имя `execute.ts:339`).
- Retry-снимок: `runtime_snapshot` (`run-planner.ts:306`), `retry_of_run_id` (`:291`), `batch_id` (`:292`); pool-снимок `:445-458`; queued-лог `:1253-1262`.
- Wizard-резолв: `resolveSelectedBaseData` (`run-planner.ts:995-1004`, правится на project-scope); ошибки `server_*_required` `:1062/1070/1074/1080`; ёмкость пула `:524/:541`; параметры `amount_times_to_run :275`/`execution_stage :274`/`parallel_batch_size :377,392`/`default_timeout_ms :277`.
- SSE/NotificationCenter: эндпоинты и события — spec §5.4; глобальный канал `/api/stream/execution`.

Все токены §2, компоненты §3 (StatusBadge, PhaseTimeline, LiveLogConsole, Wizard, ProgressBar, Tabs, Toast/NotificationCenter, ConfirmDialog, Skeleton/EmptyState/ErrorState, Button) и конвенции §4 применены единообразно во всех моках выше.

---

## 7. Кабинет проекта: credentials, merchants, pools, окружения, переменные, доступность стенда


---

### 7.7.1. Назначение и место в навигации

Кабинет проекта — это группа из пяти project-scoped вкладок под `/p/:pid/*`, где живут все данные стендов, которые подставляются в `{server_*}`-плейсхолдеры сценариев: Credentials, Merchants, Pools, Environments, Project Variables. Граница изоляции — `project_id` (spec §2.2). Все секреты — write-only (spec §4.2, §8.6): API/DOM отдают только `has_password`/`has_totp`, никогда значение (чинит `html.ts:458-460`, где `input.value = account.password`).

Вкладки кабинета (общая шапка для всех экранов 7.7.x):

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright   ● Payments ▸ Credentials         [▶3 running][🔔1][ru▾][a▾]│
├───────────────┬──────────────────────────────────────────────────────────────┤
│ ┌───────────┐ │  [ Credentials ]·[ Merchants ]·[ Pools ]·[ Environments ]·     │
│ │▸Payments ▾│ │  [ Project Variables ]                                         │
│ └───────────┘ │   ▔▔▔▔▔▔▔▔▔▔▔▔  active (--accent кант снизу, Tabs §3.9)         │
│ ПРОЕКТ         │                                                                │
│   Обзор        │   (контент вкладки — ниже, экраны 7.7.1…7.7.5)                 │
│   Сценарии     │                                                                │
│   Прогоны      │                                                                │
│ ДАННЫЕ СТЕНДА  │   ● = точка --project-accent (§2.8) в крошке — проект виден    │
│ ▸ Credentials  │       в КАЖДОЙ крошке (защита от путаницы, spec §2.4)          │
│   Merchants    │                                                                │
│   Pools        │                                                                │
│   Окружения •  │                                                                │
│   Переменные   │                                                                │
│ ──────────     │                                                                │
│   Настройки    │   • Окружения = есть «Проверить доступность стенда» (7.7.6)    │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

Данные в моках ниже взяты из реального хранилища: `storage/accounts.json` (один credential `botuser1`, пароль `botuser1`, TOTP-секрет `PNYTA2LU…J2KFZ2A` — валидный base32), `storage/merchants.json` (три мерчанта `botmerch1205 (1205)`, `merchantbot (b001)`, `MaxMerchStage (Max)` — у **всех** `admin_login=null`).

---

### 7.7.1. Credentials проекта (write-only, дом 2FA стендов)

**Назначение (1 строка):** учётки тестируемых стендов проекта — источник `{server_username/password/2faotp}` (spec §7.7a, §8.3); секреты write-only, генерация on-demand TOTP-кода без раскрытия секрета.

- **Primary-CTA:** `[ + Добавить ]` (создать credential).
- **На строке:** `[Код]` (on-demand TOTP, admin-only) + `[⋯]` overflow.
- **Overflow `⋯` строки:** Редактировать · Проверить TOTP · Дублировать (без секретов) · Где используется → · Удалить.
- **Advanced (в модалке):** «Источник 2FA» (file-based TOTP / on-demand через API / ввод вручную `{{INPUT:2fa_otp}}`, spec §7.7a, §8.1).
- **Данные откуда:** `GET /api/projects/:pid/credentials` → `stand_credentials` (DDL §9.1 D); поля `login`, `has_password` (из `password_enc`), `has_totp`+`totp_valid` (из `totp_secret_enc`, валидность через `normalizeTotpSecret`, `otp.ts:9-20`), `version`, `needs_reentry`, `updated_at`. `[Код]` → `POST /api/projects/:pid/credentials/:cid/code` → `generateTotpCodeSafeDetails` (`otp.ts:54-88`) → `{code, expires_in_sec}` без секрета (spec §8.3, §8.5).
- **Переходы:** строка/Редактировать → модалка credential; `[Код]` → поповер с кодом+таймером; «Где используется» → список merchants/runs, ссылающихся на credential; Удалить → ConfirmDialog (§3.18).

### Состояние: список (есть credentials, реальные данные)

```
┌─ Payments · Credentials ───────────────────────────────────[ + Добавить ]─────┐
│  Учётки тестируемых стендов → {server_username} {server_password} {server_2faotp}│
│  🔍[ поиск по login… ]                                                          │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ Имя         │ Login   │ Password │ 2FA / TOTP        │ Обновлён │           ││
│ │─────────────┼─────────┼──────────┼───────────────────┼──────────┼───────────││
│ │ 🔑 botuser1 │ b***r1  │ ● set    │ ● set · ✓ base32  │ 12.05    │ [Код][⋯] ││ ← строка
│ │ 🔑 stand-ops│ o***s   │ ● set    │ ○ not set         │ вчера    │ [Код][⋯] ││   кликаб.
│ └────────────────────────────────────────────────────────────────────────────┘│
│  2 учётки · 🔐 1 с 2FA · 🔑 = KeyRound (§4.1)                                   │
└────────────────────────────────────────────────────────────────────────────────┘
```
- `b***r1` — маскировка login в таблице тоже (показ полностью только в модалке редактирования). Бейджи `● set`/`○ not set` — StatusBadge secret (§3.1), значение никогда не в DOM.
- `✓ base32` — бейдж валидности TOTP-секрета (синхронный `normalizeTotpSecret`, `otp.ts:9-20`); если секрет в БД перестал быть валидным (миграция/порча) — `✖ не base32` янтарным.

### Состояние: пусто (нет credentials)

```
┌─ Payments · Credentials ───────────────────────────────────[ + Добавить ]─────┐
│  Учётки тестируемых стендов → {server_username} {server_password} {server_2faotp}│
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │                              🔑                                              ││
│ │                  Пока нет учётных данных стенда                              ││
│ │     Добавьте учётку, чтобы сценарии могли подставлять {server_username},     ││
│ │              {server_password} и генерировать {server_2faotp}.               ││
│ │                          [ + Добавить учётку ]                              ││ ← CTA, не тупик
│ └────────────────────────────────────────────────────────────────────────────┘│
│  ⓘ Без учётки server_*-плейсхолдеры не резолвятся (см. Project Variables →)     │
└────────────────────────────────────────────────────────────────────────────────┘
```
EmptyState (§3.12) ведёт к действию + связывает с экраном Variables (7.7.5).

### Состояние: loading (skeleton)

```
┌─ Payments · Credentials ───────────────────────────────────[ + Добавить ]─────┐
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ ▦▦▦▦▦▦▦▦   ▦▦▦▦▦   ▦▦▦▦▦   ▦▦▦▦▦▦▦▦▦▦▦   ▦▦▦▦   ▦▦▦▦                        ││
│ │ ▦▦▦▦▦▦     ▦▦▦▦    ▦▦▦▦    ▦▦▦▦▦▦▦       ▦▦▦▦   ▦▦▦▦   (shimmer §5.4)        ││
│ └────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```

### Состояние: модалка создания/редактирования (WRITE-ONLY)

```
┌─ Credential · Payments ──────────────────────────────────────────────[ ✕ ]────┐
│ Имя*        [ botuser1                    ]  Уникально в проекте                │
│ Login*      [ botuser1                    ]  → {server_username}                │
│─────────────────────────────────────────────────────────────────────────────────│
│ Password         [ ●●●●●●●●  ● set ]  [ Заменить ]   → {server_password}        │ ← значение
│                  значение не загружается (write-only)                           │   НЕ грузится
│ TOTP secret /2FA [ ●●●●●●●●  ● set · ✓ base32 ]  [ Заменить ]  → {server_2faotp}│
│                  ▸ Источник 2FA (Advanced)                                      │
│─────────────────────────────────────────────────────────────────────────────────│
│ [ Сгенерировать тестовый код ]    ← показывает только код+expires, без секрета  │
│─────────────────────────────────────────────────────────────────────────────────│
│                                            [ Отмена ]   [ Сохранить ]           │ ← primary справа
└────────────────────────────────────────────────────────────────────────────────┘
```
- При создании поля Password/TOTP начинают как `○ not set [ Задать… ]`. При редактировании — `● set [ Заменить ]`; клик «Заменить» открывает ПУСТОЕ поле ввода (старое значение не показывается и не приходит с сервера, spec §4.6, §8.6). Без клика «Заменить» секрет не трогается на сохранении (PATCH без поля = «не менять»).

### Состояние: модалка с раскрытым Advanced (Источник 2FA)

```
│ TOTP secret /2FA [ ●●●●●●●●  ● set · ✓ base32 ]  [ Заменить ]  → {server_2faotp}│
│   ▾ Источник 2FA (Advanced):                                                    │
│     ◉ TOTP-секрет (base32, код генерится в контейнере at run)  ← по умолчанию   │
│     ○ On-demand код через API при запуске                                       │
│     ○ Ввод кода вручную в Run-wizard  ({{INPUT:2fa_otp}})                       │
│     ⓘ NTP-коррекция применяется к коду (liveTotp); дрейф часов ломает 2FA молча │
```
Собирает три способа 2FA (spec §8.1 пути a/b/c) в один выбор, чтобы их нельзя было перепутать.

### Состояние: ввод TOTP-секрета + бейдж валидности (онлайн)

Валидный base32 (как реальный `PNYTA2LU…`):
```
│ TOTP secret  [ PNYTA2LUPEYUISB6NNCF2L3VHFLG…  ]  ● валидный · base32           │ ← зелёный
│              значение скрыто после сохранения (write-only)                      │
```

Ошибка «не base32» (вместо `alert(сырой текст)`, spec §8.5):
```
│ TOTP secret  [ secret-with-0-and-1!!!        ]  ✖ не base32                     │ ← --status-failed-fg
│              ⚠ Допустимы только символы A–Z и 2–7 (RFC base32).                 │ ← FormField error (§3.14)
│                                            [ Отмена ]   [ Сохранить ⊘ ]         │ ← disabled пока невалидно
```
Проверка синхронная на клиенте через ту же `decodeBase32`/`normalizeTotpSecret` (`otp.ts:9-20,186-201`), Zod-resolver (§1) — Сохранить заблокировано.

### Состояние: «Сгенерировать тестовый код» — поповер (код + expires, БЕЗ секрета)

```
[ Сгенерировать тестовый код ] →
   ┌─ Тестовый TOTP-код · botuser1 ────────────────┐
   │   8 4 1 7 9 2        ⧉ копировать              │ ← mono, --text-xl
   │   ▓▓▓▓▓▓▓▓▓▓░░░  действителен ещё 21с           │ ← ProgressBar (§3.16), тикает (§4.2)
   │   ⓘ Секрет не показывается. NTP-коррекция учтена.│
   │                                  [ Обновить ]   │
   └────────────────────────────────────────────────┘
```
- Источник: `POST /api/projects/:pid/credentials/:cid/code` → `generateTotpCodeSafeDetails(secret)` (`otp.ts:54-88`) возвращает `{code, expires_in_sec, period}` — **секрет в ответе отсутствует** (spec §8.3, §8.5). Admin-only, audit `credential.totp_code_issued` с `project_id`.
- Таймер `expires_in_sec` тикает на клиенте (requestAnimationFrame, §4.2); по нулю — авто-`Обновить` или показ «истёк». Код mono (§2.4). Копирование — clipboard, но **секрет туда не попадает** (§4.6).

### Состояние: error загрузки списка

```
┌─ Payments · Credentials ───────────────────────────────────[ + Добавить ]─────┐
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │   ⚠ Не удалось загрузить учётные данные                                      ││
│ │   server_unreachable                                  ← code→t() (spec §3.3) ││
│ │   [ Повторить ]   [ подробнее ]                                             ││
│ └────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```

### Состояние: needs re-entry (потеря KEK, spec §8.6)

```
│ │ 🔑 botuser1 │ b***r1  │ ⚠ требует    │ ⚠ требует         │ 12.05    │ [Ввести]││
│ │             │         │   ввода      │   ввода           │          │   [⋯]   ││
│ └────────────────────────────────────────────────────────────────────────────┘│
│ ⚠ KEK недоступен (secret_kek_lost). Секреты нечитаемы — перевведите значения.   │ ← баннер
│   Прогоны с этими учётками падают error · secret_kek_lost (не молча).           │
```
`needs_reentry=1` → бейдж `⚠ требует ввода` (StatusBadge secret needs re-entry, §3.1), `[Ввести]` открывает модалку с пустыми полями. Это переносит риск из «тихая невосстановимость» в «явный re-entry» (spec §8.6).

---

### 7.7.2. Merchants проекта (привязка admin-credential, env-allowlist)

**Назначение (1 строка):** мерчанты проекта — источник `{server_merchant}`; опциональная привязка `admin_credential_id` того же проекта даёт цепочку merchant→admin для резолва server_* (spec §7.7b, §9.2, §9.3).

- **Primary-CTA:** `[ + Merchant ]`.
- **На строке:** `[⋯]` overflow.
- **Overflow `⋯`:** Редактировать · Привязать админа · Env-allowlist · Удалить.
- **Advanced (в модалке):** env-allowlist (пусто = любое окружение, `merchants.env_ids`, runtime-cabinet «env_ids»).
- **Данные откуда:** `GET /api/projects/:pid/merchants` → `merchants` (DDL §9.1 E); поля `name` (`{server_merchant}`), `admin_credential_id` (FK на `stand_credentials` того же проекта, триггер `trg_merchant_admin_same_project`), `merchant_environments` (env-allowlist). Сегодня в `storage/merchants.json` у всех трёх `admin_login=null` — цепочка merchant→admin не существует, проставляется здесь вручную (spec §9.3 п.4, §9.2 пример B).
- **Переходы:** «Привязать админа» → модалка с селектом credentials проекта; имя credential → Credentials (7.7.1).

### Состояние: список (реальные мерчанты, admin не привязан)

```
┌─ Payments · Merchants ────────────────────────────────────[ + Merchant ]──────┐
│  Мерчанты → {server_merchant}. Привязка админа даёт цепочку merchant→admin.    │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ 🏪 Name              │ {server_merchant} │ Admin credential │ Env-allowlist  ││
│ │──────────────────────┼───────────────────┼──────────────────┼────────────────││
│ │ botmerch1205 (1205)  │ botmerch1205 (1205)│ ⚠ не привязан    │ staging      ⋯││
│ │ merchantbot (b001)   │ merchantbot (b001) │ ⚠ не привязан    │ любое        ⋯││
│ │ MaxMerchStage (Max)  │ MaxMerchStage (Max)│ ⚠ не привязан    │ любое        ⋯││
│ └────────────────────────────────────────────────────────────────────────────┘│
│ ⚠ Ни у одного мерчанта не привязан admin-credential → выбор мерчанта НЕ        │ ← предупреждение
│   резолвит {server_username/password/2faotp}. Подставится только {server_merchant}.│  (см. ниже)
│   Чтобы цепочка merchant→admin работала: ⋯ → «Привязать админа».               │
└────────────────────────────────────────────────────────────────────────────────┘
```
- `🏪` = Store (§4.1). `⚠ не привязан` (янтарный) — ключевой сигнал: без `admin_credential_id` мерчант даёт ТОЛЬКО `{server_merchant}`, а `{server_*}`-секреты не резолвятся через него (spec §9.2 пример A: `merchantAdmin=null`). Это точное отражение реальных данных.
- Env-allowlist «любое» = пустой `env_ids` (runtime-cabinet: «Empty means the merchant can be used in any environment»).

### Состояние: список (admin привязан — после пост-сегрегации §9.3 п.4)

```
│ │ MaxMerchStage (Max)  │ MaxMerchStage (Max)│ 🔑 botuser1 ✓    │ любое        ⋯││ ← зелёная галка
│ └────────────────────────────────────────────────────────────────────────────┘│
│ ✓ MaxMerchStage привязан к botuser1 — выбор мерчанта резолвит server_* через    │
│   админа (пример B, §9.2): {server_username/password/2faotp} = botuser1.        │
```

### Состояние: пусто

```
┌─ Payments · Merchants ────────────────────────────────────[ + Merchant ]──────┐
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │                              🏪                                              ││
│ │                     Пока нет мерчантов                                       ││
│ │       Мерчант задаёт {server_merchant} и может ссылаться на учётку-админа.   ││
│ │                          [ + Добавить мерчанта ]                            ││
│ └────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```

### Состояние: loading (skeleton)

```
│ │ ▦▦▦▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦▦   ▦▦▦▦▦                                     ││
│ │ ▦▦▦▦▦▦▦▦     ▦▦▦▦▦▦     ▦▦▦▦▦     ▦▦▦▦   (shimmer §5.4)                       ││
```

### Состояние: модалка merchant + «Привязать админа»

```
┌─ Merchant · Payments ────────────────────────────────────────────────[ ✕ ]────┐
│ Name*           [ MaxMerchStage (Max)       ]  → {server_merchant}             │
│─────────────────────────────────────────────────────────────────────────────────│
│ Admin credential  [ — не привязан —            ▾ ]   ← селект credentials ПРОЕКТА│
│                   ┌──────────────────────────────┐                             │
│                   │ — не привязан —              │  (цепочка merchant→admin off)│
│                   │ 🔑 botuser1   pwd●  2FA●     │  ← только credentials Payments│
│                   │ 🔑 stand-ops  pwd●  2FA○     │                             │
│                   └──────────────────────────────┘                             │
│   ⓘ Только учётки этого проекта (триггер trg_merchant_admin_same_project, §9.1).│
│─────────────────────────────────────────────────────────────────────────────────│
│ Env-allowlist (Advanced)  ☑ staging  ☐ prod    (пусто = любое окружение)        │
│─────────────────────────────────────────────────────────────────────────────────│
│                                            [ Отмена ]   [ Сохранить ]           │
└────────────────────────────────────────────────────────────────────────────────┘
```
- Селект admin-credential показывает только credentials текущего проекта с бейджами `pwd●`/`2FA●` (что именно резолвится через эту цепочку). Привязка к credential чужого проекта невозможна (триггер §9.1 E + project-scoped запрос).

### Состояние: предупреждение в Run-wizard (если admin не привязан — последствие на месте запуска)

Связь с экраном запуска: когда выбран мерчант без admin, предпросмотр подстановки (spec §7.6 шаг 2) честно показывает дыру:
```
│ MERCHANT  [ MaxMerchStage (Max) ▾ ]  → {server_merchant}=MaxMerchStage (Max)   │
│ ⚠ У мерчанта нет привязанного админа → {server_username/password/2faotp} НЕ     │
│   резолвятся через мерчанта. Выберите STAND CREDENTIAL напрямую.   [Привязать →]│
```

### Состояние: error загрузки

```
│ │   ⚠ Не удалось загрузить мерчантов                                           ││
│ │   server_unreachable                       [ Повторить ]   [ подробнее ]    ││
```

---

### 7.7.3. Pools и PoolItems

**Назначение (1 строка):** пулы переиспользуемых runtime-значений (адреса/trace_id/произвольные) и их элементы; источник `{address}`/`{trace_id}` и т.п. через стратегию аллокации (spec §7.7b, runtime-cabinet «Pools»/«Pool Items»).

- **Primary-CTA (список пулов):** `[ + Pool ]`. Рядом — `[ Bulk import ⤓ ]` (поднятый `import-run-outputs`, spec §7.7b).
- **На строке пула:** `[⋯]` overflow.
- **Overflow `⋯` пула:** Items… · Fetch info · Import run outputs · Auto-import rules · Дублировать · Удалить.
- **Advanced (модалка пула):** template (для `trace_id`), fetch_* поля, auto_import_* поля, dedupe.
- **Primary-CTA (внутри пула):** `[ + Item ]`. Рядом — `[ Fetch info ]`, `[ Add from run ]`.
- **Данные откуда:** `GET /api/projects/:pid/pools` → `pools` (DDL §9.1 H, `project_id` NOT NULL); `kind ∈ {deposit_address, payout_address, trace_id, custom}` (`PoolKindSchema`, `schemas.ts:101`); `allocation_strategy ∈ {manual, first_enabled, round_robin, random, template}` (`PoolAllocationStrategySchema`, `schemas.ts:103`). Items: `GET /api/pools/:poolId/items` → `pool_items` (`value/label/enabled/currency/network/source/last_fetched_at/last_fetch_status`, `schemas.ts:133-147`). Fetch: `POST /api/pools/:poolId/fetch`. Dedupe: `pools.dedupe` (runtime-cabinet «dedupe»).
- **Переходы:** строка пула → элементы пула; «Fetch info» → запускает `fetch_scenario_id`; «Add from run» → `POST /api/runs/:rid/outputs/:key/add-to-pool`.

### Список пулов: разные kind (default)

```
┌─ Payments · Pools ──────────────────────────[ + Pool ]  [ Bulk import ⤓ ]──────┐
│  🔍[ поиск… ]   фильтр: [deposit][payout][trace_id][custom]                     │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ Name        │ Kind            │ Strategy      │ Free/Used │ Dedupe │         ││
│ │─────────────┼─────────────────┼───────────────┼───────────┼────────┼─────────││
│ │ 💾 eth-addr │ 🏦 deposit_addr │ random        │ 412 / 88  │ ✓ on   │   ⋯    ││ ← Wallet
│ │ 💾 payouts  │ 🏦 payout_addr  │ first_enabled │ 7 / 401   │ ✓ on   │   ⋯    ││
│ │ #️⃣ trace    │ #️⃣ trace_id    │ template      │ — / —     │ ✓ on   │   ⋯    ││ ← Hash
│ │ {} amounts  │ {} custom       │ manual        │ 0 / 0     │ ✗ off  │   ⋯    ││ ← Braces
│ └────────────────────────────────────────────────────────────────────────────┘│
│  4 пула · иконки kind §4.1 (Wallet/Hash/Braces)                                │
└────────────────────────────────────────────────────────────────────────────────┘
```
- `Free/Used` — enabled-незатронутые / использованные items. Для `template`-пула items не хранятся → `— / —` (значение генерится из template, runtime-cabinet «template: generate value from template»).
- Бейдж `Dedupe` отражает `pools.dedupe`.

### Список пулов: loading (skeleton)

```
│ │ ▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦   ▦▦▦▦   (shimmer §5.4)            ││
│ │ ▦▦▦▦▦▦     ▦▦▦▦▦▦▦▦     ▦▦▦▦▦▦     ▦▦▦▦     ▦▦▦▦                              ││
```

### Список пулов: пусто

```
│ │                              💾                                              ││
│ │                       Пока нет пулов                                         ││
│ │   Пул — переиспользуемый словарь значений (адреса, trace_id) для сценариев.  ││
│ │              [ + Создать пул ]      [ Bulk import ⤓ ]                        ││
```

### Внутри пула: trace-шаблон (kind=trace_id, strategy=template)

```
┌─ Pool «trace» · trace_id · template ──────────────────────────────────[ ✕ ]──┐
│ Стратегия: template — значение генерируется, items не хранятся.                 │
│ Template:  {date}_{testName}_{seq}        ← runtime-cabinet «Common trace tmpl» │
│ Предпросмотр: 2026-06-28_withdraw-flow_001                                      │
│─────────────────────────────────────────────────────────────────────────────────│
│ Items не применимы для template-пула.                                          │ ← вместо таблицы
│ ⓘ При запуске сценарий получит сгенерированное значение, не выбранный item.     │
│ [ Редактировать template ]                                                     │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Внутри пула: адреса с items (kind=deposit_address, strategy=random)

```
┌─ Pool «eth-addr» · deposit_address · random ────[ + Item ][Fetch info][Add from run]┐
│ 412 свободно · 88 использовано · dedupe ✓   🔍[ поиск value/label… ]            │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ ☐│ Value            │ Label  │ Cur  │ Net   │ On │ Источник     │ Fetched   ││
│ │──┼──────────────────┼────────┼──────┼───────┼────┼──────────────┼────────────││
│ │ ☐│ 0x9f3a…b21c      │ hot-1  │ USDT │ ERC20 │ ✔  │ manual       │ 12:01 ✔   ││
│ │ ☐│ 0x77de…04ff      │ hot-2  │ USDT │ ERC20 │ ✔  │ run_output   │ 11:30 ✔   ││ → source.run_id
│ │ ☐│ 0x12ab…9d10      │ cold   │ USDT │ ERC20 │ ✗  │ fetch_scenario│ ✖ failed  ││ ← disabled
│ └────────────────────────────────────────────────────────────────────────────┘│
│ ☑ выбрано 0   bulk: [Enable][Disable][🗑 Delete]            (BulkBar §3.4)      │
└────────────────────────────────────────────────────────────────────────────────┘
```
- `On` = `enabled` (✔/✗); disabled items хранятся, но не выбираются аллокацией (runtime-cabinet «disabled items remain stored»). `Cur/Net` = `currency`/`network`. `Источник` = `source.type` (manual/run_output/fetch_scenario). `Fetched` = `last_fetched_at` + `last_fetch_status` (бейдж ✔/✖).
- `Add from run` → `POST /api/runs/:rid/outputs/:key/add-to-pool`; `Fetch info` → `POST /api/pools/:poolId/fetch` (запускает `fetch_scenario_id`, отдаёт enabled items как JSON в `fetch_input_name`, runtime-cabinet «Fetch Info»).

### Внутри пула: пустой пул (нет items)

```
┌─ Pool «cold-store» · payout_address · manual ──────────────────[ + Item ]─────┐
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │                              💾                                              ││
│ │                     В пуле нет значений                                      ││
│ │   Добавьте вручную, импортируйте из прогонов или запустите Fetch info.       ││
│ │       [ + Item ]   [ Add from run ]   [ Import run outputs ⤓ ]               ││
│ └────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```

### Внутри пула: исчерпан (все items disabled/использованы)

```
┌─ Pool «eth-addr» · deposit_address · random ──────────────────[ + Item ]──────┐
│ ⚠ Пул исчерпан: 0 свободных enabled-значений (88 использовано, все disabled).  │ ← баннер янтарный
│   Сценарии с auto-аллокацией из этого пула не смогут получить значение.         │
│   [ + Item ]   [ Включить отключённые ]   [ Fetch info ]                        │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ ☐│ 0x9f3a…b21c │ hot-1 │ USDT │ ERC20 │ ✗ │ manual │ used 12:01            ││
│ └────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```
Прямо связано с предпросмотром Run-wizard (spec §7.6 шаг 2: «412 free» → здесь «0 free» блокирует `ensure_right_address`).

### Внутри пула: loading / error

```
loading:  │ ▦▦│ ▦▦▦▦▦▦▦▦▦▦▦▦ │ ▦▦▦▦ │ ▦▦▦▦ │ ▦▦▦▦▦ │ ▦▦ │ ▦▦▦▦▦▦ │ ▦▦▦▦▦  (shimmer)│
error:    │ ⚠ Не удалось загрузить элементы пула · server_unreachable [Повторить]  │
```

### Модалка: Fetch info (запущен)

```
┌─ Fetch info · pool «eth-addr» ───────────────────────────────────────[ ✕ ]───┐
│ Сценарий: payments/payouts/fetch-balances   (fetch_scenario_id)                │
│ Вход:  addresses_json ← 412 enabled items (JSON)   Выход: address_info          │
│ ⟳ выполняется · queued → running · фаза execute 0:18  (live, SSE §4.2)         │
│ ▓▓▓▓▓░░░░  обновлено 0 / 412   [ Открыть прогон → ]   [ Stop ]                  │
└────────────────────────────────────────────────────────────────────────────────┘
```
По `passed` сервер читает `fetch_output_key`, обновляет `metadata`/`last_fetched_at`/`last_fetch_status` сматчившихся items (runtime-cabinet «Fetch Info» шаги 5-6). Real-time через `GET /api/runs/:id/stream`.

### Модалка: Bulk import / Import run outputs (dedupe)

```
┌─ Import run outputs → pool «eth-addr» ────────────────────────────────[ ✕ ]──┐
│ Output key*   [ address          ]   Сценарий (фильтр) [ любой ▾ ]              │
│ Status        ◉ passed  ○ failed  ○ error    Mode ◉ whole  ○ array_items       │
│ JSON path (Advanced)  [ .data[].addr ]                                         │
│ Dedupe: ✓ on → существующие value обновятся, не задвоятся (runtime-cabinet).   │ ← поведение
│                                            [ Отмена ]   [ ▶ Импортировать ]     │
└────────────────────────────────────────────────────────────────────────────────┘
результат → Toast: ✓ Импортировано 37 · обновлено 4 (dedupe) · пропущено 0
```

---

### 7.7.4. Environments проекта

**Назначение (1 строка):** окружения проекта (`base_url` и пр.) — куда целятся прогоны; точка входа «Проверить доступность стенда» (spec §7.7b, §7.8; environment уже project-scoped, `schemas.ts:69-75`).

- **Primary-CTA:** `[ + Environment ]`.
- **На строке:** `[ Проверить ]` (открывает панель 7.7.6) + `[⋯]`.
- **Overflow `⋯`:** Редактировать · Сделать по умолчанию · Где используется → · Удалить.
- **Данные откуда:** `GET /api/projects/:pid/environments` → `environments` (DDL §9.1 F); `name`, `base_url`, `is_default`. Last-known reachability — кэш из `POST /api/environments/:id/reachability` (spec §5.9), показывается чипом.
- **Переходы:** `[ Проверить ]` → панель 7.7.6; «Где используется» → merchants с этим env в allowlist + сценарии.

### Список (default, с last-known чипами)

```
┌─ Payments · Environments ─────────────────────────────────[ + Environment ]───┐
│  Окружения проекта. base_url — цель прогонов. • = «Проверить доступность».      │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ Name    │ base_url                        │ Доступность       │ Default │   ││
│ │─────────┼─────────────────────────────────┼───────────────────┼─────────┼────││
│ │ 🌐 staging│ https://google.com             │ ● 200 · 84ms      │ ★ да    │ ⋯ ││ ← реальн.
│ │ 🌐 prod │ https://prod.stand.internal     │ ⚠ slow · 1.2s     │   нет   │ ⋯ ││   seed
│ │ 🌐 qa   │ https://qa.stand.internal       │ ✖ unreachable     │   нет   │ ⋯ ││
│ │         │                                 │ [ Проверить ]     │         │   ││
│ └────────────────────────────────────────────────────────────────────────────┘│
│  Статусы: ● reachable  ⚠ slow(>1s)  ✖ unreachable  ⓧ TLS  ⓘ Docker↓ (§5.9)    │
└────────────────────────────────────────────────────────────────────────────────┘
```
- `🌐` = Globe (§4.1). Чип доступности — last-known (Reachability §5.9), цвета из `--reach-*` (§2.3). `staging`/`base_url=https://google.com` — реальный seed (`store.ts:103`). `[ Проверить ]` показывается при отсутствии кэша.

### Список: пусто / loading / error

```
пусто:    │ 🌐  Пока нет окружений · Добавьте base_url, чтобы запускать прогоны.   │
          │     [ + Добавить окружение ]                                          │
loading:  │ ▦▦▦▦▦▦▦   ▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦▦   ▦▦▦▦   (shimmer §5.4)           │
error:    │ ⚠ Не удалось загрузить окружения · server_unreachable  [Повторить]    │
```

### Модалка environment

```
┌─ Environment · Payments ─────────────────────────────────────────────[ ✕ ]───┐
│ Name*      [ prod                          ]  Уникально в проекте               │
│ base_url*  [ https://prod.stand.internal   ]  → цель прогонов                   │
│ ☐ Сделать окружением по умолчанию (is_default)                                 │
│ ────────────────────────────────────────────────────────────────────────────  │
│ [ ▶ Проверить доступность ]  ← открывает панель 7.7.6 не закрывая модалку       │
│                                            [ Отмена ]   [ Сохранить ]           │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

### 7.7.5. Project Variables (server_*) — матрица разрешимости

**Назначение (1 строка):** сводная карта, какие `server_*` откуда резолвятся (credential / merchant→admin / ProjectServerVars / произвольные) с предпросмотром резолва на конкретном примере (spec §7.7b, §9.2; агрегат credentials+merchants+`project_server_vars.extra_vars`).

- **Primary-CTA:** `[ + Variable ]` (добавить произвольный `server_*` в `extra_vars_json`).
- **На строке произвольной переменной:** `[⋯]` (Edit/Delete); секретные — write-only (`● set (secret)`).
- **Advanced:** дефолты проекта (`default_stand_credential_id`, `default_merchant_id`) — какие credential/merchant подставляются, если в run не выбраны явно (`project_server_vars`, DDL §9.1 G).
- **Данные откуда:** `GET /api/projects/:pid/variables` — агрегат: `stand_credentials` (server_username/password/2faotp), `merchants` (server_merchant), `project_server_vars.extra_vars_json` (произвольные). Резолв-логика — `resolveSelectedBaseData(db, projectId, selection)` (spec §9.2). Секретные extra_vars хранятся `enc:v1:<key_id>:…` внутри json (тот же KEK, §9.1 G).
- **Переходы:** клик по источнику (cred/merchant) → соответствующая вкладка; «Предпросмотр» → выбор примера selection.

### Матрица разрешимости (default — данные сегодня, admin не привязан)

```
┌─ Payments · Project Variables ─────────────────────────────[ + Variable ]─────┐
│  Матрица: какие server_* откуда резолвятся (§9.2). ✓ определено · ⚠ дыра.       │
│ ┌──────────────────────────────────────────────────────────────────────────────┐│
│ │ Переменная        │ Откуда                       │ Значение     │ Статус      ││
│ │───────────────────┼──────────────────────────────┼──────────────┼─────────────││
│ │ {server_username} │ credential (прямой выбор)    │ b***r1       │ ✓ определено││
│ │ {server_password} │ credential botuser1          │ ● set        │ ✓ определено││
│ │ {server_2faotp}   │ credential botuser1 (base32) │ ● set·on-dem │ ✓ определено││
│ │ {server_merchant} │ merchant (имя)               │ MaxMerch…    │ ✓ определено││
│ │ ─ через merchant→admin ──────────────────────────────────────────────────────││
│ │ {server_username} │ merchant→admin (если выбран  │ ⚠ admin не   │ ⚠ не        ││ ← дыра
│ │  /password/2faotp │   мерчант без credential)    │   привязан   │   резолвится││
│ │ ─ произвольные (extra_vars) ─────────────────────────────────────────────────││
│ │ {server_region}   │ ProjectServerVars.extra_vars │ eu-central   │ ✓ определено││
│ │ {server_token}    │ ProjectServerVars (secret)   │ ● set        │ ✓ определено││ → enc внутри json
│ └──────────────────────────────────────────────────────────────────────────────┘│
│ ⚠ Цепочка merchant→admin не работает: ни у одного мерчанта нет admin_credential.│
│   Сейчас server_* резолвятся ТОЛЬКО при прямом выборе credential. [Merchants →] │
└────────────────────────────────────────────────────────────────────────────────┘
```
- Две группы строк показывают **обе** оси резолва (прямой credential vs merchant→admin) — видно, что определено (✓ зелёный) и где дыра (⚠ янтарный). Точно отражает `storage`: `botuser1` есть, `admin_login=null` у всех → цепочка merchant→admin пуста (spec §9.2 пример A).

### Предпросмотр резолва на примере (по §9.2 пример A)

```
┌─ Предпросмотр резолва · пример selection ─────────────────────────────────────┐
│ Вход (selection):  project_id=Payments · stand_credential_id=botuser1           │
│                    merchant_id=MaxMerchStage (Max)   [ изменить пример ▾ ]      │
│─────────────────────────────────────────────────────────────────────────────────│
│ Шаг резолва (resolveSelectedBaseData, §9.2):                                    │
│  • standCredential(Payments, botuser1)            → cred ✓ (тот же проект)       │
│  • merchant(Payments, MaxMerch) .admin_credential → NULL → merchantAdmin = null │
│  • resolved = cred ?? merchantAdmin = botuser1                                  │
│─────────────────────────────────────────────────────────────────────────────────│
│ Итог подстановки:                                                              │
│  {server_username} → b***r1            (cred botuser1)                          │
│  {server_password} → ● set             (decrypt at run, не показывается)        │
│  {server_2faotp}   → ● set · on-demand код at run · ✓ base32                    │
│  {server_merchant} → MaxMerchStage (Max)   ← имя от мерчанта, credential — НЕ   │
│  {server_region}   → eu-central        (extra_vars)                            │
│ ⓘ Credential выбран НАПРЯМУЮ: у мерчанта нет admin, поэтому имя мерчанта берётся,│
│   а username/password/2faotp — от прямого credential (§9.2 пример A).           │
└────────────────────────────────────────────────────────────────────────────────┘
```
Маскировка `b***r1`, секреты `● set` (никогда не значение, §4.6). Это «живой» предпросмотр по реальному коду резолва.

### Предпросмотр: пример B (admin привязан вручную, §9.2 пример B)

```
│ Вход (selection):  project_id=Payments · merchant_id=MaxMerchStage (credential НЕ выбран)│
│ Шаг резолва:                                                                    │
│  • merchant(Payments, MaxMerch).admin_credential → botuser1 (проставлен вручную)│
│  • resolved = cred(null) ?? merchantAdmin(botuser1) = botuser1                  │
│ Итог: {server_username/password/2faotp} = botuser1 — но ЧЕРЕЗ мерчанта.         │
```

### Состояние: дыра резолва (ничего не определено)

```
┌─ Payments · Project Variables ─────────────────────────────[ + Variable ]─────┐
│ │ {server_username} │ — нет источника —            │ —            │ ⚠ не        ││
│ │ {server_password} │ — нет источника —            │ —            │   определено││
│ │ {server_2faotp}   │ — нет источника —            │ —            │ ⚠           ││
│ │ {server_merchant} │ — нет мерчантов —            │ —            │ ⚠           ││
│ └──────────────────────────────────────────────────────────────────────────────┘│
│ ⚠ В проекте нет ни credentials, ни merchants → server_*-плейсхолдеры не         │
│   резолвятся. Прогоны со server_* упадут.  [+ Credential]  [+ Merchant]         │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Состояние: loading / error

```
loading:  │ ▦▦▦▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦▦▦▦▦▦▦   ▦▦▦▦▦▦   ▦▦▦▦▦▦▦▦  (shimmer §5.4)        │
error:    │ ⚠ Не удалось загрузить переменные · server_unreachable  [Повторить]   │
```

### Модалка: добавить произвольный server_* (несекретный / секретный)

```
┌─ Project Variable · Payments ────────────────────────────────────────[ ✕ ]───┐
│ Key*    [ server_region                    ]  должен начинаться с server_       │
│ ☐ Секретная (хранить зашифрованной, write-only)                                │
│ Value   [ eu-central                       ]                                   │ ← если несекретная
│ ──────────────────────────────────────────────────────────────────────────────│
│ (если ☑ Секретная:)                                                            │
│ Value   [ ●●●●●●●● ] [ Заменить ]   → хранится enc:v1:<key_id> внутри extra_vars│ ← write-only
│                                            [ Отмена ]   [ Сохранить ]           │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

### 7.7.6. Панель «Проверить доступность стенда»

**Назначение (1 строка):** диагностика достижимости `base_url` стенда из ДВУХ сред — с хоста и из контейнера (как раннер) — с различением «стенд недоступен» vs «Docker недоступен» (spec §5.9, §7.8).

- **Где живёт (три точки встройки, spec §5.9):** (1) на окружении (`[ Проверить ]` в 7.7.4 и в модалке env); (2) в Run-wizard шаг 1 (авто-проверка перед `▶ Запустить`, spec §7.6); (3) на странице прогона `error` («Стенд был недоступен? [Проверить сейчас]»); компактный чип — на Dashboard (spec §7.2).
- **Primary-CTA:** `[ ▶ Проверить ]`.
- **Overflow / Advanced:** «Детали» (response headers · redirect chain · IP · cert expiry).
- **Данные откуда:** `POST /api/environments/:id/reachability` (новый, spec §5.9) → событие `stand.availability` (SSE). Хост-ветка — Node-fetch; контейнерная — `docker run --rm <runner-image> curl -sS -w '%{http_code} %{time_total}'`. Перед контейнерной — лёгкий `ensureDockerReady` (`execute.ts:439-460`). Таймауты `8s`/`12s` (`APP_REACHABILITY_TIMEOUT_MS`), 2 ретрая backoff `0.5s/1.5s`. Гард `environment.project_id == :pid`.
- **Переходы:** результат кэшируется как last-known для чипов (7.7.4, Dashboard, wizard).

### Состояние: проверяется (real-time, обе ветки идут)

```
┌─ Проверка доступности · env: prod ───────────────────────────────────[ ✕ ]───┐
│ BASE_URL  https://prod.stand.internal                        [ ⟳ Проверяю… ]   │
│─────────────────────────────────────────────────────────────────────────────────│
│ С ХОСТА (Ubuntu-ПК)        ⟳ проверяю… попытка 1/2   ▓▓▓░ 0:03                  │ ← пульс §5.2
│ ИЗ КОНТЕЙНЕРА (как раннер) ⟳ ensureDocker… → docker run curl…  0:05            │ ← живой таймер
│   образ playwright:v1.52 · network=bridge · тот же DOCKER_HOST                  │
│─────────────────────────────────────────────────────────────────────────────────│
│ Статусы: ● reachable  ⚠ slow(>1s)  ✖ unreachable  ⓧ TLS  ⓘ Docker↓             │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Состояние: ОК (обе ветки reachable)

```
┌─ Проверка доступности · env: staging ────────────────────────────────[ ✕ ]───┐
│ BASE_URL  https://google.com                                  [ ▶ Проверить ]  │
│─────────────────────────────────────────────────────────────────────────────────│
│ С ХОСТА (Ubuntu-ПК)        ● 200 OK   латентность 84 ms    TLS ✔ valid          │
│ ИЗ КОНТЕЙНЕРА (как раннер) ● 200 OK   латентность 121 ms   DNS ✔   ← важно      │
│   образ playwright:v1.52 · network=bridge · тот же DOCKER_HOST                  │
│─────────────────────────────────────────────────────────────────────────────────│
│ ▸ Детали (Advanced):  headers · redirect chain · IP 142.250… · cert до 2026-09 │
│ История:  12:00 ●200(84/121) · 11:30 ●200 · 10:05 ✖ timeout (из контейнера)    │
└────────────────────────────────────────────────────────────────────────────────┘
```
Латентность mono (§2.4). Расхождение «хост ✔ / контейнер ✖» немедленно диагностирует сетевой блокер (spec §7.8).

### Состояние: стенд недоступен (Docker работает, но стенд не отвечает)

```
│ С ХОСТА (Ubuntu-ПК)        ✖ unreachable   timeout 8.0s · попыток 2/2           │ ← --reach-fail
│ ИЗ КОНТЕЙНЕРА (как раннер) ✖ unreachable   timeout 12.0s · попыток 2/2          │
│   Docker ● ready — проверка прошла из обеих сред, стенд не ответил.             │ ← важно: Docker OK
│─────────────────────────────────────────────────────────────────────────────────│
│ Вывод: СТЕНД НЕДОСТУПЕН (не инфраструктура). base_url не отвечает.   [Повторить]│
```

### Состояние: Docker недоступен (различение, spec §5.9 — критично)

```
│ С ХОСТА (Ubuntu-ПК)        ● 200 OK   латентность 84 ms    TLS ✔ valid          │ ← стенд отвечает
│ ИЗ КОНТЕЙНЕРА (как раннер) ⓘ Docker недоступен — проверка из контейнера         │ ← НЕ ложный ✖
│                              невозможна (ensureDockerReady failed)             │   --reach-docker
│─────────────────────────────────────────────────────────────────────────────────│
│ Вывод: «Стенд отвечает с хоста; достижимость из раннера НЕ проверена (Docker    │
│   недоступен)». Это инфраструктура раннер-хоста, а не недоступность стенда.      │
│   [ Проверить Docker → /account/system ]   [ Повторить ]                        │
```
Ключевое: контейнерная ветка помечается отдельным статусом `ⓘ Docker недоступен` (muted, §2.3 `--reach-docker`), а НЕ ложным `✖ unreachable` — иначе панель соврала бы «стенд недоступен» именно тогда, когда нужна правда (spec §5.9). Вторая комбинация (Docker down + хост не прошёл): «Стенд недоступен с хоста; раннер-проверка невозможна (Docker недоступен)».

### Состояние: TLS error

```
│ С ХОСТА (Ubuntu-ПК)        ⓧ TLS error   cert expired 2026-01-02               │ ← --reach-tls
│ ИЗ КОНТЕЙНЕРА (как раннер) ⓧ TLS error   self-signed / untrusted CA            │
│ Вывод: соединение есть, но TLS невалиден. [Детали cert]   [Повторить]           │
```

### Состояние: slow (reachable, но >1s)

```
│ С ХОСТА (Ubuntu-ПК)        ⚠ slow   200 OK   1.2s (>1s порог)                   │ ← --reach-slow
│ ИЗ КОНТЕЙНЕРА (как раннер) ⚠ slow   200 OK   1.8s                              │
│ Вывод: стенд отвечает, но медленно — прогоны могут ловить таймауты.             │
```

### Чип-вариант (компактный, для 7.7.4 / Dashboard / wizard)

```
default:  [ prod  ● 200 · 84/121ms ]        ← last-known обе ветки
slow:     [ prod  ⚠ slow · 1.2s ]
fail:     [ prod  ✖ unreachable ] [Проверить]
docker:   [ prod  ● host 200 · ⓘ container n/a (Docker↓) ]
checking: [ prod  ⟳ проверяю… ]
```

---

### Сводка привязок раздела (кабинет проекта)

- Все экраны используют дизайн-систему: StatusBadge/secret (§3.1), Table+BulkBar (§3.4), Modal (§3.6), Tabs (§3.9), Skeleton/EmptyState/ErrorState (§3.12), FormField+SecretField (§3.14), ConfirmDialog (§3.18); иконки §4.1; write-only-конвенция §4.6; real-time §4.2; токены статусов §2.3 и `--reach-*`.
- Данные/код: схемы `e:\rabota\playwright project\tests_projec\packages\shared\src\schemas.ts` (`PoolKindSchema:101`, `PoolAllocationStrategySchema:103`, `AccountSchema:77`, `MerchantSchema:85`, `PoolItemSchema:133`, `RunStatusSchema:169`); OTP `e:\rabota\playwright project\tests_projec\packages\shared\src\otp.ts` (`normalizeTotpSecret:9`, `generateTotpCodeSafeDetails:54`, `decodeBase32:186`, `queryNtpDrift:139`); хранилище `e:\rabota\playwright project\tests_projec\apps\server\src\store.ts` (seed env `staging/https://google.com:103`); реальные значения `e:\rabota\playwright project\tests_projec\storage\accounts.json` (`botuser1`+base32 TOTP) и `e:\rabota\playwright project\tests_projec\storage\merchants.json` (3 мерчанта, все `admin_login=null`).
- Спецификация: `e:\rabota\playwright project\tests_projec\docs\ui-redesign-spec.md` §7.7 (кабинет), §7.8 (доступность стенда), §8.3 (Stand 2FA project-scoped), §8.5 (прозрачность 2FA), §8.6 (KEK/needs_reentry), §9.1 (DDL D/E/F/G/H), §9.2 (резолв server_* примеры A/B); `e:\rabota\playwright project\tests_projec\docs\runtime-cabinet.md` (поля admins/merchants/pools/items/fetch/auto-import).
- Новые эндпоинты, на которые опираются моки (project-scoped гард везде): `POST /api/projects/:pid/credentials/:cid/code` (тестовый TOTP-код, §8.3), `POST /api/environments/:id/reachability` (§5.9), `GET /api/projects/:pid/variables` (агрегат-матрица), `GET /api/runs/:id/stream` (live Fetch info/reachability).

---

## 8. Электрон-агент: рекордер и публикация

I have everything I need. The code confirms: `scenario_ulid` does not exist yet (grep returned nothing), upload has no dedup key, transformations (`replaceBaseUrl`, `forceExactOptionNameMatches`) applied silently in main.ts:266-268, status is polled via `setInterval(refreshRuntime, 1000)` at renderer.js:80, all feedback is `alert()`, IPC `readFile/writeFile` takes arbitrary paths (main.ts:207-214), and two CRUD panels (Accounts/Merchants) duplicate the server.


---

### 1. Контекст и инварианты раздела

Назначение: десктоп-рекордер — единственный клиент записи (`playwright codegen` требует GUI+локальный браузер, `main.ts:96,133-161`; research §5 «вердикт: тонкий рекордер»). Раздел проектирует полный редизайн агента: убирает дублирование сервера, оставляет конвейер `Record → Replay → Review → Publish`, добавляет личный вход, real-time push-статусы, `scenario_ulid` + resume.

Что удаляется относительно текущего UI (привязка к коду):

| Удаляется | Где сейчас | Почему |
|---|---|---|
| Панель **Server Accounts** (CRUD `/api/accounts`) | `index.html:144-167`, `renderer.js:396-458` | Дубль веб-кабинета; пароль/TOTP правятся в десктоп-UI (`renderer.js:416`). Замена — read-only выбор. |
| Панель **Server Merchants** (CRUD `/api/merchants`) | `index.html:169-189`, `renderer.js:460-511` | Дубль; та же причина. |
| Панель **Input Variables** (форма+таблица) | `index.html:100-129` | Дублирует контекст-меню вставки → один механизм (§4.3 ДС). |
| Панель **Server Tokens** (4 кнопки) | `index.html:131-142` | Дубль подменю контекст-меню. |
| Кнопки **Refresh / Preview / Apply** | `index.html:201,204,205` | Refresh не нужен при live-данных; Preview/Apply — autosave, код виден сразу после Stop. |
| `setInterval(refreshRuntime,1000)` + опрос 4 статусов | `renderer.js:80,167-177` | Замена — push `webContents.send` (recording-started / step-recorded / upload-progress). |
| `alert(...)` (12+ мест) | `renderer.js:174,251,279,...` | Блокирует, текст некопируем. Замена — Toast + копируемый лог. |
| `input.value = account.password` | `renderer.js:416` | Утечка секрета в DOM. Удаляется вместе с панелью. |
| Произвольный путь в `readFile/writeFile` | `main.ts:207-214` | IPC-дыра; ограничивается `tempDir`. |

Сохраняемые контракты (НЕ ломать): сигнатура `{{INPUT:name}}` (`renderer.js:1035`), имена `2fa_otp`/`server_2faotp`, тихие трансформации перед upload становятся видимым diff (`replaceBaseUrl`+`forceExactOptionNameMatches`, `main.ts:266-267`), `metadata.json schema_version:2` (`metadata.ts:24`) расширяется полем `scenario_ulid` (spec §6.3, сегодня отсутствует — grep пуст).

Дизайн-система применяется как для десктоп-окна: токены §2, StatusBadge §3.1, LiveLogConsole §3.3, Toast §3.8, FormField/SecretField §3.14, Button §3.13, конвенции §4 (один primary-CTA, write-only секреты §4.6, real-time §4.2). Глифы статусов из §4.1. Везде рисуется оконный хром (заголовок ОС, traffic-lights).

Легенда оконного хрома во всех моках:
```
● ● ●  = кнопки окна (close/min/max, macOS-стиль; на Win — справа)
▸Payments = индикатор активного сервера/проекта в title-bar
```

---

### 2. Глобальная раскладка окна агента (shell)

Назначение: единый каркас окна — тонкая верхняя панель (сервер+пользователь+язык+статус подключения), слева узкий рельс этапов конвейера, справа рабочая область. Заменяет `page`-less `index.html` с 7 панелями-полотнами (`index.html:22-223`).

```
┌─ ts-playwright Recorder ─────────────────────────────────────── ● ● ● ─┐
│ ▸ srv: stand.internal   anna@team  🟢 connected     [🌐 RU] [⚙][a▾]      │ ← title-bar (--surface, --z-header)
├──────────────┬──────────────────────────────────────────────────────────┤
│ КОНВЕЙЕР      │                                                          │
│ ① Контекст ✔ │   < рабочая область выбранного этапа >                    │
│ ② Запись   ● │                                                          │
│ ③ Review   ○ │                                                          │
│ ──────────   │                                                          │
│ ⟲ Незаверш.1 │ ← бейдж resume (§9), виден только при наличии черновиков   │
│ ⚙ Настройки  │                                                          │
└──────────────┴──────────────────────────────────────────────────────────┘
```

- Рельс = линейный конвейер `① Контекст → ② Запись → ③ Review`, статусные глифи `✔ done / ● current / ○ pending` (как Wizard §3.7). Это и есть «тонкий рекордер»: 3 этапа вместо 7 несвязанных панелей.
- Title-bar несёт постоянный контекст: имя сервера (`config.server_url`), кто вошёл (`User.login`), индикатор подключения StatusBadge-стиль (`🟢 connected` / `🔴 offline` / `🟡 reconnecting`), переключатель языка `🌐 RU/EN` (§1.3 ДС), `[⚙]` Настройки, `[a▾]` меню пользователя (Профиль/Выйти/Сменить сервер).
- primary-CTA меняется по этапу (Record / Replay / Publish) — один на экран (столп 3).

Состояние «не подключён» (нет токена/сервера) — рельс конвейера задизейблен, активен только экран Login (§3).

```
┌─ ts-playwright Recorder ─────────────────────────────────────── ● ● ● ─┐
│ ▸ srv: —          не выполнен вход   🔴 offline        [🌐 RU]           │
├──────────────┬──────────────────────────────────────────────────────────┤
│ КОНВЕЙЕР      │                                                          │
│ ① Контекст ⊘ │   ┌────────────────────────────────────────────────┐     │
│ ② Запись   ⊘ │   │  Войдите, чтобы начать запись                   │     │
│ ③ Review   ⊘ │   │  [ Перейти ко входу → ]                         │     │
│ ⚙ Настройки  │   └────────────────────────────────────────────────┘     │
└──────────────┴──────────────────────────────────────────────────────────┘
   ⊘ = этап недоступен до входа
```

---

### 3. Экран Login (подключение агента к серверу)

Назначение: личный вход агента вместо общего `X-API-KEY` (`renderer.js:978`, research §5 «Bearer/PAT вместо общего ключа»). Два способа: email+пароль того же `User` или Personal Access Token. primary-CTA: `Войти`. Overflow: нет. Advanced: выбор способа (Пароль/PAT), смена `server_url`. Данные: `POST /api/auth/login` → access(15м)+refresh в `safeStorage` (research §5); PAT scope `agent:record-upload`. Переход после успеха → этап ① Контекст.

**3.1 Default — вход по паролю:**
```
┌─ ts-playwright Recorder ─────────────────────────────────────── ● ● ● ─┐
│                                                       [🌐 RU/EN]        │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│            ts-playwright · Recorder                                      │
│            Вход в инструмент                                             │
│                                                                          │
│   Сервер*       [ https://stand.internal              ] [Сменить]        │
│   ┌─ Способ входа ──────────────────────────────────┐                    │
│   │  ◉ Email/пароль        ○ Personal Access Token   │                    │
│   └──────────────────────────────────────────────────┘                    │
│   Email/Login*  [ anna@team                          ]                    │
│   Пароль*       [ ●●●●●●●●                        ] [👁]                   │
│   ☐ Запомнить на этом устройстве                                          │
│                                                                          │
│                              [ Войти ]   ← primary                        │
│                                                                          │
│   Нет доступа? Запросите у администратора инструмента.                    │
└──────────────────────────────────────────────────────────────────────────┘
```

**3.2 Вход по Personal Access Token (выбран радио):**
```
│   ┌─ Способ входа ──────────────────────────────────┐                    │
│   │  ○ Email/пароль        ◉ Personal Access Token   │                    │
│   └──────────────────────────────────────────────────┘                    │
│   Токен*        [ pat_•••••••••••••••••••••••       ] [👁]                 │
│   ⓘ Создайте токен в вебе: Профиль → Токены, scope agent:record-upload    │
│                              [ Войти по токену ]                          │
```

**3.3 Loading (проверка):**
```
│                              [ ⟳ Входим…  ]   ← Button loading-состояние   │
│   🟡 проверяем учётные данные на stand.internal …                         │
```

**3.4 Error (неблокирующий, копируемый — заменяет `alert`, `renderer.js:982-984`):**
```
│   Email/Login*  [ anna@team                          ]                    │
│   Пароль*       [ ●●●●●●●●                        ] [👁]                   │
│   ┌────────────────────────────────────────────────────────┐  ← ErrorState│
│   │ ✖ Не удалось войти                                       │             │
│   │   error.invalid_credentials                              │ ← code→t()  │
│   │   [ Повторить ]                            [⧉ копировать]│             │
│   └────────────────────────────────────────────────────────┘             │
```
Серверная недоступность — отдельный код: `✖ server_unreachable · проверьте адрес сервера`.

**3.5 Подключён (после входа — мини-подтверждение в title-bar + авто-переход):**
```
│ ▸ srv: stand.internal   anna@team  🟢 connected     [🌐 RU] [⚙][a▾]      │
│   ✔ Вход выполнен · anna@team · stand.internal                           │ ← Toast success, 4с
│   → переход к этапу ① Контекст                                            │
```

**3.6 Смена сервера (popover из [Сменить] / `[a▾]→Сменить сервер`):**
```
┌─ Сменить сервер ───────────────────────────────┐  ← Modal sm §3.6
│ Текущий: https://stand.internal                 │
│ Новый адрес* [ https://stage.stand.internal   ] │
│ ⚠ Смена сервера завершит текущую сессию          │
│                     [ Отмена ]  [ Подключиться ] │
└─────────────────────────────────────────────────┘
```
Пишет `server_url` в `config.json` (единственное оставшееся поле, research §5: «в config.json остаётся только server_url»), сбрасывает токены, возвращает на 3.1.

---

### 4. Этап ① Контекст записи

Назначение: выбор куда и что записывать — проект+окружение+папка+имя+Start URL, плюс **read-only** просмотр того credential/merchant, что подставится (БЕЗ CRUD). primary-CTA: `Начать запись →`. Overflow: нет. Advanced: ручной Start URL поверх env.base_url. Данные: проекты `GET /api/projects` (`renderer.js:126`), окружения `GET /api/projects/:id/environments` (`renderer.js:143`) — фильтруются доступом пользователя; credential/merchant — read-only превью `GET /api/projects/:pid/credentials` (только `login`+`has_*`, без значений, research §5). Переход: `Начать запись` → этап ② Запись (запускает `codegen`, `main.ts:133`).

**4.1 Default:**
```
┌──────────────┬──────────────────────────────────────────────────────────┐
│ ① Контекст ● │  Контекст записи                                          │
│ ② Запись   ○ │  ┌────────────────────────────────────────────────────┐  │
│ ③ Review   ○ │  │ Проект*      [ Payments ▾ ]                         │  │
│              │  │ Окружение*   [ stg ▾ ]  ● 200·84ms [Проверить]      │  │ ← reachability §5.9
│              │  │ Папка        [ payments/payouts            ]        │  │
│              │  │ Имя сценария*[ withdraw-flow               ]        │  │
│              │  │ Start URL    [ https://stg.stand.internal/ ]        │  │ ← из env.base_url (renderer.js:150)
│              │  │              ⓘ авто из окружения · можно изменить    │  │
│              │  └────────────────────────────────────────────────────┘  │
│              │  ┌─ ЧТО ПОДСТАВИТСЯ ПРИ ЗАПУСКЕ (read-only) ──────────┐   │
│              │  │ credential  stand-admin → {server_username}=a***n  │   │ ← маскировка §4.6
│              │  │             {server_password} ●set  {server_2faotp}●set│ │
│              │  │ merchant    ACME → {server_merchant}=ACME           │   │
│              │  │ ⓘ Управление — в вебе. Здесь только просмотр.       │   │ ← НЕТ кнопок Save/Delete
│              │  └────────────────────────────────────────────────────┘   │
│              │  ☐ Сохранить auth state (сессионные куки)                  │ ← save_auth (renderer.js:203)
│              │                                  [ Начать запись → ]       │ ← primary
└──────────────┴──────────────────────────────────────────────────────────┘
```
Это убирает панели Accounts/Merchants CRUD (`index.html:144-189`): здесь credential/merchant только показываются (что подставится), правка — в вебе.

**4.2 Loading (подгрузка проектов/окружений):**
```
│  │ Проект*      [ ▦▦▦▦▦▦ ▾ ]   ← Skeleton §3.12                       │
│  │ Окружение*   [ ▦▦▦ ▾ ]                                            │
│  │ ▦▦▦▦  ▦▦▦▦▦▦                                                      │
```

**4.3 Empty (у пользователя нет доступных проектов):**
```
│  ┌────────────────────────────────────────────────────┐
│  │            ⊙                                         │
│  │   Нет доступных проектов                             │
│  │   Попросите администратора добавить вас в проект     │
│  │            [ Открыть веб → ]                          │ ← не тупик
│  └────────────────────────────────────────────────────┘
```

**4.4 Error (сервер недоступен при загрузке):**
```
│  ┌────────────────────────────────────────────────────┐
│  │ ⚠ Не удалось загрузить проекты                       │
│  │   server_unreachable                                 │
│  │   [ Повторить ]                        [⧉ копировать]│
│  └────────────────────────────────────────────────────┘
```

**4.5 Validation (нет обязательного поля — RHF+Zod, §1 ДС):**
```
│  │ Имя сценария*[                            ]        │
│  │   ⚠ Укажите имя сценария                            │ ← FormField error §3.14
│  │                                  [ Начать запись → ]│ ← disabled
```

---

### 5. Этап ② Запись — главный экран рекордера

Назначение: конвейер `Record—Stop · Replay · Review→Upload` (вместо 7 кнопок `index.html:201-207`), редактор кода (CodeMirror вместо `<textarea>` `index.html:220`), компактная декларация inputs/outputs, единый механизм вставки плейсхолдеров и `server_*` через контекст-меню. primary-CTA: зависит от под-состояния (`Запись` → `Стоп` → `Review →`). Overflow `⋯`: Replay, Очистить, Скопировать код. Advanced: outputs-декларация (сворачиваемая). Данные: код пишется `codegen --output` (`main.ts:138`), статус — push-события (§8). Переход: `Review →` → этап ③.

**5.1 idle (контекст выбран, запись ещё не шла):**
```
┌──────────────┬──────────────────────────────────────────────────────────┐
│ ① Контекст ✔ │  Payments ▸ payouts ▸ withdraw-flow            stg · ●200  │ ← Breadcrumbs §3.15
│ ② Запись   ● │ ┌─ КОНВЕЙЕР ───────────────────────────────────────────┐  │
│ ③ Review   ○ │ │ [ ● Запись ]   Replay(⊘)   Review →(⊘)               │  │ ← primary Record, прочее disabled
│              │ └──────────────────────────────────────────────────────┘  │
│              │ ┌─ scenario.spec.ts ──────────────────── [⧉ copy][⤓]──┐   │
│              │ │  1                                                   │   │ ← CodeMirror, пусто
│              │ │    (код появится после записи или Replay)            │   │
│              │ │                                                      │   │
│              │ └──────────────────────────────────────────────────────┘   │
│              │ ▸ Inputs · Outputs (0)         🔐 контекст-меню: вставка     │
└──────────────┴──────────────────────────────────────────────────────────┘
```

**5.2 recording (живой счётчик шагов — push `step-recorded`, §8):**
```
│ ② Запись   ● │ ┌─ КОНВЕЙЕР ───────────────────────────────────────────┐  │
│              │ │ [ ⏹ Стоп ]   ⟳ recording   ● 0:48   12 шагов записано │  │ ← пульс §5.2 ДС, live-таймер §4.2
│              │ └──────────────────────────────────────────────────────┘  │
│              │ ┌─ Запись идёт в окне браузера ────────────────────────┐   │
│              │ │ ⟳ codegen активен · браузер chromium открыт           │   │
│              │ │                                                       │   │
│              │ │  последний шаг:  click  #withdraw-submit              │   │ ← дописывается по step-recorded
│              │ │  ▏                                                    │   │
│              │ └──────────────────────────────────────────────────────┘   │
│              │ ⓘ Закройте окно браузера или нажмите Стоп для завершения    │
```
Счётчик «N шагов записано» — единственный честный live-сигнал во время codegen (раньше после Stop редактор был пуст до Preview, `renderer.js:205,216` — устранено).

**5.3 recorded (после Stop — код виден сразу, autosave; Preview/Apply удалены):**
```
│ ② Запись   ● │ ┌─ КОНВЕЙЕР ───────────────────────────────────────────┐  │
│              │ │ [ ▶ Replay ]   ✔ 12 шагов · сохранено   Review →     │  │ ← primary Replay; Review активен
│              │ └──────────────────────────────────────────[ ⋯ ]──────┘  │   ⋯: Очистить · Скопировать · Записать заново
│              │ ┌─ scenario.spec.ts ──────────── ●saved ─ [⧉][⤓ wrap]─┐   │
│              │ │ 1  import { test, expect } from '@playwright/test';  │   │ ← CodeMirror, подсветка TS
│              │ │ 2  test('withdraw-flow', async ({ page }) => {       │   │
│              │ │ 3    await page.goto('{server_base}/payouts');       │   │
│              │ │ 4    await page.fill('#user', '{server_username}');  │   │ ← server_* токены подсвечены
│              │ │ 5    await page.fill('#otp', '{{INPUT:2fa_otp}}');   │   │ ← INPUT-плейсхолдеры
│              │ │   ▕ правый клик → вставить плейсхолдер/server-токен   │   │
│              │ └──────────────────────────────────────────────────────┘   │
│              │ ▾ Inputs · Outputs (2)                                      │
│              │   IN  2fa_otp  (2fa_otp)  · amount (string)                 │ ← компактный список §index.html:117 заменён
│              │   OUT tx_id ← #receipt-id (text)                            │
└──────────────┴──────────────────────────────────────────────────────────┘
```

Единый механизм вставки — контекст-меню редактора (удаляет панели Input Variables `index.html:100` и Server Tokens `index.html:131`, и 3 механизма свёрнуты в 1, research §5):
```
┌─ правый клик в редакторе ───────────┐  ← один механизм, §3 ДС DropdownMenu
│ Undo · Redo · Copy · Paste          │
│ ─────────────────────────────────── │
│ Вставить 2FA OTP                    │ ← {{INPUT:2fa_otp}}
│ Input-переменная           ▸        │ ← подменю: существующие + «создать»
│ Server-токены              ▸        │ ← {server_username/password/2faotp/merchant}
└─────────────────────────────────────┘
```

**5.4 replay running (живой статус прогона локального replay):**
```
│              │ ┌─ КОНВЕЙЕР ───────────────────────────────────────────┐  │
│              │ │ [ ⏹ Стоп replay ]  ⟳ Replaying  ● 0:12               │  │ ← StatusBadge running, пульс
│              │ └──────────────────────────────────────────────────────┘  │
│              │ ┌─ Live console (replay) ──────────── [⏸ autoscroll]──┐   │ ← LiveLogConsole §3.3
│              │ │ 0:03  ✓ goto /payouts                                │   │
│              │ │ 0:07  ✓ fill #user                                   │   │
│              │ │ 0:12  ⟳ waiting for #receipt-id …                    │   │ ← дописывается
│              │ │ ▏                                          following  │   │
│              │ └──────────────────────────────────────────────────────┘   │
```

**5.5 replay passed / failed (терминал — вместо `alert("Replay finished…")`, `renderer.js:251`):**
```
│              │ │ [ ▶ Replay ]   ✔ passed · 0:18   Review →            │  │ ← Toast: «✔ Replay прошёл»
│   …          │                                                          │
│ — ИЛИ —      │ │ [ ▶ Replay ]   ✖ failed · 0:14   Review →            │  │ ← StatusBadge failed
│              │ ┌─ Live console (replay) ────────────────[⧉ copy]─────┐   │
│              │ │ 0:14  ✖ Timeout 30000ms exceeded · #receipt-id       │   │ ← копируемый, не alert
│              │ │       [ скопировать лог ]   [ открыть trace ]        │   │
│              │ └──────────────────────────────────────────────────────┘   │
```

---

### 6. Этап ③ Review & Upload

Назначение: показать финальный zip перед публикацией — трансформированный `scenario.spec.ts` с **diff** (что молча менялось в `main.ts:266-267`), `metadata.json`, отфильтрованные inputs, предупреждение про `auth_state.json`. primary-CTA: `Publish`. Overflow `⋯`: Скачать zip локально, Назад к записи. Advanced: просмотр сырого metadata.json. Данные: diff = `replaceBaseUrl`+`forceExactOptionNameMatches` (`main.ts:266-267`); inputs = `filterInputSpecs(...)` (`main.ts:270`); zip = `scenario.spec.ts`+`metadata.json`+опц.`auth_state.json` (`main.ts:289-294`). Переход: `Publish` → `POST /api/projects/:id/scenarios/upload` (`main.ts:300`), upsert по `scenario_ulid` (spec §6.3).

**6.1 review (default — diff виден):**
```
┌──────────────┬──────────────────────────────────────────────────────────┐
│ ① Контекст ✔ │  Review & Upload · withdraw-flow                          │
│ ② Запись   ✔ │ ┌─ СОДЕРЖИМОЕ ZIP ─────────────────────────────────────┐  │
│ ③ Review   ● │ │ 📄 scenario.spec.ts   (трансформирован, см. diff)     │  │
│              │ │ 📄 metadata.json      schema 2 · ulid 01J8…F2          │  │ ← scenario_ulid (spec §6.3)
│              │ │ 🔒 auth_state.json    сессионные куки  ⚠               │  │
│              │ └──────────────────────────────────────────────────────┘  │
│              │ ┌─ DIFF: что изменилось при подготовке ────────────────┐  │ ← раньше молча, main.ts:266
│              │ │  3  - await page.goto('https://stg.stand.internal/') │  │ ← красный (--status-failed-bg)
│              │ │  3  + await page.goto('{server_base}/payouts')       │  │ ← зелёный (--status-passed-bg)
│              │ │ 14  - selectOption({ label: 'USDT' })                │  │
│              │ │ 14  + selectOption({ label: 'USDT' }) //exact name   │  │ ← forceExactOptionNameMatches
│              │ │     2 замены · base_url, точные имена опций           │  │
│              │ └──────────────────────────────────────────────────────┘  │
│              │ ┌─ INPUTS (только используемые в коде) ─────────────────┐  │ ← filterInputSpecs main.ts:270
│              │ │ 2fa_otp  (2fa_otp)   amount (string)                  │  │
│              │ │ ⓘ объявленные, но не вставленные — отброшены           │  │
│              │ └──────────────────────────────────────────────────────┘  │
│              │ ┌─ ⚠ ВНИМАНИЕ: auth_state.json ────────────────────────┐  │
│              │ │ В zip попадут сессионные куки записанной сессии.       │  │
│              │ │ Они дают доступ к стенду от вашего имени.               │  │
│              │ │ ☑ Включить auth_state (нужно для сценариев с входом)    │  │
│              │ └──────────────────────────────────────────────────────┘  │
│              │ ▸ Advanced: сырой metadata.json                            │
│              │            [ ← Назад к записи ]   [ ⤴ Publish ]  ⋯         │ ← primary Publish
└──────────────┴──────────────────────────────────────────────────────────┘
```

**6.2 uploading (живой прогресс zip → POST → done — push `upload-progress`, §8; заменяет статус-опрос):**
```
│              │ ┌─ Публикация ─────────────────────────────────────────┐  │
│              │ │ ⟳ Публикуем withdraw-flow на stand.internal           │  │
│              │ │ ▓▓▓▓▓▓▓▓▓▓▓░░░░  упаковка zip … done                  │  │ ← ProgressBar §3.16, фазы
│              │ │  ✔ zip собран  ✔ отправка POST  ⟳ ответ сервера…      │  │
│              │ │ [ ⏹ Отмена ]                                          │  │
│              │ └──────────────────────────────────────────────────────┘  │
```
Фазы прогресса соответствуют коду upload: сборка zip (`main.ts:289-295`) → POST (`main.ts:300`) → ответ (`main.ts:310`).

**6.3 published (успех — заменяет `alert("Scenario uploaded…")`, `renderer.js:279`):**
```
│              │ ┌──────────────────────────────────────────────────────┐  │
│              │ │            ✔                                          │  │
│              │ │   Опубликовано · withdraw-flow                        │  │ ← Toast success + экран
│              │ │   id 01J8…F2 · Payments ▸ payouts                     │  │
│              │ │   [ Открыть в вебе → ]   [ Записать ещё ]             │  │ ← не тупик
│              │ └──────────────────────────────────────────────────────┘  │
```
`scenario_ulid` стабилен → повторный Publish = upsert (обновление), не дубль (spec §6.3; раньше `renderer.js:267` без ключа дедупликации → дубли).

**6.4 error (копируемый лог вместо `alert(сырой stderr)`, `renderer.js:311`/`main.ts:310`):**
```
│              │ ┌─ ✖ Не удалось опубликовать ──────────────────────────┐  │ ← ErrorState §3.12
│              │ │ error.upload_rejected · HTTP 422                       │  │ ← code→t()
│              │ │ ┌──────────────────────────────────────────────────┐ │  │
│              │ │ │ scenario.spec.ts: duplicate input name '2fa_otp' │ │  │ ← сырой ответ, в mono, прокручиваемый
│              │ │ │ at line 5 …                                       │ │  │
│              │ │ └──────────────────────────────────────────────────┘ │  │
│              │ │ [ ⧉ Скопировать лог ]   [ Повторить Publish ]         │  │ ← копируемо (раньше alert)
│              │ └──────────────────────────────────────────────────────┘  │
```

---

### 7. Read-only выбор credential/merchant (детально)

Назначение: подтвердить, что подставится при запуске, без права редактирования — устраняет двойную точку правки секретов (research §1 п.11). primary-CTA: нет (информативный блок на этапе ① и в превью ②). Данные: `GET /api/projects/:pid/credentials` и `/merchants` (только `login`/`name`+`has_password`/`has_totp`, значения не приходят — research §5, §4.6 ДС). Это полная замена панелей `index.html:144-189`.

**7.1 Выбор credential (popover, read-only):**
```
┌─ Credential проекта Payments (read-only) ──────────┐  ← DropdownMenu §3
│ 🔍 [ поиск …                                     ] │
│ ◉ stand-admin   a***n   pwd ●set  2FA ●set         │ ← StatusBadge secret §3.1
│ ○ stand-ops     o***s   pwd ●set  2FA ○ not set    │
│ ─────────────────────────────────────────────────  │
│ ⓘ Создать/изменить — только в вебе                  │ ← НЕТ Save/Delete (раньше renderer.js:423,443)
└────────────────────────────────────────────────────┘
```

**7.2 Empty (в проекте нет credential):**
```
┌─ Credential проекта Payments ──────────────────────┐
│ ⊙ В проекте пока нет учётных данных                 │
│ {server_*} токены не будут разрешены при запуске    │
│ [ Открыть Credentials в вебе → ]                    │
└────────────────────────────────────────────────────┘
```
Merchant-выбор симметричен (`name → {server_merchant}`), без секретов.

---

### 8. Real-time статусы через push-события (прозрачность)

Назначение: заменить опрос `setInterval(refreshRuntime,1000)` (`renderer.js:80`) и `alert` на push `webContents.send` (research §5). События main→renderer: `recording-started`, `step-recorded {count}`, `recording-stopped {steps}`, `replay-progress {line}`, `replay-done {status}`, `upload-progress {phase, pct}`, `upload-done {id}`, `agent-error {code, detail}`. Все «живые» статусы рисуются по конвенции §4.2 ДС: пульс активной фазы, live-таймеры (клиентский RAF), переходы без перезагрузки.

Где живые статусы видны в моках выше:
- title-bar: `🟢/🟡/🔴` подключение (постоянный индикатор, §2).
- этап ② recording: `⟳ recording · 0:48 · 12 шагов` (§5.2) — пульс + live-таймер + счётчик шагов из `step-recorded`.
- этап ② replay: LiveLogConsole follow-режим (§5.4) — строки по `replay-progress`.
- этап ③ uploading: ProgressBar фаз `zip→POST→ответ` (§6.2) — по `upload-progress`.

Сводка соответствия событие → мок:
```
recording-started → 5.2 (вход в recording)
step-recorded     → 5.2 счётчик «N шагов записано» (live)
recording-stopped → 5.3 (recorded, код виден)
replay-progress   → 5.4 LiveLogConsole строки
replay-done       → 5.5 passed/failed
upload-progress   → 6.2 ProgressBar фазы
upload-done       → 6.3 published
agent-error       → Toast/ErrorState (3.4 / 5.5 / 6.4) — копируемо, code→t()
```

---

### 9. Resume незавершённой записи (после краша агента)

Назначение: восстановить запись после краша Electron — состояние сегодня только в памяти (`state.runtime`, `renderer.js:1`/`main.ts:42`), при краше теряется (spec §6.3). Решение: при Stop писать `metadata.json` с `scenario_ulid` в `tempDir`; при старте агента сканировать `tempDir` по ULID и предлагать «продолжить/отбросить». primary-CTA: `Продолжить Review`. Overflow: нет. Данные: скан `os.tmpdir()/ts-playwright-agent` (`main.ts:37`) на пары `scenario_*.spec.ts`+`metadata.json` с `scenario_ulid` (spec §6.3 «скан tempDir по ULID»).

**9.1 Баннер при старте (найдены черновики):**
```
┌─ ts-playwright Recorder ─────────────────────────────────────── ● ● ● ─┐
│ ▸ srv: stand.internal   anna@team  🟢 connected     [🌐 RU] [⚙][a▾]      │
├──────────────┬──────────────────────────────────────────────────────────┤
│ ⟲ Незаверш.1 │ ┌─ ⟲ Найдена незавершённая запись ─────────────────────┐ │
│ ① Контекст   │ │ withdraw-flow · Payments ▸ payouts                     │ │
│ ② Запись     │ │ ulid 01J8…F2 · записано 12 шагов · 14:03 · 8 мин назад │ │ ← из metadata.json
│ ③ Review     │ │ auth_state: 🔒 сохранён                                │ │
│              │ │                                                       │ │
│              │ │ [ ▶ Продолжить Review ]   [ 🗑 Отбросить ]            │ │ ← primary continue
│              │ └──────────────────────────────────────────────────────┘ │
└──────────────┴──────────────────────────────────────────────────────────┘
```

**9.2 Несколько черновиков (список):**
```
│ ┌─ ⟲ Незавершённые записи (3) ─────────────────────────────────────────┐ │
│ │ ☐ withdraw-flow   Payments▸payouts  12 шагов  14:03  [Продолжить][🗑] │ │ ← Table §3.4
│ │ ☐ deposit-card    Payments▸deposits  6 шагов  11:48  [Продолжить][🗑] │ │
│ │ ☐ kyc-step1       KYC▸onboarding     3 шага   вчера  [Продолжить][🗑] │ │
│ │ ──────────────────────────────────────────  [🗑 отбросить выбранные] │ │ ← bulk-bar §3.4
│ └──────────────────────────────────────────────────────────────────────┘ │
```

**9.3 Подтверждение отбрасывания (ConfirmDialog §3.18 — вместо `confirm()`):**
```
┌─ Отбросить незавершённую запись? ──────────────┐
│ withdraw-flow · 12 шагов · auth_state сохранён  │ ← масштаб последствий
│ Файлы записи будут удалены безвозвратно.         │
│                  [ Отмена ]  [ 🗑 Отбросить ]    │
└─────────────────────────────────────────────────┘
```

**9.4 Empty (черновиков нет — баннер/рельс-бейдж скрыты):** бейдж `⟲ Незаверш.` в рельсе (§2) не показывается; старт идёт сразу на этап ① или последний контекст.

---

### 10. Настройки агента

Назначение: `server_url`, язык RU/EN, locale/timezone/browser записи (вынос из хардкода `main.ts:148-154`, `renderer.js:948-949`), ограничение IPC. primary-CTA: `Сохранить`. Overflow: нет. Advanced: путь tempDir (read-only), сброс токенов. Данные: `config.json` (`main.ts:78-85`) — `server_url`; остальное — локальные предпочтения. Сегодня `locale:"ru-RU"`/`timezone:"Europe/Riga"`/`browser:"chromium"` зашиты (`renderer.js:945-949`, `main.ts:148`).

**10.1 Default:**
```
┌─ Настройки агента ─────────────────────────────────────────────┐  ← Modal wide §3.6
│ [ Подключение ]·[ Запись ]·[ Язык ]            ← Tabs §3.9      │
│────────────────────────────────────────────────────────────────│
│ ПОДКЛЮЧЕНИЕ                                                     │
│  Сервер*        [ https://stand.internal        ] [Проверить]  │ → config.json server_url
│  Статус         🟢 connected · anna@team                        │
│  [ Выйти и сменить пользователя ]   [ Сбросить токены ]         │
│                                                                │
│ ЗАПИСЬ (дефолты codegen)                                        │
│  Браузер        [ chromium ▾ ]   (chromium/firefox/webkit)     │ ← было main.ts:148 хардкод
│  Locale         [ ru-RU ▾ ]                                    │ ← было renderer.js:948
│  Timezone       [ Europe/Riga ▾ ]                              │ ← было renderer.js:949
│  Viewport       [ 1280 ] × [ 720 ]                             │
│  Timeout codegen[ 60000 ] ms                                   │
│                                                                │
│ ▸ Advanced:  tempDir (read-only) · CSP connect-src             │
│                                  [ Отмена ]   [ Сохранить ]    │
└────────────────────────────────────────────────────────────────┘
```

**10.2 Язык (вкладка Tabs):**
```
│ ЯЗЫК ИНТЕРФЕЙСА                                                 │
│  ◉ Русский (RU)      ○ English (EN)                            │ ← §1.3 ДС, плоский словарь t()
│  ⓘ Меняется мгновенно, без перезапуска                         │
```

**10.3 Проверка сервера (loading/ok/fail в строке):**
```
│  Сервер*  [ https://stand.internal ] [⟳ Проверяем…]            │ loading
│  Сервер*  [ https://stand.internal ] [Проверить]  ● 200·54ms   │ ok
│  Сервер*  [ https://bad.internal   ] [Проверить]  ✖ unreachable │ fail (копируемо)
```

---

### 11. Карта «было → стало» (агент целиком)

| Было (текущий UI) | Стало | Состояния-моки |
|---|---|---|
| 7 несвязанных панелей (`index.html:22-223`) | 3-этапный конвейер ①②③ в рельсе (§2) | §2 (shell, offline) |
| Общий `X-API-KEY` (`renderer.js:978`) | Личный вход email/PAT (§3), токены в safeStorage | §3.1-3.6 |
| Панели Accounts/Merchants CRUD (`index.html:144-189`) | Read-only выбор, что подставится (§4.1, §7) | §7.1-7.2 |
| 7 кнопок тулбара (`index.html:201-207`) | Record—Stop · Replay · Review→Publish (§5) | §5.1-5.5 |
| `<textarea>` (`index.html:220`) | CodeMirror с подсветкой TS/токенов (§5.3) | §5.3 |
| 3 механизма вставки (`index.html:100-142`+меню) | Один: контекст-меню (§5.3) | §5.3 |
| Тихие трансформации (`main.ts:266-267`) | Видимый diff в Review (§6.1) | §6.1 |
| Опрос `setInterval(...,1000)` (`renderer.js:80`) | Push `webContents.send` (§8) | §5.2,5.4,6.2 |
| `alert()` ×12 (`renderer.js`) | Toast + копируемый ErrorState (§3.4,5.5,6.4) | §3.4,5.5,6.4 |
| Состояние только в памяти (краш = потеря) | `scenario_ulid` + resume-скан tempDir (§9) | §9.1-9.4 |
| Дубли при upload без ключа (`renderer.js:267`) | upsert по `scenario_ulid` (§6.3) | §6.3 |
| Хардкод locale/tz/browser (`main.ts:148`) | Настройки записи (§10) | §10.1 |
| `readFile/writeFile` любой путь (`main.ts:207-214`) | Ограничение `tempDir` (§10 Advanced) | §10.1 |

---

### Сводка ссылок раздела

- Источники: `e:\rabota\playwright project\tests_projec\docs\ui-redesign-spec.md` (§1 столпы, §6.3 запись/scenario_ulid/resume, §6.7 Stop); `e:\rabota\playwright project\tests_projec\docs\ui-deploy-research.md` (§5 судьба и упрощение агента).
- Заменяемый код агента: `apps\agent\assets\index.html` (панели/кнопки `:22-223`, Accounts/Merchants `:144-189`, тулбар `:201-207`, textarea `:220`); `apps\agent\assets\renderer.js` (опрос `:80`, alert `:174,251,279`, секрет в DOM `:416`, upload без ULID `:267`, контекст-меню `:690-803`, хардкод meta `:945-949`); `apps\agent\src\main.ts` (codegen `:133-161`, тихие трансформации `:266-267`, zip `:289-295`, upload POST `:300`, IPC readFile/writeFile `:207-214`, RuntimeState `:29-35`); `apps\agent\src\preload.ts` (IPC-поверхность `:3-26`); `apps\agent\assets\styles.css` (текущий хром).
- Применённая дизайн-система: токены §2, StatusBadge §3.1, LiveLogConsole §3.3, Table §3.4, Modal §3.6, Wizard §3.7, Toast §3.8, Tabs §3.9, Skeleton/Empty/Error §3.12, Button §3.13, FormField/SecretField §3.14, Breadcrumbs §3.15, ProgressBar §3.16, ConfirmDialog §3.18; конвенции §4.1 иконки, §4.2 real-time, §4.6 write-only секреты; движение §5.

---

## 9. Сквозные пользовательские сценарии (end-to-end)

У меня теперь полная картина: все экраны (§7), состояния (§5.3), машина состояний (§5.2), батч (§6.4, §7.5), Stop-механика (§6.7), 2FA (§8), резолв (§9.2), онбординг (§7.9), reachability (§7.8), sitemap (§3.2). Я опираюсь на дизайн-систему из задания (статусы §2.3, компоненты §3, глифы §4.1). Пишу финальный раздел сквозных сценариев.


---

### 0. Конвенции этого раздела (как читать сценарии)

> Каждый сценарий ниже — это сборка экранов из §7 спецификации в один сквозной поток. Имена экранов, маршруты и статусы берутся ДОСЛОВНО из `docs/ui-redesign-spec.md` (§3.2 sitemap, §7 экраны, §5 состояния, §6 завершаемость). Компоненты и глифы — из дизайн-системы (StatusBadge §3.1, PhaseTimeline §3.2, LiveLogConsole §3.3, статусы §2.3, глифы §4.1).

Единый язык глифов во всех storyboard'ах (из §4.1, повторено для самопроверки):
```
 ⋯ queued    ⟳ running    ✔ passed    ✖ failed (тест)    ⚠ error/timeout/interrupted (инфра)
 ⏹ stopped   🔐 2fa        ● set / ○ not set    ● reachable / ⚠ slow / ✖ unreachable / ⓘ docker↓
 ⊘ skipped (фаза из кеша)   ◀ здесь (активная стадия/узел)
```

Каждый сценарий маркирует три типа точек:
```
 ▣ FINISH    — точка завершения (явное терминальное состояние, столп 2)
 ✂ BREAK     — точка прерывания (краш/закрытие/рестарт/Stop)
 ↻ RESUME    — точка повтора/возобновления (idempotent/resumable)
 ⧖ LIVE      — где видны real-time статусы (SSE, пульс, таймер)
```

---

### 1. Сценарий «Онбординг нового пользователя» (от регистрации до первого `passed`)

**Цель.** Человек впервые открывает инструмент, заводит себя, аккаунт, проект, данные стенда, записывает сценарий в агенте, заливает и видит первый зелёный прогон.
**Актёр/роль.** Новый пользователь → становится `admin` своего `account_<userId>` (claim первого admin, spec §7.9).

**Пошаговая лента «экран · действие · что видит (real-time) · переход».**

1. **`/register` · Self-Register (§7.9c).** Вводит Email/Login + пароль (индикатор силы `▓▓▓ ok`) → `[Создать аккаунт]`. Сервер атомарно создаёт `accounts(account_<userId>)` + `memberships(account-wide, admin)` + пустой `projects` (§7.9 п.0, §9.3 п.0). ⧖ нет. → редирект на `/login` (или сразу сессия).
2. **`/login` · Login (§7.9a).** Email/пароль → `[Войти]`. 2FA входа ещё не включена → шага `/login/2fa` нет. → `/` → редирект на `/projects`.
3. **`/projects` · Мои проекты (§7.1).** Пользователь — admin своего аккаунта, проектов 0 (или один пустой) → активный CTA `[+ Новый проект]` (НЕ мёртвая кнопка, §7.9). primary-CTA = `+ Новый проект`. → Modal создания (§3.6): обязательно только **Название**.
4. **`/p/:pid` · Дашборд проекта (§7.2).** Пустой проект → EmptyState-чеклист онбординга `cred → env → сценарий` (§7.2, §3.12). → клик по шагу «credential» ведёт в `/p/:pid/credentials`.
5. **`/p/:pid/credentials` · Credentials (§7.7a).** primary-CTA = `[+ Добавить]` → Modal credential. Имя/Login (`→ {server_username}`), Password (write-only SecretField `[Заменить]`), **TOTP secret `[Задать…]`** (`→ {server_2faotp}`). После ввода base32 — бейдж `● валидный`; `[Проверить TOTP сейчас]` показывает 6-значный код 30с (ловит дрейф часов, §8.5). `[Сохранить]` → строка `stand-admin · ●set · ●set`.
6. **`/p/:pid/environments` · Environments (§7.7b-e, §7.8).** `[+ Environment]` (Name + base_url). primary внутри — `[Проверить]` доступность (это §7-сценарий 7 ниже). → видит `● 200 84ms`.
7. **Агент · Record (§5 spec deploy 4.5, сценарий 6 ниже).** Оператор открывает десктоп-агент, выбирает Project/Env/Name read-only из `GET /api/projects`, жмёт `Record` → `playwright codegen` (GUI) → пишет шаги → `Stop`. На Stop пишется `scenario_ulid` локально (§6.3). → экран **Review & Upload** (diff, metadata, inputs).
8. **Агент · Upload.** `Upload` → `POST /api/projects/:id/scenarios/upload` (multipart zip, upsert по `scenario_ulid` — идемпотентно, §6.3). Toast `✔ Загружено`. → в вебе сценарий появляется в дереве.
9. **`/p/:pid/scenarios` · Дерево сценариев (§7.3).** Новый сценарий `📄 withdraw-flow · — never`. primary-CTA = `[▶ Run]`. → Run-wizard (§7.6).
10. **Run-wizard Scope→Data→Execution (§7.6).** Шаг 1 Scope: выбирает окружение (с чипом `● stg 200 84ms`). Шаг 2 Data: credential `stand-admin` (`a***n · pwd ●set · 2FA ●set`), предпросмотр подстановки (`{server_2faotp} → on-demand код at run`). Шаг 3 Execution: `[▶ Запустить]`. → создаётся run, переход на `/p/:pid/runs/:rid`.
11. **`/p/:pid/runs/:rid` · Прогон LIVE (§7.4).** ⧖ LIVE: PhaseTimeline тикает, LiveLogConsole стримит (SSE `run.phase`/`run.log`), маркер `🔐 2FA подставлен`. → терминал `✔ passed`.
12. ▣ FINISH: `✔ passed` — Artifacts (trace/video), Outputs с `Add to pool`, длительность. Онбординг-чеклист на дашборде закрыт.

**Storyboard (6 кадров).**
```
[1] /register                       [2] /projects (admin, 0 проектов)
┌────────────────────────────┐      ┌──────────────────────────────────────┐
│ ts-playwright       🌐RU/EN │      │ Мои проекты         [ + Новый проект ]│  ← primary-CTA
│ Внутренний инструмент       │      │            ⊙                          │
│ Email/Login* [ anna@team  ] │      │   Пока нет проектов                   │
│ Пароль*      [ •••••• ]▓▓▓ok│      │   Создайте первый, чтобы начать       │
│ Повтор*      [ •••••• ]     │      │        [ + Новый проект ]             │
│        [ Создать аккаунт ]  │      └──────────────────────────────────────┘
└────────────────────────────┘        ▣ claim: первый admin своего account

[3] /p/:pid Дашборд — онбординг      [4] /p/:pid/credentials → Modal
┌──────────────────────────────┐    ┌─ Credential ─────────────────────────┐
│ Payments · Дашборд            │    │ Имя*     [ stand-admin   ]            │
│ ⊙ Пустой проект — 3 шага:      │    │ Login*   [ admin@stand   ] →server_username
│  ☐ 1. Добавить credential  →  │    │ Password [ ●●●● ][Заменить] (write-only)│
│  ☐ 2. Создать окружение    →  │    │ TOTP     [ ○ not set ][Задать…]      │
│  ☐ 3. Записать сценарий     →  │    │ [Проверить TOTP сейчас] → 482931 ·30s │
└──────────────────────────────┘    │              [ Отмена ] [ Сохранить ]│
   EmptyState ведёт к действию       └──────────────────────────────────────┘

[5] Агент Record ▸ Review ▸ Upload   [6] /p/:pid/runs/:rid  ▣ FINISH
┌─ Review & Upload ──────────────┐   ┌─ withdraw-flow ▸ r_5c1a   ✔ PASSED ──┐
│ scenario.spec.ts (diff) ▾      │   │ ✔Queued─✔Prepare─⊘Pull─✔Cont─✔Exec─✔ │
│ metadata.json · ulid 01H..  ●  │   │  0.2s   1.1s   —    2.1s  0:42  0.8s │
│ inputs: amount, currency       │   │ 🔐 2FA подставлен 12:04:25 · 24с      │
│ ⚠ auth_state.json исключён     │   │ [Live console][stdout][Outputs ②]    │
│        [ Replay ] [ ▶ Upload ] │   │ passed · 1240 строк · [Trace][Retry] │
└────────────────────────────────┘   └──────────────────────────────────────┘
   ✂ краш агента → resume (сцен.6)     ⧖ LIVE на шагах [5 запись] и [6 прогон]
```

**Завершение / прерывание / повтор.**
- ▣ FINISH: первый `✔ passed` на `/p/:pid/runs/:rid` (§5.3 passed).
- ✂ BREAK: краш агента до Upload → resume по `scenario_ulid` (сценарий 6); закрытие браузера на wizard → resumable-черновик `captureRunModalDraft` (§7.6) — поля целы.
- ↻ RESUME: Upload идемпотентен (upsert по ULID, без дублей); повторный запуск — `[▶ Run]` снова.

**Где видны real-time статусы.** Шаг 7 (счётчик шагов записи в агенте, push `webContents.send`), шаг 11 (PhaseTimeline-пульс + LiveLogConsole + `🔐 2FA`-маркер). Глобальный индикатор `[▶1 running]` в шапке с шага 11 (§4.2).

---

### 2. Сценарий «Ежедневный оператор» (batch со стадиями → частичный провал → Retry failed → промоут в пул)

**Цель.** Оператор запускает целую папку батчем, наблюдает прогресс по стадиям, часть падает, перезапускает только упавшее, кладёт удачные output'ы в пул.
**Актёр/роль.** `operator` (право на запуск/folder-run/retry, spec §6.3).

**Пошаговая лента.**

1. **`/login` · Login (+MFA) (§7.9a/9b).** Пароль → шаг `/login/2fa` (`[_ _ _ _ _ _]`, `☐ доверять устройству 30д`) → `[Подтвердить]`. → редирект на `/p/:lastProject` (cookie `last_project`, §2.3).
2. **ProjectSwitcher (§3.10, §2.3).** Текущий проект не тот → открывает switcher (поиск + список с `▶N running`), выбирает `Payments`. ⧖ LIVE: у каждого проекта живой счётчик running. Переключение = смена URL с сохранением подраздела (`/p/A/runs → /p/B/runs`).
3. **`/p/:pid/scenarios` · Дерево (§7.3).** Заходит в папку `payouts` → primary-CTA `[▶ Run]` (scope = крошки). → Run-wizard.
4. **Run-wizard Execution (§7.6 шаг 3).** В `▸ Advanced` включает `Parallel batch [4]` + `Execution stage`. Предупреждение масштаба `⚠ 4 контейнера разом · ~3 мин · workers свободно: 1`. `[▶ Запустить]`. → `/p/:pid/batches/:bid`.
5. **`/p/:pid/batches/:bid` · Батч (§7.5).** ⧖ LIVE: `ProgressBar` сегментирован по статусам (§3.16), стадии раскрашены, маркер `◀ здесь` на активной стадии, чипы прогонов тикают (`⟳ kyc·2(pull)`). SSE `batch.progress`/`stage.update`.
6. **Частичный провал.** Стадия 1 завершилась `partial` (`✖ deposit·2`). Батч-агрегат → `partial` (§6.4.1). primary-действие батча = `[Retry failed (1)]`.
7. **Retry failed (§6.4.3).** `[Retry failed (1)]` → новый run тем же `runtime_snapshot`, тем же `batch_id`, той же `execution_stage` (trace_id/pool не регенерятся). ⧖ LIVE: чип `deposit·2` снова `⟳ running`. → `✔ passed`. Батч-агрегат → `done`.
8. **Промоут output в пул.** Открывает удачный прогон `/p/:pid/runs/:rid` → вкладка **Outputs** (§7.4, §3.9) → на строке output `[Add to pool]`. Эффект привязан к `passed` (§6.1 п.5). Toast `✔ Добавлено в пул eth-addr`. → `/p/:pid/pools/:poolId` показывает +1 free.

**Storyboard (5 кадров).**
```
[1] /login → /login/2fa              [2] ProjectSwitcher (⧖ LIVE)
┌────────────────────┐               ┌─────────────────────────────────┐
│ Введите код 2FA     │               │ 🔍 [ pay…                     ] │
│ [4][8][2][9][3][1]  │               │ ● Payments    ▶2 running  ✓     │ ◀ выбрать
│ ☐ доверять 30д      │               │   KYC         idle              │
│   [ Подтвердить ]   │               │ ⚠ Withdrawals ▶1 🔔             │
└────────────────────┘               └─────────────────────────────────┘
                                        URL /p/A/runs → /p/B/runs (подраздел сохранён)

[3-4] Run-wizard · Execution (Advanced)        [5] /p/:pid/batches/:bid  ⧖ LIVE
┌─ RUN · payments/payouts · Step 3 of 3 ─┐     ┌─ BATCH b_8f3a · /payouts · anna ──────┐
│ Повторов [1]  ☑ Require {address}      │     │ ▓▓▓▓▓▓▓▓░░░░░░ 7/12 · 2⟳ · 3⋯ · 1✖    │
│ ▾ Advanced: stage[1] Parallel batch[4] │     │ S1 ✔done(4/4) ✔w·1 ✔w·2 ✔d·1 ✖d·2     │
│ ⚠ 4 контейнера · ~3мин · свободно:1    │     │ S2 ⟳running  ⟳kyc·1 ⟳kyc·2(pull) ⋯kyc·3◀здесь│
│            [←Назад] [ ▶ Запустить ]    │     │ S3 ○ waiting for stage 2              │
└────────────────────────────────────────┘     │ [ Retry failed (1) ] [Stop remaining]│ ← primary
                                                └──────────────────────────────────────┘
[6] Retry failed → done                  [7] Прогон ▸ Outputs → Add to pool ▣
┌─ BATCH b_8f3a  ✔ done ─────────────┐    ┌─ r_5c1a · Outputs ② ──────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓ 12/12 done            │    │ 0x9f3a…c1  payout_address  [Add to pool]│ ▣
│ S1 ✔ ✔w·1 ✔w·2 ✔d·1 ✔d·2(retry)   │    │ trace_8821 trace_id        [Add to pool]│
│ ↻ retry_of: тот же snapshot/batch  │    │ → Toast ✔ Добавлено в eth-addr (+1 free)│
└────────────────────────────────────┘    └────────────────────────────────────────┘
```

**Завершение / прерывание / повтор.**
- ▣ FINISH: батч-агрегат `done`/`partial`/`failed` (§6.4.1); промоут в пул — синхронный ответ, `last_fetched_at`/`+1 free`.
- ✂ BREAK: `[Stop remaining]` останавливает оставшиеся (`queued→cancelled`, `running→kill`, §6.7 п.5) → агрегат `cancelled`.
- ↻ RESUME: `Retry failed` идемпотентен (passed не дублируются, §6.4.3); промоут форсит `dedupe=true` (§6.5) — повторный Add не задваивает значение.

**Где видны real-time статусы.** Шаг 2 (живые `▶N` в switcher), шаг 5 (ProgressBar + чипы стадий + `◀ здесь` + SSE `batch.progress`), шаг 7 (повторный `⟳→✔` чипа).

---

### 3. Сценарий «Расследование упавшего прогона» (failed → Timeline → stderr/assertion → trace → Retry)

**Цель.** По красному прогону понять, на какой фазе и почему упал тест, посмотреть assertion и trace, перезапустить.
**Актёр/роль.** `operator`/`viewer` (просмотр всем, retry — operator+).

**Пошаговая лента.**

1. **`/p/:pid` Дашборд → RECENT FAILURES (§7.2) ИЛИ `/p/:pid/runs` журнал (§3.2, Recent runs).** Видит `✖ deposit·2 · failed (assertion) · 12:01 · [Trace][Retry]`. Цвет красный = тест, НЕ инфраструктура (инвариант §2.3). → клик по строке (строка кликабельна, §3.4) → `/p/:pid/runs/:rid`.
2. **`/p/:pid/runs/:rid` · Прогон, терминал failed (§7.4, §5.3 failed).** Бейдж `✖ failed`. PhaseTimeline показывает, на какой фазе упал: `✖Execute` красный (§3.2 «Падение на фазе»). META: `exit_code`, cred по ссылке.
3. **Timeline → клик по `✖Execute`.** Клик по сегменту → скролл LiveLogConsole/stderr к началу фазы (логи тегированы phase, §5.5). → видит точку падения.
4. **Вкладка stderr (§3.9, §7.4).** Видит assertion из stderr (`Expected #balance to be visible`), `screenshot_on_fail`. Текст копируем (не `alert`, §4.4).
5. **Вкладка Artifacts (§7.4).** `trace.zip`/video/screenshot стримом (не readFileSync). `[Trace]` открывает Playwright trace viewer.
6. ↻ RESUME: primary-CTA `[Retry]` (idempotent, trace_id не регенерится, §6.1 п.4). → новый run `retry_of r_5c1a`, переход на LIVE-прогон.

**Storyboard (5 кадров).**
```
[1] /p/:pid/runs — журнал (status-чипы)      [2] /runs/:rid  ✖ FAILED — Timeline
┌──────────────────────────────────────┐    ┌─ deposit·2 ▸ r_5c1a    ✖ FAILED ──────┐
│ [⋯q][⟳r][✔p][✖f][⚠e] 🔍[поиск] 📅    │    │ ✔Queued─✔Prepare─✔Pull─✔Cont─✖Execute─○│
│ ✖ deposit·2  failed(assert) 12:01 [▶]│ ←  │  0.2s   1.1s   2.1s  2.1s  0:42 FAIL   │
│ ✔ withdraw   passed         12:01    │    │                       └ красный, клик ↓│
│ ⚠ kyc-flow   error(docker)  11:48    │    │ META exit_code=1 · cred a***n · ACME  │
└──────────────────────────────────────┘    └──────────────────────────────────────┘
  красный=тест ≠ янтарный=инфра (§2.3)        клик по ✖Execute → стдерр к началу фазы

[3] stderr (assertion)                 [4] Artifacts → Trace          [5] Retry ↻
┌─ [stdout][stderr◀][Outputs][Artif]─┐ ┌─ Artifacts ④ ───────────┐  ┌─ r_7d2 ⟳ RUNNING ─┐
│ ✖ Error: expect(locator).toBeVisi-│ │ trace.zip   2.1MB [Trace]│  │ retry_of r_5c1a   │ ▣→↻
│   ble()                            │ │ video.webm  8.4MB [▶]    │  │ ✔Q─✔Prep─⊘Pull─⟳..│
│   Expected #balance visible        │ │ fail.png    [screenshot] │  │ trace_id НЕ регенер│
│   12:04:42  at withdraw.spec:24    │ │ stdout.log  [скачать]    │  │ ⧖ LIVE снова       │
│   [⧉ copy] (копируемо, не alert)   │ └──────────────────────────┘  └───────────────────┘
└────────────────────────────────────┘
```

**Завершение / прерывание / повтор.**
- ▣ FINISH: расследование «завершено», когда видна фаза+assertion+trace; новый Retry даёт свежий терминал.
- ✂ BREAK: n/a (прогон уже терминальный); если запускали Retry и передумали — `[Stop]` на новом LIVE-прогоне.
- ↻ RESUME: `[Retry]` (idempotent снапшот). Если корень — недоступный стенд, на `error`-прогоне есть `[Проверить сейчас]` (§5.9 точка 3) перед повтором.

**Где видны real-time статусы.** Шаги 1 и журнал — живой статус-бейдж патчится по SSE без reload (§4.2); шаг 6 — новый LIVE-прогон с пульсом Timeline.

---

### 4. Сценарий «Настройка и проверка 2FA стенда» (credential → TOTP write-only → бейдж валидности → тестовый код → маркер в LIVE)

**Цель.** Завести TOTP-секрет тестируемого стенда так, чтобы он никогда не утёк, убедиться в валидности, и увидеть момент его подстановки в живом прогоне.
**Актёр/роль.** `admin` (CRUD секретов и on-demand-код — admin-only, §6.3, §8.3).

**Пошаговая лента.**

1. **`/p/:pid/credentials` · Credentials (§7.7a).** primary-CTA `[+ Добавить]` или `⋯ → Edit` существующей. → Modal credential.
2. **Modal · TOTP secret write-only (§3.14 SecretField, §8.6).** Поле `TOTP secret [○ not set] [Задать…]` → ввод base32. Значение НЕ загружается обратно (write-only). `→ {server_2faotp}` показывает целевой плейсхолдер.
3. **Бейдж валидности (§8.5).** Синхронный `normalizeTotpSecret` → `● валидный` (base32 ок) ИЛИ `✖ не base32` (вместо `alert(сырой текст)`). ⧖ мгновенно при вводе.
4. **`[Проверить TOTP сейчас]` (§7.7a, §8.5).** Жмёт тестовый код → project-scoped эндпоинт `POST /api/projects/:pid/credentials/:cid/code` → показывает `code=482931 · expires_in 30s` (секрет в ответе ОТСУТСТВУЕТ; admin-only; audit `credential.totp_code_issued`). Если часы дрейфят — предупреждение (§8.2 п.2). `[Сохранить]` (`totp_secret_enc`, AES-256-GCM).
5. **Источник 2FA (Advanced) (§7.7a).** Раскрывает `▸ Источник 2FA`: `◉ TOTP-секрет (генерим код at run)` / `○ On-demand через API` / `○ Ввод вручную ({{INPUT:2fa_otp}})`. Один выбор вместо трёх разрозненных механизмов.
6. **Run-wizard Data (§7.6 шаг 2).** При запуске видит в предпросмотре `{server_2faotp} → on-demand код at run` (маскировано, секрет не показан, §4.6).
7. **`/p/:pid/runs/:rid` · LIVE → маркер 2FA (§7.4, §8.5).** ⧖ LIVE: в момент подстановки рантайм пишет структурную строку → в Timeline/META маркер `🔐 2FA подставлен 12:04:25 · действ. 24с` (фиолетовый StatusBadge `2fa`, §2.3). НИКОГДА код/секрет. Если `|drift|>1 шаг` — предупреждение в маркере.

**Storyboard (5 кадров).**
```
[1-2] Modal credential — TOTP write-only       [3] Бейдж валидности (⧖ мгновенно)
┌─ Credential ─────────────────────────────┐   ввод base32 →
│ Login*  [ admin@stand ] → server_username │   [ JBSWY3DPEHPK… ]  ● валидный
│ Password[ ●●●● ][Заменить] (write-only)   │   ввод мусора →
│ TOTP    [ ○ not set ][ Задать… ]          │   [ zzz!!! ]         ✖ не base32
│   → {server_2faotp}                       │   (НЕ alert — инлайн badge, §8.5)
│ ▸ Источник 2FA (Advanced)                 │
└───────────────────────────────────────────┘

[4] Проверить TOTP сейчас (admin-only)         [5] Источник 2FA (Advanced)
┌─ Проверка TOTP ──────────────────────────┐   ┌─ ▾ Источник 2FA ───────────────────┐
│  Код:  4 8 2 9 3 1                        │   │ ◉ TOTP-секрет (генерим код at run) │
│  действ. ▓▓▓▓▓░ 22s                       │   │ ○ On-demand код через API          │
│  ⚠ секрет в ответе отсутствует            │   │ ○ Ввод вручную {{INPUT:2fa_otp}}   │
│  audit: credential.totp_code_issued       │   └────────────────────────────────────┘
└──────────────────────────────────────────┘     один выбор вместо трёх механизмов

[6] Run-wizard Data — предпросмотр       [7] /runs/:rid LIVE — маркер 🔐  ⧖ LIVE
┌─ ПРЕДПРОСМОТР ПОДСТАНОВКИ ──────────┐   ┌─ withdraw-flow ▸ r_5c1a  ⟳ RUNNING ──┐
│ {server_username} → a***n           │   │ META cred stand-admin · 2FA ●set      │
│ {server_password} → ●set            │   │ ┌─ Live console ──────────────────┐   │
│ {server_2faotp}   → on-demand at run│   │ │ 12:04:23 ✓ login form           │   │
│  (секрет НЕ показан, §4.6)          │   │ │ 🔐 2FA подставлен 12:04:25·24с  │ ← │
└─────────────────────────────────────┘   │ │ 12:04:26 ✓ code accepted        │   │
                                           │ └─────────────────────────────────┘   │
                                           └──────────────────────────────────────┘
                                              НИКОГДА код/секрет в логе (§8.5)
```

**Завершение / прерывание / повтор.**
- ▣ FINISH: `[Сохранить]` → бейдж `●set`; `[Проверить TOTP сейчас]` подтверждает валидность до запуска.
- ✂ BREAK: ввод невалидного base32 → `✖ не base32`, сохранение заблокировано (не молчит). Дрейф часов → предупреждение в маркере, тест мог упасть `failed` (молчаливый дрейф из §5.7 теперь виден).
- ↻ RESUME: повторный запуск перечитывает секрет по `credential_version` (§8.3); потеря KEK → бейдж `⚠ требует повторного ввода` (§3.14, §8.6), admin перевводит.

**Где видны real-time статусы.** Шаг 3 (мгновенный бейдж валидности), шаг 4 (живой обратный отсчёт TTL кода), шаг 7 (`🔐`-маркер в LiveLogConsole + Timeline, индикатор дрейфа).

---

### 5. Сценарий «Мультипроект» (переключение, изоляция данных, разные `server_*` — как не запутаться)

**Цель.** Пользователь работает в нескольких проектах, данные стендов разные, и интерфейс на каждом шаге доказывает, в каком проекте он находится.
**Актёр/роль.** Пользователь с членством в нескольких проектах (account-wide или project-level, §2.1).

**Пошаговая лента (опираясь на 5 механизмов изоляции §2.4).**

1. **ProjectSwitcher (§3.10).** В проекте `Payments` (полоса `--project-accent` слева, цвет = `hash(projectId)`, §2.8). Открывает switcher → выбирает `Withdrawals`. Переключение = смена URL `/p/Payments/credentials → /p/Withdrawals/credentials` (подраздел сохранён, §2.3).
2. **Breadcrumbs + цвет (§3.15, механизм 2+1).** Крошки `● Withdrawals ▸ Credentials` — точка `--project-accent` в КАЖДОЙ крошке. Заголовок вкладки браузера `Withdrawals · Credentials — ts-playwright` (механизм 4).
3. **`/p/:pid/credentials` — изоляция данных (§7.7a, §2.5).** Видит ТОЛЬКО credentials проекта `Withdrawals` (`WHERE project_id`). Счётчики на карточке проекта (§7.1) `1 cred` доказывают изоляцию. Тот же login `botuser1` в другом проекте — другой секрет, невидим (§9.2 «Изоляция»).
4. **Запуск — бейдж проекта на CTA (механизм 3, §2.4).** primary-CTA `[▶ Run · Withdrawals]` несёт имя проекта. Run-wizard Data резолвит `server_*` из `Withdrawals` (другой credential/merchant/pool).
5. **Cross-project переход по ссылке (механизм 5, §2.4).** Коллега прислал ссылку `/p/Payments/runs/:rid`. Открывает → баннер «Вы в проекте **Payments** (перешли по ссылке)» + цвет/крошки сменились. Не путается, потому что URL — источник истины.
6. **Опасное действие — имя проекта в диалоге (§3.18).** Удаляет пул → ConfirmDialog `⚠ Удалить пул в проекте Withdrawals?` + масштаб (412 значений, 3 сценария).

**Storyboard (4 кадра).**
```
[1] Switcher: Payments → Withdrawals     [2] Breadcrumbs + цвет проекта
┌─────────────────────────────────┐      ● Withdrawals ▸ Credentials
│ ▌Payments ▾   (полоса teal)     │      └ точка --project-accent (rose) в КАЖДОЙ крошке
│   🔍 [ with…              ]     │      tab: «Withdrawals · Credentials — ts-playwright»
│   ● Payments    ▶2 ✓            │      ▌цвет шапки сменился teal→rose (механизм 1)
│ ⚠ Withdrawals   ▶1 🔔   ◀выбрать│
└─────────────────────────────────┘      URL /p/Payments/credentials → /p/Withdrawals/credentials

[3] Изоляция данных (WHERE project_id)   [4] Запуск — бейдж проекта на CTA
┌─ Withdrawals · Credentials ────────┐   ┌─ Withdrawals ▸ payouts ──[ ▶ Run·Withdrawals ]─┐
│ wd-admin  w***n  ●set  ●set  [Код] │   │ Run-wizard Data:                                │
│ (ТОЛЬКО этого проекта · 1 cred)    │   │  CREDENTIAL [ wd-admin ▾ ] → w***n               │
│ ⓘ login "botuser1" из Payments —   │   │  (списки = ТОЛЬКО Withdrawals; server_* изолир.) │
│    здесь невидим (§9.2 изоляция)   │   │  {server_merchant} → WD-ACME (не ACME из Payments)│
└────────────────────────────────────┘   └─────────────────────────────────────────────────┘

[5] Cross-project по ссылке (баннер)     [6] Опасное действие — имя проекта
┌────────────────────────────────────┐   ┌─ ConfirmDialog ──────────────────────┐
│ ⓘ Вы в проекте Payments             │   │ ⚠ Удалить пул в проекте Withdrawals?  │
│   (перешли по ссылке)   [понятно]  │   │ Пул «wd-addr» · 412 свободных · 3 сцен.│
│ ▌цвет/крошки = Payments (teal)     │   │ Введите имя: [ wd-addr        ]       │
│ /p/Payments/runs/r_5c1a            │   │            [Отмена] [ 🗑 Удалить ]    │
└────────────────────────────────────┘   └──────────────────────────────────────┘
```

**Завершение / прерывание / повтор.**
- ▣ FINISH: переключение завершено, когда URL+цвет+крошки+title согласованы на новый проект.
- ✂ BREAK: попытка открыть чужой проект (нет членства) → 404 (не 403, не раскрываем существование, §3.2). Гард тот же для роутов, SSE и POST (§9.4).
- ↻ RESUME: вернуться в прежний проект — switcher снова; cookie `last_project` помнит последний для голого `/`.

**Где видны real-time статусы.** В switcher живой `▶N running` по каждому проекту (один SSE `/api/stream/execution`, scope по проекту, §5.4); глобальный индикатор `[▶N]` в шапке остаётся виден при переключении.

---

### 6. Сценарий «Запись и публикация в агенте с прерыванием» (запись → краш → resume по `scenario_ulid` → Review → идемпотентный Upload)

**Цель.** Записать сценарий в десктоп-агенте, пережить краш/закрытие, продолжить с того же места, опубликовать без дублей.
**Актёр/роль.** Оператор за рабочей машиной QA (агент — тонкий рекордер, deploy §5).

**Пошаговая лента.**

1. **Агент · выбор цели (read-only) (deploy §5).** Project/Env/Name/Folder/URL — read-only выбор из `GET /api/projects` (без секретов, только login + метка). primary = `Record`.
2. **Агент · Record (§6.3).** `Record` → `playwright codegen` (GUI, локальный браузер). ⧖ LIVE: push-события `webContents.send` — `recording-started`, `step-recorded` со счётчиком (`12 шагов`). НЕ опрос раз в секунду.
3. **Агент · Stop → локальный `scenario_ulid` (§6.3).** `Stop` → редактор НЕ чистится (код виден сразу, autosave); `scenario_ulid` пишется в `metadata.json` локально. Состояние `recorded(local)`.
4. ✂ BREAK: **краш/закрытие агента** (память Electron потеряна, `state.runtime`).
5. **Агент · перезапуск → resume (§6.3).** При старте скан tempDir по ULID → плашка «Незавершённая запись — **продолжить** / отбросить». ↻ RESUME: выбирает «продолжить» → возвращается к тому же черновику (тот же `scenario_ulid`).
6. **Агент · Review & Upload (§7.9 deploy §5).** Экран Review показывает финальный zip: `scenario.spec.ts` с diff трансформаций (`replaceBaseUrl`, `forceExactOptionNameMatches`), `metadata.json`, отфильтрованные inputs, предупреждение `⚠ auth_state.json` (сессионные куки).
7. **Агент · Upload (идемпотентно) (§6.3).** `Upload` → `POST /api/.../scenarios/upload` upsert по `scenario_ulid` (БЕЗ дублей — сегодня без ключа дедупликации дубли, `renderer.js:267-277`). ⧖ LIVE: push `zip→POST→done`, не `alert`. → Toast `✔ Опубликовано`.
8. ▣ FINISH: финальное состояние записи = успешный Upload с `scenario_ulid` (uploaded(server)).

**Storyboard (5 кадров).**
```
[1-2] Агент Record (⧖ LIVE push)         [3] Stop → локальный ulid (без очистки)
┌─ Агент ▸ withdraw-flow ─────────────┐  ┌─ Editor (autosave) ─────────────────┐
│ Project [Payments▾] Env [stg▾] (RO) │  │ await page.goto(...)                 │
│ [ ● Record ]  ⟳ recording…          │  │ await page.fill('#user', server_user)│
│ ▸ 12 шагов записано                 │  │ ... (код виден сразу, не очищен)     │
│   step-recorded → webContents.send  │  │ metadata.json: ulid 01HX… ●          │
└─────────────────────────────────────┘  └──────────────────────────────────────┘
   НЕ опрос — push-события                 состояние: recorded(local)

[4] ✂ краш/закрытие             [5] Перезапуск → RESUME ↻
┌────────────────────┐          ┌─ Агент (старт) ──────────────────────────┐
│  ✖ агент закрыт    │          │ ⚠ Незавершённая запись найдена            │
│  state.runtime     │          │   withdraw-flow · ulid 01HX… · 12 шагов   │
│  потерян (память)  │          │   [ Продолжить ]   [ Отбросить ]          │
└────────────────────┘          └──────────────────────────────────────────┘
                                   скан tempDir по scenario_ulid (§6.3)

[6] Review & Upload                      [7] Upload идемпотентно ▣
┌─ Review & Upload ──────────────────┐   ┌─ Upload ──────────────────────────┐
│ scenario.spec.ts (diff) ▾          │   │ zip → POST → done  ✔              │ ▣
│ metadata.json · ulid 01HX… (ключ)  │   │ upsert по scenario_ulid           │
│ inputs: amount, currency           │   │ (повтор Upload → НЕ дубль)        │
│ ⚠ auth_state.json — куки, исключить │   │ Toast: ✔ Опубликовано             │
│       [ Replay ]   [ ▶ Upload ]    │   │ ↻ повторный Upload идемпотентен   │
└────────────────────────────────────┘   └───────────────────────────────────┘
```

**Завершение / прерывание / повтор.**
- ▣ FINISH: успешный Upload с `scenario_ulid` — единственная точка пересечения клиент→сервер (§6.3).
- ✂ BREAK: краш до Stop → черновик autosave; краш после Stop → resume по ULID (шаг 5).
- ↻ RESUME: продолжить запись по `scenario_ulid`; Upload upsert идемпотентен (повтор без дублей).

**Где видны real-time статусы.** Шаг 2 (живой счётчик шагов записи, push), шаг 7 (живой прогресс `zip→POST→done` вместо блокирующего `alert`).

---

### 7. Сценарий «Проверка доступности стенда перед запуском» (wizard/окружение → Проверить → ок/недоступен/Docker down → решение)

**Цель.** Убедиться, что тестируемый стенд достижим из той же среды, что и реальный прогон, и осознанно решить, запускать ли.
**Актёр/роль.** `operator`/`admin`.

**Пошаговая лента (§7.8, §5.9).**

1. **`/p/:pid/environments` · Environments (§7.7b-e) ИЛИ Run-wizard Scope (§7.6 шаг 1).** Чип окружения `prod [проверить]`. primary внутри панели = `[▶ Проверить]`.
2. **Панель «Проверить доступность стенда» (§7.8).** ⧖ LIVE: SSE `stand.availability`. Два источника параллельно: **С ХОСТА** (Node-fetch) и **ИЗ КОНТЕЙНЕРА** (как раннер, `docker run --rm curl`). Показывает HTTP-код, латентность, TLS, DNS.
3. **Исход A — ок.** `С ХОСТА ● 200 OK 84ms TLS✔` + `ИЗ КОНТЕЙНЕРА ● 200 OK 121ms DNS✔`. Решение: запускать. Результат кэшируется как last-known для чипа wizard (§5.9 точка 1).
4. **Исход B — недоступен.** `С ХОСТА ● 200` / `ИЗ КОНТЕЙНЕРА ✖ unreachable (timeout)`. Расхождение немедленно диагностирует сетевой блокер (раннер не видит стенд — VPN/подсеть, deploy §5 риск). Решение: НЕ запускать с этого хоста.
5. **Исход C — Docker down (§5.9 ключевое различение).** `С ХОСТА ● 200` / `ИЗ КОНТЕЙНЕРА ⓘ Docker недоступен — проверка из контейнера невозможна` (отдельный статус `--reach-docker` muted, НЕ ложный `✖ unreachable`, §2.3). Вывод: «Стенд отвечает с хоста; достижимость из раннера не проверена (Docker недоступен)».
6. **Встройка в wizard (§5.9 точка 1).** В Run-wizard Scope чип окружения показывает last-known `● stg 200 84ms`; авто-проверка перед `[▶ Запустить]` не блокирует жёстко, но предупреждает.
7. ▣ Решение: запускать (исход A) / чинить сеть (B) / чинить Docker (C).

**Storyboard (4 кадра + 3 исхода).**
```
[1] /p/:pid/environments → [Проверить]   [2] Панель (⧖ LIVE, 2 источника)
┌─ Payments · Environments ──────────┐   ┌─ Проверка · env: prod ───────[✕]──┐
│ stg  base_url …stg   ● 200 [Провер]│   │ BASE_URL https://prod… [▶Проверить]│
│ prod base_url …prod  ? [Проверить] │   │ С ХОСТА          ⟳ проверяем…      │ ⧖
│              [ + Environment ]     │   │ ИЗ КОНТЕЙНЕРА     ⟳ docker run…    │
└────────────────────────────────────┘   └───────────────────────────────────┘

[3A] ИСХОД ok → запускать          [3B] ИСХОД сеть-блокер → НЕ запускать
┌───────────────────────────────┐  ┌──────────────────────────────────────┐
│ С ХОСТА      ● 200 84ms TLS✔  │  │ С ХОСТА      ● 200 OK 84ms            │
│ ИЗ КОНТЕЙН.  ● 200 121ms DNS✔ │  │ ИЗ КОНТЕЙН.  ✖ unreachable (timeout)  │ ◀ блокер
│ → решение: ЗАПУСКАТЬ ✔        │  │ → раннер не видит стенд (VPN/подсеть) │
└───────────────────────────────┘  │ → решение: НЕ запускать с этого хоста │
                                    └──────────────────────────────────────┘
[3C] ИСХОД Docker down (различение)   [4] Встройка в wizard Scope
┌──────────────────────────────────┐ ┌─ RUN Step 1 · Scope ─────────────────┐
│ С ХОСТА      ● 200 OK 84ms       │ │ Окружение*                            │
│ ИЗ КОНТЕЙН.  ⓘ Docker недоступен  │ │ ( ● stg [200 84ms] ) (○ prod [провер])│
│   — проверка из контейн. невозм. │ │ last-known чип · авто-проверка перед  │
│ (НЕ ложный ✖, §5.9 · muted)      │ │  [▶ Запустить] — не блокирует жёстко  │
│ → чинить Docker, потом запускать │ └──────────────────────────────────────┘
└──────────────────────────────────┘
```

**Завершение / прерывание / повтор.**
- ▣ FINISH: решение принято (запускать / чинить сеть / чинить Docker) на основе двух источников.
- ✂ BREAK: таймаут источника (8s хост / 12s контейнер) → результат `✖ unreachable (timeout)` с числом попыток (2 ретрая backoff 0.5s/1.5s, §5.9).
- ↻ RESUME: `[▶ Проверить]` повторно (idempotent, кэшируется last-known); с `error`-прогона есть `[Проверить сейчас]` (§5.9 точка 3) для повторной диагностики.

**Где видны real-time статусы.** Шаг 2 (SSE `stand.availability`, оба источника тикают `⟳ проверяем…`), история проверок с таймстемпами (§7.8), last-known чип в wizard/дашборде (§5.9).

---

### 8. Сценарий «Восстановление после рестарта сервера во время батча» (interrupted → Дозавершить незавершённые стадии)

**Цель.** Сервер перезапустился посреди батча; пользователь видит честное состояние и одной кнопкой дозавершает то, что не доехало.
**Актёр/роль.** `operator`/`admin`.

**Пошаговая лента (§6.4.2, §5.2 interrupted, §7.5).**

1. **✂ BREAK: рестарт сервера во время батча.** In-memory очередь (`queueMicrotask`) и реестр процессов теряются; исполняющиеся контейнеры убиты рестартом.
2. **`recoverInterruptedRuns` (§6.1 п.3, §5.2).** На старте сервер финализирует висящие строки: читает `result.json` (восстанавливает `passed`/`failed`, если контейнер успел дописать) ИЛИ ставит `error · interrupted` с лог-записью «сервер перезапускался». batch-aware расширение (§6.4.2) находит незапущенные стадии.
3. **`/p/:pid/runs/:rid` · прогон interrupted (§5.3 interrupted).** Бейдж `⚠ interrupted` (янтарный, инфра, НЕ красный-тест, §2.3). META «сервер перезапускался во время прогона». primary-CTA `[Retry]`.
4. **`/p/:pid/batches/:bid` · Батч (§7.5).** ⧖ LIVE: батч-агрегат показывает прерванные стадии. Появляется кнопка `⚠ [Дозавершить незавершённые (3)]` (resumable, только при незавершённых стадиях после рестарта, §6.4.2).
5. **`[Дозавершить незавершённые]` (§6.4.2).** Незавершённые стадии повторно ставятся в `run_queue` (state `waiting`/`waiting_stage`), диспетчер с лизами их подхватывает. ⧖ LIVE: стадии `S2/S3` оживают `○ waiting → ⟳ running`, маркер `◀ здесь` едет дальше. Persistent-очередь (§5.8) — пред-условие, без неё дозавершение умерло бы при следующем рестарте.
6. ▣ FINISH: батч-агрегат `done`/`partial` после дозавершения всех стадий. Идемпотентность эффектов (`effects_applied`, §6.5) — пулы/импорты не применяются дважды для восстановленных-в-passed.

**Storyboard (5 кадров).**
```
[1] ✂ рестарт во время батча          [2] recoverInterruptedRuns (старт)
┌────────────────────────────┐        ┌─ server boot ──────────────────────────┐
│  ⟳ батч выполнялся…        │        │ • running без result.json → ⚠ interrupted│
│  ✖ сервер перезапущен      │        │ • running с result.json   → ✔/✖ восстан. │
│  queueMicrotask потерян    │        │ • batch-aware: найдены незавершённые     │
│  контейнеры убиты          │        │   стадии S2(частично), S3(не стартовала) │
└────────────────────────────┘        └──────────────────────────────────────────┘

[3] /runs/:rid  ⚠ INTERRUPTED          [4] /batches/:bid — Дозавершить  ⧖ LIVE
┌─ kyc·2 ▸ r_9a3   ⚠ INTERRUPTED ────┐ ┌─ BATCH b_8f3a ── ⚠ прерван ───────────┐
│ ✔Queued─✔Prepare─⚠Pull(interrupted)│ │ ▓▓▓▓▓░░░░░░░ 5/12 · 0⟳ · 0⋯ · 5✔ · 2✖ │
│ "сервер перезапускался во время    │ │ S1 ✔done(4/4)                          │
│  прогона" (янтарный ≠ красный)     │ │ S2 ⚠ прервана (2/4 доехало)            │
│ META triggered_by anna             │ │ S3 ○ не стартовала                     │
│            [ Retry ]               │ │ ⚠ [ Дозавершить незавершённые (3) ] ←  │ ↻ resumable
└────────────────────────────────────┘ └────────────────────────────────────────┘

[5] После Дозавершить (⧖ LIVE → ▣)
┌─ BATCH b_8f3a ── ⟳ выполняется → ✔ done ─────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓ 12/12 done                                          │ ▣
│ S2 ⟳→✔ (kyc·3,kyc·4 поставлены в run_queue · waiting→running)    │
│ S3 ⟳→✔ (стартовала после S2) ◀ здесь едет дальше                 │
│ effects_applied: пулы/импорты НЕ применены дважды (§6.5)         │
└──────────────────────────────────────────────────────────────────┘
```

**Завершение / прерывание / повтор.**
- ▣ FINISH: батч-агрегат `done`/`partial` после дозавершения; восстановленные строки имеют честный терминальный статус (не висят `running` вечно).
- ✂ BREAK: рестарт — само прерывание; `recoverInterruptedRuns` гарантирует, что ни один run не остаётся в `running` без процесса.
- ↻ RESUME: `[Дозавершить незавершённые (N)]` (batch-aware, persistent-очередь §5.8); per-run `[Retry]` для interrupted-строк (idempotent снапшот). Эффекты идемпотентны (`effects_applied`).

**Где видны real-time статусы.** Шаг 4 (батч-агрегат с прерванными стадиями, SSE `batch.progress`), шаг 5 (стадии оживают `○→⟳→✔`, `◀ здесь` едет, ProgressBar дополняется по SSE без reload).

---

### Сквозная матрица: завершение / прерывание / повтор / real-time по сценариям

| # | Сценарий | ▣ Завершение | ✂ Прерывание | ↻ Повтор/возобновление | ⧖ Где real-time |
|---|---|---|---|---|---|
| 1 | Онбординг | первый `✔ passed` (§5.3) | краш агента / закрытие wizard | Upload upsert по ULID; resumable-черновик | счётчик записи; PhaseTimeline+LiveLog; `🔐` |
| 2 | Оператор-батч | агрегат `done/partial` (§6.4.1) | `Stop remaining` (§6.7) | `Retry failed` idempotent; `dedupe=true` промоут | switcher `▶N`; ProgressBar+стадии+`◀ здесь` |
| 3 | Расследование failed | фаза+assertion+trace видны | `Stop` на новом Retry-прогоне | `[Retry]` снапшот; `[Проверить сейчас]` для error | патч бейджа по SSE; новый LIVE-прогон |
| 4 | 2FA стенда | `[Сохранить]`→`●set`; тестовый код | `✖ не base32` блокирует; дрейф→предупреждение | перечитка по `credential_version`; re-entry при потере KEK | бейдж валидности; TTL кода; `🔐`-маркер |
| 5 | Мультипроект | URL+цвет+крошки+title согласованы | 404 на чужой проект (§3.2) | switcher; cookie `last_project` | `▶N` по проектам в switcher; глоб. `[▶N]` |
| 6 | Запись+прерывание | Upload с `scenario_ulid` | краш/закрытие агента | resume по ULID; Upload upsert | счётчик шагов записи; `zip→POST→done` |
| 7 | Доступность стенда | решение (A/B/C) по 2 источникам | таймаут источника (8s/12s) | `[▶ Проверить]` повторно; last-known кэш | SSE `stand.availability`, оба источника `⟳` |
| 8 | Рестарт во время батча | агрегат `done/partial` после дозавершения | рестарт сервера | `[Дозавершить (N)]` (§6.4.2); per-run `[Retry]` | агрегат прерванных стадий; `○→⟳→✔` по SSE |

Каждый из восьми потоков ПРОЗРАЧЕН (real-time статус виден на каждом нетерминальном шаге через SSE/пульс/таймер, без `location.reload()`), ЗАВЕРШАЕМ (явная ▣-точка с терминальным `status`/`outcome`/агрегатом) и ПОВТОРЯЕМ (↻-точка idempotent/resumable: ULID-upsert, `runtime_snapshot`, `Retry failed`, batch-aware дозавершение, last-known reachability).

**Эталонные источники раздела.** `docs/ui-redesign-spec.md` — §3.2 (sitemap/маршруты), §5.2-5.3 (машина состояний и данные по состояниям), §5.4 (SSE), §5.9 (reachability), §6.2-6.4 (флоу/батч), §6.7 (Stop-механика), §7.1-7.9 (все экраны, их имена и моки), §8.3-8.6 (2FA, write-only, KEK). Дизайн-система — §2.3 (статусы), §3.1-3.18 (компоненты), §4.1 (глифы), §4.2 (real-time-конвенции).

---

## 10. Дополнения и исправления


### Дополнения и исправления

> Раздел закрывает пробелы и расхождения по итогам ревью полноты. Не повторяет уже описанное (токены §2, компоненты §3, конвенции §4, экраны §3-9) — только добавляет недостающие моки/состояния и чинит терминологические расхождения. Дизайн-система применяется без изменений: статусы §2.3, HealthIndicator §3.11, Table §3.4, Tabs §3.9, FormField/SecretField §3.14, Skeleton/EmptyState/ErrorState §3.12, ConfirmDialog §3.18, write-only §4.6, real-time §4.2.

---

### Д.1. HealthIndicator: добавлена строка «Server ● up» (5-я строка) — §3.11, §5 виджет Health

**Что это.** Расхождение с эталоном: spec §7.2/§5.7 рисует виджет HEALTH с ПЯТЬЮ строками (`Server ● up 12d`, Docker, Image cache, Disk, Clock(NTP)), а HealthIndicator §3.11 и все моки дашборда §5 (состояния 1/2/4/5/6) показывали только 4 — строка `Server` отсутствовала и как состояние компонента, и в моках. Аптайм хоста — это health-сигнал, обязан быть виден везде, где есть исполнение.

**К какому разделу.** §3.11 (HealthIndicator — закрепить состояние Server) + §5 раздел 1 (дашборд, виджет HEALTH) + §3.5 (Card — выровнять набор строк, см. Д.7).

**Закрепляемое состояние компонента (добавляется в §3.11):**
```
● up      зелёный   Server uptime 12d 04:11   ← аптайм процесса/хоста раннера
⟳ restart синий     Server just restarted (uptime <5m, пульс)  ← после рестарта,
                       связан с interrupted-прогонами (§5.2, recoverInterruptedRuns)
⚠ flap    янтарный  Server uptime 0:42 · 3 рестарта за час   ← нестабилен, частые рестарты
✖ down    красный   Server unreachable (этот виджет — last-known, рисуется при обрыве SSE)
```

**Полный 5-строчный виджет HEALTH (канон для всех моков дашборда §5):**
```
┌─ HEALTH (раннер-хост) ────────┐
│ Server      ● up 12d 04:11    │  ← НОВАЯ 1-я строка (аптайм процесса раннера)
│ Docker      ● ready v27       │
│ Image cache ● present 1.52    │
│ Disk /data  ▓▓▓░ 61%          │
│ Clock(NTP)  ● in sync · 12ms  │
└────────────────[▸ Подробнее]─┘
```

**Состояние «сервер недавно перезапускался» (увязка с interrupted-прогонами §5.2/§8 сценарий 8):**
```
┌─ HEALTH (раннер-хост) ────────┐
│ Server      ⟳ restarted 0:42  │  ← синий пульс; uptime <5m
│  └ прогоны могли прерваться → проверьте батчи  [Дозавершить →]
│ Docker      ● ready v27       │
│ Image cache ● present 1.52    │
│ Disk /data  ▓▓▓▓ 78%  ⚠ rising│
│ Clock(NTP)  ● in sync · 12ms  │
└────────────────[▸ Подробнее]─┘
```

**Деградация (правка §5 состояние 5 — Server в last-known при обрыве):**
```
│ Server      ✖ down (last-known 12d, поток health закрыт)  │  ← красный, как Docker ✖
```

Источник данных: SSE `GET /api/stream/health` (`execution.health`), поле `server_uptime_sec` (process uptime раннера) + счётчик рестартов за окно. Аптайм mono (§2.4), тикает на клиенте (§4.2, requestAnimationFrame). Все остальные моки дашборда §5 (состояния 1/2/4/6) и Card §3.5 получают строку `Server ● up <uptime>` первой в виджете HEALTH.

---

### Д.2. Экран `/account/system` (Система: воркеры/Docker/NTP/image cache, admin) — §4, §6.8

**Что это.** Главный (high) пробел: экран из sitemap (spec §3.2) был лишь упомянут в скобках (§6.8) и выведен «в отдельный раздел спеца». Это единственный хост-уровневый экран, где Docker/NTP/disk/image-cache/воркеры живут в реальном времени; HealthIndicator §3.11 нарисован, но его «домашний» экран не спроектирован.

**К какому разделу.** §4 (Уровень аккаунта) — новый экран account-навбара между «Пользователи» и «Аудит»; маршрут `/account/system` (spec §3.2). Admin/super-only (как «Пользователи»/«Аудит», §4.1.2).

- **Primary-CTA:** нет (это монитор хоста, не форма). Действия — точечные по строкам.
- **Overflow по секциям:** Docker → `Перепроверить`; Image cache → `Pull образ`, `Очистить неиспользуемые`; Worker → `Drain` (вывести из ротации), `Resume`.
- **Advanced:** «Сырой `docker info`», «История NTP-дрейфа» (uPlot спарклайн, §1.1), env-конфиг лимитов (`APP_RUN_TIMEOUT_MS`, concurrency).
- **Данные/откуда:** SSE `GET /api/stream/health` + `GET /api/stream/execution` (хост-агрегат): `workers`/`run_queue` (§5.8), `docker version`/`docker info` (`execute.ts:446`), `docker image inspect` (`:463`), диск `/data`, `queryNtpDrift` (`execute.ts:84`). Account-уровень → рельса проекта НЕТ (§4.1).
- **Переходы:** worker `busy` → `/p/:pid/runs/:rid` исполняемого прогона; Docker `✖` ведёт сюда же из дашборда проекта (§5 состояние 5, ссылка «Проверить Docker (Система) →»); image cache → список образов.

**Состояние 1 — default (хост здоров):**
```
┌────────────────────────────────────────────────────────────────────────────────┐
│ [≡] ts-playwright   Аккаунт ▸ Система            [▶3 running][🔔0][🌐RU][anna ▾] │
├────────────────────────────────────────────────────────────────────────────────┤
│  Мои проекты  Пользователи  [ Система ]  Аудит  Профиль        ← admin-only      │
├────────────────────────────────────────────────────────────────────────────────┤
│  Система · раннер-хост                                          обновлено только что│
│  ┌─ HOST ─────────────────────────┐  ┌─ DOCKER ──────────────────────────────┐  │
│  │ Server   ● up 12d 04:11         │  │ Daemon   ● ready · v27.1.1            │  │
│  │ Disk /data ▓▓▓░ 61% · 184G своб.│  │ Transport copy · DOCKER_HOST unix://… │  │
│  │ Clock(NTP) ● in sync · drift 12ms│  │ [ Перепроверить ]                    │  │
│  │  └ TOTP стендов корректны        │  └────────────────────────────────────────┘  │
│  └─────────────────────────────────┘  ┌─ IMAGE CACHE ─────────────────────────┐  │
│  ┌─ WORKERS ─────────────────────────┐ │ ● playwright:v1.52.0-jammy · 1.52 GB  │  │
│  │ всего 4 · busy 3 · idle 1 · drain 0│ │   present · last pull 3д назад        │  │
│  │ Concurrency ▓▓▓░ 3/4              │ │ ○ playwright:v1.49 · отсутствует       │  │
│  │ ─────────────────────────────────│ │ [ Pull образ ]  [ Очистить неисп. ]   │  │
│  │ w1 ● busy  withdraw-flow  exec 0:42│ └────────────────────────────────────────┘  │
│  │ w2 ● busy  deposit-card   pull 0:50│  ┌─ QUEUE ──────────────────────────────┐  │
│  │ w3 ● busy  kyc-1          coll 0:08│  │ depth 12 · waiting 9 · waiting_stage 3│  │
│  │ w4 ○ idle  —                       │  │ persistent (run_queue) ● активна     │  │
│  │   [Drain w-?]                      │ │ oldest wait 0:38 · ETA дренажа ~6м    │  │
│  └───────────────────────────────────┘ └────────────────────────────────────────┘  │
│  ▸ Advanced: docker info · история NTP-дрейфа · лимиты (APP_RUN_TIMEOUT_MS …)    │
└────────────────────────────────────────────────────────────────────────────────┘
  ⧖ LIVE: воркеры/очередь/health патчатся по SSE без reload (§4.2); таймеры тикают клиентом
```

**Состояние 2 — loading (skeleton до снапшота health/execution):**
```
│  ┌─ HOST ──────────────────┐  ┌─ DOCKER ────────────────────┐                   │
│  │ ▦▦▦▦▦▦  ▦▦▦▦▦▦▦▦         │  │ ▦▦▦▦▦▦   ▦▦▦▦▦▦▦▦            │  ← shimmer §5.4     │
│  │ ▦▦▦▦▦▦  ▦▦▦▦▦▦           │  │ ▦▦▦▦▦▦▦▦▦▦                   │                    │
│  └──────────────────────────┘  └──────────────────────────────┘                   │
│  ┌─ WORKERS ────────────────┐  ┌─ IMAGE CACHE ───────────────┐                   │
│  │ ▦▦▦▦ ▦▦▦▦ ▦▦▦▦  ▦▦▦▦▦▦▦  │  │ ▦▦ ▦▦▦▦▦▦▦▦▦▦▦  ▦▦▦▦         │                   │
│  │ ▦▦ ▦ ▦▦▦▦▦▦▦▦▦▦ ▦▦▦▦ ▦▦▦ │  │ ▦▦ ▦▦▦▦▦▦▦▦▦▦▦               │                   │
│  └──────────────────────────┘  └──────────────────────────────┘                   │
│   подключение к потоку состояния хоста…  (Skeleton §3.12, не спиннер)             │
```

**Состояние 3 — empty (воркеров нет / стенд только поднят):**
```
│  ┌─ WORKERS ─────────────────────────────────────────────────────────────────┐  │
│  │                              ⊙                                              │  │
│  │            Нет зарегистрированных воркеров                                  │  │
│  │   Очередь run_queue активна, но ни один воркер не подключён — прогоны       │  │
│  │   будут ждать. Проверьте процесс раннера и Docker.                         │  │
│  │            [ Перепроверить Docker ]                                         │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
   EmptyState §3.12 — не тупик, ведёт к диагностике.
```

**Состояние 4 — деградация (Docker ✖, дрейф NTP, диск, очередь in-memory):**
```
│  ┌─ HOST ─────────────────────────┐  ┌─ DOCKER ──────────────────────────────┐  │
│  │ Server   ● up 0:42 ⚠ 3 рестарта│  │ Daemon   ✖ unavailable                │  │
│  │ Disk /data ▓▓▓▓▓ 92% ✖ alert    │  │  └ docker version не отвечает          │  │
│  │ Clock(NTP) ⚠ drift 1.4s         │  │ [ Перепроверить ]                     │  │
│  │  └ ломает 2FA стендов МОЛЧА      │  └────────────────────────────────────────┘  │
│  └─────────────────────────────────┘  ┌─ IMAGE CACHE ─────────────────────────┐  │
│  ┌─ WORKERS ─────────────────────────┐ │ ⓘ неизвестно (Docker недоступен)       │  │
│  │ ⚠ воркеры недоступны — Docker down │ │                                       │  │
│  └───────────────────────────────────┘ └────────────────────────────────────────┘  │
│  ┌─ QUEUE ───────────────────────────────────────────────────────────────────┐  │
│  │ ⚠ run_queue не активна — очередь in-memory, позиции не сохраняются (§5.8). │  │
│  │   При рестарте незапущенные прогоны потеряются (нет «Дозавершить»).        │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
│  ┌─ ⚠ Деградация хоста ──────────────────────────────────────────────────────┐  │
│  │ Docker недоступен → новые прогоны падают error (не failed). NTP-дрейф 1.4s │  │
│  │ → 2FA-коды стендов отклоняются. Диск 92% → сбор артефактов под угрозой.    │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
  Docker ✖ красный · drift ⚠ янтарный · диск 92% ✖ · виджеты деградируют поштучно (§4.5)
```

**Состояние 5 — error (загрузка экрана не удалась) / 6 — no-permission:**
```
ERROR (поток health/execution недоступен):           NO-PERMISSION (operator/viewer открыл напрямую):
┌────────────────────────────────────────┐           ┌────────────────────────────────────────────┐
│   ⚠ Не удалось загрузить состояние хоста │           │  🔒 Система — только для администратора        │
│   server_unreachable · поток закрыт      │           │  Ваша роль: operator. Состояние раннер-хоста   │
│   [ Повторить ]   [ подробнее ]          │           │  видно только admin/super.                     │
└────────────────────────────────────────┘           └────────────────────────────────────────────┘
   ErrorState §3.12 · code→t() (§3.3)                    403-экран по роли (раздел существует, НЕ 404)
```

---

### Д.3. Вкладка «Inputs/Outputs» сценария — отдельный мок тела вкладки — §5 раздел 3

**Что это.** Вкладка `[ Inputs/Outputs ② ]` объявлена в наборе вкладок просмотра сценария (§5 раздел 3) и счётчик показан, но ASCII самого тела вкладки не было — inputs/outputs показывались только свёрнуто внутри Overview. Дизайнер не имел макета, как отображаются inputs с типами и outputs с маппингом на пул.

**К какому разделу.** §5 раздел 3 (Просмотр сценария) — добавляется как отдельный вид вкладки (Tabs §3.9). Read-only (правка inputs/outputs — на стороне записи в агенте, §8; здесь только просмотр контракта). Данные: `ScenarioMetadataSchema.inputs[]/outputs[]` (`schemas.ts:35-61`).

**Состояние: default (вкладка Inputs/Outputs, есть оба):**
```
┌───────────────┬────────────────────────────────────────────────────────────────────────┐
│ │▸Payments ▾│ │ ● Payments ▸ payouts ▸ withdraw-flow                       [ ▶ Run ][⋯] │
│  Сценарии ◀    │ [ Overview ]·[ Code ]·[ Inputs/Outputs ② ◀ ]·[ История ⑤ ]              │
│               │ ┌─ INPUTS (2) ───────────────────────────────────────────────────────┐ │
│               │ │ Имя        │ Тип            │ Источник при запуске    │ Обязателен │ │
│               │ │────────────┼────────────────┼─────────────────────────┼────────────│ │
│               │ │ amount     │ number         │ Run-wizard · SHARED     │ ✔ да       │ │
│               │ │ currency   │ enum[USDT,USD] │ Run-wizard · SHARED     │ ✔ да       │ │
│               │ │ 2fa_otp    │ 2fa_otp        │ {server_2faotp} (cred)  │ — спец.    │ │ ← особый тип
│               │ └────────────────────────────────────────────────────────────────────┘ │
│               │ ┌─ OUTPUTS (2) ──────────────────────────────────────────────────────┐ │
│               │ │ Ключ       │ Извлечение        │ Маппинг на пул        │ Тип       │ │
│               │ │────────────┼───────────────────┼───────────────────────┼───────────│ │
│               │ │ trace_id   │ from #receipt-id  │ → pool «trace» (auto) │ string    │ │ ← маппинг
│               │ │ receipt_url│ from a.download@href│ — (не в пул)         │ url       │ │
│               │ └────────────────────────────────────────────────────────────────────┘ │
│               │  ⓘ Read-only: контракт задаётся при записи в агенте. enum/типы из metadata│
└───────────────┴────────────────────────────────────────────────────────────────────────┘
  тип 2fa_otp подсвечен (контракт 2FA §8); маппинг output→pool показывает связь с §7.7.3
```

**Состояние: empty (сценарий без inputs/outputs — счётчик ⓪):**
```
│ [ Overview ]·[ Code ]·[ Inputs/Outputs ⓪ ◀ ]·[ История ]                              │
│ ┌────────────────────────────────────────────────────────────────────────────────┐   │
│ │                              ⊙                                                    │   │
│ │            У сценария нет объявленных inputs и outputs                            │   │
│ │   Сценарий запускается без параметров и не публикует значения в пулы.            │   │
│ │   Inputs/outputs объявляются при записи в агенте ({{INPUT:name}}, PW_OUTPUT).    │   │
│ │            [ Как объявить? ]                                                      │   │
│ └────────────────────────────────────────────────────────────────────────────────┘   │
  EmptyState §3.12 — объясняет, откуда берётся контракт (не тупик)
```

(Состояния loading/error вкладки наследуют общий skeleton/ErrorState просмотра сценария §5 раздел 3, состояния 4/6 — отдельного мока не требуют.)

---

### Д.4. Экран «Настройки проекта» `/p/:pid/settings` (общие/удаление/архив + под-вкладка Участники) — §4

**Что это.** Пункт «Настройки» есть в рельсе (AppShell §1.1), маршрут `/p/:pid/settings` есть в sitemap (spec §3.2), но сам экран не раскрыт: показана только под-вкладка Участники (§4 раздел 5.2). Удаление/архив проекта показаны через `⋯` карточки на `/projects` (§4 раздел 4.6/4.7), но НЕ в контексте `/p/:pid/settings`, куда ведёт рельс.

**К какому разделу.** §4 (Уровень аккаунта/проекты) — новый project-уровневый экран (рельс + switcher + цв.полоса есть, это project-scope). Под-вкладки (Tabs §3.9): `Общие · Участники · Опасная зона`. «Участники» уже описана (§4 раздел 5.2) — здесь только каркас и недостающие вкладки «Общие» и «Опасная зона».

- **Primary-CTA:** на вкладке «Общие» — `[ Сохранить ]` (локально); на «Опасная зона» — нет (только danger-действия).
- **Overflow/Advanced:** «Общие» → `▸ Дублировать настройки в новый проект (без секретов)` (§4 раздел 4.2).
- **Данные/откуда:** `GET /api/projects/:pid` (`ProjectSchema` `schemas.ts:63` + `color_token`, `status`); `PATCH /api/projects/:pid`; счётчики масштаба для удаления — агрегаты scenarios/runs/credentials/pools.
- **Переходы:** «Архивировать»/«Удалить» → ConfirmDialog §3.18 (та же механика, что §4 раздел 4.7, но достижимая из рельса); смена цвета → мгновенная перекраска `--project-accent` каркаса.

**Состояние: вкладка «Общие» (default):**
```
┌─ Payments · Настройки ────────────────────────────────────────────────────────┐
│  [ Общие ◀ ]·[ Участники ]·[ Опасная зона ]                ← Tabs §3.9          │
│  ──────────                                                                     │
│  Название*   [ Payments                          ]  Уникально в аккаунте        │
│  Цвет проекта  ( ●teal )( ○indigo )( ○amber )( ○rose )…   ← смена → перекраска  │
│  Статус        ◉ active   ○ archived              ← архив (обратимо)            │
│  ────────────────────────────────────────────────────────────────────────────  │
│  Сводка изоляции: 42 сценария · 5 creds · 3 merchant · 4 пула · env: stg,prod   │
│  ▸ Дублировать настройки в новый проект (без секретов)   ← §4 раздел 4.2        │
│                                                          [ Сохранить ]          │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Состояние: вкладка «Опасная зона» (архив/удаление в контексте экрана):**
```
┌─ Payments · Настройки ────────────────────────────────────────────────────────┐
│  [ Общие ]·[ Участники ]·[ Опасная зона ◀ ]                                     │
│                          ▔▔▔▔▔▔▔▔▔▔▔                                            │
│  ┌─ Архивировать проект ─────────────────────────────────────────────────────┐ │
│  │ Проект станет read-only, исчезнет из активного списка. Обратимо.           │ │
│  │                                              [ Архивировать ]              │ │ ← danger §3.13, лёгкое
│  └────────────────────────────────────────────────────────────────────────────┘ │
│  ┌─ Удалить проект ──────────────────────────────────────────────────────────┐ │
│  │ Безвозвратно: 42 сценария · 128 прогонов · 5 creds (с секретами) ·          │ │ ← МАСШТАБ (§3.18)
│  │ 3 мерчанта · 4 пула (831 значение).                                        │ │
│  │                                              [ 🗑 Удалить проект ]          │ │ ← → ConfirmDialog ввод имени
│  └────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
  «Удалить» → ConfirmDialog §3.18 с вводом имени проекта (необратимо), как §4 раздел 4.7.
  «Архивировать» → лёгкое подтверждение без ввода имени.
```

**Состояния loading/error** наследуют каркас project-уровня (§1.3/§1.4): skeleton полей формы (§3.12) и ErrorState `project_not_found`/`server_unreachable`. Под-вкладка «Участники» — целиком §4 раздел 5.2/5.7 (loading/empty/error/no-permission там описаны), не дублируется.

---

### Д.5. Батч: состояния empty и error-загрузки — §6 раздел 5.E

**Что это.** У экрана батча были loading/done/cancelled/partial/interrupted, но не было `empty` (batch_id указывает на батч из 0 валидных runs / все отфильтрованы) и `error` загрузки (стрим `batch.progress` недоступен). Для остальных экранов документ настаивает на полном наборе default/loading/empty/error.

**К какому разделу.** §6 раздел 5.E (Экран батча) — добавляются два недостающих состояния к 5.E.4.

**Состояние: empty (батч без валидных стадий/прогонов):**
```
┌─ BATCH b_0empty · Run folder /payouts · started by anna · 12:04 ─────────[ ⋯ ]─┐
│ Progress ░░░░░░░░░░░░░░  0/0                                                     │
│ Состояние: ⊙ батч пуст                                                          │
│────────────────────────────────────────────────────────────────────────────────│
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │                              ⊙                                              │ │
│ │            В батче нет прогонов                                             │ │
│ │   Папка не содержала запускаемых сценариев, либо все были отфильтрованы     │ │
│ │   (scope пуст). Стадии не созданы.                                          │ │
│ │   [ ← К дереву сценариев ]   [ ▶ Настроить запуск заново ]                  │ │ ← не тупик
│ └────────────────────────────────────────────────────────────────────────────┘ │
│ [ Retry failed (0) ✕ ]   [ Stop remaining ✕ ]   (нечего — обе скрыты/disabled) │
└──────────────────────────────────────────────────────────────────────────────────┘
  EmptyState §3.12 — объясняет причину (пустой scope/фильтр), ведёт назад к запуску
```

**Состояние: error загрузки экрана (стрим `batch.progress` недоступен):**
```
┌─ BATCH b_8f3a · Run folder /payouts ─────────────────────────────────────[ ⋯ ]─┐
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │   ⚠ Не удалось загрузить батч                                                │ │
│ │   server_unreachable · поток batch.progress закрыт                          │ │
│ │   (переподключение через 3с… EventSource Last-Event-ID, §5.4)               │ │
│ │   [ Повторить сейчас ]   [ подробнее ]                                       │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│  last-known (если был снапшот): Progress ▓▓▓▓▓▓░░ 6/12 · стадии заморожены      │ ← деградация
└──────────────────────────────────────────────────────────────────────────────────┘
  ErrorState §3.12 · code→t() (§3.3) · если снапшот уже приходил — показываем last-known
  прогресс замороженным, как §5.C.15 (страница прогона), а не пустой экран
```

---

### Д.6. `/login/2fa`: собственный мок состояния locked (rate-limit на MFA) — §3 раздел 3.6

**Что это.** Блокировка (rate-limit) на шаге MFA была показана только текстом «3 неверных подряд → плашка rate-limit (как 3.4)» без собственного мока. Для `/login` locked-состояние нарисовано детально (3.4), а для `/login/2fa` — лишь ссылка текстом. MFA-брутфорс — реальная поверхность атаки; единообразие состояний двух почти одинаковых экранов входа не выдержано.

**К какому разделу.** §3 (Аутентификация) раздел 3.6 — добавляется явный locked-мок для `/login/2fa` (симметрично 3.4). Триггер: `429 too_many_totp_attempts` с `retry_after` после 3 неверных кодов подряд.

**Состояние: `/login/2fa` locked (rate-limit на MFA-шаге):**
```
                         ┌──────────────────────────────────────────┐
                         │  ts-playwright                  🌐 RU ▾   │
                         │  🛡 Двухфакторный вход                     │  ← 🛡 (Login MFA, НЕ 🔐)
                         │  ─────────────────────────────────────    │
                         │  ┌────────────────────────────────────┐   │
                         │  │ ⚠ Слишком много попыток 2FA         │   │  ← ErrorState, --status-error
                         │  │   3 неверных кода подряд.            │   │     янтарный (как 3.4)
                         │  │   Повторите через 0:48              │   │
                         │  │   ▓▓▓▓▓▓▓▓░░░░  обратный отсчёт      │   │  ← таймер тикает клиентом (§4.2)
                         │  └────────────────────────────────────┘   │
                         │      [_] [_] [_]   [_] [_] [_]             │  ← ячейки disabled до 0:00
                         │  ☐ Доверять этому устройству 30 дней        │     (заблокированы)
                         │  [        ▶ Подтвердить               ]    │  ← disabled, разблок. по 0:00
                         │  Использовать резервный код →              │  ← остаётся доступен (обход brute,
                         │  ← Назад ко входу                          │     recovery не под тем же лимитом)
                         └──────────────────────────────────────────┘
   Симметрично 3.4 (/login locked). Отличие: ссылка «Использовать резервный код» активна
   и во время блокировки — легитимный путь при потере телефона (§3.7), recovery-эндпоинт
   имеет собственный отдельный rate-limit. audit login.2fa_rate_limited.
```

---

### Д.7. Auto-import rules пула — собственный мок со состояниями — §7.7.3

**Что это.** «Auto-import rules» упомянута в overflow `⋯` пула и в Advanced модалки пула (`auto_import_*` поля), но не имела собственного мока. «Fetch info» имеет мок запущенного состояния (§7.7.3), а конфигурация правил auto-import (когда/откуда автоматически тянуть значения в пул) — нет. `runtime-cabinet.md` описывает `auto_import_*` как самостоятельную функцию пула.

**К какому разделу.** §7.7.3 (Pools) — добавляется модалка «Auto-import rules» со своими состояниями. Открывается из `⋯ пула → Auto-import rules`.

- **Primary-CTA:** `[ Сохранить правило ]`. **Overflow:** Включить/Выключить правило · Запустить сейчас · Удалить.
- **Данные/откуда:** `pools.auto_import_*` (runtime-cabinet): источник (output-ключ сценария / fetch-сценарий), фильтр (статус прогона, JSON-path), расписание (после каждого passed-прогона сценария / по cron / вручную), dedupe. `GET/PUT /api/pools/:poolId/auto-import`.

**Состояние: default (правило настроено, включено):**
```
┌─ Auto-import rules · pool «eth-addr» ────────────────────────────────[ ✕ ]───┐
│  Автоматическое пополнение пула из прогонов/fetch.   Статус: ● включено        │
│────────────────────────────────────────────────────────────────────────────────│
│ Источник*    ◉ Output прогонов сценария   ○ Fetch-сценарий                      │
│ Сценарий     [ payments/payouts/withdraw-flow ▾ ]                              │
│ Output key*  [ deposit_address              ]   когда сценарий публикует ключ   │
│ Триггер*     ◉ После каждого passed-прогона   ○ По расписанию [ cron … ]        │
│ Фильтр       Статус [ passed ▾ ]   JSON-path (Advanced) [ .data[].addr ]        │
│ Dedupe       ✓ on → существующие value обновятся, не задвоятся                  │
│────────────────────────────────────────────────────────────────────────────────│
│ Последний импорт: 11:30 · +4 значения · 0 дублей          [ Запустить сейчас ]  │
│                                            [ Выключить ]   [ Сохранить правило ] │
└────────────────────────────────────────────────────────────────────────────────┘
  → при passed-прогоне withdraw-flow сервер читает output deposit_address и upsert'ит в пул
```

**Состояние: empty (правил нет) / выполняется / error:**
```
EMPTY (auto-import не настроен):                  RUNNING (правило срабатывает сейчас, ⧖ LIVE):
┌─ Auto-import rules · pool «eth-addr» ──────┐    ┌─ Auto-import · pool «eth-addr» ───────────┐
│              ⊙                              │    │ ⟳ импорт из прогона r_5c1a · withdraw-flow│
│  Авто-пополнение не настроено               │    │ output deposit_address → пул               │
│  Пул наполняется только вручную / Fetch.    │    │ ▓▓▓▓▓░░ 3/4 значения · dedupe ✓           │
│  [ + Создать правило ]                      │    │ (push по SSE, без reload)                  │
└────────────────────────────────────────────┘    └────────────────────────────────────────────┘
ERROR (источник недоступен / output-ключ не найден в последних прогонах):
│ ⚠ Правило не сработало: output «deposit_address» не найден в passed-прогонах    │
│   withdraw-flow за период. error.auto_import_key_missing   [ Изменить правило ] │
```

---

### Д.8. Электрон-агент: replay loading-перед-стартом и replay-empty (пустой код) — §8 этап ② Запись

**Что это.** Для replay были idle/recording/recorded/replay-running/replay-passed/failed, но не покрыты: подготовка replay (loading перед стартом) и «нажал Replay при пустом коде» (нечего реплеить). Документ требует полный набор состояний.

**К какому разделу.** §8 раздел 5 (этап ② Запись) — добавляются два граничных под-состояния replay между 5.3 (recorded) и 5.4 (replay running).

**Состояние: replay loading (подготовка перед стартом — между нажатием и первой строкой):**
```
│ ② Запись   ● │ ┌─ КОНВЕЙЕР ───────────────────────────────────────────┐  │
│              │ │ [ ⏹ Отмена ]   ⟳ Подготовка replay…                  │  │ ← между нажатием и стартом
│              │ └──────────────────────────────────────────────────────┘  │
│              │ ┌─ Replay ─────────────────────────────────────────────┐   │
│              │ │ ⟳ запускаем локальный прогон записанного кода…         │   │ ← Skeleton/спиннер фазы
│              │ │   ▸ проверка кода · старт браузера                     │   │   (ещё нет log-строк)
│              │ │   (вывод появится через секунду)                      │   │
│              │ └──────────────────────────────────────────────────────┘   │
   push replay-progress ещё не пришёл → показываем подготовку, не «пустой» экран (§4.5)
```

**Состояние: replay-empty (нажал Replay при пустом коде — нечего реплеить):**
```
│ ② Запись   ● │ ┌─ КОНВЕЙЕР ───────────────────────────────────────────┐  │
│              │ │ [ ● Запись ]   Replay(⊘)   Review →(⊘)               │  │ ← Replay снова disabled
│              │ └──────────────────────────────────────────────────────┘  │
│              │ ┌─ Replay недоступен ──────────────────────────────────┐   │
│              │ │ ⊙ Нечего реплеить — код сценария пуст                  │   │ ← EmptyState §3.12
│              │ │   Сначала запишите шаги (Record) или вставьте код.    │   │
│              │ │   [ ● Начать запись ]                                 │   │ ← ведёт к действию
│              │ └──────────────────────────────────────────────────────┘   │
   Toast (вместо alert): «⊙ Нет шагов для replay» · кнопка Replay остаётся ⊘ пока код пуст
   (предотвращает запуск codegen-replay вхолостую)
```

---

### Д.9. Унификация терминологии навигации (расхождения подписей)

**Что это.** Четыре расхождения подписей между разделами документа и относительно spec. Чинятся унификацией; ниже — закреплённый канон для всех экранов.

**К какому разделу.** Сквозное — §4 (AppShell/рельс), §5 (дашборд), §7 (кабинет), плюс пометка устаревшего мока spec §7.4.

| # | Расхождение | КАНОН (закрепляется) | Где править |
|---|---|---|---|
| 1 | Рельс «Переменные» (рус.) vs вкладка «Project Variables» (англ.) | **Рельс: «Переменные»** (рус., как все пункты рельса). **Вкладка/заголовок: «Переменные проекта»** (рус.). Маршрут `/p/:pid/variables` (spec §3.2). Английское «Project Variables» НЕ используется в подписях — только в коде/схемах. | §4 §1.1 (рельс — уже «Переменные», ок); §7.7.1 шапка вкладок и §7.7.5 заголовок — заменить «Project Variables» → «Переменные проекта» |
| 2 | Рельс «Обзор» vs заголовок «Дашборд» | **Рельс: «Обзор»** (LayoutDashboard). **Заголовок экрана: «Обзор»** (а не «Дашборд»). Один термин для `/p/:pid`. Внутреннее имя компонента/маршрута — `dashboard`, но в UI везде «Обзор». | §5 раздел 1 — в моках заголовок «Payments · Дашборд» → «Payments · Обзор»; «Dashboard◀» (наследие spec §7.2) не использовать в UI |
| 3 | Health-виджет: 4 строки (§5) vs 5 (spec §7.2) vs 2 (Card §3.5) | **Канон — 5 строк:** Server · Docker · Image cache · Disk · Clock(NTP) (Д.1). Card §3.5 — это эскизный пример, помечается явно как сокращённый («2 строки — иллюстрация Card, полный набор см. §3.11/Д.1»), либо приводится к 5 строкам. | §3.5 (Card — пометка/выравнивание), §5 все моды HEALTH (Д.1) |
| 4 | PhaseTimeline: канон §5.1 (7 фаз) vs устаревший мок spec §7.4 («○Execute─○Artifacts») | **Канон = §5.1:** `queued·prepare·pull_image·create_container·execute·collecting·done` (как во всех моках документа). **Мок spec §7.4 устарел** (показывает `Execute─Artifacts` без collecting/done) — при сверке игнорировать, следовать §5.1. | Явная пометка в §3.2 (PhaseTimeline) и §6: «канон фаз — §5.1; инлайн-мок spec §7.4 устарел» |

**Пометка для §3.2 PhaseTimeline и §6 (зафиксировать в тексте):**
```
⚠ Канон последовательности фаз — spec §5.1 (7 фаз: queued·prepare·pull_image·
  create_container·execute·collecting·done). Инлайн-мок spec §7.4 показывает
  устаревшую последовательность «○Execute─○Artifacts» (без collecting/done) —
  это рассинхрон внутри самого spec. Все моки документа следуют §5.1; при сверке
  с §7.4 дизайнер ДОЛЖЕН игнорировать его фазовую цепочку.
```

**Пометка для §3.5 Card (Health как эскиз):**
```
ⓘ Набор строк HEALTH в примере Card §3.5 — сокращённый (иллюстрация компонента
  Card, не контракт виджета). Полный канонический виджет HEALTH — 5 строк
  (Server·Docker·Image cache·Disk·Clock), см. §3.11 / Д.1. Дашборд §5 использует
  все 5; Card-пример допускает усечение, но не задаёт набор.
```

---

Все восемь пробелов и четыре расхождения закрыты: добавлены строка `Server ● up` в HealthIndicator (Д.1), полноценный экран `/account/system` с 6 состояниями (Д.2), тело вкладки Inputs/Outputs (Д.3), экран `/p/:pid/settings` с вкладками Общие/Опасная зона (Д.4), empty+error батча (Д.5), locked-мок `/login/2fa` (Д.6), модалка Auto-import rules (Д.7), replay loading/empty агента (Д.8), и унифицирована терминология навигации с пометкой устаревшего spec §7.4 (Д.9). Дизайн-система (токены §2, компоненты §3, конвенции §4, движение §5), write-only-секреты §4.6 и разведение 🛡 Login MFA / 🔐 Stand 2FA соблюдены во всех новых моках.
