// Typed wrappers over the Tauri commands. All request/response shapes come
// from the ts-rs generated types — never hand-declare engine types here.

import { invoke } from "@tauri-apps/api/core";
import type { Plan } from "../types/generated/Plan";
import type { Projection } from "../types/generated/Projection";
import type { Presets } from "../types/generated/Presets";

export function runProjection(plan: Plan): Promise<Projection> {
  return invoke<Projection>("run_projection", { plan });
}

export function loadPlan(): Promise<Plan> {
  return invoke<Plan>("load_plan");
}

export function savePlan(plan: Plan): Promise<void> {
  return invoke<void>("save_plan", { plan });
}

export function listPlans(): Promise<string[]> {
  return invoke<string[]>("list_plans");
}

export function getPresets(): Promise<Presets> {
  return invoke<Presets>("get_presets");
}

export function engineVersion(): Promise<string> {
  return invoke<string>("engine_version");
}
