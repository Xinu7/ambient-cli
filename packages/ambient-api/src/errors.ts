import { AmbError } from "@amb/protocol";
import { classify429, isContextOverflowError } from "@amb/reliability";

/**
 * Map an HTTP failure from Ambient into a classified AmbError. The 429 split (cold vs rate-limit) and
 * the 400 overflow-vs-param distinction are the two that matter most for the agent's recovery path.
 */
export function classifyHttpError(
  status: number,
  body: string,
  opts: { model?: string; hasImage?: boolean } = {},
): AmbError {
  const model = opts.model;
  if (status === 401 || status === 403) {
    return new AmbError({
      kind: "auth",
      message: "Ambient authentication failed — check your API key.",
      retryable: false,
      model,
      detail: body,
    });
  }
  if (status === 429) {
    const kind = classify429(body);
    return new AmbError({
      kind,
      message:
        kind === "cold"
          ? "No workers are currently available for this model (cold)."
          : "Rate limited by Ambient.",
      retryable: kind !== "cold",
      model,
      detail: body,
    });
  }
  if (status === 400 && isContextOverflowError(body, { hasImage: opts.hasImage })) {
    return new AmbError({
      kind: "overflow",
      message: "Prompt exceeds the model's context window.",
      retryable: true,
      model,
      detail: body,
    });
  }
  if (status === 400) {
    return new AmbError({
      kind: "bad_request",
      message: "Bad request to Ambient.",
      retryable: false,
      model,
      detail: body,
    });
  }
  if (status >= 500) {
    return new AmbError({
      kind: "transport",
      message: `Ambient upstream error (${status}).`,
      retryable: true,
      model,
      detail: body,
    });
  }
  return new AmbError({
    kind: "transport",
    message: `Unexpected Ambient status ${status}.`,
    retryable: false,
    model,
    detail: body,
  });
}
