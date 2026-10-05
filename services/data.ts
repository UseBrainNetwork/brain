/**
 * Data access facade. Components read network/economic data ONLY through here.
 * Today each function returns DEMO data from services/mock; swap the bodies for real
 * API calls without touching any component.
 */
import type { CreatorRevenue, ModelPool, NetworkMetrics } from "@/domain/types";
import {
  baselineMetrics,
  deviceClasses,
  inferenceModels,
  meanComputeScore,
  modelPools,
  revenue,
  token,
  topContributors,
} from "./mock/mockData";

export function getBaselineMetrics(): NetworkMetrics {
  return {
    ...baselineMetrics,
    capacityScore: Math.round((baselineMetrics.gpusOnline * meanComputeScore) / 1e5) / 10,
  };
}

export const getDeviceClasses = () => deviceClasses;
export const getModelPools = (): ModelPool[] => modelPools;
export const getRevenue = (): CreatorRevenue[] => revenue;
export const getToken = () => token;
export const getTopContributors = (n?: number) => topContributors(n);
export const getInferenceModels = () => inferenceModels;
