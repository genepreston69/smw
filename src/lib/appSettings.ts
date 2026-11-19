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

/** An account matched by its leading number, as typed ("960 Interest Expense"). */
export interface NumberedAccount {
  /** Leading account number, e.g. "960". Sub-accounts count with it. */
  number: string;
  /** The line as the admin typed it. */
  label: string;
}

/** Which expense accounts the Income Statement adds back to Net income for
    EBITDA. A listed account wins over the automatic search; see
    ebitdaAddBackMatcher in financials.ts. */
export interface EbitdaAddBackRules {
  /** Also pick add-backs by QuickBooks detail type and account name. */
  automatic: boolean;
  interest: NumberedAccount[];
  taxes: NumberedAccount[];
  depreciation: NumberedAccount[];
  amortization: NumberedAccount[];
  /** Never added back, even when the automatic search would pick them. */
  exclude: NumberedAccount[];
}

export interface AppSettings {
  /** The calendar year the Budget page builds. */
  budgetYear: number;
  /** Cost of Benefits: benefit rate = Employee Benefits ÷ the sum of these. */
  benefitBaseAccounts: BenefitBaseAccount[];
  intercompany: IntercompanyRules;
  ebitdaAddBacks: EbitdaAddBackRules;
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
  ebitdaAddBacks: {
    automatic: true,
    interest: [],
    taxes: [],
    depreciation: [],
    amortization: [],
    exclude: [],
  },
};

const name = z.string().trim().min(1).max(80);
const lower = name.transform((s) => s.toLowerCase());
const distinct = (keys: string[]) => new Set(keys).size === keys.length;
const numbered = z.object({ number: z.string().regex(/^\d{1,8}$/), label: name });
const ebitdaList = z.array(numbered).max(50);

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
  ebitda_add_backs: z
    .object({
      automatic: z.boolean(),
      interest: ebitdaList,
      taxes: ebitdaList,
      depreciation: ebitdaList,
      amortization: ebitdaList,
      exclude: ebitdaList,
    })
    .refine(
      (r) =>
        distinct(
          [r.interest, r.taxes, r.depreciation, r.amortization, r.exclude]
            .flat()
            .map((a) => a.number),
        ),
      "An account number can be in only one EBITDA list",
    ),
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
    ebitdaAddBacks: read("ebitda_add_backs", DEFAULT_SETTINGS.ebitdaAddBacks),
  };
}
