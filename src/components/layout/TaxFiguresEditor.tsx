import { useEffect, useState } from "react";
import { getTaxFigures, saveTaxFigures, type TaxFiguresState } from "../../lib/api";
import { usePlanStore } from "../../store/planStore";
import type { ByFilingStatus } from "../../types/generated/ByFilingStatus";
import type { ContributionLimits } from "../../types/generated/ContributionLimits";
import type { FederalTax } from "../../types/generated/FederalTax";
import type { TaxFigures } from "../../types/generated/TaxFigures";
import { NumberField } from "../inputs/fields";
import { BracketTable } from "../inputs/TaxBracketEditor";
import { Modal } from "./Modal";

// The in-app editor for `tax-figures.yaml`. It edits a draft of what the
// file says now and writes it back on Save — the file stays the one source,
// so a hand edit and an edit here are the same thing.
//
// Adding a figure: `TaxFigures` is generated from the Rust struct, so a new
// field arrives here as a type change, and one of the three records below
// stops compiling until it is given a place —
//   - a contribution limit needs a row in LIMIT_FIELDS;
//   - a filing status needs a label in FILING_STATUSES;
//   - a new top-level group of figures needs a section in SECTIONS.
// That is the same bargain `decompose` makes for `Plan`: nothing added on the
// Rust side can go missing from the form without `tsc` saying so.

type FilingStatusKey = keyof ByFilingStatus<unknown>;

const FILING_STATUSES: Record<FilingStatusKey, string> = {
  single: "Single",
  married_filing_jointly: "Married filing jointly",
};

type LimitGroup = "Workplace plans" | "IRAs" | "HSA" | "SEP and SIMPLE IRAs";

/** Label, hint and group for every contribution limit. The groups render in
 * the order they first appear here. */
const LIMIT_FIELDS: Record<
  keyof ContributionLimits,
  { label: string; hint?: string; group: LimitGroup }
> = {
  employer_plan: {
    label: "401(k) / 403(b) deferral",
    hint: "Shared across a person's 401(k), 403(b) and TSP.",
    group: "Workplace plans",
  },
  employer_plan_catch_up_50: {
    label: "Catch-up, age 50+",
    group: "Workplace plans",
  },
  employer_plan_catch_up_60_63: {
    label: "Catch-up, ages 60–63",
    hint: "Replaces the age-50 catch-up in those years.",
    group: "Workplace plans",
  },
  plan_457b: {
    label: "457(b) deferral",
    hint: "A separate cap from the 401(k) one; same catch-ups.",
    group: "Workplace plans",
  },
  annual_additions: {
    label: "Annual additions (415(c))",
    hint: "Employee plus employer money into a workplace plan.",
    group: "Workplace plans",
  },
  ira: {
    label: "IRA",
    hint: "Shared across traditional and Roth IRAs.",
    group: "IRAs",
  },
  ira_catch_up_50: { label: "IRA catch-up, age 50+", group: "IRAs" },
  hsa: {
    label: "HSA (self-only)",
    hint: "Published each spring. The $1,000 age-55 catch-up is fixed by law.",
    group: "HSA",
  },
  sep_ira: { label: "SEP-IRA", group: "SEP and SIMPLE IRAs" },
  simple_ira: { label: "SIMPLE IRA deferral", group: "SEP and SIMPLE IRAs" },
  simple_ira_catch_up_50: {
    label: "SIMPLE catch-up, age 50+",
    group: "SEP and SIMPLE IRAs",
  },
  simple_ira_catch_up_60_63: {
    label: "SIMPLE catch-up, ages 60–63",
    group: "SEP and SIMPLE IRAs",
  },
};

interface SectionProps<K extends keyof TaxFigures> {
  value: TaxFigures[K];
  onChange: (next: TaxFigures[K]) => void;
}

function FederalSection({ value, onChange }: SectionProps<"federal">) {
  const [status, setStatus] = useState<FilingStatusKey>("married_filing_jointly");
  const set = <F extends keyof FederalTax>(
    field: F,
    next: FederalTax[F][FilingStatusKey],
  ) => onChange({ ...value, [field]: { ...value[field], [status]: next } });

  return (
    <>
      <h3>Federal income tax</h3>
      <p className="storage-badge">
        Published each October or November for the coming year.
      </p>
      <fieldset className="segmented">
        <legend className="visually-hidden">Filing status</legend>
        {(Object.keys(FILING_STATUSES) as FilingStatusKey[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={status === key}
            onClick={() => setStatus(key)}
          >
            {FILING_STATUSES[key]}
          </button>
        ))}
      </fieldset>
      {/* Keyed by status so each table's row ids start fresh. */}
      <div key={status} className="tax-bracket-editor">
        <NumberField
          label="Standard deduction ($)"
          value={value.standard_deduction[status]}
          step={100}
          onChange={(n) => set("standard_deduction", n)}
        />
        <h4>Ordinary income</h4>
        <BracketTable
          label="Ordinary"
          brackets={value.ordinary_brackets[status]}
          onChange={(b) => set("ordinary_brackets", b)}
        />
        <h4>Long-term capital gains</h4>
        <BracketTable
          label="Capital gains"
          brackets={value.capital_gains_brackets[status]}
          onChange={(b) => set("capital_gains_brackets", b)}
        />
      </div>
    </>
  );
}

