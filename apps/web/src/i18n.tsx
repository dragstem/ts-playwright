import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "./api";

export type Lang = "en" | "ru";

// Lightweight i18n (no framework): a flat key→string dictionary + a localStorage-backed switcher.
// Technical, internal tool — only the UI chrome and headings are translated; missing keys fall back
// to English, then to the key itself.
const DICT: Record<Lang, Record<string, string>> = {
  en: {
    "nav.dashboard": "Dashboard",
    "nav.projects": "Projects",
    "nav.runs": "Runs",
    "nav.batches": "Batches",
    "nav.credentials": "Credentials",
    "nav.merchants": "Merchants",
    "nav.pools": "Pools",
    "nav.tokens": "Tokens",
    "nav.users": "Users",
    "nav.audit": "Audit",
    "nav.running": "running",
    "action.logout": "Logout",
    "dashboard.title": "Dashboard",
    "dashboard.projects": "Projects",
    "dashboard.activeRuns": "Active runs",
    "dashboard.passed": "Passed (recent)",
    "dashboard.failed": "Failed (recent)",
    "dashboard.recentFailures": "Recent failures",
    "dashboard.noFailures": "No recent failures. 🎉",
    "login.signIn": "Sign in",
    "login.register": "Register",
    "common.loading": "Loading…",
    "action.save": "Save",
    "action.delete": "Delete",
    "action.create": "Create",
    "action.cancel": "Cancel",
    "action.close": "Close",
    "action.add": "Add",
    "modal.close_confirm": "Are you sure you want to leave? Unsaved changes will be lost.",
    "modal.close_confirm_label": "Leave",
    "form.login": "login",
    "form.password": "password",
    "form.password_keep": "password (leave empty to keep)",
    "form.merchant_name": "merchant name",
    "form.pool_name": "pool name",
    "form.scope": "Scope",
    "form.scope_global": "Global (all projects)",
    "page.projects": "Projects",
    "page.scenarios": "Scenarios",
    "page.runs": "Runs",
    "page.batches": "Batches",
    "page.credentials": "Stand credentials",
    "page.merchants": "Merchants",
    "page.pools": "Pools",
    "page.tokens": "Access tokens",
    "page.users": "Users",
    "page.audit": "Audit log",
    "err.project.not_found": "Project not found",
    "err.scenario.not_found": "Scenario not found",
    "err.run.not_found": "Run not found",
    "err.account.not_found": "Stand credential not found",
    "err.merchant.not_found": "Merchant not found",
    "err.batch.not_found": "Batch not found",
    "err.pool.not_found": "Pool not found",
    "err.auth.invalid_credentials": "Invalid login or password",
    "err.auth.unauthorized": "Please sign in to continue",
    "err.mfa.invalid_code": "Invalid authentication code",
    "err.mfa.challenge_invalid": "Login session expired — sign in again"
  },
  ru: {
    "nav.dashboard": "Дашборд",
    "nav.projects": "Проекты",
    "nav.runs": "Прогоны",
    "nav.batches": "Батчи",
    "nav.credentials": "Учётки",
    "nav.merchants": "Мерчанты",
    "nav.pools": "Пулы",
    "nav.tokens": "Токены",
    "nav.users": "Пользователи",
    "nav.audit": "Аудит",
    "nav.running": "в работе",
    "action.logout": "Выйти",
    "dashboard.title": "Дашборд",
    "dashboard.projects": "Проекты",
    "dashboard.activeRuns": "Активные прогоны",
    "dashboard.passed": "Успешные (недавние)",
    "dashboard.failed": "Упавшие (недавние)",
    "dashboard.recentFailures": "Недавние сбои",
    "dashboard.noFailures": "Недавних сбоев нет. 🎉",
    "login.signIn": "Войти",
    "login.register": "Регистрация",
    "common.loading": "Загрузка…",
    "action.save": "Сохранить",
    "action.delete": "Удалить",
    "action.create": "Создать",
    "action.cancel": "Отмена",
    "action.close": "Закрыть",
    "action.add": "Добавить",
    "modal.close_confirm": "Вы точно хотите выйти? Несохранённые изменения будут потеряны.",
    "modal.close_confirm_label": "Выйти",
    "form.login": "логин",
    "form.password": "пароль",
    "form.password_keep": "пароль (пусто — оставить прежний)",
    "form.merchant_name": "название мерчанта",
    "form.pool_name": "название пула",
    "form.scope": "Область",
    "form.scope_global": "Глобально (все проекты)",
    "page.projects": "Проекты",
    "page.scenarios": "Сценарии",
    "page.runs": "Прогоны",
    "page.batches": "Батчи",
    "page.credentials": "Учётки стендов",
    "page.merchants": "Мерчанты",
    "page.pools": "Пулы",
    "page.tokens": "Токены доступа",
    "page.users": "Пользователи",
    "page.audit": "Журнал аудита",
    "err.project.not_found": "Проект не найден",
    "err.scenario.not_found": "Сценарий не найден",
    "err.run.not_found": "Прогон не найден",
    "err.account.not_found": "Учётка стенда не найдена",
    "err.merchant.not_found": "Мерчант не найден",
    "err.batch.not_found": "Батч не найден",
    "err.pool.not_found": "Пул не найден",
    "err.auth.invalid_credentials": "Неверный логин или пароль",
    "err.auth.unauthorized": "Требуется вход",
    "err.mfa.invalid_code": "Неверный код подтверждения",
    "err.mfa.challenge_invalid": "Сессия входа истекла — войдите снова"
  }
};

// Module-level active language, kept in sync by LanguageProvider so non-hook helpers (toasts) can
// localize. Falls back to English, then to the server-provided message.
let activeLang: Lang = "en";

export function localizeError(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `err.${error.code}`;
    const localized = DICT[activeLang][key] ?? DICT.en[key];
    if (localized) {
      return localized;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string) => string;
}

const LangContext = createContext<LangContextValue>({ lang: "en", setLang: () => {}, t: (k) => k });

function readInitialLang(): Lang {
  try {
    const stored = localStorage.getItem("tsp_lang");
    if (stored === "ru" || stored === "en") {
      return stored;
    }
  } catch {
    // ignore (private mode / no storage)
  }
  return "en";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitialLang);
  activeLang = lang; // keep the module-level translator in sync for non-hook helpers
  const value = useMemo<LangContextValue>(
    () => ({
      lang,
      setLang: (next: Lang) => {
        try {
          localStorage.setItem("tsp_lang", next);
        } catch {
          // ignore
        }
        setLangState(next);
      },
      t: (key: string) => DICT[lang][key] ?? DICT.en[key] ?? key
    }),
    [lang]
  );
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useT(): LangContextValue {
  return useContext(LangContext);
}
