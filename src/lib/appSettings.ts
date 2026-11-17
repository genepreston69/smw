import { z } from "zod";

// Business rules an admin can change on the Settings page without a deploy.
// They are rows in public.app_settings (migration 0041), one per key below; a
// setting with no row — or with a value that doesn't validate — uses the
// default here, so the app behaves exactly as it did before the table existed
// until someone changes something. Pure and client-safe; the database read is
// appSettingsServer.ts.
//
// Rules that must stay code (the import-window dates) are in businessRules.ts.

/** One account of the Cost of Benefits denominator, matched by account number. */
export interface BenefitBaseAccount {
  /** Leading account number, e.g. "710". */
  number: string;
  /** How the line is labeled on screen and in the export. */
  label: string;
}

/** Customers that are sister companies: their jobs are intercompany work. */
export interface IntercompanyRules {
  /** Matched anywhere in the customer name ("superior marine"). */
  phrases: string[];
  /** Matched as whole words only ("smw"), so short names don't over-match. */
  acronyms: string[];
}

export interface AppSettings {
  /** The calendar year the Budget page builds. */
  budgetYear: number;
  /** Cost of Benefits: benefit rate = Employee Benefits ÷ the sum of these. */
  benefitBaseAccounts: BenefitBaseAccount[];
  intercompany: IntercompanyRules;
}

export const DEFAULT_SETTINGS: AppSettings = {
  budgetYear: 2027,
  benefitBaseAccounts: [
    { number: "710", label: "710 Labor Cost" },
    { number: "935", label: "935 Salaries & Wages" },
    { number: "934", label: "934 Labor Maint" },
  ],
  intercompany: {
    phrases: ["precision paint", "superior marine", "inland river dredging"],
    acronyms: ["smw", "irdc"],
  },
};

const name = z.string().trim().min(1).max(80);
const lower = name.transform((s) => s.toLowerCase());
const distinct = (keys: string[]) => new Set(keys).size === keys.length;

/** Validation per setting; also what the Settings form's action enforces. */
export const SETTING_SCHEMAS = {
  budget_year: z.number().int().min(2024).max(2100),
  benefit_base_accounts: z
    .array(z.object({ number: z.string().regex(/^\d{1,8}$/), label: name }))
    .min(1)
    .max(20)
    .refine((list) => distinct(list.map((a) => a.number)), "Each account number can appear only once"),
  intercompany_names: z.object({
    phrases: z.array(lower).max(50).refine(distinct, "Duplicate name"),
    // Whole-word matching splits on anything but letters and digits.
    acronyms: z
      .array(lower.refine((s) => /^[a-z0-9]+$/.test(s), "Letters and digits only"))
      .max(50)
      .refine(distinct, "Duplicate acronym"),
  }),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;

/** Stored rows → settings. Missing or invalid values fall back to defaults. */
export function settingsFromRows(
  rows: { key: string; value: unknown }[],
): AppSettings {
  const read = <K extends SettingKey, T>(key: K, fallback: T): T => {
    const row = rows.find((r) => r.key === key);
    if (!row) return fallback;
    const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
    return parsed.success ? (parsed.data as T) : fallback;
  };
  return {
    budgetYear: read("budget_year", DEFAULT_SETTINGS.budgetYear),
    benefitBaseAccounts: read(
      "benefit_base_accounts",
      DEFAULT_SETTINGS.benefitBaseAccounts,
    ),
    intercompany: read("intercompany_names", DEFAULT_SETTINGS.intercompany),
  };
}
