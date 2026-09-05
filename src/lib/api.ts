// Typed wrappers over the Tauri commands. All request/response shapes come
// from the ts-rs generated types — never hand-declare engine types here.

import { Channel, invoke } from "@tauri-apps/api/core";
import type { MonteCarloConfig } from "../types/generated/MonteCarloConfig";
import type { MonteCarloResult } from "../types/generated/MonteCarloResult";
import type { Plan } from "../types/generated/Plan";
import type { Presets } from "../types/generated/Presets";
import type { Projection } from "../types/generated/Projection";

export function runProjection(plan: Plan): Promise<Projection> {
  return invoke<Projection>("run_projection", { plan });
}

// One entry per scenario result, in the same order as the request — a
// scenario that fails validation gets its own Err rather than blanking the
// whole comparison. Neither shape is a ts-rs domain type (this is a
// command-only response), so it's hand-declared like StorageInfo below.
export type ProjectionResult = { Ok: Projection } | { Err: string };

export function runProjections(plans: Plan[]): Promise<ProjectionResult[]> {
  return invoke<ProjectionResult[]>("run_projections", { plans });
}

/** One progress report from an in-flight Monte Carlo run — a command-only
 * shape (src-tauri/src/commands.rs), hand-declared like StorageInfo. */
export interface MonteCarloProgress {
  run_id: number;
  completed: number;
  total: number;
}

/** Starts a Monte Carlo run, superseding (cancelling) any run in flight.
 *
 * Resolves to the result, or to `null` if the run was cancelled — by
 * `cancelMonteCarlo` or by a later `runMonteCarlo`. Cancellation is not a
 * rejection: the caller asked for it and keeps its previous result.
 *
 * The Tauri `Channel` is built here so the store only ever sees a callback,
 * and its tests can mock this module without a transport. */
export function runMonteCarlo(
  plan: Plan,
  config: MonteCarloConfig,
  runId: number,
  onProgress: (progress: MonteCarloProgress) => void,
): Promise<MonteCarloResult | null> {
  const channel = new Channel<MonteCarloProgress>();
  channel.onmessage = onProgress;
  return invoke<MonteCarloResult | null>("run_monte_carlo", {
    plan,
    config,
    runId,
    onProgress: channel,
  });
}

/** One entry per scenario, in request order — same shape and same reasoning
 * as `ProjectionResult`: an invalid scenario gets its own Err rather than
 * blanking the comparison. */
export type MonteCarloResultEntry = { Ok: MonteCarloResult } | { Err: string };

/** Monte Carlo across several scenarios for the comparison table, at one
 * shared config — seed included, so the scenarios are measured against the
 * same draws and their *differences* are comparable.
 *
 * Resolves to `null` if the batch was cancelled or superseded, exactly as
 * `runMonteCarlo` does. Progress is aggregated across the batch: one climbing
 * count over every scenario's paths, not a bar that restarts per scenario. */
export function runMonteCarlos(
  plans: Plan[],
  config: MonteCarloConfig,
  runId: number,
  onProgress: (progress: MonteCarloProgress) => void,
): Promise<MonteCarloResultEntry[] | null> {
  const channel = new Channel<MonteCarloProgress>();
  channel.onmessage = onProgress;
  return invoke<MonteCarloResultEntry[] | null>("run_monte_carlos", {
    plans,
    config,
    runId,
    onProgress: channel,
  });
}

/** Stops the run with this id if it is still the one in flight; a no-op for
 * a run that has already finished or been superseded. */
export function cancelMonteCarlo(runId: number): Promise<void> {
  return invoke<void>("cancel_monte_carlo", { runId });
}

/** The path-count limits, from the backend: the clamp range and the count
 * above which runs are on demand rather than automatic after every edit. */
export interface MonteCarloLimits {
  min_paths: number;
  max_paths: number;
  auto_run_max_paths: number;
}

export function getMonteCarloLimits(): Promise<MonteCarloLimits> {
  return invoke<MonteCarloLimits>("get_monte_carlo_limits");
}

export function loadPlan(): Promise<Plan> {
  return invoke<Plan>("load_plan");
}

export function loadPlanNamed(id: string): Promise<Plan> {
  return invoke<Plan>("load_plan_named", { id });
}

export function savePlan(plan: Plan): Promise<void> {
  return invoke<void>("save_plan", { plan });
}

export interface PlanSummary {
  id: string;
  name: string;
}

export function listPlans(): Promise<PlanSummary[]> {
  return invoke<PlanSummary[]>("list_plans");
}

export function setActivePlan(id: string): Promise<void> {
  return invoke<void>("set_active_plan", { id });
}

export function duplicatePlan(id: string, newName: string): Promise<Plan> {
  return invoke<Plan>("duplicate_plan", { id, newName });
}

export function deletePlan(id: string): Promise<void> {
  return invoke<void>("delete_plan", { id });
}

/** A plan's snapshot timestamps, newest first — see StorageSettings. */
export function listSnapshots(id: string): Promise<string[]> {
  return invoke<string[]>("list_snapshots", { id });
}

export function restoreSnapshot(id: string, timestamp: string): Promise<Plan> {
  return invoke<Plan>("restore_snapshot", { id, timestamp });
}

export function getPresets(): Promise<Presets> {
  return invoke<Presets>("get_presets");
}

export function engineVersion(): Promise<string> {
  return invoke<string>("engine_version");
}

// StorageInfo is a Tauri-command-only response shape (src-tauri/src/commands.rs),
// not an engine domain type, so it isn't part of the ts-rs pipeline — hand-declared
// here like any other command wrapper's shape.
export interface StorageInfo {
  effective_dir: string;
  is_default: boolean;
  default_dir: string;
}

export function getStorageInfo(): Promise<StorageInfo> {
  return invoke<StorageInfo>("get_storage_info");
}

export function chooseStorageDir(): Promise<string | null> {
  return invoke<string | null>("choose_storage_dir");
}

export function setStorageDir(path: string): Promise<void> {
  return invoke<void>("set_storage_dir", { path });
}

export function revealStorageDir(): Promise<void> {
  return invoke<void>("reveal_storage_dir");
}

/** Paths per Monte Carlo run. Always concrete — the backend resolves "unset"
 * to its own default, and clamps, so the frontend holds neither number. */
export function getMonteCarloPaths(): Promise<number> {
  return invoke<number>("get_monte_carlo_paths");
}

export function setMonteCarloPaths(paths: number): Promise<void> {
  return invoke<void>("set_monte_carlo_paths", { paths });
}

/** Opens a folder picker and writes a timestamped copy of the whole plans
 * directory there. Resolves to the created folder's path, or null if the
 * user cancels the picker. */
export function exportPlans(): Promise<string | null> {
  return invoke<string | null>("export_plans");
}

/** Opens a save-file dialog pre-filled with `suggestedName` and writes
 * `contents` there. Resolves to the written path, or null if the user
 * cancels the picker. */
export function exportTextFile(
  suggestedName: string,
  contents: string,
): Promise<string | null> {
  return invoke<string | null>("export_text_file", { suggestedName, contents });
}

/** Renders this window straight to a paginated PDF file at a user-chosen
 * path — no print dialog involved, but paginated exactly as one would be,
 * via `@media print` (App.css) and the real print pipeline. macOS only
 * today. Resolves to the written path, or null if the user cancels the
 * picker. */
export function exportReportPdf(suggestedName: string): Promise<string | null> {
  return invoke<string | null>("export_report_pdf", { suggestedName });
}
