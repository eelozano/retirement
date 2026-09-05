import { useId, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ratePercent } from "../../lib/format";
import type { MonteCarloResult } from "../../types/generated/MonteCarloResult";
import type { Spread } from "../../types/generated/Spread";
import {
  failureFindings,
  REFERENCE_BAND,
  type ReturnsFinding,
  type SpendingFinding,
  type TimingFinding,
} from "./whyPathsFailData";

// The card under the headline that answers "why does this plan fail?" as far
// as the model honestly can: when the failures land, what returns the failed
// paths saw, and what the plan withdraws at retirement.
//
// Every sentence here is descriptive. Nothing on this card attributes a
// failure to a cause, because the simulation cannot support that: a path
// fails because its draws were bad, and these figures only report the shape
// of that. Wording that sounds like attribution will be read as attribution.
//
// Hidden entirely at 100% success — `diagnostics.failed` is null exactly
// then, and a card explaining failures that did not happen is noise.

const CHART_HEIGHT = 132;

/** "10th–90th percentile" tail, in whichever basis the finding chose. */
function spreadRange(s: Spread): string {
  return `${ratePercent(s.p10)} to ${ratePercent(s.p90)}`;
}

/**
 * "62 of 71", or "All 71" when one side of the split holds every failure —
 * "71 of 71" is a ratio the reader has to divide to understand.
 */
function share(part: number, total: number) {
  if (part === total) {
    return (
      <>
        All <strong>{total.toLocaleString()}</strong>
      </>
    );
  }
  return (
    <>
      <strong>{part.toLocaleString()}</strong> of {total.toLocaleString()}
    </>
  );
}

function TimingFindingBlock(props: { timing: TimingFinding; textId: string }) {
  const t = props.timing;
  const chartId = `${props.textId}-chart`;

  const sentence =
    t.shape === "early" ? (
      <>
        {share(t.early, t.failed)} failures happen in the first {t.windowYears} years of
        retirement.
      </>
    ) : t.shape === "late" ? (
      <>
        {share(t.late, t.failed)} failures happen more than {t.windowYears} years into
        retirement.
      </>
    ) : t.shape === "mixed" ? (
      <>
        <strong>{t.early.toLocaleString()}</strong> of {t.failed.toLocaleString()}{" "}
        failures happen in the first {t.windowYears} years of retirement; the other{" "}
        <strong>{t.late.toLocaleString()}</strong> come later.
      </>
    ) : (
      <>
        <strong>{t.failed.toLocaleString()}</strong> paths run dry over the projection.
      </>
    );

  const support =
    t.shape === "unanchored" ? (
      <>
        No retirement falls inside the plan, so the failures cannot be dated against one.
        {t.medianYear !== null && <> Half of them land by {t.medianYear}.</>}
      </>
    ) : (
      <>
        {t.medianYear !== null && (
          <>
            Half of them land by {t.medianYear}
            {t.inLastDecade && <>, in the plan's last decade</>}.{" "}
          </>
        )}
        {t.retirementYear !== null && <>Retirement begins {t.retirementYear}.</>}
      </>
    );

  return (
    <div className="why-fail-finding why-fail-timing">
      <span className="tile-label">Timing</span>
      <div
        className="why-fail-chart"
        role="img"
        aria-label="Failed paths by the year they ran dry"
        aria-describedby={props.textId}
        id={chartId}
      >
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart
            data={t.bars}
            margin={{ top: 14, right: 4, bottom: 0, left: 0 }}
            barCategoryGap={2}
          >
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {/* The early window drawn rather than described: the shaded span
                is the same split the sentence below counts. */}
            {t.retirementYear !== null && t.windowEndYear !== null && (
              <ReferenceArea
                x1={t.retirementYear}
                x2={t.windowEndYear}
                fill="var(--surface-3)"
                fillOpacity={1}
              />
            )}
            <XAxis
              dataKey="year"
              tick={{ fill: "var(--muted)", fontSize: 10.5 }}
              tickLine={false}
              axisLine={{ stroke: "var(--axis)" }}
              minTickGap={24}
            />
            <YAxis
              tick={{ fill: "var(--muted)", fontSize: 10.5 }}
              tickLine={false}
              axisLine={false}
              width={30}
              allowDecimals={false}
            />
            {t.retirementYear !== null && (
              <ReferenceLine
                x={t.retirementYear}
                stroke="var(--axis)"
                strokeDasharray="3 3"
                label={{
                  value: "retires",
                  position: "top",
                  fill: "var(--muted)",
                  fontSize: 10.5,
                }}
              />
            )}
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              content={<FailureTooltip />}
              isAnimationActive={false}
            />
            <Bar
              dataKey="count"
              name="Paths"
              fill="var(--series-1)"
              radius={[4, 4, 0, 0]}
              maxBarSize={18}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {/* The chart's text alternative, not a caption beside it: the figures
          are the data and the bars are the illustration, so the chart points
          here with aria-describedby rather than repeating itself. */}
      <div id={props.textId}>
        <p className="why-fail-sentence">{sentence}</p>
        <p className="why-fail-support">{support}</p>
      </div>
    </div>
  );
}

interface TooltipRow {
  value?: number | string;
  payload?: FailureBarPayload;
}
interface FailureBarPayload {
  year?: number;
  count?: number;
}

function FailureTooltip(props: { active?: boolean; payload?: readonly TooltipRow[] }) {
  const row = props.payload?.[0]?.payload;
  if (!props.active || !row) return null;
  const count = row.count ?? 0;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{row.year}</div>
      <div className="chart-tooltip-row">
        <strong>{count.toLocaleString()}</strong>
        <span className="series-name">path{count === 1 ? "" : "s"} ran dry</span>
      </div>
    </div>
  );
}

