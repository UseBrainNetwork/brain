/** Privy app IDs are public identifiers; the app secret is server-only and never shipped to the client. */
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
export const privyEnabled = PRIVY_APP_ID.length > 0;
export const PRIVY_ADAPTER_ID = "privy";