function LimitsSection({ value, onChange }: SectionProps<"contribution_limits">) {
  const keys = Object.keys(LIMIT_FIELDS) as (keyof ContributionLimits)[];
  const groups = [...new Set(keys.map((k) => LIMIT_FIELDS[k].group))];
  return (
    <>
      <h3>Contribution limits</h3>
      <p className="storage-badge">
        Published each October or November, except the HSA limit.
      </p>
      {groups.map((group) => (
        <div key={group}>
          <h4>{group}</h4>
          {keys
            .filter((k) => LIMIT_FIELDS[k].group === group)
            .map((k) => (
              <NumberField
                key={k}
                label={`${LIMIT_FIELDS[k].label} ($)`}
                hint={LIMIT_FIELDS[k].hint}
                value={value[k]}
                step={50}
                onChange={(n) => onChange({ ...value, [k]: n })}
              />
            ))}
        </div>
      ))}
    </>
  );
}

/** One section per top-level group of figures, rendered in this order. */
const SECTIONS: {
  [K in Exclude<keyof TaxFigures, "tax_year">]: (
    props: SectionProps<K>,
  ) => React.ReactNode;
} = {
  federal: FederalSection,
  contribution_limits: LimitsSection,
};

export function TaxFiguresEditor(props: { open: boolean; onClose: () => void }) {
  const taxFiguresChanged = usePlanStore((s) => s.taxFiguresChanged);
  const [state, setState] = useState<TaxFiguresState | null>(null);
  const [draft, setDraft] = useState<TaxFigures | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Read afresh on every open, so the draft is what the file says now — a
  // hand edit since the last open included.
  useEffect(() => {
    if (!props.open) return;
    setError(null);
    setDraft(null);
    getTaxFigures()
      .then((loaded) => {
        setState(loaded);
        setDraft(loaded.figures);
      })
      .catch((e) => setError(String(e)));
  }, [props.open]);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await saveTaxFigures(draft);
    } catch (e) {
      setError(String(e));
      setSaving(false);
      return;
    }
    setSaving(false);
    props.onClose();
    // Saved is saved: a failure re-running the plan shows on the dashboard,
    // not as an error against a save that worked.
    void taxFiguresChanged().catch(() => {});
  };

  const section = <K extends keyof typeof SECTIONS>(key: K, figures: TaxFigures) => {
    const Section = SECTIONS[key] as (props: SectionProps<K>) => React.ReactNode;
    return (
      <Section
        key={key}
        value={figures[key]}
        onChange={(next) => setDraft({ ...figures, [key]: next })}
      />
    );
  };

  return (
    <Modal open={props.open} onClose={props.onClose} title="Tax figures">
      {state?.error && (
        <p role="alert" className="banner critical">
          The file could not be used, so these are the built-in {state.built_in.tax_year}{" "}
          figures: {state.error}. Saving replaces the file.
        </p>
      )}
      {error && (
        <p role="alert" className="banner critical">
          Not saved: {error}
        </p>
      )}
      {draft && state ? (
        <>
          <p className="storage-badge">
            Every plan uses these. Each is indexed forward from the tax year at the plan's
            inflation rate, so they only need changing when the IRS publishes a new year.
          </p>
          <NumberField
            label="Tax year"
            value={draft.tax_year}
            step={1}
            min={1900}
            max={2200}
            onChange={(tax_year) => setDraft({ ...draft, tax_year })}
          />
          {(Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]).map((key) =>
            section(key, draft),
          )}
          <p className="storage-badge">
            Saving rewrites {state.path}, keeping the previous version beside it as
            tax-figures.yaml.bak. Comments you added to the file by hand are not kept.
          </p>
          <div className="storage-actions">
            <button type="button" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setDraft(structuredClone(state.built_in))}
              disabled={saving}
            >
              Reset to built-in {state.built_in.tax_year}
            </button>
          </div>
        </>
      ) : (
        !error && <p>Loading…</p>
      )}
    </Modal>
  );
}
