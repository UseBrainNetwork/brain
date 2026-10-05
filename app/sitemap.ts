import type { MetadataRoute } from "next";
import { siteUrl as base } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/contribute", "/brain", "/inference", "/explorer", "/rewards", "/economics", "/developers", "/auto", "/capacity", "/network"].map((p) => ({
    url: `${base}${p}`,
    changeFrequency: p === "" || p === "/explorer" ? "daily" : "weekly",
    priority: p === "" ? 1 : 0.7,
  }));
}
