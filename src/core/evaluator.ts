/**
 * Condition Evaluator
 * Evaluates dynamic condition payloads against runtime metadata
 */

export class ConditionEvaluator {
  /**
   * Matches policy condition payload against runtime event metadata.
   * Returns true if all conditions pass, or if conditionPayload is empty.
   */
  public static matches(
    conditionPayload?: Record<string, unknown> | null,
    metadata?: Record<string, unknown> | null
  ): boolean {
    if (!conditionPayload || Object.keys(conditionPayload).length === 0) {
      return true;
    }

    const meta = metadata ?? {};

    // 1. Task completion guardrails
    if (
      conditionPayload.requireAllTasks === true &&
      meta.hasPendingTasks === true
    ) {
      return false;
    }

    // 2. Generic key-value matching
    for (const [key, expectedValue] of Object.entries(conditionPayload)) {
      if (key === 'requireAllTasks') continue;

      const actualValue = meta[key];

      if (expectedValue !== undefined) {
        if (actualValue === undefined) {
          // If a condition rule explicitly demands a key, but it's absent from metadata, it fails
          return false;
        }

        if (Array.isArray(expectedValue)) {
          if (!expectedValue.includes(actualValue)) {
            return false;
          }
        } else if (typeof expectedValue === 'object' && expectedValue !== null) {
          if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue)) {
            return false;
          }
        } else if (expectedValue !== actualValue) {
          return false;
        }
      }
    }

    return true;
  }
}
