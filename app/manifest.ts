import type { MetadataRoute } from "next"

/**
 * Web app manifest (served at /manifest.webmanifest). Icons are PLACEHOLDERS drawn from the
 * in-app "D" mark in components/duely/app-shell.tsx: public/branding has no real logo yet.
 * Replace the files in public/icons/ (same names and sizes) when the real logo exists.
 *
 * Deliberately no service worker: Duely shows invoice and payment state that must come
 * from the live source, so nothing is cached for offline use.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Duely",
    short_name: "Duely",
    description:
      "Escrow-backed early payment for freelancers. Demo mode with simulated tokens.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#06152F",
    theme_color: "#06152F",
    categories: ["finance", "business"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
