// E3 — renders a `CalibrationReport` into one self-contained, static HTML file: the "small
// internal dashboard" the step spec asks for. This is an operator tool, not an end-user page —
// no build step, no JS framework, no charting library (the coordinator's own safety constraint:
// "if the dashboard needs a visual, plain HTML/SVG ... is fine and preferable"). The reliability
// diagram below is hand-rolled inline SVG; everything else is plain HTML tables.
//
// Pure function: string in (well, a report object), string out. No file I/O here —
// scripts/generateCalibrationReport.ts writes the result to disk.

import type { CalibrationReport } from "./report.ts";
import type { CalibrationBucket } from "./calibrationCurve.ts";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(n: number | null, digits = 1): string {
  return n === null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

function num(n: number | null, digits = 3): string {
  return n === null ? "—" : n.toFixed(digits);
}

const SVG_SIZE = 360;
const SVG_MARGIN = 36;
const PLOT_SIZE = SVG_SIZE - 2 * SVG_MARGIN;

function toSvgX(confidence: number): number {
  return SVG_MARGIN + confidence * PLOT_SIZE;
}
function toSvgY(rate: number): number {
  return SVG_MARGIN + (1 - rate) * PLOT_SIZE;
}

/** The reliability diagram: predicted (x) vs observed (y) for every bucket that cleared
 * `minBucketSize`, plus a diagonal "perfect calibration" reference line. A bucket below the
 * minimum is drawn as a small hollow tick on the x-axis at its bucket midpoint, labelled with its
 * `n` — visible (so a thin report doesn't look like it has no data at all) but never plotted as a
 * point with a fabricated y-value. */
function renderReliabilitySvg(buckets: readonly CalibrationBucket[]): string {
  const axisPath = `M ${SVG_MARGIN} ${SVG_MARGIN} L ${SVG_MARGIN} ${SVG_MARGIN + PLOT_SIZE} L ${
    SVG_MARGIN + PLOT_SIZE
  } ${SVG_MARGIN + PLOT_SIZE}`;
  const diagonal = `M ${toSvgX(0)} ${toSvgY(0)} L ${toSvgX(1)} ${toSvgY(1)}`;

  const maxN = Math.max(1, ...buckets.map((b) => b.n));
  const points: string[] = [];
  const belowFloor: string[] = [];

  for (const b of buckets) {
    const mid = (b.bucketLow + b.bucketHigh) / 2;
    if (b.meanPredictedConfidence === null || b.observedSuccessRate === null) {
      if (b.n > 0) {
        const x = toSvgX(mid);
        belowFloor.push(
          `<line x1="${x}" y1="${SVG_MARGIN + PLOT_SIZE - 6}" x2="${x}" y2="${SVG_MARGIN + PLOT_SIZE + 6}" class="below-floor-tick" />` +
            `<text x="${x}" y="${SVG_MARGIN + PLOT_SIZE + 18}" class="tick-label" text-anchor="middle">n=${b.n}</text>`,
        );
      }
      continue;
    }
    const x = toSvgX(b.meanPredictedConfidence);
    const y = toSvgY(b.observedSuccessRate);
    const r = 4 + 8 * Math.sqrt(b.n / maxN);
    points.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" class="cal-point" />` +
        `<title>bucket [${b.bucketLow.toFixed(1)}, ${b.bucketHigh.toFixed(1)}) — n=${b.n}, mean stated confidence ${b.meanPredictedConfidence.toFixed(3)}, observed success ${b.observedSuccessRate.toFixed(3)}</title>`,
    );
  }

  return `
<svg viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}" width="100%" height="${SVG_SIZE}" role="img" aria-label="Reliability diagram: stated confidence vs observed success rate">
  <rect x="0" y="0" width="${SVG_SIZE}" height="${SVG_SIZE}" class="svg-bg" />
  <path d="${diagonal}" class="diagonal" />
  <path d="${axisPath}" class="axis" />
  ${[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => `<text x="${toSvgX(t)}" y="${SVG_MARGIN + PLOT_SIZE + 18}" class="axis-label" text-anchor="middle">${t}</text>`).join("")}
  ${[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => `<text x="${SVG_MARGIN - 8}" y="${toSvgY(t) + 4}" class="axis-label" text-anchor="end">${t}</text>`).join("")}
  <text x="${SVG_MARGIN + PLOT_SIZE / 2}" y="${SVG_SIZE - 4}" class="axis-title" text-anchor="middle">stated confidence (mean per bucket)</text>
  <text x="12" y="${SVG_MARGIN + PLOT_SIZE / 2}" class="axis-title" text-anchor="middle" transform="rotate(-90 12 ${SVG_MARGIN + PLOT_SIZE / 2})">observed success rate</text>
  ${belowFloor.join("\n  ")}
  ${points.join("\n  ")}
</svg>`;
}

