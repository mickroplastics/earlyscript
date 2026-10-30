import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { EarlyscriptBrand } from "@t3tools/shared/earlyscriptBrand";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  `${EarlyscriptBrand.urlScheme}://app`,
  `${EarlyscriptBrand.devUrlScheme}://app`,
] as const;
