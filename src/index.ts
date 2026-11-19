// Root `@aphrody/auto` Library & SDK entrypoint for external developers and AI agents.
export * from "@aphrody/auto-domain";
export * from "@aphrody/auto-i18n";
export * from "@aphrody/auto-platform";
export * from "@aphrody/auto-services";
export * as native from "@aphrody/auto-native";
export * as store from "@aphrody/auto-store";
export * as client from "@aphrody/auto-client";
export {
  createAutoClient,
  createAutoClientFromEnv,
  asAgentTools,
  AutoClient,
  AutoSyncClient,
  AutoApiError,
} from "@aphrody/auto-client";
export {
  initNative,
  facturx,
  renderPdf,
  verifyPdfA,
  xmlCii,
  extractXml,
  authHashPassword,
  authVerifyPassword,
  authSignJwt,
  authVerifyJwt,
  authJwks,
  authSealSecret,
  authOpenSecret,
  authTotpCode,
  authTotpVerify,
  authGenerateApiKey,
  authCanPerform,
} from "@aphrody/auto-native";
export {
  AutomationWorkflow,
  cloudflareWorker,
  CompanyDO,
  createAutoApp,
  createSelfHostedServer,
  buildOpenApiSpec,
} from "@aphrody/auto-server";
