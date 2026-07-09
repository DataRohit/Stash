/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as collab from "../collab.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as documents from "../documents.js";
import type * as limits from "../limits.js";
import type * as members from "../members.js";
import type * as organizations from "../organizations.js";
import type * as presence from "../presence.js";
import type * as projects from "../projects.js";
import type * as sharing from "../sharing.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  collab: typeof collab;
  comments: typeof comments;
  crons: typeof crons;
  documents: typeof documents;
  limits: typeof limits;
  members: typeof members;
  organizations: typeof organizations;
  presence: typeof presence;
  projects: typeof projects;
  sharing: typeof sharing;
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
