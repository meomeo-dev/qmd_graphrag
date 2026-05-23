import type { DspyExpansionFailureReason } from "../contracts/dspy.js";

export class DspyQueryExpansionStrictRefusalError extends Error {
  readonly reason: DspyExpansionFailureReason;

  constructor(reason: DspyExpansionFailureReason, message: string) {
    super(message);
    this.name = "DspyQueryExpansionStrictRefusalError";
    this.reason = reason;
  }
}
