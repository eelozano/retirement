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
