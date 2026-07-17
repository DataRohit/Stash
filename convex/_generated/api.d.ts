/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as charts from "../charts.js";
import type * as collab from "../collab.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as documents from "../documents.js";
import type * as email from "../email.js";
import type * as health from "../health.js";
import type * as limits from "../limits.js";
import type * as maintenance from "../maintenance.js";
import type * as members from "../members.js";
import type * as navigation from "../navigation.js";
import type * as organizations from "../organizations.js";
import type * as presence from "../presence.js";
import type * as projects from "../projects.js";
import type * as secrets from "../secrets.js";
import type * as sharing from "../sharing.js";
import type * as structuredSurfaces from "../structuredSurfaces.js";
import type * as templates from "../templates.js";
import type * as watchHelpers from "../watchHelpers.js";
import type * as watches from "../watches.js";
import type * as writeRateLimit from "../writeRateLimit.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  charts: typeof charts;
  collab: typeof collab;
  comments: typeof comments;
  crons: typeof crons;
  documents: typeof documents;
  email: typeof email;
  health: typeof health;
  limits: typeof limits;
  maintenance: typeof maintenance;
  members: typeof members;
  navigation: typeof navigation;
  organizations: typeof organizations;
  presence: typeof presence;
  projects: typeof projects;
  secrets: typeof secrets;
  sharing: typeof sharing;
  structuredSurfaces: typeof structuredSurfaces;
  templates: typeof templates;
  watchHelpers: typeof watchHelpers;
  watches: typeof watches;
  writeRateLimit: typeof writeRateLimit;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
