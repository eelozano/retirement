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
