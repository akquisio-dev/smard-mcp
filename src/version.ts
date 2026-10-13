/**
 * Name and version come from package.json, the single source of truth.
 * Both src/ (tests) and dist/ (build) sit one level below it.
 */

import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };

export const SERVER_NAME = pkg.name;
export const SERVER_VERSION = pkg.version;
