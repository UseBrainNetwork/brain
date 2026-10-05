import type { RewardsSummary } from "@/domain/types";
import { balanceOf, payoutStatus, refreshClaims } from "./claims";
import { demoRewardHistory } from "./mock/mockRewards";
import { currentProgress } from "./settlement";
import { getStore } from "./store";

export async function rewardsSummary(wallet: string): Promise<RewardsSummary> {
  const store = getStore();
  const payouts = payoutStatus();
  // Everything independent runs concurrently; balanceOf already loads this wallet's allocations.
  const [claims, current, bal] = await Promise.all([refreshClaims(wallet), currentProgress(wallet), balanceOf(wallet)]);
  const allocations = bal.allocations;

  const found = await Promise.all(allocations.map((a) => store.getEpoch(a.epochId)));
  let epochs: RewardsSummary["epochs"] = [];
  found.forEach((e, i) => {
    if (e) epochs.push({ ...e, allocation: allocations[i] });
  });
  epochs.sort((a, b) => b.startsAt - a.startsAt);

  // A wallet with nothing settled sees DEMO history while payouts are off, so the page is explorable pre-launch.
  const demo = epochs.length === 0 && !payouts.enabled;
  if (demo) epochs = demoRewardHistory(wallet);
  const demoLamports = demo ? epochs.reduce((s, e) => s + e.allocation.lamports, 0) : bal.demo;

  return {
    wallet,
    epochs,
    claims,
    current,
    earnedLamports: bal.earned,
    claimedLamports: bal.claimed,
    claimableLamports: bal.claimable,
    demoLamports,
    demo,
    payouts,
  };
}