function ReturnsFindingBlock(props: { returns: ReturnsFinding }) {
  const r = props.returns;
  const per = r.basis === "annual" ? " a year" : "";
  const window = `the first ${r.windowYears} retirement years`;

  return (
    <div className="why-fail-finding">
      <span className="tile-label">Returns</span>
      <p className="why-fail-sentence">
        {r.overlapping ? (
          <>
            Returns barely separate the failed paths from the rest:{" "}
            <strong>{ratePercent(r.failed.p50)}</strong>
            {per} against <strong>{ratePercent(r.succeeded.p50)}</strong>
            {per} over {window}.
          </>
        ) : (
          <>
            Failed paths returned <strong>{ratePercent(r.failed.p50)}</strong>
            {per} over {window}; the paths that held returned{" "}
            <strong>{ratePercent(r.succeeded.p50)}</strong>
            {per}.
          </>
        )}
      </p>
      <p className="why-fail-support">
        Medians of each group. 10th–90th percentile: {spreadRange(r.failed)} for the
        failed paths, {spreadRange(r.succeeded)} for the rest.
        {r.basis === "window" && " Totals over the window, not per year."}
      </p>
    </div>
  );
}

function SpendingFindingBlock(props: { spending: SpendingFinding }) {
  const s = props.spending;
  const pos = (rate: number) => `${Math.min(100, (rate / s.scaleMax) * 100)}%`;
  // "3–4%", not "3%–4%": the unit belongs on the range, not on each end.
  const bandLabel = `${Math.round(REFERENCE_BAND.low * 100)}–${ratePercent(REFERENCE_BAND.high, 0)}`;

  return (
    <div className="why-fail-finding">
      <span className="tile-label">Spending</span>
      <p className="why-fail-sentence">
        The median path withdraws <strong>{ratePercent(s.medianRate)}</strong> of the
        portfolio in the first full year of retirement.
      </p>
      {/* A reference range, drawn as a band rather than a threshold: no tone,
          no pass/fail. The app offers 3–4% the way it offers 0.70–0.80 for
          survivor spending — as the conventional figure, not as a rule it
          enforces. */}
      <div
        className="why-fail-strip"
        role="img"
        aria-label={`Withdrawal rate ${ratePercent(s.medianRate)} against a conventional reference range of ${bandLabel}, on a scale to ${ratePercent(s.scaleMax, 0)}`}
      >
        <span
          className="why-fail-band"
          style={{
            left: pos(REFERENCE_BAND.low),
            width: `${((REFERENCE_BAND.high - REFERENCE_BAND.low) / s.scaleMax) * 100}%`,
          }}
        />
        <span className="why-fail-mark" style={{ left: pos(s.medianRate) }} />
      </div>
      <div className="why-fail-scale" aria-hidden="true">
        <span>0%</span>
        <span>{bandLabel} conventional</span>
        <span>{ratePercent(s.scaleMax, 0)}</span>
      </div>
      <p className="why-fail-support">
        {bandLabel} is the conventional range, offered as a reference and not as a rule
        this app enforces.
        {s.failedRate !== null && s.succeededRate !== null && (
          <>
            {" "}
            Failed paths withdrew {ratePercent(s.failedRate)}; the paths that held
            withdrew {ratePercent(s.succeededRate)}.
          </>
        )}
      </p>
    </div>
  );
}

export function WhyPathsFail(props: {
  result: MonteCarloResult | null;
  /** Deterministic depletion year, or null. Leads the card when set. */
  depletionYear: number | null;
  stale: boolean;
  /** False in the report, where the section supplies its own heading. */
  heading?: boolean;
}) {
  const data = useMemo(() => failureFindings(props.result), [props.result]);
  const textId = useId();
  if (!data) return null;
  const showHeading = props.heading !== false;

  return (
    <section className="card why-fail" aria-label="Why paths fail">
      <div className="card-head">
        {showHeading && <h2>Why paths fail</h2>}
        <span className="card-note">
          {data.timing.failed.toLocaleString()} of {data.nPaths.toLocaleString()} paths
          ran dry{props.stale && " · from before the latest change"}
        </span>
      </div>
      {/* The deterministic run depleting is the strongest spending signal the
          app has — it needed no bad luck at all — so it leads the card. */}
      {props.depletionYear !== null && (
        <p className="why-fail-lead">
          The plan runs out of money in <strong>{props.depletionYear}</strong> even at
          fixed average returns, before any bad luck is simulated.
        </p>
      )}

      <div className="why-fail-grid">
        <TimingFindingBlock timing={data.timing} textId={textId} />
        {data.returns && <ReturnsFindingBlock returns={data.returns} />}
        {data.spending && <SpendingFindingBlock spending={data.spending} />}
      </div>

      <p className="why-fail-note">
        Each year's returns are drawn independently, which under-produces the clustered
        bad decade that sequence-of-returns risk actually is. Failure concentrated around
        the retirement date is a floor here, not an estimate.
      </p>
    </section>
  );
}
