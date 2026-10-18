import { getStore } from "@netlify/blobs";
import { handle, netlifyStore } from "../lib/core.mjs";

export default async (req, context) => handle(req, context, { store: netlifyStore(getStore), env: process.env });

export const config = {
  path: "/api/*",
  // A backstop against floods. Officer screens check for changes every few seconds, and everyone
  // at a meeting may share one Wi-Fi connection, so this is generous.
  rateLimit: { windowLimit: 900, windowSize: 60, aggregateBy: ["ip", "domain"] }
};
