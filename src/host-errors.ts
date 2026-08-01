import { errString } from "./redact.js";

/**
 * Translate Paperclip's company-scope denials into something an operator can
 * act on.
 *
 * Both denials read like plugin bugs but are really ordering constraints in how
 * the host authorizes a plugin to act on a company:
 *
 * - Secret access is granted per *configured* company, seeded from the plugin's
 *   saved config rows — so a Test Connection run before the first Save can
 *   never resolve a secret.
 * - Background (non-invocation) work is authorized from the set of companies
 *   that had a saved configuration when the worker process started. Configuring
 *   a plugin for the first time therefore leaves a already-running worker with
 *   an empty authorized set until it is restarted.
 *
 * Anything else is passed through unchanged (token-redacted).
 */
export function describeHostError(err: unknown): string {
  const message = errString(err);

  if (message.includes("company context is required")) {
    return (
      "the secret could not be resolved yet. Paperclip grants a plugin access to " +
      "secrets per configured company, and this configuration has not been saved " +
      "yet — click Save first, then run Test Connection again."
    );
  }

  if (message.includes("invocation scope")) {
    return (
      "Paperclip has not authorized this plugin to act on its configured company " +
      "from background work yet. That authorization is seeded when the plugin " +
      "worker starts, from the configurations saved at that moment — so a plugin " +
      "configured for the first time needs a restart. Disable and re-enable the " +
      "plugin (or restart Paperclip) and try again."
    );
  }

  return message;
}
