import { describe, expect, it } from "vitest";
import { creatorVaults, PUMP_PROGRAMS } from "./solana";

const WALLET = "HZLev74M3ATV5jQJsoN8FcJAKx3RUefAobhcXr3egxwa";

describe("creatorVaults", () => {
  it("derives the pump.fun creator-fee vault PDAs for the protocol wallet", () => {
    const v = creatorVaults(WALLET);
    // Verified against mainnet: the bonding vault held the launch-day creator fees.
    expect(v.bonding).toBe("C3yRmkmh3gKpUKH8y7StKsMEWU3ipjSsY8Wnioh6qqfH");
    expect(v.amm).toBe("8qLR16BgQLHUEjJhobbxYP7ZMHmEbnbiHFPhLH4Nn9ce");
  });
  it("uses the published pump.fun program ids", () => {
    expect(PUMP_PROGRAMS.bondingCurve).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    expect(PUMP_PROGRAMS.amm).toBe("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  });
});
