import type { MetadataRoute } from "next";
import { siteUrl as base } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/chat", "/pricing", "/earn", "/account", "/network", "/brain", "/explorer", "/rewards", "/economics", "/developers", "/auto", "/capacity", "/models", "/provider", "/payouts", "/status"].map((p) => ({
    url: `${base}${p}`,
    changeFrequency: p === "" || p === "/explorer" ? "daily" : "weekly",
    priority: p === "" ? 1 : 0.7,
  }));
}
