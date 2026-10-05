import type { MetadataRoute } from "next";

/** Lets the site be installed to the Dock / taskbar, so node notifications carry the BRAIN name and icon. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BRAIN",
    short_name: "BRAIN",
    description: "Distributed AI compute network. Compute from everywhere.",
    start_url: "/earn",
    display: "standalone",
    background_color: "#0b0d11",
    theme_color: "#0b0d11",
    icons: [
      { src: "/brand/pfp-dark-400.png", sizes: "400x400", type: "image/png" },
      { src: "/brand/pfp-dark-1024.png", sizes: "1024x1024", type: "image/png", purpose: "any" },
    ],
  };
}
