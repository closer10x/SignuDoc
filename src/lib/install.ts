import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { Branding } from "./branding.ts";
import { ServiceConfigurationError } from "./services/service-config.ts";
import { getBranding, isFreshInstall } from "./settings.ts";


const NOINDEX_HOSTS = new Set(["sign.allininsure.com"]);

/** True when this request is the All In signing app, which should stay out of Google. */
async function shouldNoindexSignHost(): Promise<boolean> {
  const h = await headers();
  return [h.get("x-forwarded-host"), h.get("host")]
    .flatMap((value) => (value ? value.split(",") : []))
    .map((value) => value.trim().toLowerCase().replace(/:\d+$/, ""))
    .some((host) => NOINDEX_HOSTS.has(host));
}

function withSignHostRobots(metadata: Metadata, noindex: boolean): Metadata {
  if (!noindex) return metadata;
  return { ...metadata, robots: { index: false, follow: false } };
}

/**
 * Page title and description for an install that is not the hosted service:
 * the organization's name instead of SignuDoc's own. The hosted service
 * keeps what the root layout says.
 */
export async function getInstallMetadata(): Promise<Metadata> {
  const noindex = await shouldNoindexSignHost();
  let branding: Branding;

  try {
    branding = await getBranding();
  } catch {
    // A page title is not worth failing a page over. Whatever went wrong
    // (no database, most likely) is reported by the page itself.
    return withSignHostRobots({}, noindex);
  }

  if (branding.hosted) {
    return withSignHostRobots({}, noindex);
  }

  return withSignHostRobots(
    {
      description: `Send and sign documents with ${branding.productName}.`,
      title: branding.productName,
    },
    noindex,
  );
}

/**
 * For the pages a first visitor can land on. While the install has no
 * accounts and has never been set up, they all lead to /setup. So does a
 * deployment with no database connected, where /setup explains what to do.
 */
export async function redirectToSetupIfNeeded() {
  let needsSetup: boolean;

  try {
    needsSetup = await isFreshInstall();
  } catch (error) {
    if (error instanceof ServiceConfigurationError) {
      needsSetup = true;
    } else {
      // The database could not be asked. That is not a reason to send
      // visitors of a working site to the setup page, or to fail a page
      // that may not need the database at all.
      console.error("[setup] Could not read the setup state:", error);
      needsSetup = false;
    }
  }

  if (needsSetup) {
    redirect("/setup");
  }
}
