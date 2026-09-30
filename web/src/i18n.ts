import translations from "./locales/catalog.json" with { type: "json" };
export const languages = ["en", "tr", "de", "fr", "es"] as const;
export type Language = (typeof languages)[number];
export const names: Record<Language, string> = {
  en: "English",
  tr: "Türkçe",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
};
export const languageLabels: Record<Language, string> = {
  en: "Language",
  tr: "Dil",
  de: "Sprache",
  fr: "Langue",
  es: "Idioma",
};
let current: Language = "en";
const listeners = new Set<() => void>();
export function getLanguage() {
  return current;
}
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function isLanguage(value: unknown): value is Language {
  return languages.includes(value as Language);
}
export function t(key: string): string {
  return (
    (translations as Record<string, Record<string, string>>)[current]?.[key] ??
    key
  );
}
export function setLanguage(value: Language, persist = true) {
  if (!isLanguage(value)) return;
  current = value;
  document.documentElement.lang = value;
  document.title = "Cardea · " + t("A sponsored start");
  if (persist) {
    try {
      localStorage.setItem("cardea-language", value);
    } catch {}
  }
  listeners.forEach((fn) => fn());
}
export async function initializeLanguage() {
  try {
    const saved = localStorage.getItem("cardea-language");
    if (isLanguage(saved)) {
      setLanguage(saved, false);
      return;
    }
  } catch {}
  try {
    const response = await fetch("/api/locale", {
      signal: AbortSignal.timeout(1800),
      cache: "no-store",
    });
    if (response.ok) {
      const data = await response.json();
      if (isLanguage(data.language)) {
        setLanguage(data.language, false);
        return;
      }
    }
  } catch {}
  setLanguage("en", false);
}