function renderBucketTable(buckets: readonly CalibrationBucket[], minBucketSize: number): string {
  const rows = buckets
    .map((b) => {
      const below = b.n < minBucketSize;
      return `<tr class="${below ? "below-floor" : ""}">
        <td>${b.bucketLow.toFixed(1)}–${b.bucketHigh.toFixed(1)}</td>
        <td>${b.n}</td>
        <td>${num(b.meanPredictedConfidence)}</td>
        <td>${pct(b.observedSuccessRate)}</td>
        <td>${below ? `below minimum (${minBucketSize}) — not reported` : ""}</td>
      </tr>`;
    })
    .join("\n");
  return `<table>
    <thead><tr><th>Confidence bucket</th><th>n</th><th>Mean stated confidence</th><th>Observed success rate</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderRejectionRateTable(report: CalibrationReport): string {
  const rows = report.guardrailRejectionRate.overTime
    .map((p) => {
      const width = p.rate === null ? 0 : Math.round(p.rate * 100);
      return `<tr>
        <td>${esc(p.period)}</td>
        <td>${p.attempts}</td>
        <td>${p.rejections}</td>
        <td>${pct(p.rate)}<div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div></td>
      </tr>`;
    })
    .join("\n");
  return report.guardrailRejectionRate.overTime.length === 0
    ? `<p class="muted">No recommendation attempts (COMPLETE or REJECTED) recorded yet.</p>`
    : `<table>
    <thead><tr><th>Period</th><th>Attempts</th><th>Rejections</th><th>Rate</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderViolationTables(report: CalibrationReport): string {
  const byCode = report.guardrailRejectionRate.violations.byCode
    .map((v) => `<tr><td>${esc(v.code)}</td><td>${v.count}</td></tr>`)
    .join("\n");
  const byField = report.guardrailRejectionRate.violations.byField
    .map(
      (v) =>
        `<tr><td>${esc(v.field)}</td><td>${esc(v.source)}${v.source === "default" ? ' <span class="pill">placeholder</span>' : ""}</td><td>${v.mostRecentLimit}</td><td>${v.count}</td></tr>`,
    )
    .join("\n");
  return `
  <h3>By violation code</h3>
  ${
    report.guardrailRejectionRate.violations.byCode.length === 0
      ? `<p class="muted">No guardrail rejections recorded yet.</p>`
      : `<table><thead><tr><th>Code</th><th>Count</th></tr></thead><tbody>${byCode}</tbody></table>`
  }
  <h3>By limit (field judged against)</h3>
  ${
    report.guardrailRejectionRate.violations.byField.length === 0
      ? `<p class="muted">No numeric-limit violations recorded yet.</p>`
      : `<table><thead><tr><th>Field</th><th>Source</th><th>Most recent limit</th><th>Count</th></tr></thead><tbody>${byField}</tbody></table>
         <p class="muted">"placeholder" means the limit came from this system's built-in default, not an operator-reviewed setting — see IMPLEMENTATION_PLAN.md D5's own notes (e.g. targetCpa defaults to ₹1,500 against a measured real account CPA of ₹1,761.63). A cluster of rejections against a placeholder is a signal about the LIMIT, not necessarily about the model.</p>`
  }`;
}

export function renderCalibrationDashboard(report: CalibrationReport): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Confidence calibration report (internal)</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 960px; margin: 0 auto; padding: 24px 20px 64px; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  h2 { font-size: 1.1rem; margin-top: 2.5rem; border-bottom: 1px solid #8884; padding-bottom: 4px; }
  h3 { font-size: 0.95rem; margin-top: 1.5rem; }
  .muted { color: #888; font-size: 0.9rem; }
  .banner { border: 1px solid #d99; background: #fee; color: #611; border-radius: 6px; padding: 12px 16px; margin: 16px 0; }
  .banner.ok { border-color: #9c9; background: #efe; color: #161; }
  table { border-collapse: collapse; width: 100%; font-size: 0.88rem; margin: 8px 0 16px; }
  th, td { border: 1px solid #8884; padding: 5px 8px; text-align: left; }
  th { background: #8882; }
  tr.below-floor td { color: #999; font-style: italic; }
  .stat-row { display: flex; gap: 16px; flex-wrap: wrap; margin: 12px 0; }
  .stat-tile { border: 1px solid #8884; border-radius: 8px; padding: 10px 16px; min-width: 140px; }
  .stat-tile .label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.03em; }
  .stat-tile .value { font-size: 1.3rem; font-weight: 600; }
  .stat-tile .n { font-size: 0.78rem; color: #888; }
  .bar-track { background: #8882; border-radius: 3px; height: 6px; margin-top: 3px; overflow: hidden; }
  .bar-fill { background: #c66; height: 100%; }
  .pill { font-size: 0.72rem; background: #fd8; color: #741; border-radius: 3px; padding: 1px 5px; }
  svg { display: block; margin: 8px auto; }
  .svg-bg { fill: transparent; }
  .axis { stroke: #8888; stroke-width: 1; fill: none; }
  .diagonal { stroke: #8888; stroke-width: 1; stroke-dasharray: 4 3; fill: none; }
  .axis-label, .tick-label { font-size: 9px; fill: #888; }
  .axis-title { font-size: 10px; fill: #888; }
  .cal-point { fill: #47a; fill-opacity: 0.75; stroke: #235; stroke-width: 0.5; }
  .below-floor-tick { stroke: #c66; stroke-width: 1.5; }
  ul.notes li { margin-bottom: 6px; }
  footer { margin-top: 3rem; font-size: 0.78rem; color: #888; }
</style>
</head>
<body>
  <h1>Confidence calibration report</h1>
  <p class="muted">Generated ${esc(report.generatedAt)} — internal operator report, not for end users (IMPLEMENTATION_PLAN.md E3).</p>

  ${
    report.dataProvenance.hasAnyJudgedData
      ? `<div class="banner ok">This report reflects ${report.combinedBrier.n} judged point(s) of real data.</div>`
      : `<div class="banner"><strong>No judged outcome or backtest data exists yet.</strong> Every table below is
         structurally correct and ready to populate, but there is currently nothing to calibrate against — this
         system has never run in production (the raw archive bucket is empty, and no recommendation has yet
         accumulated a live outcome). Do not read any statistic on this page as a real calibration result until
         <code>dataProvenance.hasAnyJudgedData</code> is <code>true</code>.</div>`
  }

  <h2>Headline: is stated confidence calibrated?</h2>
  <div class="stat-row">
    <div class="stat-tile"><div class="label">Live Brier score</div><div class="value">${num(report.live.brier.meanBrier)}</div><div class="n">n=${report.live.brier.n}</div></div>
    <div class="stat-tile"><div class="label">Backtest (SYSTEM) Brier score</div><div class="value">${num(report.backtest.systemBrier.meanBrier)}</div><div class="n">n=${report.backtest.systemBrier.n}</div></div>
    <div class="stat-tile"><div class="label">Combined Brier score</div><div class="value">${num(report.combinedBrier.meanBrier)}</div><div class="n">n=${report.combinedBrier.n}</div></div>
  </div>
  <p class="muted">Lower is better. 0 = perfect; 0.25 = what a constant-0.5 forecaster gets; 1 = maximally wrong on
  every call. "Combined" pools live and backtest points on the same (confidence − actual)² scale — see the notes
  section for the one way the two streams define "actual" slightly differently.</p>

  <h3>Reliability diagram</h3>
  <p class="muted">Points on the diagonal are well calibrated. A point above the line means the system was
  <em>under</em>-confident at that bucket (it succeeded more than it claimed); below the line means
  <em>over</em>-confident. Red ticks on the axis mark buckets with real data too thin to plot (n below
  ${report.calibrationCurve.minBucketSize}) — reported honestly as "not enough data", never drawn as a point.</p>
  ${renderReliabilitySvg(report.calibrationCurve.buckets)}
  ${renderBucketTable(report.calibrationCurve.buckets, report.calibrationCurve.minBucketSize)}
  <p class="muted">Points by source: ${report.calibrationCurve.pointCountBySource.live} live, ${report.calibrationCurve.pointCountBySource.backtestSystem} backtest (SYSTEM).</p>

  <h2>Live outcomes (E2)</h2>
  <div class="stat-row">
    <div class="stat-tile"><div class="label">Total outcome docs</div><div class="value">${report.live.totalOutcomeDocs}</div></div>
    <div class="stat-tile"><div class="label">Success</div><div class="value">${report.live.successCount}</div></div>
    <div class="stat-tile"><div class="label">Failure</div><div class="value">${report.live.failureCount}</div></div>
    <div class="stat-tile"><div class="label">Neutral (excluded)</div><div class="value">${report.live.neutralCount}</div></div>
    <div class="stat-tile"><div class="label">Seasonally confounded (excluded)</div><div class="value">${report.live.seasonallyConfoundedCount}</div></div>
  </div>
  <p class="muted">Neutral and seasonally-confounded outcomes are never scored — see the notes at the bottom of this
  page for why.</p>

  <h2>Not (yet) part of the calibration</h2>
  <div class="stat-row">
    <div class="stat-tile"><div class="label">Accepted, not yet judged</div><div class="value">${report.unjudged.acceptedNoOutcomeYet}</div></div>
    <div class="stat-tile"><div class="label">Complete, never accepted</div><div class="value">${report.unjudged.completeNotAccepted}</div></div>
    <div class="stat-tile"><div class="label">Guardrail-rejected</div><div class="value">${report.unjudged.guardrailRejected}</div></div>
  </div>
  <p class="muted"><strong>"Accepted, not yet judged" is not a failure.</strong> It means the recheck conditions
  E2 requires (minimum additional spend AND purchases) have not yet been met — the recommendation is still
  waiting for enough evidence, exactly the caution §21.1 asks for.</p>

  <h2>Guardrail rejection rate (§29 criterion 12)</h2>
  <div class="stat-row">
    <div class="stat-tile"><div class="label">Overall rate</div><div class="value">${pct(report.guardrailRejectionRate.overall.rate)}</div><div class="n">${report.guardrailRejectionRate.overall.rejections} / ${report.guardrailRejectionRate.overall.attempts} attempts</div></div>
  </div>
  <h3>Over time</h3>
  ${renderRejectionRateTable(report)}
  ${renderViolationTables(report)}

  <h2>Backtest (E1) comparison</h2>
  <div class="stat-row">
    <div class="stat-tile"><div class="label">SYSTEM runs</div><div class="value">${report.backtest.systemRuns}</div></div>
    <div class="stat-tile"><div class="label">NAIVE runs</div><div class="value">${report.backtest.naiveRuns}</div></div>
    <div class="stat-tile"><div class="label">SYSTEM scaled-successfully rate</div><div class="value">${pct(report.backtest.systemScaledSuccessRate.rate)}</div><div class="n">n=${report.backtest.systemScaledSuccessRate.n}</div></div>
    <div class="stat-tile"><div class="label">NAIVE scaled-successfully rate</div><div class="value">${pct(report.backtest.naiveScaledSuccessRate.rate)}</div><div class="n">n=${report.backtest.naiveScaledSuccessRate.n}</div></div>
  </div>
  <p class="muted">NAIVE never states a confidence (E1's own design — "no probability claim to score"), so it has
  no Brier score; its <code>scaledSuccessfullyRate</code> is the §29 criterion 10 baseline SYSTEM must beat.</p>

  <h2>What this report is and is not</h2>
  <ul class="notes">
    ${report.dataProvenance.notes.map((n) => `<li>${esc(n)}</li>`).join("\n    ")}
  </ul>

  <footer>IMPLEMENTATION_PLAN.md E3 — Confidence calibration. Generated by
  services/calibration/report.ts + dashboardHtml.ts, via scripts/generateCalibrationReport.ts.</footer>
</body>
</html>
`;
}
