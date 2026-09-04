// Typed wrappers over the Tauri commands. All request/response shapes come
// from the ts-rs generated types — never hand-declare engine types here.

import { invoke } from "@tauri-apps/api/core";
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

export function runMonteCarlo(
  plan: Plan,
  config: MonteCarloConfig,
): Promise<MonteCarloResult> {
  return invoke<MonteCarloResult>("run_monte_carlo", { plan, config });
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
