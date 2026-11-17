import type { MetadataRoute } from "next";
import { headers } from "next/headers";

const NOINDEX_HOSTS = new Set(["sign.allininsure.com"]);

export default async function robots(): Promise<MetadataRoute.Robots> {
  const h = await headers();
  const isSignHost = [h.get("x-forwarded-host"), h.get("host")]
    .flatMap((value) => (value ? value.split(",") : []))
    .map((value) => value.trim().toLowerCase().replace(/:\d+$/, ""))
    .some((host) => NOINDEX_HOSTS.has(host));

  if (isSignHost) {
    return {
      rules: { userAgent: "*", disallow: "/" },
    };
  }

  return {
    rules: { userAgent: "*", allow: "/" },
  };
}
